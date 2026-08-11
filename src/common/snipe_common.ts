import { Worker } from 'worker_threads';
import inquirer from 'inquirer';
import { clearLine, moveCursor } from 'readline';
import { LAMPORTS_PER_SOL, PartiallyDecodedInstruction, PublicKey } from '@solana/web3.js';
import {
    COMMITMENT,
    PriorityLevel,
    SNIPE_BUY_SLIPPAGE,
    SNIPE_META_POLL_INTERVAL_MS,
    SNIPE_MIN_BUY,
    SNIPE_MIN_MCAP,
    SNIPE_SELL_SLIPPAGE,
    TRADE_MAX_SLIPPAGE
} from '../constants';
import * as common from './common';
import { IProgramTrader, get_balance, retry_get_tx } from './trade_common';
import bs58 from 'bs58';
import { configure_helius_rate_limiter, create_helius_rate_limit_state } from './rate_limit';

export type BotConfig = {
    thread_cnt: number;
    spend_limit: number;
    min_buy: number;
    max_buy?: number;
    mcap_threshold: number;
    is_buy_once: boolean;
    start_interval: number;
    trade_interval: number;
    sell_slippage: number;
    buy_slippage: number;
    priority_level: PriorityLevel;
    protection_tip: number;
    token_name: string | undefined;
    token_ticker: string | undefined;
    mint: PublicKey | undefined;
};

export type WorkerConfig = {
    program: common.Program;
    secret: Uint8Array;
    id: number;
    trade_interval: number;
    spend_limit: number;
    min_buy: number;
    max_buy?: number;
    mcap_threshold: number;
    is_buy_once: boolean;
    sell_slippage: number;
    buy_slippage: number;
    priority_level: PriorityLevel;
    protection_tip?: number;
    helius_rate_limit_state: SharedArrayBuffer;
};

export function update_config(config: WorkerConfig | BotConfig, key: string, value: string): [boolean, string?] {
    switch (key) {
        case 'trade_interval':
            if (common.validate_float(value, 0)) {
                config.trade_interval = parseFloat(value);
                return [true, undefined];
            } else {
                return [false, 'Invalid buy interval.'];
            }
        case 'spend_limit':
            if (common.validate_float(value, SNIPE_MIN_BUY)) {
                config.spend_limit = parseFloat(value);
                return [true, undefined];
            } else {
                return [false, 'Invalid spend limit.'];
            }
        case 'min_buy':
            if (common.validate_float(value, SNIPE_MIN_BUY)) {
                config.min_buy = parseFloat(value);
                return [true, undefined];
            } else {
                return [false, `Invalid min_buy. Must be greater than ${SNIPE_MIN_BUY}.`];
            }
        case 'max_buy':
            if (common.validate_float(value, config.min_buy)) {
                config.max_buy = parseFloat(value);
                return [true, undefined];
            } else {
                return [false, `Invalid max_buy. Must be greater than or equal to min_buy (${config.min_buy}).`];
            }
        case 'is_buy_once':
            if (value !== 'true' && value !== 'false') {
                return [false, 'Invalid value for is_buy_once. Use true or false.'];
            } else {
                config.is_buy_once = value === 'true';
                return [true, undefined];
            }
        case 'mcap_threshold':
            if (common.validate_int(value, SNIPE_MIN_MCAP)) {
                config.mcap_threshold = parseInt(value, 10);
                return [true, undefined];
            } else {
                return [false, 'Invalid market cap threshold.'];
            }
        case 'start_interval':
            if (!('start_interval' in config)) return [true, ''];
            if (common.validate_float(value, 0)) {
                config.start_interval = parseFloat(value);
                return [true, undefined];
            } else {
                return [false, 'Invalid start interval.'];
            }
        default:
            return [false, 'Invalid key.'];
            break;
    }
}

type WorkerJob = {
    worker: Worker;
    index: number;
    job: Promise<void>;
};

enum Method {
    Wait = 0,
    Snipe = 1
}

type WorkerMessage = 'stop' | 'buy' | 'mint' | 'sell' | 'config';

export interface ISniper {
    snipe(wallets: common.Wallet[], sol_price: number): Promise<void>;
    setup_config(keys_cnt: number, json_config?: object): Promise<void>;
}

