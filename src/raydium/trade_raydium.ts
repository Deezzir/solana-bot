import {
    AddressLookupTableAccount,
    AccountInfo,
    Keypair,
    LAMPORTS_PER_SOL,
    PublicKey,
    Signer,
    SystemProgram,
    TokenAmount,
    TransactionInstruction
} from '@solana/web3.js';
import * as common from '../common/common';
import * as trade from '../common/trade_common';
import {
    COMMITMENT,
    PriorityLevel,
    RAYDIUM_CPMM_AUTHORITY,
    RAYDIUM_CPMM_CREATOR_FEE_CLAIM_DISCRIMINATOR,
    RAYDIUM_CPMM_POOL_STATE_HEADER,
    RAYDIUM_CPMM_PROGRAM_ID,
    RAYDIUM_CPMM_SWAP_DISCRIMINATOR,
    RAYDIUM_LAUNCHPAD_AUTHORITY,
    RAYDIUM_LAUNCHPAD_BUY_DISCRIMINATOR,
    RAYDIUM_LAUNCHPAD_EVENT_AUTHORITY,
    RAYDIUM_LAUNCHPAD_GLOBAL_CONFIG,
    RAYDIUM_LAUNCHPAD_POOL_HEADER,
    RAYDIUM_LAUNCHPAD_POOL_SEED,
    RAYDIUM_LAUNCHPAD_PROGRAM_ID,
    RAYDIUM_LAUNCHPAD_SELL_DISCRIMINATOR,
    RAYDIUM_LAUNCHPAD_VAULT_SEED,
    RAYDIUM_LTA_ACCOUNT,
    ACCOUNT_SUBSCRIPTION_FLUSH_MS,
    SOL_MINT,
    SYSTEM_PROGRAM_ID,
    TRADE_DEFAULT_TOKEN_DECIMALS,
    TRADE_MAX_SLIPPAGE
} from '../constants';
import {
    ASSOCIATED_TOKEN_PROGRAM_ID,
    createAssociatedTokenAccountIdempotentInstruction,
    createCloseAccountInstruction,
    createSyncNativeInstruction,
    TOKEN_PROGRAM_ID
} from '@solana/spl-token';
import base58 from 'bs58';
import { define_decoder_struct, skip, u8, u64, discriminator, pubkey } from '../common/struct_decoder';

const StateStruct = define_decoder_struct({
    discriminator: discriminator(Buffer.from(RAYDIUM_LAUNCHPAD_POOL_HEADER)),
    epoch: skip(u64().size),
    auth_bump: skip(u8().size),
    status: u8(),
    base_decimals: skip(u8().size),
    quote_decimals: skip(u8().size),
    migrate_type: skip(u8().size),
    supply: u64(),
    total_base_sell: skip(u64().size),
    virtual_base: u64(),
    virtual_quote: u64(),
    real_base: u64(),
    real_quote: u64(),
    total_quote_fund_raising: skip(u64().size),
    quote_protocol_fee: skip(u64().size),
    platform_fee: skip(u64().size),
    migrate_fee: skip(u64().size),
    vesting_schedule: skip(5 * u64().size),
    global_config: skip(pubkey().size),
    platform_config: pubkey(),
    base_mint: skip(pubkey().size),
    quote_mint: skip(pubkey().size),
    base_vault: skip(pubkey().size),
    quote_vault: skip(pubkey().size),
    creator: pubkey(),
    padding: skip(8 * u64().size)
});

type State = ReturnType<typeof StateStruct.decode>;

const CPMMStateStruct = define_decoder_struct({
    discriminator: discriminator(Buffer.from(RAYDIUM_CPMM_POOL_STATE_HEADER)),
    amm_config: pubkey(),
    pool_creator: pubkey(),
    token_0_vault: pubkey(),
    token_1_vault: pubkey(),
    lp_mint: skip(pubkey().size),
    token_0_mint: pubkey(),
    token_1_mint: pubkey(),
    token_0_program: pubkey(),
    token_1_program: pubkey(),
    observation_key: pubkey(),
    auth_bump: skip(u8().size),
    status: skip(u8().size),
    lp_mint_decimals: skip(u8().size),
    mint_0_decimals: u8(),
    mint_1_decimals: u8(),
    lp_supply: skip(u64().size),
    protocol_fees_token_0: u64(),
    protocol_fees_token_1: u64(),
    fund_fees_token_0: u64(),
    fund_fees_token_1: u64(),
    open_time: skip(u64().size),
    recent_epoch: skip(u64().size),
    creator_fee_on: skip(u8().size),
    enable_creator_fee: skip(u8().size),
    padding1: skip(6),
    creator_fees_token_0: u64(),
    creator_fees_token_1: u64(),
    padding: skip(28 * u64().size)
});

type CPMMState = ReturnType<typeof CPMMStateStruct.decode> & {
    token_0_reserves: bigint;
    token_1_reserves: bigint;
    supply: bigint;
};

type RaydiumClaimableAsset = trade.ClaimableAsset & {
    state: ReturnType<typeof CPMMStateStruct.decode>;
    pool: PublicKey;
};

export class RaydiumMintMeta implements trade.IMintMeta {
    mint!: string;
    name: string = 'Unknown';
    symbol: string = 'Unknown';
    base_vault!: string;
    quote_vault!: string;
    pool!: string;
    config!: string;
    creator!: string;
    sol_reserves: bigint = BigInt(0);
    token_reserves: bigint = BigInt(0);
    total_supply: bigint = BigInt(0);
    usd_market_cap: number = 0;
    market_cap: number = 0;
    complete: boolean = false;
    observation_state: string | null = null;
    fee: number = 0.0125;
    token_program_id!: string;

    constructor(data: Partial<RaydiumMintMeta> = {}) {
        Object.assign(this, data);
    }

    public get token_name(): string {
        return this.name;
    }

    public get token_mint(): string {
        return this.mint.toString();
    }

