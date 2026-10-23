import { Worker } from 'worker_threads';
import inquirer from 'inquirer';
import { clearLine, moveCursor } from 'readline';
import { ParsedTransactionWithMeta, PublicKey, TokenAmount } from '@solana/web3.js';
import {
    COMMITMENT,
    PRIORITY_FEE_TTL_MS,
    PriorityLevel,
    SNIPE_BUY_SLIPPAGE,
    SNIPE_META_POLL_INTERVAL_MS,
    SNIPE_MIN_BUY,
    SNIPE_MIN_MCAP,
    SNIPE_SELL_SLIPPAGE,
    SNIPE_SUB_COMMITMENT,
    SOL_MINT,
    TransactionRelay,
    TRADE_MAX_SLIPPAGE
} from '../constants';
import * as common from './common';
import {
    IProgramProvider,
    IMintMeta,
    get_balance,
    get_quote_info,
    get_token_balance,
    get_priority_fee_estimate,
    lamports_to_sol,
    get_sol_token_amount,
    retry_get_tx
} from './trade_common';
import { quote_price } from './trade_common';
import { quote_jupiter } from '../jupiter/swap_jupiter';
import bs58 from 'bs58';
import { configure_rpc_rate_limiter, create_rpc_rate_limit_state } from './rate_limit';
import {
    deserialize_transaction_notification,
    LogsSubscriber,
    Subscriber,
    SubscriberType,
    TransactionSubscribeMessage,
    TxSubscriber
} from './subscriber';

type BotConfig = {
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
    mev_protect: boolean;
    funding: boolean;
    token_name: string | undefined;
    token_ticker: string | undefined;
    mint: PublicKey | undefined;
    quote_mint?: string;
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
    protection_tip?: number;
    mev_protect: boolean;
    priority_level: PriorityLevel;
    transaction_relay: TransactionRelay;
    transaction_version: 0 | 1;
    funding: boolean;
    quote_mint?: string;
    quote_valuation?: { sol_amount: number; token_amount: TokenAmount };
    rpc_rate_limit_state: SharedArrayBuffer;
};

type StartupBalances = {
    spend_limits: Map<number, number>;
    quote_valuation?: WorkerConfig['quote_valuation'];
};

type WorkerJob = {
    worker: Worker;
    index: number;
    job: Promise<void>;
};

type WorkerMessage = 'stop' | 'buy' | 'mint' | 'sell' | 'config' | 'priority_fee' | 'market_cap';

type MintDetection = {
    mint: PublicKey;
    misc?: object;
    mint_meta?: IMintMeta;
};

type WaitCreateOptions =
    | {
          by_name: {
              name: string;
              ticker: string;
          };
          by_mint?: never;
      }
    | {
          by_name?: never;
          by_mint: {
              mint: PublicKey;
          };
      };

export interface ISniper {
    snipe(wallets: common.Wallet[], sol_price: number): Promise<void>;
    setup_config(keys_cnt: number, json_config?: object): Promise<void>;
}

enum Method {
    Wait = 0,
    Snipe = 1
}

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

export abstract class SniperBase implements ISniper {
    protected bot_config: BotConfig | null;
    protected provider: IProgramProvider;
    protected workers: WorkerJob[];
    private rpc_rate_limit_state: SharedArrayBuffer;

    protected mint_authority!: PublicKey;
    protected program_id!: PublicKey;
    protected mint_account_index!: number;

    private subscriber: Subscriber | null = null;
    private subscribe_type: SubscriberType;
    private wait_stop_func: (() => void) | null = null;

    constructor(provider: IProgramProvider, subscribe_type: SubscriberType = SubscriberType.Tx) {
        this.workers = new Array<WorkerJob>();
        this.provider = provider;
        this.bot_config = null;
        this.rpc_rate_limit_state = create_rpc_rate_limit_state();
        this.subscribe_type = subscribe_type;
    }

    private create_subscriber(): Subscriber {
        switch (this.subscribe_type) {
            case SubscriberType.Logs:
                return new LogsSubscriber(this.mint_authority, SNIPE_SUB_COMMITMENT);
            case SubscriberType.Tx:
                return new TxSubscriber(this.mint_authority, SNIPE_SUB_COMMITMENT);
            default:
                throw new Error(`Unsupported subscriber type: ${this.subscribe_type}`);
        }
    }