export abstract class SniperBase implements ISniper {
    protected bot_config: BotConfig | null;
    protected trader: IProgramTrader;
    protected workers: WorkerJob[];
    private helius_rate_limit_state: SharedArrayBuffer;

    protected mint_authority!: PublicKey;
    protected program_id!: PublicKey;

    private sub_id: number | undefined;
    private logs_stop_func: (() => void) | null = null;

    constructor(trader: IProgramTrader) {
        this.workers = new Array<WorkerJob>();
        this.trader = trader;
        this.bot_config = null;
        this.helius_rate_limit_state = create_helius_rate_limit_state();
    }

    protected abstract decode_create_instr(data: Uint8Array): { name: string; symbol: string; misc?: object } | null;
    protected abstract is_create_tx(logs: string[]): boolean;

    private get_worker_path(): string {
        return './dist/common/snipe_worker';
    }

    private async wait_drop_unsub(): Promise<void> {
        if (this.sub_id !== undefined) {
            if (this.logs_stop_func) this.logs_stop_func();
            global.CONNECTION.removeOnLogsListener(this.sub_id)
                .then(() => (this.sub_id = undefined))
                .catch((err) => common.error(common.red(`Failed to unsubscribe from logs: ${err}`)));
        }
    }

    public async wait_drop_sub(
        token_name: string,
        token_ticker: string
    ): Promise<{ mint: PublicKey; misc?: object } | null> {
        const name = token_name.toLowerCase();
        const ticker = token_ticker.toLowerCase();
        common.log(`Waiting for the new token drop for the '${this.trader.get_name()}' program...`);

        return new Promise<{ mint: PublicKey; misc?: object } | null>((resolve, reject) => {
            this.logs_stop_func = () => reject(new Error('User stopped the process'));

            this.sub_id = global.CONNECTION.onLogs(
                this.mint_authority,
                async ({ err, logs, signature }) => {
                    if (err) return;
                    if (logs && this.is_create_tx(logs)) {
                        try {
                            const tx = await retry_get_tx(signature);
                            if (!tx || !tx.meta || !tx.transaction.message) return;

                            const instructions = tx.transaction.message.instructions as PartiallyDecodedInstruction[];

                            for (const instr of instructions) {
                                const program_id = instr.programId;
                                const mint = tx.transaction.message.accountKeys[1];

                                if (!program_id.equals(this.program_id)) continue;
                                const result = this.decode_create_instr(bs58.decode(instr.data));
                                if (!result) continue;

                                if (
                                    result.name.toLowerCase() === name &&
                                    result.symbol.toLowerCase() === ticker &&
                                    mint
                                ) {
                                    this.logs_stop_func = null;
                                    await this.wait_drop_unsub();
                                    common.log(`Found the mint using Solana logs`);
                                    resolve({ mint: mint.pubkey, misc: result.misc });
                                }
                            }
                        } catch (err) {
                            common.error(common.red(`Failed fetching the parsed transaction: ${err}`));
                        }
                    }
                },
                COMMITMENT
            );

            if (this.sub_id === undefined) {
                reject(new Error('Failed to subscribe to logs'));
            }
        }).catch(() => {
            return null;
        });
    }

    public async setup_config(keys_cnt: number, json_config?: object): Promise<void> {
        if (json_config) {
            const bot_config = await this.validate_json_config(json_config, keys_cnt);
            this.log_bot_config(bot_config);
            await common.to_confirm('Press ENTER to start the bot...');

            common.clear_lines_up(1);
            this.bot_config = bot_config;
        } else {
            try {
                const bot_config = await this.get_config(keys_cnt);
                common.clear_lines_up(1);
                this.bot_config = bot_config;
            } catch (error) {
                if (error instanceof Error) {
                    if (error.message.includes('prompt')) {
                        throw new Error('The bot setup was cancelled.');
                    }
                    throw new Error(`${error.message}`);
                } else {
                    throw new Error('Failed to setup the bot.');
                }
            }
        }
    }

