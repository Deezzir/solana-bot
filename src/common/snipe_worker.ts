import { parentPort, workerData } from 'worker_threads';
import { Keypair, LAMPORTS_PER_SOL, Connection, TokenAmount } from '@solana/web3.js';
import * as common from './common';
import * as snipe from './snipe_common';
import * as trade from './trade_common';
import { Helius } from 'helius-sdk';
import {
    COMMITMENT,
    HELIUS_API_KEY,
    HELIUS_RPC,
    SNIPE_TRADE_BATCH,
    SNIPE_MIN_BUY,
    SNIPE_RETRIES,
    SNIPE_RETRY_INTERVAL_MS
} from '../constants';
import { get_trader } from './get_trader';
import { configure_helius_rate_limiter, helius_connection_config } from './rate_limit';

type State =
    | { mode: 'idle'; spendings?: number; buys: number; sells: number }
    | { mode: 'buy'; buy_amount: number; spendings?: number; buys: number; sells: number }
    | { mode: 'sell'; percent?: number; spendings?: number; buys: number; sells: number }
    | { mode: 'stop'; spendings?: number; buys: number; sells: number };

const CONFIG: snipe.WorkerConfig = workerData as snipe.WorkerConfig;
const KEYPAIR: Keypair = Keypair.fromSecretKey(new Uint8Array(CONFIG.secret));
const TRADER: trade.IProgramTrader = get_trader(CONFIG.program);
configure_helius_rate_limiter(CONFIG.helius_rate_limit_state);
global.CONNECTION = new Connection(HELIUS_RPC, helius_connection_config({ commitment: COMMITMENT }));
global.HELIUS_CONNECTION = new Helius(HELIUS_API_KEY);

var MINT_METADATA: trade.IMintMeta;
var CANCEL_SLEEP: (() => void) | null = null;
var MESSAGE_BUFFER: string[] = [];
var STATE: State = { mode: 'idle', buys: 0, sells: 0 };

function control_sleep(ms: number): { promise: Promise<void>; cancel: () => void } {
    let timeout_id: NodeJS.Timeout;
    let cancel: () => void = () => {};

    const promise = new Promise<void>((resolve) => {
        timeout_id = setTimeout(resolve, ms);
        cancel = () => {
            clearTimeout(timeout_id);
            resolve();
        };
    });

    return { promise, cancel };
}

function send_messages(): void {
    if (MESSAGE_BUFFER.length > 0) parentPort?.postMessage(MESSAGE_BUFFER.join('\n'));
    MESSAGE_BUFFER = [];
}

async function process_buy(promise: Promise<String>, amount: number) {
    try {
        const sig = await promise;
        try {
            const balance_change = await trade.get_balance_change(sig.toString(), KEYPAIR.publicKey);
            STATE.spendings = (STATE.spendings || 0) + balance_change;
        } catch (error) {
            MESSAGE_BUFFER.push(`[Worker ${CONFIG.id}] Error getting balance change, continuing...`);
        }
        STATE.buys++;
        MESSAGE_BUFFER.push(`[Worker ${CONFIG.id}] Bought ${amount} SOL of the token, signature: ${sig}`);
        return true;
    } catch (error) {
        if (error instanceof Error) {
            if (error.message.includes('Simulation failed')) {
                await common.sleep(SNIPE_RETRY_INTERVAL_MS);
                MESSAGE_BUFFER.push(`[Worker ${CONFIG.id}] Buy simulation failed, retrying...`);
            } else {
                MESSAGE_BUFFER.push(`[Worker ${CONFIG.id}] Failed to buy the token (${error.message}), retrying...`);
            }
        }
        return false;
    }
}

function calc_buy_amount(
    min_buy: number,
    max_buy?: number,
    spendings: number = 0,
    spend_limit: number = Infinity
): number {
    const remaining = (spend_limit - spendings) * 0.95;
    let amount: number;
    if (max_buy && max_buy > min_buy) {
        amount = common.normal_random((min_buy + max_buy) / 2, (max_buy - min_buy) / 4);
        amount = Math.max(min_buy, Math.min(max_buy, amount));
    } else {
        amount = min_buy;
    }
    return Math.max(SNIPE_MIN_BUY, parseFloat(Math.min(amount, remaining).toFixed(5)));
}

