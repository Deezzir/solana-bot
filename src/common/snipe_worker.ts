import { parentPort, workerData } from 'worker_threads';
import { Keypair, Connection, TokenAmount } from '@solana/web3.js';
import * as common from './common';
import * as snipe from './snipe_common';
import * as trade from './trade_common';
import {
    COMMITMENT,
    HELIUS_RPC,
    SENDER_ENDPOINT,
    SNIPE_TRADE_BATCH,
    SNIPE_MIN_BUY,
    SNIPE_RETRIES,
    SNIPE_RETRY_INTERVAL_MS,
    TransactionRelay
} from '../constants';
import { create_executor } from './get_provider';
import { configure_rpc_rate_limiter, rpc_connection_config } from './rate_limit';

type State =
    | { mode: 'idle'; spendings?: number; buys: number; sells: number }
    | { mode: 'buy'; buy_amount: number; spendings?: number; buys: number; sells: number }
    | { mode: 'sell'; percent?: number; spendings?: number; buys: number; sells: number }
    | { mode: 'stop'; spendings?: number; buys: number; sells: number };

const CONFIG: snipe.WorkerConfig = workerData as snipe.WorkerConfig;
const KEYPAIR: Keypair = await Keypair.fromSecretKey(new Uint8Array(CONFIG.secret));
const EXECUTOR = create_executor({ enable_funding: CONFIG.funding, program: CONFIG.program });
global.PROGRAM = CONFIG.program;
global.TRANSACTION_RELAY = CONFIG.transaction_relay;
global.TRANSACTION_VERSION = CONFIG.transaction_version;
global.PRIORITY_FEE = undefined;
configure_rpc_rate_limiter(CONFIG.rpc_rate_limit_state);
global.CONNECTION = new Connection(HELIUS_RPC, rpc_connection_config({ commitment: COMMITMENT }));

var MINT_METADATA: trade.IMintMeta;
var USD_MARKET_CAP = 0;
var CANCEL_SLEEP: (() => void) | null = null;
var MESSAGE_BUFFER: string[] = [];
var STATE: State = { mode: 'idle', buys: 0, sells: 0 };
var SENDER_WARM_TIMER: NodeJS.Timeout | undefined;
var SENDER_WARMING = false;
var SENDER_WARM_FAILED = false;

async function warm_sender_connection(): Promise<void> {
    if (global.TRANSACTION_RELAY !== TransactionRelay.Sender || !SENDER_ENDPOINT || SENDER_WARMING) return;
    SENDER_WARMING = true;
    try {
        const response = await fetch(`${SENDER_ENDPOINT}/ping`, { signal: AbortSignal.timeout(5000) });
        await response.arrayBuffer();
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        SENDER_WARM_FAILED = false;
    } catch (error) {
        if (!SENDER_WARM_FAILED)
            parentPort?.postMessage(`[Worker ${CONFIG.id}] Sender connection warmup failed: ${error}`);
        SENDER_WARM_FAILED = true;
    } finally {
        SENDER_WARMING = false;
    }
}

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
        if (error instanceof trade.TransactionSubmissionError && error.outcome === 'unknown') {
            STATE.mode = 'stop';
            MESSAGE_BUFFER.push(
                `[Worker ${CONFIG.id}] Buy outcome unknown; stopping to avoid a duplicate buy. ${error.message}`
            );
            return false;
        }
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
        while (count > 0 && STATE.mode === 'buy') {
            const buy_promise = EXECUTOR.buy_token(
                amount,
                KEYPAIR,
                MINT_METADATA,
                CONFIG.buy_slippage,
                CONFIG.priority_level,
                CONFIG.protection_tip,
                CONFIG.mev_protect
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
        if (error instanceof trade.TransactionSubmissionError && error.outcome === 'unknown') {
            STATE.mode = 'stop';
            MESSAGE_BUFFER.push(
                `[Worker ${CONFIG.id}] Sell outcome unknown; stopping to avoid resubmission. ${error.message}`
            );
            return false;
        }
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

    while (!sold && STATE.mode === 'sell') {
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
        while (sell_retry > 0 && STATE.mode === 'sell') {
            const sell_promise = EXECUTOR.sell_token(
                balance,
                KEYPAIR,
                MINT_METADATA,
                CONFIG.sell_slippage,
                CONFIG.priority_level,
                CONFIG.protection_tip,
                CONFIG.mev_protect
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
        const should_sell = () => STATE.mode === 'sell' || USD_MARKET_CAP >= CONFIG.mcap_threshold;
        const should_buy = () =>
            STATE.mode === 'buy' &&
            (STATE.buys === 0 || !CONFIG.is_buy_once) &&
            (STATE.spendings || 0) < CONFIG.spend_limit &&
            STATE.buy_amount > SNIPE_MIN_BUY;
        const process = async () => {
            if (!MINT_METADATA) return;

            if (should_sell()) {
                await sell();
                if (STATE.mode === 'stop') return;
                STATE = { mode: 'idle', spendings: STATE.spendings, buys: STATE.buys, sells: STATE.sells };
                return;
            }

            if (should_buy()) {
                await buy();
                if (STATE.mode === 'stop') return;
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

            if (STATE.mode === 'buy' && ms >= 1000)
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
    const balance = trade.lamports_to_sol(await trade.get_balance(KEYPAIR.publicKey, COMMITMENT));
    CONFIG.spend_limit = Math.min(balance, CONFIG.spend_limit) - SNIPE_MIN_BUY;

    await trade.get_ltas(EXECUTOR.get_lta_addresses());
    await warm_sender_connection();
    SENDER_WARM_TIMER = setInterval(() => void warm_sender_connection(), 5000);
    SENDER_WARM_TIMER.unref();

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
                    if (CANCEL_SLEEP !== null) CANCEL_SLEEP();
                    const { mint_meta, priority_fee } = msg.data;
                    global.PRIORITY_FEE = priority_fee;
                    if (mint_meta !== undefined) MINT_METADATA = EXECUTOR.deserialize_mint_meta(mint_meta);
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
                MINT_METADATA = EXECUTOR.deserialize_mint_meta(msg.data);
                break;
            case 'market_cap':
                USD_MARKET_CAP = msg.data;
                break;
            case 'priority_fee':
                global.PRIORITY_FEE = msg.data;
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

    if (SENDER_WARM_TIMER) clearInterval(SENDER_WARM_TIMER);
    parentPort?.postMessage(`[Worker ${CONFIG.id}] Finished`);
    process.exit(0);
}

main().catch((err) => {
    throw err;
});