    public async snipe(wallets: common.Wallet[], sol_price: number): Promise<void> {
        if (!this.bot_config) throw new Error('The bot configuration is not set.');
        configure_helius_rate_limiter(this.helius_rate_limit_state);

        if (this.bot_config.mint) {
            common.log(common.yellow('Sniping existing mint...'));
        } else if (this.bot_config.token_name && this.bot_config.token_ticker) {
            common.log(common.yellow('Sniping token by name and ticker...'));
        }

        this.setup_cmd_interface();

        common.log('[Main Worker] Starting the bot...');
        try {
            await this.workers_start(wallets);
        } catch (error) {
            common.close_readline();
            throw new Error(`Failed to start the workers: ${error} Exiting...`);
        }
        common.log('[Main Worker] Bot started successfully, waiting for the token...');

        try {
            const result =
                this.bot_config.token_name && this.bot_config.token_ticker
                    ? await this.wait_drop_sub(this.bot_config.token_name, this.bot_config.token_ticker)
                    : { mint: this.bot_config.mint, misc: undefined };

            if (!result || !result.mint) throw new Error('Failed to find the token. Exiting...');

            this.bot_config.mint = result.mint;
            common.log(`[Main Worker] Token detected: ${this.bot_config.mint.toString()}`);

            let mint_meta = await this.trader.default_mint_meta(this.bot_config.mint, sol_price, result.misc);
            this.workers_post_message('mint', mint_meta.serialize());

            let migrated: boolean = false;
            let poll_stopped = false;
            let unsub: (() => void) | null = null;

            const publish_update = (next_meta: typeof mint_meta) => {
                mint_meta = next_meta;
                if (mint_meta.migrated && !migrated) {
                    migrated = true;
                    common.log('[Main Worker] Token migrated to liquidity pool...');
                }
                if (global.RL) global.RL.emit('mcap', mint_meta.token_usd_mc);
                this.workers_post_message('mint', mint_meta.serialize());
            };

            const poll = async () => {
                if (poll_stopped) return;
                try {
                    mint_meta = await this.trader.update_mint_meta(mint_meta, sol_price);
                    publish_update(mint_meta);
                } catch (err) {
                    common.error(common.red(`Failed to update token metadata`));
                }
                if (!poll_stopped) setTimeout(poll, SNIPE_META_POLL_INTERVAL_MS);
            };

            setTimeout(poll, SNIPE_META_POLL_INTERVAL_MS);
            unsub = await this.trader.subscribe_mint_meta(mint_meta, publish_update);

            this.workers_post_message('buy');
            await this.workers_wait();

            if (unsub) unsub();
            poll_stopped = true;
        } catch (error) {
            throw new Error(`Failed to snipe the token: ${error}`);
        } finally {
            common.close_readline();
        }
    }

    private async workers_wait(): Promise<void> {
        let promises = this.workers.map((w) => w.job);
        try {
            await Promise.all(promises);
            common.log('[Main Worker] All workers have finished executing');
        } catch (error) {
            throw new Error(`One of the workers encountered an error: ${error}`);
        }
    }

    private async check_balances(wallets: common.Wallet[], min_balance: number = 0): Promise<boolean> {
        let ok = true;
        const balance_checks = wallets.map(async (wallet) => {
            const holder = wallet.keypair;
            try {
                const sol_balance = (await get_balance(holder.publicKey, COMMITMENT)) / LAMPORTS_PER_SOL;
                if (sol_balance <= min_balance) {
                    common.error(
                        `Address: ${holder.publicKey.toString().padEnd(44, ' ')} has no balance. (wallet ${wallet.id})`
                    );
                    ok = false;
                }
            } catch (err) {
                common.error(common.red(`Failed to get the balance: ${err} for 'wallet ${wallet.id}'`));
                ok = false;
            }
        });
        await Promise.all(balance_checks);
        return ok;
    }

    private async workers_post_message(message: WorkerMessage, data: any = {}): Promise<void> {
        if (!this.bot_config) throw new Error('Bot configuration is not set.');

        if (message === 'stop') await this.wait_drop_unsub();
        if (message === 'buy') {
            if ('idx' in data && data.idx !== undefined) {
                const worker = this.workers.find((w) => w.index === data.idx);
                if (worker) {
                    common.log(`[Main Worker] Sending the buy command to worker ${worker.index} `);
                    worker.worker.postMessage({ command: `buy${worker.index}`, data });
                    return;
                }
            } else {
                for (const worker of this.workers) {
                    common.log(`[Main Worker] Sending the buy command to worker ${worker.index} `);
                    worker.worker.postMessage({ command: `buy${worker.index}`, data });
                    const start_interval = this.bot_config.start_interval;
                    if (start_interval > 0) {
                        const min_interval = start_interval * 1000;
                        const max_interval = start_interval * 1.5 * 1000;
                        await common.sleep(common.normal_random(min_interval, max_interval));
                    }
                }
                return;
            }
        }
        if (message === 'sell') {
            if ('idx' in data && data.idx !== undefined) {
                const worker = this.workers.find((w) => w.index === data.idx);
                if (worker) {
                    common.log(`[Main Worker] Sending the sell command to worker ${worker.index} `);
                    worker.worker.postMessage({ command: `sell${worker.index}`, data });
                    return;
                }
            } else {
                this.workers.forEach((worker) => {
                    common.log(`[Main Worker] Sending the sell command to worker ${worker.index} `);
                    worker.worker.postMessage({ command: 'sell', data });
                });
                return;
            }
        }
        this.workers.forEach(({ worker }) => worker.postMessage({ command: message, data }));
    }