const buy = async () => {
    if (STATE.mode !== 'buy') return;

    const amount = STATE.buy_amount;
    parentPort?.postMessage(`[Worker ${CONFIG.id}] Buying ${amount} SOL of the token`);
    let bought = false;

    while (STATE.mode === 'buy' && !bought) {
        let transactions = [];
        let count = SNIPE_TRADE_BATCH;
        while (count > 0) {
            const buy_promise = TRADER.buy_token(
                amount,
                KEYPAIR,
                MINT_METADATA,
                CONFIG.buy_slippage,
                CONFIG.priority_level,
                CONFIG.protection_tip
            );
            transactions.push(
                process_buy(buy_promise, amount).then((result) => {
                    if (result) bought = true;
                })
            );

            count--;
            await common.sleep(SNIPE_RETRY_INTERVAL_MS);
        }
        await Promise.allSettled(transactions);
    }
};

async function process_sell(promise: Promise<String>, balance: TokenAmount) {
    try {
        const sig = await promise;
        const ui_amount = balance.uiAmount ? balance.uiAmount.toFixed(2) : 0;
        MESSAGE_BUFFER.push(`[Worker ${CONFIG.id}] Sold ${ui_amount} tokens, signature: ${sig}`);
        return true;
    } catch (error) {
        if (error instanceof Error) {
            if (error.message.includes('Simulation failed')) {
                await common.sleep(SNIPE_RETRY_INTERVAL_MS);
                MESSAGE_BUFFER.push(`[Worker ${CONFIG.id}] Sell simulation failed, retrying...`);
            } else {
                MESSAGE_BUFFER.push(`[Worker ${CONFIG.id}] Error selling the token, ${error.message} retrying...`);
            }
        }
        return false;
    }
}

const sell = async () => {
    if (STATE.mode !== 'sell') throw new Error('Invalid state for selling. Current state: ' + STATE.mode);

    let sold = false;
    let balance: TokenAmount | undefined = undefined;

    while (!sold) {
        let get_balance_retry = SNIPE_RETRIES;
        while (get_balance_retry > 0) {
            try {
                balance = await trade.get_token_balance(
                    KEYPAIR.publicKey,
                    MINT_METADATA.mint_pubkey,
                    COMMITMENT,
                    MINT_METADATA.token_program
                );
                if (balance.uiAmount !== null && balance.uiAmount !== 0) break;
                get_balance_retry--;

                if (get_balance_retry > 0) MESSAGE_BUFFER.push(`[Worker ${CONFIG.id}] Retrying to get the balance...`);
                if (get_balance_retry === 0) {
                    MESSAGE_BUFFER.push(`[Worker ${CONFIG.id}] No tokens to sell, exiting...`);
                    sold = true;
                }
                await common.sleep(SNIPE_RETRY_INTERVAL_MS * get_balance_retry);
            } catch (e) {
                MESSAGE_BUFFER.push(`[Worker ${CONFIG.id}] Error getting the balance, retrying...`);
                get_balance_retry--;
            }
        }

        if (sold || !balance) break;

        balance = STATE.percent ? trade.get_token_amount_by_percent(balance!, STATE.percent) : balance;
        parentPort?.postMessage(`[Worker ${CONFIG.id}] Selling ${balance.uiAmount} tokens`);

        let transactions = [];
        let sell_retry = SNIPE_TRADE_BATCH;
        while (sell_retry > 0) {
            const sell_promise = TRADER.sell_token(
                balance,
                KEYPAIR,
                MINT_METADATA,
                CONFIG.sell_slippage,
                CONFIG.priority_level,
                CONFIG.protection_tip
            );
            transactions.push(
                process_sell(sell_promise, balance).then((result) => {
                    if (result) sold = true;
                })
            );

            sell_retry--;
            await common.sleep(SNIPE_RETRY_INTERVAL_MS);
        }
        await Promise.allSettled(transactions);
    }
};