    public get token_symbol(): string {
        return this.symbol;
    }

    public get token_usd_mc(): number {
        return this.usd_market_cap;
    }

    public get migrated(): boolean {
        return false;
    }

    public get platform_fee(): number {
        return this.fee;
    }

    public get mint_pubkey(): PublicKey {
        return new PublicKey(this.mint);
    }

    public get token_program(): PublicKey {
        return new PublicKey(this.token_program_id);
    }

    public serialize(): trade.SerializedMintMeta {
        return {
            token_usd_mc: this.token_usd_mc,
            mint_pubkey: this.mint_pubkey.toBase58(),
            token_program: this.token_program.toBase58(),
            migrated: this.migrated,
            platform_fee: this.platform_fee,
            token_name: this.token_name,
            token_symbol: this.token_symbol,
            token_mint: this.token_mint,

            mint: this.mint,
            name: this.name,
            symbol: this.symbol,
            base_vault: this.base_vault,
            quote_vault: this.quote_vault,
            pool: this.pool,
            config: this.config,
            creator: this.creator,
            sol_reserves: this.sol_reserves.toString(),
            token_reserves: this.token_reserves.toString(),
            total_supply: this.total_supply.toString(),
            usd_market_cap: this.usd_market_cap,
            market_cap: this.market_cap,
            complete: this.complete,
            observation_state: this.observation_state,
            fee: this.fee,
            token_program_id: this.token_program_id
        };
    }

    public static deserialize(data: trade.SerializedMintMeta): RaydiumMintMeta {
        return new RaydiumMintMeta({
            mint: data.mint as string,
            name: data.name as string,
            symbol: data.symbol as string,
            base_vault: data.base_vault as string,
            quote_vault: data.quote_vault as string,
            pool: data.pool as string,
            config: data.config as string,
            creator: data.creator as string,
            sol_reserves: BigInt(data.sol_reserves as string),
            token_reserves: BigInt(data.token_reserves as string),
            total_supply: BigInt(data.total_supply as string),
            usd_market_cap: data.usd_market_cap as number,
            market_cap: data.market_cap as number,
            complete: data.complete as boolean,
            observation_state: data.observation_state as string | null,
            fee: data.fee as number,
            token_program_id: data.token_program_id as string
        });
    }
}

export class RaydiumTrader implements trade.IProgramTrader {
    public get_name(): string {
        return common.Program.Raydium;
    }

    public get_lta_addresses(): PublicKey[] {
        return [RAYDIUM_LTA_ACCOUNT];
    }

    public deserialize_mint_meta(data: trade.SerializedMintMeta): RaydiumMintMeta {
        return RaydiumMintMeta.deserialize(data);
    }

    public async get_trader_fees(trader: Signer): Promise<RaydiumClaimableAsset[]> {
        const pools = await trade.get_program_accounts_v2(RAYDIUM_CPMM_PROGRAM_ID, [
            { memcmp: { offset: CPMMStateStruct.get_offset('pool_creator'), bytes: trader.publicKey.toBase58() } },
            { memcmp: { offset: 0, bytes: base58.encode(RAYDIUM_CPMM_POOL_STATE_HEADER) } }
        ]);
        const assets = pools.map(({ pubkey, account }) => {
            const state = CPMMStateStruct.decode(account.data);
            const claimable: RaydiumClaimableAsset[] = [];
            if (state.creator_fees_token_0 > 0n)
                claimable.push({
                    mint: state.token_0_mint,
                    raw_amount: state.creator_fees_token_0,
                    decimals: state.mint_0_decimals,
                    source: 'creator_reward' as const,
                    state,
                    pool: pubkey
                });
            if (state.creator_fees_token_1 > 0n)
                claimable.push({
                    mint: state.token_1_mint,
                    raw_amount: state.creator_fees_token_1,
                    decimals: state.mint_1_decimals,
                    source: 'creator_reward' as const,
                    state,
                    pool: pubkey
                });
            return claimable;
        });
        return assets.flat();
    }

    public async claim_trader_fees(
        trader: Signer,
        assets: RaydiumClaimableAsset[],
        priority?: PriorityLevel
    ): Promise<String> {
        if (assets.length === 0) throw new Error(`No assets were provided`);

        const instructions: TransactionInstruction[] = [];
        const claimed_pools = new Set<string>();
        for (const asset of assets) {
            if (claimed_pools.has(asset.pool.toBase58())) continue;
            claimed_pools.add(asset.pool.toBase58());
            const state = asset.state;
            if (state.creator_fees_token_0 === 0n && state.creator_fees_token_1 === 0n) continue;
            const creator_token_0 = trade.calc_ata(trader.publicKey, state.token_0_mint, state.token_0_program);
            const creator_token_1 = trade.calc_ata(trader.publicKey, state.token_1_mint, state.token_1_program);
            instructions.push(
                createAssociatedTokenAccountIdempotentInstruction(
                    trader.publicKey,
                    creator_token_0,
                    trader.publicKey,
                    state.token_0_mint,
                    state.token_0_program
                ),
                createAssociatedTokenAccountIdempotentInstruction(
                    trader.publicKey,
                    creator_token_1,
                    trader.publicKey,
                    state.token_1_mint,
                    state.token_1_program
                ),
                new TransactionInstruction({
                    programId: RAYDIUM_CPMM_PROGRAM_ID,
                    data: Buffer.from(RAYDIUM_CPMM_CREATOR_FEE_CLAIM_DISCRIMINATOR),
                    keys: [
                        { pubkey: trader.publicKey, isSigner: true, isWritable: true },
                        { pubkey: RAYDIUM_CPMM_AUTHORITY, isSigner: false, isWritable: false },
                        { pubkey: asset.pool, isSigner: false, isWritable: true },
                        { pubkey: state.amm_config, isSigner: false, isWritable: false },
                        { pubkey: state.token_0_vault, isSigner: false, isWritable: true },
                        { pubkey: state.token_1_vault, isSigner: false, isWritable: true },
                        { pubkey: state.token_0_mint, isSigner: false, isWritable: false },
                        { pubkey: state.token_1_mint, isSigner: false, isWritable: false },
                        { pubkey: creator_token_0, isSigner: false, isWritable: true },
                        { pubkey: creator_token_1, isSigner: false, isWritable: true },
                        { pubkey: state.token_0_program, isSigner: false, isWritable: false },
                        { pubkey: state.token_1_program, isSigner: false, isWritable: false },
                        {
                            pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,
                            isSigner: false,
                            isWritable: false
                        },
                        { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false }
                    ]
                })
            );
        }

        if (instructions.length === 0) throw new Error('Invalid assets were provided, no tx was derived');
        return await trade.send_tx(instructions, [trader], priority);
    }