    private async workers_start(wallets: common.Wallet[]): Promise<void> {
        if (!this.bot_config) throw new Error('Bot configuration is not set.');
        wallets = wallets.filter((wallet) => !wallet.is_reserve).slice(0, this.bot_config.thread_cnt);

        if (wallets.length < this.bot_config.thread_cnt)
            throw new Error(`The number of keys doesn't match the number of threads`);

        const all_has_balances = await this.check_balances(wallets);
        if (!all_has_balances) throw new Error('Fund the specified accounts, exiting...');

        common.log('[Main Worker] Starting the workers...');
        const started_promises: Promise<void>[] = [];

        for (const wallet of wallets) {
            const worker_data: WorkerConfig = {
                program: this.trader.get_name() as common.Program,
                secret: wallet.keypair.secretKey,
                id: wallet.id,
                trade_interval: this.bot_config.trade_interval,
                spend_limit: this.bot_config.spend_limit,
                min_buy: this.bot_config.min_buy,
                max_buy: this.bot_config.max_buy,
                mcap_threshold: this.bot_config.mcap_threshold,
                is_buy_once: this.bot_config.is_buy_once,
                sell_slippage: this.bot_config.sell_slippage,
                buy_slippage: this.bot_config.buy_slippage,
                priority_level: this.bot_config.priority_level,
                protection_tip: this.bot_config.protection_tip,
                helius_rate_limit_state: this.helius_rate_limit_state
            };

            const worker = new Worker(this.get_worker_path(), {
                workerData: worker_data
            });

            let started: () => void;
            const started_promise = new Promise<void>((resolve) => (started = resolve));

            const job = new Promise<void>((resolve, reject) => {
                worker.on('message', async (msg) => {
                    if (msg.command === 'started') {
                        started();
                        common.log(msg.data);
                        return;
                    }
                    common.log(msg);
                });
                worker.on('error', (err) => {
                    common.error(common.red(`[Worker ${wallet.id}] Encountered error: ${err}`));
                    reject();
                });
                worker.on('exit', (code) => {
                    if (code !== 0) reject(new Error(`[Worker ${wallet.id}] Stopped with exit code ${code} `));
                    else resolve();
                });
            });

            started_promises.push(started_promise);
            this.workers.push({ worker: worker, index: wallet.id, job: job });
        }

        await Promise.all(started_promises);
        common.log('[Main Worker] All workers have started');
    }