    protected abstract decode_create_instr(
        data: Uint8Array,
        accounts: PublicKey[]
    ): { name: string; symbol: string; misc?: object } | null;
    protected abstract is_create_tx(logs: string[]): boolean;

    private get_worker_path(): URL {
        return new URL('./snipe_worker.ts', import.meta.url);
    }

    private async wait_create_unsubscribe(): Promise<void> {
        if (this.wait_stop_func) this.wait_stop_func();
        if (this.subscriber) await this.subscriber.unsubscribe();
    }

    private find_create_transaction(
        tx: ParsedTransactionWithMeta,
        options: WaitCreateOptions
    ): { mint: PublicKey; misc?: object } | null {
        for (const instr of tx.transaction.message.instructions) {
            if (!('accounts' in instr) || !instr.programId.equals(this.program_id)) continue;
            const result = this.decode_create_instr(bs58.decode(instr.data), instr.accounts);
            if (!result) continue;
            const mint = instr.accounts[this.mint_account_index];
            if (!mint) continue;

            if (options.by_name) {
                if (
                    result.name.toLowerCase() === options.by_name.name.toLowerCase() &&
                    result.symbol.toLowerCase() === options.by_name.ticker.toLowerCase()
                )
                    return { mint, misc: { ...result.misc, name: result.name, symbol: result.symbol } };
            } else {
                if (options.by_mint.mint.equals(mint))
                    return { mint, misc: { ...result.misc, name: result.name, symbol: result.symbol } };
            }
        }
        return null;
    }