    public async buy_token(
        sol_amount: number,
        buyer: Signer,
        mint_meta: RaydiumMintMeta,
        slippage: number = 0.05,
        priority?: PriorityLevel,
        protection_tip?: number
    ): Promise<String> {
        const [instructions, ltas] = await this.buy_token_instructions(sol_amount, buyer, mint_meta, slippage);
        return await trade.send_tx(instructions, [buyer], priority, protection_tip, ltas);
    }

    public async buy_token_instructions(
        sol_amount: number,
        buyer: Signer,
        mint_meta: RaydiumMintMeta,
        slippage: number = 0.05
    ): Promise<[TransactionInstruction[], AddressLookupTableAccount[]?]> {
        const lta = await trade.get_ltas([RAYDIUM_LTA_ACCOUNT]);
        if (mint_meta.complete) {
            const instructions = await this.get_buy_cpmm_instructions(sol_amount, buyer, mint_meta, slippage);
            return [instructions, lta];
        }
        const instructions = await this.get_buy_instructions(sol_amount, buyer, mint_meta, slippage);
        return [instructions, lta];
    }

    public async sell_token(
        token_amount: TokenAmount,
        seller: Signer,
        mint_meta: RaydiumMintMeta,
        slippage: number = 0.05,
        priority: PriorityLevel,
        protection_tip?: number
    ): Promise<String> {
        const [instructions, ltas] = await this.sell_token_instructions(token_amount, seller, mint_meta, slippage);
        return await trade.send_tx(instructions, [seller], priority, protection_tip, ltas);
    }

    public async sell_token_instructions(
        token_amount: TokenAmount,
        seller: Signer,
        mint_meta: RaydiumMintMeta,
        slippage: number = 0.05
    ): Promise<[TransactionInstruction[], AddressLookupTableAccount[]?]> {
        const lta = await trade.get_ltas([RAYDIUM_LTA_ACCOUNT]);
        if (mint_meta.complete) {
            const instructions = await this.get_sell_cpmm_instructions(token_amount, seller, mint_meta, slippage);
            return [instructions, lta];
        }
        const instructions = await this.get_sell_instructions(token_amount, seller, mint_meta, slippage);
        return [instructions, lta];
    }

    public async buy_sell_instructions(
        sol_amount: number,
        trader: Signer,
        mint_meta: RaydiumMintMeta,
        slippage: number = 0.05
    ): Promise<[TransactionInstruction[], TransactionInstruction[], AddressLookupTableAccount[]?]> {
        const sol_amount_raw = BigInt(Math.floor(sol_amount * LAMPORTS_PER_SOL));
        const token_amount_raw = this.calc_token_amount_raw(sol_amount_raw, mint_meta);
        let [buy_instructions, lta] = await this.buy_token_instructions(sol_amount, trader, mint_meta, slippage);
        let [sell_instructions] = await this.sell_token_instructions(
            {
                uiAmount: Number(token_amount_raw) / 10 ** TRADE_DEFAULT_TOKEN_DECIMALS,
                amount: token_amount_raw.toString(),
                decimals: TRADE_DEFAULT_TOKEN_DECIMALS
            },
            trader,
            mint_meta,
            slippage
        );
        return [buy_instructions, sell_instructions, lta];
    }

    public async buy_sell(
        sol_amount: number,
        trader: Signer,
        mint_meta: RaydiumMintMeta,
        slippage: number = 0.05,
        interval_ms?: number,
        priority?: PriorityLevel,
        protection_tip?: number
    ): Promise<[String, String]> {
        const [buy_instructions, sell_instructions, ltas] = await this.buy_sell_instructions(
            sol_amount,
            trader,
            mint_meta,
            slippage
        );

        if (interval_ms && interval_ms > 0) {
            const buy_signature = await trade.send_tx(buy_instructions, [trader], priority, protection_tip, ltas);
            await common.sleep(interval_ms);
            const sell_signature = await trade.retry_send_tx(
                sell_instructions,
                [trader],
                priority,
                protection_tip,
                ltas
            );
            return [buy_signature, sell_signature];
        }

        const signature = await trade.send_tx(
            [...buy_instructions, ...sell_instructions],
            [trader],
            priority,
            protection_tip,
            ltas
        );
        return [signature, signature];
    }

    public async buy_sell_bundle(
        sol_amount: number,
        trader: Signer,
        mint_meta: RaydiumMintMeta,
        tip: number,
        slippage: number = 0.05,
        priority?: PriorityLevel
    ): Promise<String> {
        const [buy_instructions, sell_instructions, ltas] = await this.buy_sell_instructions(
            sol_amount,
            trader,
            mint_meta,
            slippage
        );
        return await trade.send_bundle(
            [buy_instructions, sell_instructions],
            [[trader], [trader]],
            tip,
            priority,
            ltas
        );
    }

    public async get_mint_meta(mint: PublicKey, sol_price: number = 0): Promise<RaydiumMintMeta | undefined> {
        try {
            let mint_meta = await this.default_mint_meta(mint, sol_price);
            mint_meta = await this.update_mint_meta(mint_meta, sol_price);
            return mint_meta;
        } catch (error) {
            return undefined;
        }
    }