    private setup_cmd_interface() {
        if (!this.bot_config) throw new Error('Bot configuration is not set.');
        if (!global.RL) common.setup_readline();
        global.RL.setPrompt('Command (stop/config/sell/set)> ');
        global.RL.prompt(true);

        let stopping = false;

        global.RL.on('line', (line) => {
            moveCursor(process.stdout, 0, -1);
            clearLine(process.stdout, 0);

            const [command, ...rest] = line.trim().split(' ');
            switch (command) {
                case 'stop': {
                    if (!stopping) {
                        common.log('[Main Worker] Stopping the bot...');
                        this.workers_post_message('stop');
                        stopping = true;
                    } else {
                        common.log('[Main Worker] Stopping is already in progress...');
                    }
                    break;
                }
                case 'buy': {
                    const [amountRaw, idxRaw] = rest;
                    const amount = amountRaw ? parseFloat(amountRaw) : undefined;
                    const idx = idxRaw ? parseInt(idxRaw, 10) : undefined;

                    if (amount !== undefined && (isNaN(amount) || amount <= 0.0)) {
                        common.log('Invalid amount. Usage: buy <amount> <worker_id>');
                        break;
                    }
                    if (idx !== undefined && (isNaN(idx) || !this.workers.some((w) => w.index === idx))) {
                        common.log('Invalid worker ID. Usage: buy <amount> <worker_id>');
                        break;
                    }

                    if (!stopping) this.workers_post_message('buy', { idx, amount });
                    else common.log('[Main Worker] Cannot send buy command, stopping is in progress...');
                    break;
                }
                case 'config': {
                    this.log_bot_config(this.bot_config!);
                    break;
                }
                case 'sell': {
                    const [percentRaw, idxRaw] = rest;
                    const percent = percentRaw ? parseFloat(percentRaw) : undefined;
                    const idx = idxRaw ? parseInt(idxRaw, 10) : undefined;

                    if (percent !== undefined && (isNaN(percent) || percent <= 0.0 || percent > 1.0)) {
                        common.log('Invalid percentage. Usage: sell <percent> <worker_id>');
                        break;
                    }
                    if (idx !== undefined && (isNaN(idx) || !this.workers.some((w) => w.index === idx))) {
                        common.log('Invalid worker ID. Usage: sell <percent> <worker_id>');
                        break;
                    }

                    if (!stopping) this.workers_post_message('sell', { percent, idx });
                    else common.log('[Main Worker] Cannot send sell command, stopping is in progress...');
                    break;
                }
                case 'set': {
                    if (rest.length < 2) {
                        common.log('Invalid command. Usage: set <key> <value>');
                        break;
                    }

                    const [key, value] = rest;
                    const [ok, err] = update_config(this.bot_config!, key, value);
                    if (ok) {
                        common.log(`[Main Worker] Configuration updated: ${key} = ${value}`);
                        this.workers_post_message('config', { key, value });
                    } else {
                        common.log(common.red(err || 'Failed to update configuration'));
                    }
                    break;
                }
                default: {
                    common.log(`Unknown command: ${line.trim()} `);
                    break;
                }
            }
            global.RL.prompt(true);
        })
            .on('mcap', (mcap: number) => {
                const threshold_reached = this.bot_config!.mcap_threshold < mcap ? ' (Target reached)' : '';
                const mcap_message = common.bold(`MCAP: $${common.format_currency(mcap)}${threshold_reached}`);
                global.RL.setPrompt(`${mcap_message} | Command (stop/config/sell/set)> `);
                global.RL.prompt(true);
            })
            .on('close', () => {
                if (!stopping) {
                    common.log('[Main Worker] Stopping the bot...');
                    this.workers_post_message('stop');
                    common.close_readline();
                }
            });
    }