const control_loop = async () =>
    new Promise<void>(async (resolve) => {
        const should_sell = () => STATE.mode === 'sell' || MINT_METADATA.token_usd_mc >= CONFIG.mcap_threshold;
        const should_buy = () =>
            STATE.mode === 'buy' &&
            (STATE.buys === 0 || !CONFIG.is_buy_once) &&
            (STATE.spendings || 0) < CONFIG.spend_limit &&
            STATE.buy_amount > SNIPE_MIN_BUY;
        const process = async () => {
            if (!MINT_METADATA) return;

            if (should_sell()) {
                await sell();
                STATE = { mode: 'idle', spendings: STATE.spendings, buys: STATE.buys, sells: STATE.sells };
                return;
            }

            if (should_buy()) {
                await buy();
                if (STATE.mode === 'buy')
                    STATE.buy_amount = calc_buy_amount(
                        CONFIG.min_buy,
                        CONFIG.max_buy,
                        STATE.spendings,
                        CONFIG.spend_limit
                    );
                if (!should_buy()) {
                    MESSAGE_BUFFER.push(
                        `[Worker ${CONFIG.id}] Spend limit reached or buy amount too low, stopping buys...`
                    );
                    STATE = { mode: 'idle', spendings: STATE.spendings, buys: STATE.buys, sells: STATE.sells };
                }
                return;
            }
        };

        while (STATE.mode !== 'stop') {
            await process();
            const ms =
                STATE.mode === 'buy'
                    ? common.normal_random(CONFIG.trade_interval, 0.5 * CONFIG.trade_interval) * 1000
                    : SNIPE_RETRY_INTERVAL_MS;

            if (STATE.mode === 'buy')
                MESSAGE_BUFFER.push(
                    `[Worker ${CONFIG.id}] Sleeping for ${(ms / 1000).toFixed(2)} seconds before the next trade...`
                );

            const { promise, cancel } = control_sleep(ms);
            CANCEL_SLEEP = cancel;
            send_messages();
            await promise;
        }

        send_messages();
        resolve();
    });

async function main() {
    const balance = (await trade.get_balance(KEYPAIR.publicKey, COMMITMENT)) / LAMPORTS_PER_SOL;
    CONFIG.spend_limit = Math.min(balance, CONFIG.spend_limit) - SNIPE_MIN_BUY;

    // Warmup
    await trade.get_ltas(TRADER.get_lta_addresses());

    parentPort?.postMessage({
        command: 'started',
        data: `[Worker ${CONFIG.id}] Started with Public Key: ${KEYPAIR.publicKey.toString()}`
    });

    parentPort?.on('message', async (msg) => {
        switch (msg.command) {
            case `buy${CONFIG.id}`:
                let buy_amount: number;
                if (msg.data.amount)
                    buy_amount = calc_buy_amount(msg.data.amount, 0, STATE.spendings, CONFIG.spend_limit);
                else buy_amount = calc_buy_amount(CONFIG.min_buy, CONFIG.max_buy, STATE.spendings, CONFIG.spend_limit);

                if (STATE.mode !== 'buy') {
                    parentPort?.postMessage(`[Worker ${CONFIG.id}] Received buy command from the main thread`);
                    STATE = {
                        mode: 'buy',
                        buy_amount,
                        spendings: STATE.spendings,
                        buys: STATE.buys,
                        sells: STATE.sells
                    };
                }
                break;
            case `sell${CONFIG.id}`:
                if (STATE.mode !== 'sell') {
                    const { percent } = msg.data;
                    parentPort?.postMessage(`[Worker ${CONFIG.id}] Received sell command from the main thread`);
                    STATE = { mode: 'sell', percent, spendings: STATE.spendings, buys: STATE.buys, sells: STATE.sells };
                    if (CANCEL_SLEEP !== null) CANCEL_SLEEP();
                }
                break;
            case 'stop':
                if (STATE.mode !== 'stop') {
                    parentPort?.postMessage(`[Worker ${CONFIG.id}] Stopped by the main thread`);
                    STATE = { mode: 'stop', spendings: STATE.spendings, buys: STATE.buys, sells: STATE.sells };
                    if (CANCEL_SLEEP !== null) CANCEL_SLEEP();
                }
                break;
            case 'mint':
                MINT_METADATA = TRADER.deserialize_mint_meta(msg.data);
                break;
            case 'config':
                const { key, value } = msg.data;
                snipe.update_config(CONFIG, key, value);
                break;
            default:
                parentPort?.postMessage(`[Worker ${CONFIG.id}] Unknown command from the main thread: ${msg.command}`);
                break;
        }
    });

    await control_loop();

    parentPort?.postMessage(`[Worker ${CONFIG.id}] Finished`);
    process.exit(0);
}

main().catch((err) => {
    throw err;
});