    public async get_random_mints(_count: number): Promise<RaydiumMintMeta[]> {
        throw new Error('Not implemented');
    }

    public async create_token(
        _mint: Keypair,
        _creator: Signer,
        _token_name: string,
        _token_symbol: string,
        _meta_cid: string,
        _sol_amount?: number,
        _traders?: [Signer, number][],
        _bundle_tip?: number,
        _priority?: PriorityLevel
    ): Promise<String> {
        throw new Error('Not implemented');
    }

    public async create_token_metadata(_meta: common.IPFSMetadata, _image_path: string): Promise<string> {
        throw new Error('Not implemented');
    }

    public update_mint_meta_reserves(mint_meta: RaydiumMintMeta, amount: number | TokenAmount): RaydiumMintMeta {
        if (typeof amount === 'number') {
            const sol_amount_raw = BigInt(Math.floor(amount * LAMPORTS_PER_SOL));
            const fee = (sol_amount_raw * BigInt(mint_meta.fee * 10000)) / 10000n;
            const n = mint_meta.sol_reserves * mint_meta.token_reserves;
            mint_meta.sol_reserves = mint_meta.sol_reserves + (sol_amount_raw - fee);
            mint_meta.token_reserves = n / mint_meta.sol_reserves + 1n;
            return mint_meta;
        } else if (typeof amount === 'object') {
            const token_amount_raw = BigInt(amount.amount);
            mint_meta.token_reserves = mint_meta.token_reserves + token_amount_raw;
            const n = (token_amount_raw * mint_meta.sol_reserves) / mint_meta.token_reserves;
            const fee = (n * BigInt(mint_meta.fee * 10000)) / 10000n;
            mint_meta.sol_reserves = mint_meta.sol_reserves - (n - fee);
            return mint_meta;
        }
        throw new Error(`Invalid amount type: ${typeof amount}`);
    }

    public async subscribe_mint_meta(
        mint_meta: RaydiumMintMeta,
        callback: (mint_meta: RaydiumMintMeta) => void,
        sol_price: number = 0
    ): Promise<() => void> {
        let launchpad_sub: number | undefined;
        const cpmm_subs: number[] = [];
        let flush_timeout: NodeJS.Timeout | null = null;
        let latest_update: RaydiumMintMeta | null = null;
        let stopped = false;

        const publish = (update: RaydiumMintMeta) => {
            latest_update = update;
            if (flush_timeout || stopped) return;
            flush_timeout = setTimeout(() => {
                flush_timeout = null;
                if (!latest_update || stopped) return;
                callback(latest_update);
                latest_update = null;
            }, ACCOUNT_SUBSCRIPTION_FLUSH_MS);
        };
        const unsubscribe = (id: number | undefined) => {
            if (id !== undefined) global.CONNECTION.removeAccountChangeListener(id).catch(() => {});
        };
        const subscribe_cpmm = (pool: PublicKey) => {
            let vaults_subscribed = false;
            const process = async (info: AccountInfo<Buffer>) => {
                if (stopped) return;
                const state = CPMMStateStruct.decode(info.data);
                const [token_0, token_1, supply] = await Promise.all([
                    trade.get_vault_balance(state.token_0_vault),
                    trade.get_vault_balance(state.token_1_vault),
                    trade.get_token_supply(state.token_1_mint)
                ]);
                const token_0_reserves =
                    token_0.balance -
                    state.protocol_fees_token_0 -
                    state.fund_fees_token_0 -
                    state.creator_fees_token_0;
                const token_1_reserves =
                    token_1.balance -
                    state.protocol_fees_token_1 -
                    state.fund_fees_token_1 -
                    state.creator_fees_token_1;
                const metrics = this.get_token_metrics(token_0_reserves, token_1_reserves, supply.supply);
                publish(
                    new RaydiumMintMeta({
                        ...mint_meta,
                        pool: pool.toBase58(),
                        sol_reserves: token_0_reserves,
                        token_reserves: token_1_reserves,
                        base_vault: state.token_1_vault.toBase58(),
                        quote_vault: state.token_0_vault.toBase58(),
                        total_supply: supply.supply,
                        complete: true,
                        config: state.amm_config.toBase58(),
                        observation_state: state.observation_key.toBase58(),
                        market_cap: metrics.mcap_sol,
                        usd_market_cap: metrics.mcap_sol * sol_price
                    })
                );
                if (vaults_subscribed) return;
                vaults_subscribed = true;
                const refresh = async () => {
                    const pool_info = await global.CONNECTION.getAccountInfo(pool, COMMITMENT);
                    if (pool_info) await process(pool_info);
                };
                cpmm_subs.push(
                    global.CONNECTION.onAccountChange(state.token_0_vault, refresh, { commitment: COMMITMENT }),
                    global.CONNECTION.onAccountChange(state.token_1_vault, refresh, { commitment: COMMITMENT })
                );
            };
            cpmm_subs.push(global.CONNECTION.onAccountChange(pool, process, { commitment: COMMITMENT }));
            global.CONNECTION.getAccountInfo(pool, COMMITMENT)
                .then((info) => info && process(info))
                .catch(() => {});
        };
        const pool = new PublicKey(mint_meta.pool);
        const cpmm = await this.get_cpmm_from_mint(new PublicKey(mint_meta.mint));
        if (cpmm) {
            subscribe_cpmm(cpmm);
        } else {
            launchpad_sub = global.CONNECTION.onAccountChange(
                pool,
                async (info) => {
                    if (stopped) return;
                    const state = StateStruct.decode(info.data);
                    const metrics = this.get_token_metrics(
                        state.real_quote + state.virtual_quote,
                        state.virtual_base - state.real_base,
                        state.supply
                    );
                    publish(
                        new RaydiumMintMeta({
                            ...mint_meta,
                            sol_reserves: state.real_quote + state.virtual_quote,
                            token_reserves: state.virtual_base - state.real_base,
                            total_supply: state.supply,
                            complete: state.status !== 0,
                            config: state.platform_config.toBase58(),
                            creator: state.creator.toBase58(),
                            market_cap: metrics.mcap_sol,
                            usd_market_cap: metrics.mcap_sol * sol_price
                        })
                    );
                    if (state.status === 0) return;
                    const migrated = await this.get_cpmm_from_mint(new PublicKey(mint_meta.mint));
                    if (!migrated) return;
                    unsubscribe(launchpad_sub);
                    launchpad_sub = undefined;
                    subscribe_cpmm(migrated);
                },
                { commitment: COMMITMENT }
            );
        }
        return () => {
            stopped = true;
            if (flush_timeout) clearTimeout(flush_timeout);
            unsubscribe(launchpad_sub);
            cpmm_subs.forEach(unsubscribe);
        };
    }