    private async validate_json_config(json: any, keys_cnt: number): Promise<BotConfig> {
        const required_fields = ['thread_cnt', 'min_buy'];
        for (const field of required_fields) {
            if (!(field in json)) throw new Error(`Missing required field: ${field}`);
        }
        const {
            token_name,
            token_ticker,
            mint,
            thread_cnt,
            trade_interval,
            spend_limit,
            min_buy,
            max_buy,
            mcap_threshold,
            start_interval,
            is_buy_once,
            sell_slippage,
            buy_slippage,
            priority_level,
            protection_tip
        } = json;
        if (mint === undefined && token_name === undefined && token_ticker === undefined) {
            throw new Error('Missing mint or token name and token ticker.');
        }
        if (mint !== undefined) {
            if (token_name !== undefined || token_ticker !== undefined)
                throw new Error('Mint and token name/token ticker are mutually exclusive. Choose one.');
            if (!common.is_valid_pubkey(mint) || (await this.trader.get_mint_meta(new PublicKey(mint))) === undefined) {
                throw new Error('Invalid mint public key.');
            }
            json.mint = new PublicKey(json.mint);
        }
        if (
            (token_name === undefined && token_ticker !== undefined) ||
            (token_name !== undefined && token_ticker === undefined)
        ) {
            throw new Error('Both token name and token ticker are required.');
        }
        if (typeof min_buy !== 'number' || min_buy <= SNIPE_MIN_BUY) {
            throw new Error(`min_buy must be a number greater than ${SNIPE_MIN_BUY}.`);
        }
        if (max_buy !== undefined) {
            if (typeof max_buy !== 'number' || max_buy < min_buy) {
                throw new Error('max_buy must be a number greater than or equal to min_buy.');
            }
        }
        if (spend_limit !== undefined && (typeof spend_limit !== 'number' || spend_limit < min_buy)) {
            throw new Error(`spend_limit must be a number greater than or equal to min_buy.`);
        }
        if (typeof thread_cnt !== 'number' || thread_cnt > keys_cnt) {
            throw new Error('thread_cnt must be a number and less than or equal to keys_cnt.');
        }
        if (mcap_threshold && (typeof mcap_threshold !== 'number' || mcap_threshold < SNIPE_MIN_MCAP)) {
            throw new Error(`mcap_threshold must be a number greater than or equal to ${SNIPE_MIN_MCAP}.`);
        }
        if (start_interval && (typeof start_interval !== 'number' || start_interval < 0)) {
            throw new Error('start_interval must be a number greater than or equal to 0.');
        }
        if (is_buy_once && typeof is_buy_once !== 'boolean') {
            throw new Error('is_buy_once must be a boolean');
        }
        if (trade_interval && (typeof trade_interval !== 'number' || trade_interval <= 0)) {
            throw new Error('trade_interval must be a number greater than 0.');
        }
        if (!is_buy_once && trade_interval === undefined) {
            throw new Error('trade_interval is required when is_buy_once is false.');
        }
        if (is_buy_once && trade_interval !== undefined) {
            throw new Error('trade_interval is not required when is_buy_once is true.');
        }
        if (sell_slippage !== undefined) {
            if (typeof sell_slippage !== 'number' || sell_slippage < 0.0 || sell_slippage > TRADE_MAX_SLIPPAGE) {
                throw new Error(`sell_slippage must be a number between 0.0 and ${TRADE_MAX_SLIPPAGE}.`);
            }
            json.sell_slippage = sell_slippage;
        }
        if (buy_slippage !== undefined) {
            if (typeof buy_slippage !== 'number' || buy_slippage < 0.0 || buy_slippage > TRADE_MAX_SLIPPAGE) {
                throw new Error(`buy_slippage must be a number between 0.0 and ${TRADE_MAX_SLIPPAGE}.`);
            }
            json.buy_slippage = buy_slippage;
        }
        if (priority_level !== undefined) {
            if (
                typeof priority_level !== 'string' ||
                !Object.values(PriorityLevel).includes(priority_level as PriorityLevel)
            ) {
                throw new Error(`priority_level must be a valid string, values: ${Object.values(PriorityLevel)}`);
            }
            json.priority_level = priority_level as PriorityLevel;
        }
        if (protection_tip !== undefined) {
            if (typeof protection_tip !== 'number' || protection_tip < 0.0) {
                throw new Error('protection_tip must be a number greater than 0.0.');
            }
            json.protection_tip = protection_tip;
        }
        if (!('is_buy_once' in json)) json.is_buy_once = false;
        if (!('trade_interval' in json)) json.trade_interval = 0;
        if (!('start_interval' in json)) json.start_interval = 0;
        if (!('mcap_threshold' in json)) json.mcap_threshold = Infinity;
        if (!('max_buy' in json)) json.max_buy = min_buy;
        if (!('spend_limit' in json)) json.spend_limit = Infinity;
        if (!('sell_slippage' in json)) json.sell_slippage = SNIPE_SELL_SLIPPAGE;
        if (!('buy_slippage' in json)) json.buy_slippage = SNIPE_BUY_SLIPPAGE;
        if (!('protection_tip' in json)) json.protection_tip = undefined;
        if (!('priority_level' in json)) json.priority_level = PriorityLevel.DEFAULT;

        return json as BotConfig;
    }