    public async wait_create_subscribe(options: WaitCreateOptions): Promise<MintDetection> {
        const subscriber = (this.subscriber ??= this.create_subscriber());
        const { promise, resolve, reject } = Promise.withResolvers<MintDetection>();
        let completed = false;
        const finish = (result: MintDetection) => {
            if (completed) return;
            completed = true;
            resolve(result);
        };
        const fail = (error: unknown) => {
            if (completed) return;
            completed = true;
            reject(error);
        };
        this.wait_stop_func = () => fail(new Error('User stopped the subscription.'));
        common.log(`Waiting for the new token create for the '${this.provider.get_name()}' program...`);

        const subscribe = async () => {
            switch (subscriber.type) {
                case SubscriberType.Logs: {
                    const on_logs = async (logs: string[], signature?: string) => {
                        if (completed || !signature || !this.is_create_tx(logs)) return;
                        try {
                            const tx = await retry_get_tx(signature);
                            if (!tx || !tx.meta || tx.meta.err || !tx.transaction.message) return;
                            const result = this.find_create_transaction(tx, options);
                            if (result) finish(result);
                        } catch (err) {
                            common.error(common.red(`Failed fetching the parsed transaction: ${err}`));
                        }
                    };
                    await subscriber.subscribe(on_logs);
                    break;
                }
                case SubscriberType.Tx: {
                    const on_logs = (message: TransactionSubscribeMessage) => {
                        if (completed) return;
                        try {
                            const tx = deserialize_transaction_notification(message);
                            if (!tx || tx.meta?.err || !tx.meta?.logMessages || !this.is_create_tx(tx.meta.logMessages))
                                return;
                            const result = this.find_create_transaction(tx, options);
                            if (result) finish(result);
                        } catch (error) {
                            fail(error);
                        }
                    };
                    await subscriber.subscribe(on_logs);
                    break;
                }
                default:
                    throw new Error(`Unsupported subscriber type: ${subscriber.type}`);
            }

            if (options.by_mint && !completed) {
                const mint_meta = await this.provider.get_mint_meta(options.by_mint.mint);
                if (mint_meta) finish({ mint: options.by_mint.mint, mint_meta });
            }
        };

        try {
            await Promise.race([subscribe(), promise]);
            return await promise;
        } finally {
            completed = true;
            this.wait_stop_func = null;
            await this.wait_create_unsubscribe();
        }
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
        configure_rpc_rate_limiter(this.rpc_rate_limit_state);

        if (this.bot_config.mint) {
            common.log(common.yellow('Sniping by mint...'));
        } else if (this.bot_config.token_name && this.bot_config.token_ticker) {
            common.log(common.yellow('Sniping token by name and ticker...'));
        }

        this.setup_cmd_interface();

        common.log('Checking selected wallet balances...');
        try {
            await this.workers_start(wallets);
        } catch (error) {
            common.close_readline();
            throw new Error(`Unable to start sniping: ${error instanceof Error ? error.message : String(error)}`);
        }
        common.log('[Main Worker] Bot started successfully, waiting for the token...');

        const use_cached_priority_fee =
            Boolean(this.bot_config.protection_tip) && global.TRANSACTION_RELAY === TransactionRelay.Sender;
        let priority_fee: number | undefined = use_cached_priority_fee ? 0 : undefined;
        let priority_refreshing = false;
        let priority_refresh_timer: NodeJS.Timeout | undefined;
        let market_cap_timer: NodeJS.Timeout | undefined;
        let unsubscribe: (() => void) | null = null;
        let poll_stopped = false;
        const refresh_priority_fee = async () => {
            if (priority_refreshing) return;
            priority_refreshing = true;
            try {
                priority_fee = await get_priority_fee_estimate(this.bot_config!.priority_level, [this.program_id]);
                await this.workers_post_message('priority_fee', priority_fee);
            } catch {
                priority_fee ??= 0;
                await this.workers_post_message('priority_fee', priority_fee);
            } finally {
                priority_refreshing = false;
            }
        };
        if (use_cached_priority_fee) {
            await this.workers_post_message('priority_fee', priority_fee);
            void refresh_priority_fee();
            priority_refresh_timer = setInterval(() => void refresh_priority_fee(), PRIORITY_FEE_TTL_MS);
        }

        try {
            const result = await this.get_wait_mint(this.bot_config);
            this.bot_config.mint = result.mint;
            common.log(`[Main Worker] Token detected: ${this.bot_config.mint.toString()}`);

            let mint_meta =
                result.mint_meta ?? (await this.provider.default_mint_meta(this.bot_config.mint, result.misc));
            if (
                this.bot_config.quote_mint &&
                !mint_meta.quote_mint_pubkey.equals(new PublicKey(this.bot_config.quote_mint))
            )
                throw new Error(
                    `Detected quote mint does not match configured quote_mint ${this.bot_config.quote_mint}`
                );

            void this.workers_post_message('buy', {
                mint_meta: mint_meta.serialize(),
                priority_fee
            });

            let migrated: boolean = false;
            let last_subscription_update = 0;

            const publish_market_cap = async () => {
                if (poll_stopped) return;
                try {
                    const { quote_mint_pubkey, token_quote_mc } = mint_meta;
                    const price = quote_mint_pubkey.equals(SOL_MINT)
                        ? sol_price
                        : await quote_price(quote_mint_pubkey).catch(() => 0);
                    if (poll_stopped) return;
                    const usd_market_cap = Number.isFinite(price) && price > 0 ? token_quote_mc * price : 0;
                    if (global.RL) global.RL.emit('mcap', usd_market_cap);
                    await this.workers_post_message('market_cap', usd_market_cap);
                } catch (error) {
                    common.warn(`Failed to publish market cap: ${error}`);
                }
                if (!poll_stopped) market_cap_timer = setTimeout(publish_market_cap, SNIPE_META_POLL_INTERVAL_MS);
            };

            const publish_mint = (next_meta: typeof mint_meta) => {
                mint_meta = next_meta;
                if (mint_meta.migrated && !migrated) {
                    migrated = true;
                    common.log('[Main Worker] Token migrated to liquidity pool...');
                }
                void this.workers_post_message('mint', mint_meta.serialize());
            };
            const publish_update = (next_meta: typeof mint_meta) => {
                last_subscription_update = performance.now();
                publish_mint(next_meta);
            };

            const poll = async () => {
                if (poll_stopped) return;
                try {
                    const poll_started = performance.now();
                    const next_meta = await this.provider.update_mint_meta(mint_meta);
                    if (!poll_stopped && last_subscription_update <= poll_started) {
                        publish_mint(next_meta);
                    }
                } catch (err) {
                    common.error(common.red(`Failed to update token metadata`));
                }
                if (!poll_stopped) setTimeout(poll, SNIPE_META_POLL_INTERVAL_MS);
            };

            setTimeout(poll, SNIPE_META_POLL_INTERVAL_MS);
            unsubscribe = await this.provider.subscribe_mint_meta(mint_meta, publish_update, SNIPE_SUB_COMMITMENT);
            market_cap_timer = setTimeout(publish_market_cap, 0);

            await this.workers_wait();
        } catch (error) {
            throw new Error(`Failed to snipe the token: ${error}`);
        } finally {
            poll_stopped = true;
            unsubscribe?.();
            if (market_cap_timer) clearTimeout(market_cap_timer);
            if (priority_refresh_timer) clearInterval(priority_refresh_timer);
            await Promise.all(this.workers.map(({ worker }) => worker.terminate()));
            common.close_readline();
        }
    }