    public async update_mint_meta(mint_meta: RaydiumMintMeta, sol_price: number = 0.0): Promise<RaydiumMintMeta> {
        try {
            const cpmm_pool = await this.get_cpmm_from_mint(new PublicKey(mint_meta.mint));

            if (!cpmm_pool && !mint_meta.complete) {
                const state = await this.get_state(new PublicKey(mint_meta.pool));
                const metrics = this.get_token_metrics(
                    state.real_quote + state.virtual_quote,
                    state.virtual_base - state.real_base,
                    state.supply
                );
                return new RaydiumMintMeta({
                    ...mint_meta,
                    usd_market_cap: metrics.mcap_sol * sol_price,
                    market_cap: metrics.mcap_sol,
                    sol_reserves: state.real_quote + state.virtual_quote,
                    token_reserves: state.virtual_base - state.real_base,
                    total_supply: state.supply,
                    complete: state.status !== 0,
                    config: state.platform_config.toString(),
                    creator: state.creator.toString()
                });
            }

            if (cpmm_pool) {
                const state = await this.get_cpmm_state(cpmm_pool);
                const metrics = this.get_token_metrics(state.token_0_reserves, state.token_1_reserves, state.supply);
                return new RaydiumMintMeta({
                    ...mint_meta,
                    usd_market_cap: metrics.mcap_sol * sol_price,
                    market_cap: metrics.mcap_sol,
                    pool: cpmm_pool.toString(),
                    sol_reserves: state.token_0_reserves,
                    token_reserves: state.token_1_reserves,
                    base_vault: state.token_1_vault.toString(),
                    quote_vault: state.token_0_vault.toString(),
                    total_supply: state.supply,
                    complete: true,
                    observation_state: state.observation_key.toString(),
                    config: state.amm_config.toString()
                });
            }

            return mint_meta;
        } catch (error) {
            throw new Error(`Failed to update mint meta reserves: ${error}`);
        }
    }

    public async default_mint_meta(mint: PublicKey, sol_price: number = 0.0): Promise<RaydiumMintMeta> {
        const meta = await trade.get_token_meta(mint).catch(() => {
            return { token_name: 'Unknown', token_symbol: 'Unknown', token_program: TOKEN_PROGRAM_ID };
        });
        const pool = this.calc_pool(mint);
        const [base_vault, quote_vault] = this.calc_vault(mint, pool);

        return new RaydiumMintMeta({
            mint: mint.toString(),
            symbol: meta.token_symbol,
            name: meta.token_name,
            pool: pool.toString(),
            base_vault: base_vault.toString(),
            quote_vault: quote_vault.toString(),
            market_cap: 30,
            usd_market_cap: 30 * sol_price,
            sol_reserves: BigInt(30000852951),
            token_reserves: BigInt(1073025605596382),
            total_supply: BigInt(1000000000000000),
            token_program_id: meta.token_program.toString()
        });
    }

    protected calc_token_amount_raw(sol_amount_raw: bigint, token: Partial<RaydiumMintMeta>): bigint {
        if (!token.sol_reserves || !token.token_reserves || !token.fee) return 0n;
        if (sol_amount_raw <= 0) return 0n;

        const fee = (sol_amount_raw * BigInt(token.fee * 10000)) / 10000n;
        const n = token.sol_reserves * token.token_reserves;
        const new_sol_reserves = token.sol_reserves + (sol_amount_raw - fee);
        const new_token_reserves = n / new_sol_reserves + 1n;
        return token.token_reserves - new_token_reserves;
    }

    protected calc_sol_amount_raw(token_amount_raw: bigint, token: Partial<RaydiumMintMeta>): bigint {
        if (!token.sol_reserves || !token.token_reserves) return 0n;
        if (token_amount_raw <= 0) return 0n;

        return (token_amount_raw * token.sol_reserves) / (token.token_reserves + token_amount_raw);
    }

    protected calc_slippage_up(sol_amount: bigint, slippage: number): bigint {
        if (slippage <= 0.0 || slippage >= TRADE_MAX_SLIPPAGE) throw new RangeError('Slippage must be between 0 and 1');
        return sol_amount + (sol_amount * BigInt(Math.floor(slippage * 10000))) / BigInt(10000);
    }

    protected calc_slippage_down(sol_amount: bigint, slippage: number): bigint {
        if (slippage <= 0.0 || slippage >= TRADE_MAX_SLIPPAGE) throw new RangeError('Slippage must be between 0 and 1');
        return sol_amount - (sol_amount * BigInt(Math.floor(slippage * 10000))) / BigInt(10000);
    }

    protected swap_data(amount_in: bigint, minimum_amount_out: bigint, op: 'buy' | 'sell'): Buffer {
        const discriminator = op === 'buy' ? RAYDIUM_LAUNCHPAD_BUY_DISCRIMINATOR : RAYDIUM_LAUNCHPAD_SELL_DISCRIMINATOR;
        const instruction_buf = Buffer.from(discriminator);
        const sol_amount_buf = Buffer.alloc(8);
        sol_amount_buf.writeBigUInt64LE(amount_in, 0);
        const token_amount_buf = Buffer.alloc(8);
        token_amount_buf.writeBigUInt64LE(minimum_amount_out, 0);
        const share_fee_rate = Buffer.alloc(8);
        share_fee_rate.writeBigUInt64LE(0n, 0);
        return Buffer.concat([instruction_buf, sol_amount_buf, token_amount_buf, share_fee_rate]);
    }