    private async get_config(keys_cnt: number): Promise<BotConfig> {
        let answers: BotConfig;
        do {
            let min_buy_val: number;
            answers = await inquirer.prompt<BotConfig>([
                {
                    type: 'input',
                    name: 'thread_cnt',
                    message: `Enter the number of bots to run (${keys_cnt} accounts available):`,
                    validate: (value: string) =>
                        common.validate_int(value, 1, keys_cnt)
                            ? true
                            : `Please enter a valid number greater than 0 and less or equal to ${keys_cnt}.`,
                    filter: (value: string) => (common.validate_int(value, 1, keys_cnt) ? parseInt(value, 10) : value)
                },
                {
                    type: 'input',
                    name: 'start_interval',
                    message: 'Enter the start interval in seconds:',
                    validate: (value: string) => {
                        if (value === '') return true;
                        if (!common.validate_float(value, 0.0))
                            return 'Please enter a valid number greater than or equal to 0.';
                        return true;
                    },
                    filter: (value: string) => (value === '' ? 0 : parseFloat(value))
                },
                {
                    type: 'input',
                    name: 'min_buy',
                    message: 'Enter the minimum SOL amount per buy:',
                    validate: (value: string) => {
                        if (!common.validate_float(value, SNIPE_MIN_BUY))
                            return `Please enter a valid number greater than or equal to ${SNIPE_MIN_BUY}.`;
                        min_buy_val = parseFloat(value);
                        return true;
                    },
                    filter: () => min_buy_val
                },
                {
                    type: 'input',
                    name: 'max_buy',
                    message: 'Enter the maximum SOL amount per buy (leave blank to use min_buy):',
                    default: '',
                    validate: (value: string) => {
                        if (value === '') return true;
                        if (!common.validate_float(value, min_buy_val))
                            return `Please enter a valid number greater than or equal to min_buy (${min_buy_val}).`;
                        return true;
                    },
                    filter: (value: string) => (value === '' ? undefined : parseFloat(value))
                },
                {
                    type: 'input',
                    name: 'spend_limit',
                    message: 'Enter the total SOL spend limit per bot (leave blank for Infinity):',
                    default: '',
                    validate: (value: string) => {
                        if (value === '') return true;
                        if (!common.validate_float(value, min_buy_val))
                            return `Please enter a valid number greater than or equal to min_buy (${min_buy_val}).`;
                        return true;
                    },
                    filter: (value: string) => (value === '' ? Infinity : parseFloat(value))
                },
                {
                    type: 'input',
                    name: 'mcap_threshold',
                    message: 'Enter the threshold market cap (leave blank for Infinity):',
                    default: '',
                    validate: (value: string) =>
                        value === '' || common.validate_int(value, SNIPE_MIN_MCAP)
                            ? true
                            : `Please enter a valid number greater than or equal to ${SNIPE_MIN_MCAP}.`,
                    filter: (value: string) => (value === '' ? Infinity : parseInt(value, 10))
                },
                {
                    type: 'input',
                    name: 'sell_slippage',
                    message: 'Enter the sell slippage in percentage:',
                    default: (SNIPE_SELL_SLIPPAGE * 100).toString(),
                    validate: (value: string) =>
                        value === '' || common.validate_float(value, 0.0, TRADE_MAX_SLIPPAGE)
                            ? true
                            : `Please enter a valid number between 0.0 and ${TRADE_MAX_SLIPPAGE}`,
                    filter: (value: string) => (value === '' ? SNIPE_SELL_SLIPPAGE : parseFloat(value) / 100)
                },
                {
                    type: 'input',
                    name: 'buy_slippage',
                    message: 'Enter the buy slippage in percentage:',
                    default: (SNIPE_BUY_SLIPPAGE * 100).toString(),
                    validate: (value: string) =>
                        value === '' || common.validate_float(value, 0.0, TRADE_MAX_SLIPPAGE)
                            ? true
                            : `Please enter a valid number between 0.0 and ${TRADE_MAX_SLIPPAGE}`,
                    filter: (value: string) => (value === '' ? SNIPE_BUY_SLIPPAGE : parseFloat(value) / 100)
                },
                {
                    type: 'list',
                    name: 'priority_level',
                    message: 'Choose the priority level for the bot:',
                    choices: Object.values(PriorityLevel).map((level) => level.toString())
                },
                {
                    type: 'input',
                    name: 'protection_tip',
                    message: 'Enter the protection tip in percentage (leave blank for no protection):',
                    default: '',
                    validate: (value: string) =>
                        value === '' || common.validate_float(value, 0.0)
                            ? true
                            : 'Please enter a valid number greater than 0.0',
                    filter: (value: string) => (value === '' ? undefined : parseFloat(value))
                },
                {
                    type: 'confirm',
                    name: 'is_buy_once',
                    message: 'Do you want to buy only once?',
                    default: false
                }
            ]);

            if (!answers.is_buy_once) {
                const trade_interval = await inquirer.prompt([
                    {
                        type: 'input',
                        name: 'trade_interval',
                        message: 'Enter the interval between each buy in seconds:',
                        validate: (value: string) => {
                            if (value === '') return true;
                            if (!common.validate_float(value, 0.0))
                                return 'Please enter a valid number greater than or equal to 0.';
                            return true;
                        },
                        filter: (value: string) => (value === '' ? 0 : parseFloat(value))
                    }
                ]);
                answers = { ...answers, ...trade_interval };
            }

            const MethodStrings = ['Wait', 'Snipe'];
            const method = await inquirer.prompt([
                {
                    type: 'list',
                    name: 'type',
                    message: 'Choose the type of the sniping:',
                    choices: ['Wait for the token to drop', 'Snipe an existing token'],
                    default: 0,
                    filter: (input: string) =>
                        input.toLowerCase().includes(MethodStrings[Method.Wait].toLocaleLowerCase())
                            ? Method.Wait
                            : Method.Snipe
                }
            ]);

            if (method.type === Method.Wait) {
                const token_meta = await inquirer.prompt([
                    {
                        type: 'input',
                        name: 'token_name',
                        message: 'Enter the token name:'
                    },
                    {
                        type: 'input',
                        name: 'token_ticker',
                        message: 'Enter the token ticker:'
                    }
                ]);
                answers = { ...answers, ...token_meta };
            } else {
                const mint = await inquirer.prompt([
                    {
                        type: 'input',
                        name: 'mint',
                        message: 'Enter the mint public key:',
                        validate: async (value: string) => {
                            if (!common.is_valid_pubkey(value)) return 'Please enter a valid public key.';
                            if ((await this.trader.get_mint_meta(new PublicKey(value))) === undefined)
                                return 'Mint not found. Please enter a valid mint public key.';
                            return true;
                        },
                        filter: (value: string) => new PublicKey(value)
                    }
                ]);
                answers = { ...answers, ...mint };
            }

            await common.clear_lines_up(Object.keys(answers).length + 1);
            this.log_bot_config(answers);
            const prompt = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'proceed',
                    message: 'Do you want to start the bot with the above configuration?'
                }
            ]);

            if (prompt.proceed) break;
            else await common.clear_lines_up(Object.keys(answers).length + 7);
        } while (true);

        return answers;
    }

    private log_bot_config(bot_config: BotConfig) {
        const to_print = {
            ...bot_config,
            mcap_threshold:
                bot_config.mcap_threshold === Infinity
                    ? 'N/A'
                    : `$${common.format_currency(bot_config.mcap_threshold)}`,
            start_interval: bot_config.start_interval !== 0 ? `${bot_config.start_interval} secs` : 'N/A',
            trade_interval: bot_config.trade_interval !== 0 ? `${bot_config.trade_interval} secs` : 'N/A',
            mint: bot_config.mint ? bot_config.mint.toString() : 'N/A',
            token_name: bot_config.token_name ? bot_config.token_name : 'N/A',
            token_ticker: bot_config.token_ticker ? bot_config.token_ticker : 'N/A',
            is_buy_once: bot_config.is_buy_once ? 'Yes' : 'No',
            priority_level: bot_config.priority_level.toString(),
            protection_tip: bot_config.protection_tip ? `${bot_config.protection_tip} SOL` : 'N/A',
            spend_limit: bot_config.spend_limit === Infinity ? 'N/A' : `${bot_config.spend_limit} SOL`,
            min_buy: bot_config.min_buy ? `${bot_config.min_buy} SOL` : 'N/A',
            max_buy: bot_config.max_buy ? `${bot_config.max_buy} SOL` : 'N/A',
            buy_slippage: bot_config.buy_slippage ? `${bot_config.buy_slippage * 100}%` : 'N/A',
            sell_slippage: bot_config.sell_slippage ? `${bot_config.sell_slippage * 100}%` : 'N/A'
        };

        const max_length = Math.max(...Object.values(to_print).map((value) => value.toString().length));

        common.print_header([
            { title: 'Parameter', width: common.COLUMN_WIDTHS.parameter, align: 'center' },
            { title: 'Value', width: max_length, align: 'center' }
        ]);

        for (const [key, value] of Object.entries(to_print)) {
            common.print_row([
                { content: key, width: common.COLUMN_WIDTHS.parameter, align: 'center' },
                { content: value.toString(), width: max_length, align: 'left' }
            ]);
        }

        common.print_footer([{ width: common.COLUMN_WIDTHS.parameter }, { width: max_length }]);
    }
}