    private async get_wait_mint(config: BotConfig): Promise<MintDetection> {
        if (config.token_name && config.token_ticker) {
            return this.wait_create_subscribe({
                by_name: { name: config.token_name, ticker: config.token_ticker }
            });
        }
        if (!config.mint) throw new Error('No token information provided in the config');
        const mint_meta = await this.provider.get_mint_meta(config.mint);
        if (mint_meta) return { mint: config.mint, mint_meta };
        return this.wait_create_subscribe({ by_mint: { mint: config.mint } });
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

    private async check_balances(
        wallets: common.Wallet[],
        min_balance: number = SNIPE_MIN_BUY
    ): Promise<StartupBalances | null> {
        const config = this.bot_config!;
        const quote_mint = config.quote_mint ? new PublicKey(config.quote_mint) : undefined;
        const quote = quote_mint && !quote_mint.equals(SOL_MINT) ? await get_quote_info(quote_mint) : undefined;
        const amount = config.max_buy ?? config.min_buy;
        const valuation = quote
            ? await quote_jupiter(get_sol_token_amount(amount), SOL_MINT, quote_mint!, config.buy_slippage)
            : undefined;
        if (valuation && BigInt(valuation.outAmount) <= 0n)
            throw new Error('Cannot value quote balance: zero quoted output');
        const quote_valuation =
            quote && valuation
                ? {
                      sol_amount: amount,
                      token_amount: { amount: valuation.outAmount, decimals: quote.decimals, uiAmount: null }
                  }
                : undefined;
        const spend_limits = new Map<number, number>();
        const balance_checks = wallets.map(async (wallet) => {
            const holder = wallet.keypair;
            const issues: string[] = [];
            try {
                const sol_balance = lamports_to_sol(await get_balance(holder.publicKey, COMMITMENT));
                let spendable_balance = sol_balance - SNIPE_MIN_BUY;
                if (quote && valuation) {
                    const balance = await get_token_balance(
                        holder.publicKey,
                        quote_mint!,
                        COMMITMENT,
                        quote.token_program
                    );
                    const quote_balance = (Number(balance.amount) / Number(valuation.outAmount)) * amount;
                    spendable_balance = quote_balance + (config.funding ? spendable_balance : 0);
                }
                if (spendable_balance <= config.min_buy) {
                    issues.push(`Spendable: ${spendable_balance.toFixed(9)} SOL; required: > ${config.min_buy} SOL`);
                }
                spend_limits.set(wallet.id, Math.min(spendable_balance, config.spend_limit));
                if (sol_balance < min_balance) {
                    issues.push(
                        `SOL balance: ${sol_balance.toFixed(9)} SOL; required: >= ${min_balance} SOL for fees and rent`
                    );
                }
            } catch (err) {
                issues.push(`Could not read balances: ${err instanceof Error ? err.message : String(err)}`);
            }
            return issues.length
                ? `  ${wallet.name} (${wallet.id})  ${holder.publicKey.toBase58()}\n${issues.map((issue) => `    ${issue}`).join('\n')}`
                : null;
        });
        const failures = (await Promise.all(balance_checks)).filter((result) => result !== null);
        if (failures.length) {
            common.error(
                common.red(
                    `Wallet preflight failed (${failures.length}/${wallets.length})\n\n${failures.join('\n\n')}\n`
                )
            );
            return null;
        }
        return { spend_limits, quote_valuation };
    }

    private async workers_post_message(message: WorkerMessage, data: any = {}): Promise<void> {
        if (!this.bot_config) throw new Error('Bot configuration is not set.');

        if (message === 'stop') await this.wait_create_unsubscribe();
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
                    worker.worker.postMessage({ command: `sell${worker.index}`, data });
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

        const balances = await this.check_balances(wallets);
        if (!balances) throw new Error('Resolve the reported wallet balances or errors, then retry.');

        common.log('[Main Worker] Starting the workers...');
        const started_promises: Promise<void>[] = [];

        for (const wallet of wallets) {
            const worker_data: WorkerConfig = {
                program: this.provider.get_name() as common.Program,
                secret: wallet.keypair.secretKey,
                id: wallet.id,
                trade_interval: this.bot_config.trade_interval,
                spend_limit: balances.spend_limits.get(wallet.id)!,
                min_buy: this.bot_config.min_buy,
                max_buy: this.bot_config.max_buy,
                mcap_threshold: this.bot_config.mcap_threshold,
                is_buy_once: this.bot_config.is_buy_once,
                sell_slippage: this.bot_config.sell_slippage,
                buy_slippage: this.bot_config.buy_slippage,
                priority_level: this.bot_config.priority_level,
                protection_tip: this.bot_config.protection_tip,
                mev_protect: this.bot_config.mev_protect,
                funding: this.bot_config.funding,
                quote_mint: this.bot_config.quote_mint,
                quote_valuation: balances.quote_valuation,
                transaction_relay: global.TRANSACTION_RELAY,
                transaction_version: global.TRANSACTION_VERSION,
                rpc_rate_limit_state: this.rpc_rate_limit_state
            };

            const worker = new Worker(this.get_worker_path(), {
                workerData: worker_data
            });

            let started: () => void;
            let startup_failed: (reason: unknown) => void;
            let is_started = false;
            const started_promise = new Promise<void>((resolve, reject) => {
                started = resolve;
                startup_failed = reject;
            });

            const job = new Promise<void>((resolve, reject) => {
                worker.on('message', async (msg) => {
                    if (msg.command === 'started') {
                        is_started = true;
                        started();
                        common.log(msg.data);
                        return;
                    }
                    common.log(msg);
                });
                worker.on('error', (err) => {
                    common.error(common.red(`[Worker ${wallet.id}] Encountered error: ${err}`));
                    startup_failed(err);
                    reject(err);
                });
                worker.on('exit', (code) => {
                    if (!is_started)
                        startup_failed(new Error(`[Worker ${wallet.id}] Exited before startup with code ${code}`));
                    if (code !== 0) reject(new Error(`[Worker ${wallet.id}] Stopped with exit code ${code} `));
                    else resolve();
                });
            });
            void job.catch(() => {});

            started_promises.push(started_promise);
            this.workers.push({ worker: worker, index: wallet.id, job: job });
        }

        try {
            await Promise.all(started_promises);
        } catch (error) {
            await Promise.all(this.workers.map(({ worker }) => worker.terminate()));
            await Promise.allSettled(this.workers.map(({ job }) => job));
            throw error;
        }
        common.log('[Main Worker] All workers have started');
    }

    private setup_cmd_interface() {
        if (!this.bot_config) throw new Error('Bot configuration is not set.');
        if (!global.RL) common.setup_readline();
        const rl = global.RL!;
        rl.setPrompt('Command (stop/config/sell/set)> ');
        rl.prompt(true);

        let stopping = false;

        rl.on('line', (line) => {
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
            rl.prompt(true);
        })
            .on('mcap', (mcap: number) => {
                const threshold_reached = this.bot_config!.mcap_threshold < mcap ? ' (Target reached)' : '';
                const mcap_message = common.bold(`MCAP: $${common.format_currency(mcap)}${threshold_reached}`);
                rl.setPrompt(`${mcap_message} | Command (stop/config/sell/set)> `);
                rl.prompt(true);
            })
            .on('close', () => {
                if (!stopping) {
                    stopping = true;
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
            protection_tip,
            mev_protect,
            funding,
            quote_mint
        } = json;
        if (quote_mint !== undefined && (typeof quote_mint !== 'string' || !common.is_valid_pubkey(quote_mint)))
            throw new Error('Invalid quote_mint public key.');
        if (mint === undefined && token_name === undefined && token_ticker === undefined) {
            throw new Error('Missing mint or token name and token ticker.');
        }
        if (mint !== undefined) {
            if (token_name !== undefined || token_ticker !== undefined)
                throw new Error('Mint and token name/token ticker are mutually exclusive. Choose one.');
            if (!common.is_valid_pubkey(mint)) {
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
        if (!Number.isInteger(thread_cnt) || thread_cnt < 1 || thread_cnt > keys_cnt) {
            throw new Error('thread_cnt must be an integer between 1 and keys_cnt.');
        }
        if (mcap_threshold && (typeof mcap_threshold !== 'number' || mcap_threshold < SNIPE_MIN_MCAP)) {
            throw new Error(`mcap_threshold must be a number greater than or equal to ${SNIPE_MIN_MCAP}.`);
        }
        if (start_interval && (typeof start_interval !== 'number' || start_interval < 0)) {
            throw new Error('start_interval must be a number greater than or equal to 0.');
        }
        if (is_buy_once !== undefined && typeof is_buy_once !== 'boolean') {
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
        if (mev_protect !== undefined && typeof mev_protect !== 'boolean') {
            throw new Error('mev_protect must be a boolean');
        }
        if (mev_protect && (!protection_tip || protection_tip <= 0)) {
            throw new Error('mev_protect requires a protection tip to be greater than 0.');
        }
        if (funding !== undefined && typeof funding !== 'boolean') {
            throw new Error('funding must be a boolean');
        }

        if (!('is_buy_once' in json)) json.is_buy_once = false;
        if (!('mev_protect' in json)) json.mev_protect = false;
        if (!('funding' in json)) json.funding = false;
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
                    message: 'Enter the protection tip in SOL (leave blank for no tip):',
                    default: '',
                    validate: (value: string) =>
                        value === '' || common.validate_float(value, 0.0)
                            ? true
                            : 'Please enter a valid number greater than 0.0',
                    filter: (value: string) => (value === '' ? undefined : parseFloat(value))
                },
                {
                    type: 'confirm',
                    name: 'mev_protect',
                    message: 'Do you want to enable MEV protection?',
                    default: false
                },
                {
                    type: 'confirm',
                    name: 'is_buy_once',
                    message: 'Do you want to buy only once?',
                    default: false
                },
                {
                    type: 'confirm',
                    name: 'funding',
                    message: 'Do you want to enable token funding?',
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
                    choices: ['Wait for the token to drop', 'Snipe by mint (existing or upcoming)'],
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
                        validate: (value: string) => {
                            if (!common.is_valid_pubkey(value)) return 'Please enter a valid public key.';
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
            Workers: bot_config.thread_cnt,
            'Buy amount (min)': `${bot_config.min_buy} SOL`,
            'Buy amount (max)': bot_config.max_buy === undefined ? 'N/A' : `${bot_config.max_buy} SOL`,
            'Buy once': bot_config.is_buy_once ? 'Yes' : 'No',
            'Token name': bot_config.token_name || 'N/A',
            'Token ticker': bot_config.token_ticker || 'N/A',
            'Quote mint': bot_config.quote_mint ?? 'Auto',
            'Buy slippage': `${bot_config.buy_slippage * 100}%`,
            'Sell slippage': `${bot_config.sell_slippage * 100}%`,
            'Protection tip': bot_config.protection_tip ? `${bot_config.protection_tip} SOL` : 'N/A',
            Priority: bot_config.priority_level.toString(),
            'Start interval': bot_config.start_interval !== 0 ? `${bot_config.start_interval} secs` : 'N/A',
            'MEV protection': bot_config.mev_protect ? 'Yes' : 'No',
            Funding: bot_config.funding ? 'Yes' : 'No',
            'Trade interval': bot_config.trade_interval !== 0 ? `${bot_config.trade_interval} secs` : 'N/A',
            'Market cap threshold':
                bot_config.mcap_threshold === Infinity
                    ? 'N/A'
                    : `$${common.format_currency(bot_config.mcap_threshold)}`,
            'Spend limit': bot_config.spend_limit === Infinity ? 'N/A' : `${bot_config.spend_limit} SOL`,
            Mint: bot_config.mint ? bot_config.mint.toString() : 'N/A'
        };

        const max_length = Math.max(...Object.values(to_print).map((value) => value.toString().length));

        common.print_header([
            { title: 'Parameter', width: common.COLUMN_WIDTHS.parameter },
            { title: 'Value', width: max_length }
        ]);

        for (const [key, value] of Object.entries(to_print)) {
            common.print_row([
                { content: key, width: common.COLUMN_WIDTHS.parameter },
                { content: value.toString(), width: max_length, align: 'left' }
            ]);
        }

        common.print_footer([{ width: common.COLUMN_WIDTHS.parameter }, { width: max_length }]);
    }
}