    protected swap_cpmm_data(amount_in: bigint, minimum_amount_out: bigint): Buffer {
        const instruction_buf = Buffer.from(RAYDIUM_CPMM_SWAP_DISCRIMINATOR);
        const sol_amount_buf = Buffer.alloc(8);
        sol_amount_buf.writeBigUInt64LE(amount_in, 0);
        const token_amount_buf = Buffer.alloc(8);
        token_amount_buf.writeBigUInt64LE(minimum_amount_out, 0);
        return Buffer.concat([instruction_buf, sol_amount_buf, token_amount_buf]);
    }

    protected calc_volume_accumulator(target: PublicKey): PublicKey {
        const [user_volume_accumulator] = PublicKey.findProgramAddressSync(
            [target.toBuffer(), SOL_MINT.toBuffer()],
            RAYDIUM_LAUNCHPAD_PROGRAM_ID
        );
        return user_volume_accumulator;
    }

    protected async get_buy_instructions(
        sol_amount: number,
        buyer: Signer,
        mint_meta: Partial<RaydiumMintMeta>,
        slippage: number = 0.05
    ): Promise<TransactionInstruction[]> {
        if (
            !mint_meta.mint ||
            !mint_meta.base_vault ||
            !mint_meta.quote_vault ||
            !mint_meta.pool ||
            !mint_meta.config ||
            !mint_meta.creator
        )
            throw new Error(`Incomplete mint meta data for buy instructions.`);

        const mint = new PublicKey(mint_meta.mint);
        const quote_vault = new PublicKey(mint_meta.quote_vault);
        const base_vault = new PublicKey(mint_meta.base_vault);
        const pool = new PublicKey(mint_meta.pool);
        const config = new PublicKey(mint_meta.config);
        const creator = new PublicKey(mint_meta.creator);

        const platform_volume_accumulator = this.calc_volume_accumulator(config);
        const creator_volume_accumulator = this.calc_volume_accumulator(creator);

        const token_ata = trade.calc_ata(buyer.publicKey, mint);
        const wsol_ata = trade.calc_ata(buyer.publicKey, SOL_MINT);

        const sol_amount_raw = BigInt(Math.floor(sol_amount * LAMPORTS_PER_SOL));
        const token_amount_raw = this.calc_slippage_down(
            this.calc_token_amount_raw(sol_amount_raw, mint_meta),
            slippage
        );
        const instruction_data = this.swap_data(sol_amount_raw, token_amount_raw, 'buy');

        return [
            createAssociatedTokenAccountIdempotentInstruction(buyer.publicKey, token_ata, buyer.publicKey, mint),
            createAssociatedTokenAccountIdempotentInstruction(buyer.publicKey, wsol_ata, buyer.publicKey, SOL_MINT),
            SystemProgram.transfer({
                fromPubkey: buyer.publicKey,
                toPubkey: wsol_ata,
                lamports: this.calc_slippage_up(sol_amount_raw, slippage)
            }),
            createSyncNativeInstruction(wsol_ata),
            new TransactionInstruction({
                keys: [
                    { pubkey: buyer.publicKey, isSigner: true, isWritable: true },
                    { pubkey: RAYDIUM_LAUNCHPAD_AUTHORITY, isSigner: false, isWritable: false },
                    { pubkey: RAYDIUM_LAUNCHPAD_GLOBAL_CONFIG, isSigner: false, isWritable: false },
                    { pubkey: config, isSigner: false, isWritable: false },
                    { pubkey: pool, isSigner: false, isWritable: true },
                    { pubkey: token_ata, isSigner: false, isWritable: true },
                    { pubkey: wsol_ata, isSigner: false, isWritable: true },
                    { pubkey: base_vault, isSigner: false, isWritable: true },
                    { pubkey: quote_vault, isSigner: false, isWritable: true },
                    { pubkey: mint, isSigner: false, isWritable: false },
                    { pubkey: SOL_MINT, isSigner: false, isWritable: false },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: RAYDIUM_LAUNCHPAD_EVENT_AUTHORITY, isSigner: false, isWritable: false },
                    { pubkey: RAYDIUM_LAUNCHPAD_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: platform_volume_accumulator, isSigner: false, isWritable: true },
                    { pubkey: creator_volume_accumulator, isSigner: false, isWritable: true }
                ],
                programId: RAYDIUM_LAUNCHPAD_PROGRAM_ID,
                data: instruction_data
            }),
            createCloseAccountInstruction(wsol_ata, buyer.publicKey, buyer.publicKey)
        ];
    }

    protected async get_sell_instructions(
        token_amount: TokenAmount,
        seller: Signer,
        mint_meta: Partial<RaydiumMintMeta>,
        slippage: number = 0.05
    ): Promise<TransactionInstruction[]> {
        if (
            !mint_meta.mint ||
            !mint_meta.quote_vault ||
            !mint_meta.base_vault ||
            !mint_meta.pool ||
            !mint_meta.config ||
            !mint_meta.creator
        )
            throw new Error(`Incomplete mint meta data for sell instructions.`);
        if (token_amount.amount === null) throw new Error(`Invalid token amount: ${token_amount.amount}`);

        const mint = new PublicKey(mint_meta.mint);
        const quote_vault = new PublicKey(mint_meta.quote_vault);
        const base_vault = new PublicKey(mint_meta.base_vault);
        const pool = new PublicKey(mint_meta.pool);
        const config = new PublicKey(mint_meta.config);
        const creator = new PublicKey(mint_meta.creator);

        const platform_volume_accumulator = this.calc_volume_accumulator(config);
        const creator_volume_accumulator = this.calc_volume_accumulator(creator);

        const token_amount_raw = BigInt(token_amount.amount);
        const sol_amount_raw = this.calc_slippage_down(this.calc_sol_amount_raw(token_amount_raw, mint_meta), slippage);

        const instruction_data = this.swap_data(token_amount_raw, sol_amount_raw, 'sell');
        const token_ata = trade.calc_ata(seller.publicKey, mint);
        const wsol_ata = trade.calc_ata(seller.publicKey, SOL_MINT);

        return [
            createAssociatedTokenAccountIdempotentInstruction(seller.publicKey, wsol_ata, seller.publicKey, SOL_MINT),
            new TransactionInstruction({
                keys: [
                    { pubkey: seller.publicKey, isSigner: true, isWritable: true },
                    { pubkey: RAYDIUM_LAUNCHPAD_AUTHORITY, isSigner: false, isWritable: false },
                    { pubkey: RAYDIUM_LAUNCHPAD_GLOBAL_CONFIG, isSigner: false, isWritable: false },
                    { pubkey: config, isSigner: false, isWritable: false },
                    { pubkey: pool, isSigner: false, isWritable: true },
                    { pubkey: token_ata, isSigner: false, isWritable: true },
                    { pubkey: wsol_ata, isSigner: false, isWritable: true },
                    { pubkey: base_vault, isSigner: false, isWritable: true },
                    { pubkey: quote_vault, isSigner: false, isWritable: true },
                    { pubkey: mint, isSigner: false, isWritable: false },
                    { pubkey: SOL_MINT, isSigner: false, isWritable: false },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: RAYDIUM_LAUNCHPAD_EVENT_AUTHORITY, isSigner: false, isWritable: false },
                    { pubkey: RAYDIUM_LAUNCHPAD_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: platform_volume_accumulator, isSigner: false, isWritable: true },
                    { pubkey: creator_volume_accumulator, isSigner: false, isWritable: true }
                ],
                programId: RAYDIUM_LAUNCHPAD_PROGRAM_ID,
                data: instruction_data
            }),
            createCloseAccountInstruction(wsol_ata, seller.publicKey, seller.publicKey)
        ];
    }

    protected async get_buy_cpmm_instructions(
        sol_amount: number,
        buyer: Signer,
        mint_meta: RaydiumMintMeta,
        slippage: number = 0.05
    ): Promise<TransactionInstruction[]> {
        if (
            !mint_meta.mint ||
            !mint_meta.pool ||
            !mint_meta.base_vault ||
            !mint_meta.quote_vault ||
            !mint_meta.observation_state ||
            !mint_meta.config
        )
            throw new Error(`Incomplete mint meta data for buy instructions.`);

        const mint = new PublicKey(mint_meta.mint);
        const pool = new PublicKey(mint_meta.pool);
        const observation_state = new PublicKey(mint_meta.observation_state);
        const quote_vault = new PublicKey(mint_meta.quote_vault);
        const base_vault = new PublicKey(mint_meta.base_vault);
        const config = new PublicKey(mint_meta.config);

        const sol_amount_raw = BigInt(Math.floor(sol_amount * LAMPORTS_PER_SOL));
        const token_amount_raw = this.calc_slippage_down(
            this.calc_token_amount_raw(sol_amount_raw, mint_meta),
            slippage
        );

        const instruction_data = this.swap_cpmm_data(sol_amount_raw, token_amount_raw);
        const token_ata = trade.calc_ata(buyer.publicKey, mint);
        const wsol_ata = trade.calc_ata(buyer.publicKey, SOL_MINT);

        return [
            createAssociatedTokenAccountIdempotentInstruction(buyer.publicKey, token_ata, buyer.publicKey, mint),
            createAssociatedTokenAccountIdempotentInstruction(buyer.publicKey, wsol_ata, buyer.publicKey, SOL_MINT),
            SystemProgram.transfer({
                fromPubkey: buyer.publicKey,
                toPubkey: wsol_ata,
                lamports: this.calc_slippage_up(sol_amount_raw, slippage)
            }),
            createSyncNativeInstruction(wsol_ata),
            new TransactionInstruction({
                keys: [
                    { pubkey: buyer.publicKey, isSigner: true, isWritable: true },
                    { pubkey: RAYDIUM_CPMM_AUTHORITY, isSigner: false, isWritable: false },
                    { pubkey: config, isSigner: false, isWritable: false },
                    { pubkey: pool, isSigner: false, isWritable: true },
                    { pubkey: wsol_ata, isSigner: false, isWritable: true },
                    { pubkey: token_ata, isSigner: false, isWritable: true },
                    { pubkey: quote_vault, isSigner: false, isWritable: true },
                    { pubkey: base_vault, isSigner: false, isWritable: true },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: mint_meta.token_program, isSigner: false, isWritable: false },
                    { pubkey: SOL_MINT, isSigner: false, isWritable: false },
                    { pubkey: mint, isSigner: false, isWritable: false },
                    { pubkey: observation_state, isSigner: false, isWritable: true }
                ],
                programId: RAYDIUM_CPMM_PROGRAM_ID,
                data: instruction_data
            }),
            createCloseAccountInstruction(wsol_ata, buyer.publicKey, buyer.publicKey)
        ];
    }

    protected async get_sell_cpmm_instructions(
        token_amount: TokenAmount,
        seller: Signer,
        mint_meta: RaydiumMintMeta,
        slippage: number = 0.05
    ): Promise<TransactionInstruction[]> {
        if (
            !mint_meta.mint ||
            !mint_meta.pool ||
            !mint_meta.base_vault ||
            !mint_meta.quote_vault ||
            !mint_meta.observation_state ||
            !mint_meta.config
        )
            throw new Error(`Incomplete mint meta data for sell instructions.`);
        if (token_amount.amount === null) throw new Error(`Invalid token amount: ${token_amount.amount}`);

        const mint = new PublicKey(mint_meta.mint);
        const pool = new PublicKey(mint_meta.pool);
        const observation_state = new PublicKey(mint_meta.observation_state);
        const quote_vault = new PublicKey(mint_meta.quote_vault);
        const base_vault = new PublicKey(mint_meta.base_vault);
        const config = new PublicKey(mint_meta.config);

        const token_amount_raw = BigInt(token_amount.amount);
        const instruction_data = this.swap_cpmm_data(
            token_amount_raw,
            this.calc_slippage_down(this.calc_sol_amount_raw(token_amount_raw, mint_meta), slippage)
        );
        const token_ata = trade.calc_ata(seller.publicKey, new PublicKey(mint_meta.mint));
        const wsol_ata = trade.calc_ata(seller.publicKey, SOL_MINT);

        return [
            createAssociatedTokenAccountIdempotentInstruction(seller.publicKey, wsol_ata, seller.publicKey, SOL_MINT),
            new TransactionInstruction({
                keys: [
                    { pubkey: seller.publicKey, isSigner: true, isWritable: true },
                    { pubkey: RAYDIUM_CPMM_AUTHORITY, isSigner: false, isWritable: false },
                    { pubkey: config, isSigner: false, isWritable: false },
                    { pubkey: pool, isSigner: false, isWritable: true },
                    { pubkey: token_ata, isSigner: false, isWritable: true },
                    { pubkey: wsol_ata, isSigner: false, isWritable: true },
                    { pubkey: base_vault, isSigner: false, isWritable: true },
                    { pubkey: quote_vault, isSigner: false, isWritable: true },
                    { pubkey: mint_meta.token_program, isSigner: false, isWritable: false },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: mint, isSigner: false, isWritable: false },
                    { pubkey: SOL_MINT, isSigner: false, isWritable: false },
                    { pubkey: observation_state, isSigner: false, isWritable: true }
                ],
                programId: RAYDIUM_CPMM_PROGRAM_ID,
                data: instruction_data
            }),
            createCloseAccountInstruction(wsol_ata, seller.publicKey, seller.publicKey)
        ];
    }

    protected calc_vault(mint: PublicKey, pool: PublicKey): [PublicKey, PublicKey] {
        const [base_vault] = PublicKey.findProgramAddressSync(
            [RAYDIUM_LAUNCHPAD_VAULT_SEED, pool.toBuffer(), mint.toBuffer()],
            RAYDIUM_LAUNCHPAD_PROGRAM_ID
        );
        const [quote_vault] = PublicKey.findProgramAddressSync(
            [RAYDIUM_LAUNCHPAD_VAULT_SEED, pool.toBuffer(), SOL_MINT.toBuffer()],
            RAYDIUM_LAUNCHPAD_PROGRAM_ID
        );
        return [base_vault, quote_vault];
    }

    protected calc_pool(base_mint: PublicKey): PublicKey {
        const [vault] = PublicKey.findProgramAddressSync(
            [RAYDIUM_LAUNCHPAD_POOL_SEED, base_mint.toBuffer(), SOL_MINT.toBuffer()],
            RAYDIUM_LAUNCHPAD_PROGRAM_ID
        );
        return vault;
    }

    protected get_token_metrics(quote_reserves: bigint, base_reserves: bigint, supply: bigint): trade.TokenMetrics {
        const price_sol = this.calculate_curve_price(quote_reserves, base_reserves);
        const mcap_sol = (price_sol * Number(supply)) / 10 ** TRADE_DEFAULT_TOKEN_DECIMALS;
        return { price_sol, mcap_sol };
    }

    protected calculate_curve_price(quote_reserves: bigint, base_reserves: bigint): number {
        if (base_reserves <= 0 || quote_reserves <= 0)
            throw new RangeError('Curve state contains invalid virtual reserves');
        return (
            Number(quote_reserves) /
            LAMPORTS_PER_SOL /
            (Number(base_reserves) / Math.pow(10, TRADE_DEFAULT_TOKEN_DECIMALS))
        );
    }

    protected async get_state(bond_curve_addr: PublicKey): Promise<State> {
        const info = await global.CONNECTION.getAccountInfo(bond_curve_addr, COMMITMENT);
        if (!info || !info.data) throw new Error('Unexpected curve state');
        return StateStruct.decode(info.data);
    }

    protected async get_cpmm_from_mint(mint: PublicKey): Promise<PublicKey | null> {
        const [cpmm] = await trade.get_program_accounts_v2(RAYDIUM_CPMM_PROGRAM_ID, [
            { memcmp: { offset: CPMMStateStruct.get_offset('token_1_mint'), bytes: mint.toBase58() } },
            { memcmp: { offset: CPMMStateStruct.get_offset('token_0_mint'), bytes: SOL_MINT.toBase58() } },
            { memcmp: { offset: 0, bytes: base58.encode(RAYDIUM_CPMM_POOL_STATE_HEADER) } }
        ]);
        return cpmm?.pubkey ?? null;
    }

    protected async get_cpmm_state(cpmm_pool: PublicKey): Promise<CPMMState> {
        const info = await global.CONNECTION.getAccountInfo(cpmm_pool);
        if (!info || !info.data) throw new Error('Unexpected CPMM state');

        const state = CPMMStateStruct.decode(info.data);
        const token_0_reserves = await trade.get_vault_balance(state.token_0_vault);
        const token_1_reserves = await trade.get_vault_balance(state.token_1_vault);
        const supply = await trade.get_token_supply(state.token_1_mint);

        return {
            ...state,
            token_0_reserves:
                token_0_reserves.balance -
                state.protocol_fees_token_0 -
                state.fund_fees_token_0 -
                state.creator_fees_token_0,
            token_1_reserves:
                token_1_reserves.balance -
                state.protocol_fees_token_1 -
                state.fund_fees_token_1 -
                state.creator_fees_token_1,
            supply: supply.supply
        };
    }
}
