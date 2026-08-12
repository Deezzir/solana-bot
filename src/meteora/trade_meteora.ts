import {
    AddressLookupTableAccount,
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
    METEORA_CONFIG_HEADER,
    METEORA_DBC_CLAIM_CREATOR_FEE_DISCRIMINATOR,
    METEORA_DAMM_V2_PROGRAM_ID,
    METEORA_DAMM_V2_STATE_HEADER,
    METEORA_DBC_EVENT_AUTHORITY,
    METEORA_DBC_POOL_AUTHORITY,
    METEORA_DBC_PROGRAM_ID,
    METEORA_DBC_STATE_HEADER,
    METEORA_LTA_ACCOUNT,
    METEORA_SWAP_DISCRIMINATOR,
    PriorityLevel,
    SOL_MINT,
    TRADE_MAX_SLIPPAGE
} from '../constants';
import base58 from 'bs58';
import {
    createAssociatedTokenAccountIdempotentInstruction,
    createCloseAccountInstruction,
    createSyncNativeInstruction,
    ExtensionType,
    getExtensionTypes,
    TOKEN_2022_PROGRAM_ID,
    TOKEN_PROGRAM_ID
} from '@solana/spl-token';
import { bytes, define_decoder_struct, discriminator, pubkey, skip, u8, u64 } from '../common/struct_decoder';

export class MeteoraMintMeta implements trade.IMintMeta {
    mint!: string;
    name: string = 'Unknown';
    symbol: string = 'Unknown';
    pool!: string;

    sol_reserves: bigint = 0n;
    token_reserves: bigint = 0n;
    total_supply: bigint = 0n;
    usd_market_cap: number = 0;
    market_cap: number = 0;
    complete: boolean = false;
    token_decimal: number = 9;
    fee: number = 0;
    token_program_id!: string;

    dbc_data?: DBCData;
    damm_v2_data?: DAMMV2Data;

    constructor(data: Partial<MeteoraMintMeta> = {}) {
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
        return this.damm_v2_data !== undefined;
    }

    public get platform_fee(): number {
        return 0.001;
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
            pool: this.pool,
            sol_reserves: this.sol_reserves.toString(),
            token_reserves: this.token_reserves.toString(),
            total_supply: this.total_supply.toString(),
            complete: this.complete,
            usd_market_cap: this.usd_market_cap,
            market_cap: this.market_cap,
            token_decimal: this.token_decimal,
            fee: this.fee,
            token_program_id: this.token_program_id,
            dbc_data: this.dbc_data,
            damm_v2_data: this.damm_v2_data
        };
    }

    public static deserialize(data: trade.SerializedMintMeta): MeteoraMintMeta {
        return new MeteoraMintMeta({
            mint: data.mint as string,
            name: data.name as string,
            symbol: data.symbol as string,
            pool: data.pool as string,
            sol_reserves: BigInt(data.sol_reserves as string),
            token_reserves: BigInt(data.token_reserves as string),
            total_supply: BigInt(data.total_supply as string),
            complete: data.complete as boolean,
            usd_market_cap: data.usd_market_cap as number,
            market_cap: data.market_cap as number,
            token_decimal: data.token_decimal as number,
            fee: data.fee as number,
            token_program_id: data.token_program_id as string,
            dbc_data: data.dbc_data as DBCData,
            damm_v2_data: data.damm_v2_data as DAMMV2Data
        });
    }
}

const DAMMV2StateStruct = define_decoder_struct({
    discriminator: discriminator(Buffer.from(METEORA_DAMM_V2_STATE_HEADER)),
    base_fee_data: bytes(32),
    base_fee_padding: skip(8),
    protocol_fee_percent: skip(1),
    pool_fee_padding_0: skip(1),
    referral_fee_percent: skip(1),
    pool_fee_padding_1: skip(3),
    compounding_fee_bps: skip(2),
    dynamic_fee_initialized: u8(),
    dynamic_fee_data: skip(95),
    init_sqrt_price: skip(16),
    token_a_mint: pubkey(),
    token_b_mint: pubkey(),
    token_a_vault: pubkey(),
    token_b_vault: pubkey(),
    whitelisted_vault: skip(32),
    pool_padding_0: skip(32),
    liquidity: skip(16),
    pool_padding_1: skip(16),
    protocol_a_fee: skip(8),
    protocol_b_fee: skip(8),
    pool_padding_2: skip(16),
    sqrt_min_price: skip(16),
    sqrt_max_price: skip(16),
    sqrt_price: skip(16),
    activation_point: skip(8),
    activation_type: u8(),
    pool_status: u8(),
    token_a_flag: u8(),
    token_b_flag: u8(),
    collect_fee_mode: u8(),
    pool_type: skip(1),
    fee_version: u8(),
    pool_padding_3: skip(1),
    fee_a_per_liquidity: skip(32),
    fee_b_per_liquidity: skip(32),
    permanent_lock_liquidity: skip(16),
    metrics: skip(80),
    creator: skip(32),
    token_a_amount: u64(),
    token_b_amount: u64(),
    layout_version: u8(),
    pool_padding_4: skip(7),
    pool_padding_5: skip(24),
    reward_infos: skip(384)
});
const DBCConfigStruct = define_decoder_struct({
    discriminator: discriminator(Buffer.from(METEORA_CONFIG_HEADER)),
    quote_mint: pubkey(),
    fee_claimer: skip(32),
    leftover_receiver: skip(32),
    curve: skip(128),
    collect_fee_mode: skip(1),
    migration_option: skip(1),
    activation_type: skip(1),
    token_decimal: u8(),
    version: skip(1),
    token_type: u8(),
    quote_token_flag: u8(),
    partner_locked_lp_percentage: skip(1),
    partner_lp_percentage: skip(1),
    creator_locked_lp_percentage: skip(1),
    creator_lp_percentage: skip(1),
    migration_fee_option: skip(1),
    fixed_token_supply_flag: skip(1),
    creator_trading_fee_percentage: skip(1),
    config_padding: skip(10),
    swap_base_amount: skip(8),
    migration_quote_threshold: skip(8),
    migration_base_threshold: skip(8),
    migration_sqrt_price: skip(16),
    config_padding_2: skip(48),
    pre_migration_token_supply: u64(),
    post_migration_token_supply: skip(8),
    config_padding_3: skip(32),
    sqrt_start_price: skip(16)
});

const DBCStateStruct = define_decoder_struct({
    discriminator: discriminator(Buffer.from(METEORA_DBC_STATE_HEADER)),
    state_padding: skip(64),
    config: pubkey(),
    creator: pubkey(),
    base_mint: pubkey(),
    base_vault: pubkey(),
    quote_vault: pubkey(),
    base_reserve: u64(),
    quote_reserve: u64(),
    protocol_base_fee: skip(8),
    protocol_quote_fee: skip(8),
    partner_base_fee: skip(8),
    partner_quote_fee: skip(8),
    sqrt_price: bytes(16),
    activation_point: skip(8),
    pool_type: skip(1),
    is_migrated: u8(),
    state_flags: skip(5),
    state_padding_2: skip(33),
    finish_curve_timestamp: skip(8),
    creator_base_fee: u64(),
    creator_quote_fee: u64()
});
type DBCState = {
    pool: PublicKey;
    token_decimals: number;
    total_supply: bigint;
    base_mint: PublicKey;
    config: PublicKey;
    quote_mint: PublicKey;
    base_vault: PublicKey;
    quote_vault: PublicKey;
    base_reserve: bigint;
    quote_reserve: bigint;
    sqrt_price: bigint;
    creator: PublicKey;
    is_migrated: boolean;
};
type DAMMV2Data = {
    token_a_mint: string;
    token_b_mint: string;
    token_a_vault: string;
    token_b_vault: string;
    token_a_amount: bigint;
    token_b_amount: bigint;
    fee_numerator: bigint;
};

type DBCData = {
    sqrt_price: bigint;
    config: string;
    base_vault: string;
    quote_vault: string;
};

type MeteoraClaimableAsset = trade.ClaimableAsset & {
    pool: PublicKey;
    state: ReturnType<typeof DBCStateStruct.decode>;
    config: ReturnType<typeof DBCConfigStruct.decode>;
};

export class Trader implements trade.IProgramTrader {
    public get_name(): string {
        return common.Program.Meteora;
    }

    public get_lta_addresses(): PublicKey[] {
        return [METEORA_LTA_ACCOUNT];
    }

    public deserialize_mint_meta(data: trade.SerializedMintMeta): MeteoraMintMeta {
        return MeteoraMintMeta.deserialize(data);
    }

    public async get_trader_fees(trader: Signer): Promise<MeteoraClaimableAsset[]> {
        const pools = await trade.get_program_accounts_v2(METEORA_DBC_PROGRAM_ID, [
            { memcmp: { offset: DBCStateStruct.get_offset('creator'), bytes: trader.publicKey.toBase58() } },
            { memcmp: { offset: 0, bytes: base58.encode(METEORA_DBC_STATE_HEADER) } }
        ]);

        const assets = await Promise.all(
            pools.map(async ({ pubkey, account }) => {
                const state = DBCStateStruct.decode(account.data);
                if (state.creator_base_fee === 0n && state.creator_quote_fee === 0n) return null;

                const config_info = await global.CONNECTION.getAccountInfo(state.config, COMMITMENT);
                if (!config_info) {
                    common.warn('DBC configuration account is missing.');
                    return null;
                }

                const config = DBCConfigStruct.decode(config_info.data);
                if (config.token_type !== 0 || config.quote_token_flag !== 0) {
                    common.warn('DBC Token-2022 or transfer-hook creator-fee claims are not supported.');
                    return null;
                }
                if (state.creator_base_fee > 0n) {
                    const supply = await trade.get_token_supply(state.base_mint);
                    return {
                        mint: state.base_mint,
                        raw_amount: state.creator_base_fee,
                        decimals: supply.decimals,
                        source: 'creator_reward' as const,
                        state,
                        config,
                        pool: pubkey
                    };
                }
                if (state.creator_quote_fee > 0n) {
                    const supply = await trade.get_token_supply(config.quote_mint);
                    return {
                        mint: config.quote_mint,
                        raw_amount: state.creator_quote_fee,
                        decimals: config.quote_mint.equals(SOL_MINT) ? 9 : supply.decimals,
                        source: 'creator_reward' as const,
                        state,
                        config,
                        pool: pubkey
                    };
                }
                return null;
            })
        );

        return assets.filter((a) => a !== null);
    }

    public async claim_trader_fees(
        trader: Signer,
        assets: MeteoraClaimableAsset[],
        priority?: PriorityLevel
    ): Promise<String> {
        if (assets.length === 0) throw new Error(`No assets were provided`);

        const created_atas = new Set<string>();
        const add_ata = (mint: PublicKey) => {
            const ata = trade.calc_ata(trader.publicKey, mint);
            if (!created_atas.has(ata.toBase58())) {
                instructions.push(
                    createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, ata, trader.publicKey, mint)
                );
                created_atas.add(ata.toBase58());
            }
            return ata;
        };

        const instructions: TransactionInstruction[] = [];

        for (const asset of assets) {
            const state = asset.state;
            const config = asset.config;

            const base_ata = add_ata(state.base_mint);
            const quote_ata = add_ata(config.quote_mint);
            const data = Buffer.alloc(24);
            Buffer.from(METEORA_DBC_CLAIM_CREATOR_FEE_DISCRIMINATOR).copy(data);
            data.writeBigUInt64LE(state.creator_base_fee, 8);
            data.writeBigUInt64LE(state.creator_quote_fee, 16);
            instructions.push(
                new TransactionInstruction({
                    programId: METEORA_DBC_PROGRAM_ID,
                    data,
                    keys: [
                        { pubkey: METEORA_DBC_POOL_AUTHORITY, isSigner: false, isWritable: false },
                        { pubkey: asset.pool, isSigner: false, isWritable: true },
                        { pubkey: base_ata, isSigner: false, isWritable: true },
                        { pubkey: quote_ata, isSigner: false, isWritable: true },
                        { pubkey: state.base_vault, isSigner: false, isWritable: true },
                        { pubkey: state.quote_vault, isSigner: false, isWritable: true },
                        { pubkey: state.base_mint, isSigner: false, isWritable: false },
                        { pubkey: config.quote_mint, isSigner: false, isWritable: false },
                        { pubkey: trader.publicKey, isSigner: true, isWritable: false },
                        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                        { pubkey: METEORA_DBC_EVENT_AUTHORITY, isSigner: false, isWritable: false },
                        { pubkey: METEORA_DBC_PROGRAM_ID, isSigner: false, isWritable: false }
                    ]
                })
            );
            if (config.quote_mint.equals(SOL_MINT))
                instructions.push(createCloseAccountInstruction(quote_ata, trader.publicKey, trader.publicKey));
        }

        if (instructions.length === 0) throw new Error('Invalid assets were provided, no tx was derived');
        return await trade.send_tx(instructions, [trader], priority);
    }

    public async buy_token(
        sol_amount: number,
        buyer: Signer,
        mint_meta: MeteoraMintMeta,
        slippage: number,
        priority?: PriorityLevel,
        protection_tip?: number
    ): Promise<String> {
        const [instructions, ltas] = await this.buy_token_instructions(sol_amount, buyer, mint_meta, slippage);
        return await trade.send_tx(instructions, [buyer], priority, protection_tip, ltas);
    }

    public async sell_token(
        token_amount: TokenAmount,
        seller: Signer,
        mint_meta: MeteoraMintMeta,
        slippage: number,
        priority?: PriorityLevel,
        protection_tip?: number
    ): Promise<String> {
        const [instructions, ltas] = await this.sell_token_instructions(token_amount, seller, mint_meta, slippage);
        return await trade.send_tx(instructions, [seller], priority, protection_tip, ltas);
    }

    public async buy_token_instructions(
        sol_amount: number,
        buyer: Signer,
        mint_meta: MeteoraMintMeta,
        slippage: number
    ): Promise<[TransactionInstruction[], AddressLookupTableAccount[]?]> {
        const lta = await trade.get_ltas([METEORA_LTA_ACCOUNT]);
        if (mint_meta.migrated) {
            if (!mint_meta.damm_v2_data) throw new Error('Missing DAMM v2 pool data.');
            return [await this.get_buy_damm_v2_instructions(sol_amount, buyer, mint_meta, slippage), lta];
        }
        return [await this.get_buy_dbc_instructions(sol_amount, buyer, mint_meta, slippage), lta];
    }

    public async sell_token_instructions(
        token_amount: TokenAmount,
        seller: Signer,
        mint_meta: MeteoraMintMeta,
        slippage: number
    ): Promise<[TransactionInstruction[], AddressLookupTableAccount[]?]> {
        const lta = await trade.get_ltas([METEORA_LTA_ACCOUNT]);
        if (mint_meta.migrated) {
            if (!mint_meta.damm_v2_data) throw new Error('Missing DAMM v2 pool data.');
            return [await this.get_sell_damm_v2_instructions(token_amount, seller, mint_meta, slippage), lta];
        }
        return [await this.get_sell_dbc_instructions(token_amount, seller, mint_meta, slippage), lta];
    }

    public async buy_sell_instructions(
        sol_amount: number,
        trader: Signer,
        mint_meta: MeteoraMintMeta,
        slippage: number
    ): Promise<[TransactionInstruction[], TransactionInstruction[], AddressLookupTableAccount[]?]> {
        const sol_amount_raw = BigInt(Math.floor(sol_amount * LAMPORTS_PER_SOL));
        const token_amount_raw = mint_meta.migrated
            ? this.calc_damm_v2_amount_out(sol_amount_raw, SOL_MINT, mint_meta)
            : this.calc_dbc_token_amount_raw(sol_amount_raw, mint_meta.dbc_data!);
        let [buy_instructions, lta] = await this.buy_token_instructions(sol_amount, trader, mint_meta, slippage);
        let [sell_instructions] = await this.sell_token_instructions(
            {
                uiAmount: Number(token_amount_raw) / 10 ** mint_meta.token_decimal,
                amount: token_amount_raw.toString(),
                decimals: mint_meta.token_decimal
            },
            trader,
            mint_meta,
            slippage
        );
        return [buy_instructions, sell_instructions, lta];
    }

    public async buy_sell_bundle(
        sol_amount: number,
        trader: Signer,
        mint_meta: MeteoraMintMeta,
        tip: number,
        slippage: number,
        priority?: PriorityLevel
    ): Promise<String> {
        const [buy_instructions, sell_instructions, lta] = await this.buy_sell_instructions(
            sol_amount,
            trader,
            mint_meta,
            slippage
        );
        return await trade.send_bundle([buy_instructions, sell_instructions], [[trader], [trader]], tip, priority, lta);
    }

    public async buy_sell(
        sol_amount: number,
        trader: Signer,
        mint_meta: MeteoraMintMeta,
        slippage: number,
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

    public create_token(
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

    public create_token_metadata(_meta: common.IPFSMetadata, _image_path: string): Promise<string> {
        throw new Error('Not implemented');
    }

    public get_random_mints(_count: number): Promise<MeteoraMintMeta[]> {
        throw new Error('Not implemented');
    }

    public async get_mint_meta(mint: PublicKey, sol_price?: number): Promise<MeteoraMintMeta | undefined> {
        try {
            let mint_meta = await this.default_mint_meta(mint, sol_price);
            mint_meta = await this.update_mint_meta(mint_meta, sol_price);
            return mint_meta;
        } catch (error) {
            console.error(`Error fetching mint meta: ${error}`);
            return undefined;
        }
    }

    public async subscribe_mint_meta(
        _mint_meta: MeteoraMintMeta,
        _callback: (mint_meta: MeteoraMintMeta) => void
    ): Promise<() => void> {
        throw new Error('Not implemented');
    }

    public async update_mint_meta(mint_meta: MeteoraMintMeta, sol_price: number = 0): Promise<MeteoraMintMeta> {
        try {
            const mint = new PublicKey(mint_meta.mint);
            const dbc_pool = await this.get_dbc_pool_from_mint(mint);
            if (dbc_pool) {
                const state = await this.get_dbc_state(mint);
                if (!state.is_migrated) {
                    const metrics = this.get_dbc_token_metrics(state);
                    return new MeteoraMintMeta({
                        ...mint_meta,
                        dbc_data: {
                            sqrt_price: state.sqrt_price,
                            base_vault: state.base_vault.toString(),
                            quote_vault: state.quote_vault.toString(),
                            config: state.config.toString()
                        },
                        damm_v2_data: undefined,
                        sol_reserves: state.quote_reserve,
                        token_reserves: state.base_reserve,
                        total_supply: state.total_supply,
                        token_decimal: state.token_decimals,
                        pool: state.pool.toString(),
                        complete: false,
                        usd_market_cap: metrics.mcap_sol * sol_price,
                        market_cap: metrics.mcap_sol
                    });
                }
            }

            const damm = await this.get_damm_from_mint(mint);
            if (damm) return this.damm_v2_mint_meta(mint_meta, damm, sol_price);

            if (dbc_pool) {
                const state = await this.get_dbc_state(mint);
                const metrics = this.get_dbc_token_metrics(state);
                return new MeteoraMintMeta({
                    ...mint_meta,
                    dbc_data: {
                        sqrt_price: state.sqrt_price,
                        base_vault: state.base_vault.toString(),
                        quote_vault: state.quote_vault.toString(),
                        config: state.config.toString()
                    },
                    sol_reserves: state.quote_reserve,
                    token_reserves: state.base_reserve,
                    total_supply: state.total_supply,
                    token_decimal: state.token_decimals,
                    pool: state.pool.toString(),
                    complete: state.is_migrated,
                    usd_market_cap: metrics.mcap_sol * sol_price,
                    market_cap: metrics.mcap_sol
                });
            }

            throw new Error('Meteora DBC or DAMM v2 pool not found.');
        } catch (error) {
            throw new Error(`Failed to update mint meta reserves: ${error}`);
        }
    }

    public update_mint_meta_reserves(mint_meta: MeteoraMintMeta, _amount: number | TokenAmount): MeteoraMintMeta {
        return mint_meta;
    }

    public async default_mint_meta(mint: PublicKey, sol_price: number = 0): Promise<MeteoraMintMeta> {
        const meta = await trade.get_token_meta(mint).catch(() => {
            return {
                token_name: 'Unknown',
                token_symbol: 'Unknown',
                token_supply: 10 ** 18,
                token_decimal: 9,
                token_program: TOKEN_PROGRAM_ID
            };
        });

        return new MeteoraMintMeta({
            mint: mint.toString(),
            symbol: meta.token_symbol,
            name: meta.token_name,
            complete: false,
            market_cap: 135,
            usd_market_cap: 135 * sol_price,
            sol_reserves: 0n,
            token_reserves: 1000000000000000000n,
            total_supply: BigInt(meta.token_supply),
            token_decimal: meta.token_decimal,
            token_program_id: meta.token_program.toString()
        });
    }

    private get_dbc_token_metrics(state: DBCState): trade.TokenMetrics {
        const price_sol = this.calc_token_price(state.sqrt_price);
        const mcap_sol = price_sol * Number(state.base_reserve / 10n ** BigInt(state.token_decimals));
        return { price_sol, mcap_sol };
    }

    private calc_token_price(sqrt_price: bigint): number {
        const SCALE_FACTOR = 2n ** 64n;
        const PRECISION = 10n ** 18n;

        const numerator = sqrt_price * sqrt_price * PRECISION;
        const denominator = SCALE_FACTOR * SCALE_FACTOR;
        return Number(numerator / denominator) / 1e18;
    }

    private async get_dbc_state(mint: PublicKey): Promise<DBCState> {
        const pool = await this.get_dbc_pool_from_mint(mint);
        if (!pool) throw new Error('Pool not found');
        const pool_state = DBCStateStruct.decode(pool.account.data);
        const config_info = await global.CONNECTION.getAccountInfo(pool_state.config, COMMITMENT);
        if (!config_info) throw new Error('Unexpected config state');
        const config_state = DBCConfigStruct.decode(config_info.data);

        return {
            pool: pool.pubkey,
            base_mint: mint,
            quote_mint: config_state.quote_mint,
            config: pool_state.config,
            token_decimals: config_state.token_decimal,
            total_supply: config_state.pre_migration_token_supply,
            base_vault: pool_state.base_vault,
            quote_vault: pool_state.quote_vault,
            base_reserve: pool_state.base_reserve,
            quote_reserve: pool_state.quote_reserve,
            sqrt_price: common.read_biguint_le(pool_state.sqrt_price, 0, 16),
            is_migrated: pool_state.is_migrated === 1,
            creator: pool_state.creator
        };
    }

    private async get_dbc_pool_from_mint(mint: PublicKey): Promise<trade.ProgramAccount | null> {
        try {
            const [pool] = await trade.get_program_accounts_v2(METEORA_DBC_PROGRAM_ID, [
                { memcmp: { offset: DBCStateStruct.get_offset('base_mint'), bytes: mint.toBase58() } },
                { memcmp: { offset: 0, bytes: base58.encode(METEORA_DBC_STATE_HEADER) } }
            ]);
            return pool;
        } catch (error) {
            return null;
        }
    }

    private calc_slippage_up(sol_amount: bigint, slippage: number): bigint {
        if (slippage <= 0.0 || slippage >= TRADE_MAX_SLIPPAGE) throw new RangeError('Slippage must be between 0 and 1');
        return sol_amount + (sol_amount * BigInt(Math.floor(slippage * 10000))) / BigInt(10000);
    }

    private calc_slippage_down(sol_amount: bigint, slippage: number): bigint {
        if (slippage <= 0.0 || slippage >= TRADE_MAX_SLIPPAGE) throw new RangeError('Slippage must be between 0 and 1');
        return sol_amount - (sol_amount * BigInt(Math.floor(slippage * 10000))) / BigInt(10000);
    }

    private calc_dbc_token_amount_raw(sol_amount_raw: bigint, info: DBCData): bigint {
        if (sol_amount_raw <= 0) return 0n;

        const SCALE_FACTOR = BigInt(2) ** BigInt(128);
        const price = info.sqrt_price * info.sqrt_price;
        return (sol_amount_raw * SCALE_FACTOR) / price;
    }

    private calc_dbc_sol_amount_raw(token_amount_raw: bigint, info: DBCData): bigint {
        if (token_amount_raw <= 0) return 0n;

        const SCALE_FACTOR = BigInt(2) ** BigInt(128);
        const price = info.sqrt_price * info.sqrt_price;
        return (token_amount_raw * price) / SCALE_FACTOR;
    }

    private async get_damm_from_mint(mint: PublicKey): Promise<trade.ProgramAccount | null> {
        try {
            const pools = await Promise.all(
                ['token_a_mint', 'token_b_mint'].map((field) =>
                    trade.get_program_accounts_v2(METEORA_DAMM_V2_PROGRAM_ID, [
                        { memcmp: { offset: DAMMV2StateStruct.get_offset(field), bytes: mint.toBase58() } },
                        { memcmp: { offset: 0, bytes: base58.encode(METEORA_DAMM_V2_STATE_HEADER) } }
                    ])
                )
            );
            return (
                pools.flat().find((pool) => {
                    const state = DAMMV2StateStruct.decode(pool.account.data);
                    return state.token_a_mint.equals(SOL_MINT) || state.token_b_mint.equals(SOL_MINT);
                }) ?? null
            );
        } catch {
            return null;
        }
    }

    private damm_v2_mint_meta(
        mint_meta: MeteoraMintMeta,
        pool: trade.ProgramAccount,
        sol_price: number
    ): MeteoraMintMeta {
        const state = DAMMV2StateStruct.decode(pool.account.data);
        this.validate_damm_v2_state(state);
        const mint_is_token_a = state.token_a_mint.equals(mint_meta.mint_pubkey);
        const sol_mint = mint_is_token_a ? state.token_b_mint : state.token_a_mint;
        if (!sol_mint.equals(SOL_MINT)) throw new Error('DAMM v2 pool does not pair the token with SOL.');
        const token_reserves = mint_is_token_a ? state.token_a_amount : state.token_b_amount;
        const sol_reserves = mint_is_token_a ? state.token_b_amount : state.token_a_amount;
        const price_sol = Number(sol_reserves) / Number(token_reserves);
        const market_cap = (price_sol * Number(mint_meta.total_supply)) / 10 ** mint_meta.token_decimal;

        return new MeteoraMintMeta({
            ...mint_meta,
            pool: pool.pubkey.toBase58(),
            complete: true,
            sol_reserves,
            token_reserves,
            market_cap,
            usd_market_cap: market_cap * sol_price,
            damm_v2_data: {
                token_a_mint: state.token_a_mint.toBase58(),
                token_b_mint: state.token_b_mint.toBase58(),
                token_a_vault: state.token_a_vault.toBase58(),
                token_b_vault: state.token_b_vault.toBase58(),
                token_a_amount: state.token_a_amount,
                token_b_amount: state.token_b_amount,
                fee_numerator: state.base_fee_data.readBigUInt64LE(0)
            }
        });
    }

    private validate_damm_v2_state(state: ReturnType<typeof DAMMV2StateStruct.decode>): bigint {
        const base_fee_mode = state.base_fee_data[8];
        const period_frequency = state.base_fee_data.readBigUInt64LE(16);
        if (state.collect_fee_mode !== 2) throw new Error('DAMM v2 trading supports compounding pools only.');
        if (state.pool_status !== 0) throw new Error('DAMM v2 pool is disabled.');
        if (state.layout_version !== 1) throw new Error('DAMM v2 pool layout version is not supported.');
        if (state.dynamic_fee_initialized !== 0) throw new Error('DAMM v2 dynamic-fee pools are not supported.');
        if ((base_fee_mode !== 0 && base_fee_mode !== 1) || period_frequency !== 0n)
            throw new Error('DAMM v2 non-static fee pools are not supported.');
        if (state.fee_version > 1) throw new Error('Unsupported DAMM v2 fee version.');
        return state.base_fee_data.readBigUInt64LE(0);
    }

    private async get_token_program(mint: PublicKey): Promise<PublicKey> {
        if (mint.equals(SOL_MINT)) return TOKEN_PROGRAM_ID;
        const mint_info = await global.CONNECTION.getAccountInfo(mint, COMMITMENT);
        if (!mint_info || (!mint_info.owner.equals(TOKEN_PROGRAM_ID) && !mint_info.owner.equals(TOKEN_2022_PROGRAM_ID)))
            throw new Error(`Unsupported token program for mint ${mint}.`);
        if (
            mint_info.owner.equals(TOKEN_2022_PROGRAM_ID) &&
            getExtensionTypes(mint_info.data).includes(ExtensionType.TransferHook)
        )
            throw new Error('Meteora transfer-hook tokens are not supported.');
        return mint_info.owner;
    }

    private calc_damm_v2_minimum_amount_out(
        amount_in: bigint,
        input_is_token_a: boolean,
        state: ReturnType<typeof DAMMV2StateStruct.decode>,
        slippage: number
    ): bigint {
        const fee_numerator = this.validate_damm_v2_state(state);
        const fee_denominator = 1_000_000_000n;
        const fee = (amount_in * fee_numerator + fee_denominator - 1n) / fee_denominator;
        const amount_after_fee = input_is_token_a ? amount_in : amount_in - fee;
        const input_reserve = input_is_token_a ? state.token_a_amount : state.token_b_amount;
        const output_reserve = input_is_token_a ? state.token_b_amount : state.token_a_amount;
        const output_before_fee = (output_reserve * amount_after_fee) / (input_reserve + amount_after_fee);
        const output_after_fee = input_is_token_a
            ? output_before_fee - (output_before_fee * fee_numerator + fee_denominator - 1n) / fee_denominator
            : output_before_fee;
        return this.calc_slippage_down(output_after_fee, slippage);
    }

    private calc_damm_v2_amount_out(amount_in: bigint, input_mint: PublicKey, mint_meta: MeteoraMintMeta): bigint {
        if (!mint_meta.damm_v2_data) throw new Error('Missing DAMM v2 pool data.');
        const input_is_token_a = input_mint.toBase58() === mint_meta.damm_v2_data.token_a_mint;
        const input_reserve = input_is_token_a
            ? mint_meta.damm_v2_data.token_a_amount
            : mint_meta.damm_v2_data.token_b_amount;
        const output_reserve = input_is_token_a
            ? mint_meta.damm_v2_data.token_b_amount
            : mint_meta.damm_v2_data.token_a_amount;
        const fee_denominator = 1_000_000_000n;
        const fee = (amount_in * mint_meta.damm_v2_data.fee_numerator + fee_denominator - 1n) / fee_denominator;
        const amount_after_fee = input_is_token_a ? amount_in : amount_in - fee;
        const output_before_fee = (output_reserve * amount_after_fee) / (input_reserve + amount_after_fee);
        return input_is_token_a
            ? output_before_fee -
                  (output_before_fee * mint_meta.damm_v2_data.fee_numerator + fee_denominator - 1n) / fee_denominator
            : output_before_fee;
    }

    private damm_v2_swap_data(amount_in: bigint, minimum_amount_out: bigint): Buffer {
        const data = Buffer.alloc(25);
        Buffer.from([65, 75, 63, 76, 235, 91, 91, 136]).copy(data);
        data.writeBigUInt64LE(amount_in, 8);
        data.writeBigUInt64LE(minimum_amount_out, 16);
        data.writeUInt8(0, 24);
        return data;
    }

    private swap_data(amount_in: bigint, minimum_amount_out: bigint): Buffer {
        const instruction_buf = Buffer.from(METEORA_SWAP_DISCRIMINATOR);
        const sol_amount_buf = Buffer.alloc(8);
        sol_amount_buf.writeBigUInt64LE(amount_in, 0);
        const token_amount_buf = Buffer.alloc(8);
        token_amount_buf.writeBigUInt64LE(minimum_amount_out, 0);
        return Buffer.concat([instruction_buf, sol_amount_buf, token_amount_buf]);
    }

    private async get_buy_dbc_instructions(
        sol_amount: number,
        buyer: Signer,
        mint_meta: Partial<MeteoraMintMeta>,
        slippage: number = 0.05
    ): Promise<TransactionInstruction[]> {
        if (!mint_meta.mint || !mint_meta.dbc_data || !mint_meta.pool)
            throw new Error(`Incomplete mint meta data for buy instructions.`);

        const mint = new PublicKey(mint_meta.mint);
        const pool = new PublicKey(mint_meta.pool);
        const config = new PublicKey(mint_meta.dbc_data.config);
        const base_vault = new PublicKey(mint_meta.dbc_data.base_vault);
        const quote_vault = new PublicKey(mint_meta.dbc_data.quote_vault);

        const sol_amount_raw = BigInt(Math.floor(sol_amount * LAMPORTS_PER_SOL));
        const token_amount_raw = this.calc_slippage_down(
            this.calc_dbc_token_amount_raw(sol_amount_raw, mint_meta.dbc_data),
            slippage
        );

        const instruction_data = this.swap_data(sol_amount_raw, token_amount_raw);
        const token_program = await this.get_token_program(mint);
        const token_ata = trade.calc_ata(buyer.publicKey, mint, token_program);
        const wsol_ata = trade.calc_ata(buyer.publicKey, SOL_MINT);

        return [
            createAssociatedTokenAccountIdempotentInstruction(
                buyer.publicKey,
                token_ata,
                buyer.publicKey,
                mint,
                token_program
            ),
            createAssociatedTokenAccountIdempotentInstruction(buyer.publicKey, wsol_ata, buyer.publicKey, SOL_MINT),
            SystemProgram.transfer({
                fromPubkey: buyer.publicKey,
                toPubkey: wsol_ata,
                lamports: this.calc_slippage_up(sol_amount_raw, slippage)
            }),
            createSyncNativeInstruction(wsol_ata),
            new TransactionInstruction({
                keys: [
                    { pubkey: METEORA_DBC_POOL_AUTHORITY, isSigner: false, isWritable: false },
                    { pubkey: config, isSigner: false, isWritable: false },
                    { pubkey: pool, isSigner: false, isWritable: true },
                    { pubkey: wsol_ata, isSigner: false, isWritable: true },
                    { pubkey: token_ata, isSigner: false, isWritable: true },
                    { pubkey: base_vault, isSigner: false, isWritable: true },
                    { pubkey: quote_vault, isSigner: false, isWritable: true },
                    { pubkey: mint, isSigner: false, isWritable: false },
                    { pubkey: SOL_MINT, isSigner: false, isWritable: false },
                    { pubkey: buyer.publicKey, isSigner: true, isWritable: false },
                    { pubkey: token_program, isSigner: false, isWritable: false },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: METEORA_DBC_PROGRAM_ID, isSigner: false, isWritable: true },
                    { pubkey: METEORA_DBC_EVENT_AUTHORITY, isSigner: false, isWritable: false },
                    { pubkey: METEORA_DBC_PROGRAM_ID, isSigner: false, isWritable: false }
                ],
                programId: METEORA_DBC_PROGRAM_ID,
                data: instruction_data
            }),
            createCloseAccountInstruction(wsol_ata, buyer.publicKey, buyer.publicKey)
        ];
    }

    private async get_sell_dbc_instructions(
        token_amount: TokenAmount,
        seller: Signer,
        mint_meta: Partial<MeteoraMintMeta>,
        slippage: number = 0.05
    ): Promise<TransactionInstruction[]> {
        if (!mint_meta.mint || !mint_meta.dbc_data || !mint_meta.pool)
            throw new Error(`Incomplete mint meta data for sell instructions.`);
        if (token_amount.amount === null) throw new Error(`Invalid token amount: ${token_amount.amount}`);

        const mint = new PublicKey(mint_meta.mint);
        const pool = new PublicKey(mint_meta.pool);
        const config = new PublicKey(mint_meta.dbc_data.config);
        const base_vault = new PublicKey(mint_meta.dbc_data.base_vault);
        const quote_vault = new PublicKey(mint_meta.dbc_data.quote_vault);

        const token_amount_raw = BigInt(token_amount.amount);
        const sol_amount_raw = this.calc_slippage_down(
            this.calc_dbc_sol_amount_raw(token_amount_raw, mint_meta.dbc_data),
            slippage
        );

        const instruction_data = this.swap_data(token_amount_raw, sol_amount_raw);
        const token_program = await this.get_token_program(mint);
        const token_ata = trade.calc_ata(seller.publicKey, mint, token_program);
        const wsol_ata = trade.calc_ata(seller.publicKey, SOL_MINT);

        return [
            createAssociatedTokenAccountIdempotentInstruction(seller.publicKey, wsol_ata, seller.publicKey, SOL_MINT),
            new TransactionInstruction({
                keys: [
                    { pubkey: METEORA_DBC_POOL_AUTHORITY, isSigner: false, isWritable: false },
                    { pubkey: config, isSigner: false, isWritable: false },
                    { pubkey: pool, isSigner: false, isWritable: true },
                    { pubkey: token_ata, isSigner: false, isWritable: true },
                    { pubkey: wsol_ata, isSigner: false, isWritable: true },
                    { pubkey: base_vault, isSigner: false, isWritable: true },
                    { pubkey: quote_vault, isSigner: false, isWritable: true },
                    { pubkey: mint, isSigner: false, isWritable: false },
                    { pubkey: SOL_MINT, isSigner: false, isWritable: false },
                    { pubkey: seller.publicKey, isSigner: true, isWritable: false },
                    { pubkey: token_program, isSigner: false, isWritable: false },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: METEORA_DBC_PROGRAM_ID, isSigner: false, isWritable: true },
                    { pubkey: METEORA_DBC_EVENT_AUTHORITY, isSigner: false, isWritable: false },
                    { pubkey: METEORA_DBC_PROGRAM_ID, isSigner: false, isWritable: false }
                ],
                programId: METEORA_DBC_PROGRAM_ID,
                data: instruction_data
            }),
            createCloseAccountInstruction(wsol_ata, seller.publicKey, seller.publicKey)
        ];
    }

    private async get_buy_damm_v2_instructions(
        sol_amount: number,
        buyer: Signer,
        mint_meta: MeteoraMintMeta,
        slippage: number
    ): Promise<TransactionInstruction[]> {
        return this.get_damm_v2_swap_instructions(
            BigInt(Math.floor(sol_amount * LAMPORTS_PER_SOL)),
            buyer,
            mint_meta,
            true,
            slippage
        );
    }

    private async get_sell_damm_v2_instructions(
        token_amount: TokenAmount,
        seller: Signer,
        mint_meta: MeteoraMintMeta,
        slippage: number
    ): Promise<TransactionInstruction[]> {
        if (token_amount.amount === null) throw new Error(`Invalid token amount: ${token_amount.amount}`);
        return this.get_damm_v2_swap_instructions(BigInt(token_amount.amount), seller, mint_meta, false, slippage);
    }

    private async get_damm_v2_swap_instructions(
        amount_in: bigint,
        trader: Signer,
        mint_meta: MeteoraMintMeta,
        buy: boolean,
        slippage: number
    ): Promise<TransactionInstruction[]> {
        if (!mint_meta.pool || !mint_meta.damm_v2_data) throw new Error('Incomplete DAMM v2 pool data.');
        if (amount_in <= 0n) throw new RangeError('DAMM v2 swap amount must be positive.');

        const pool = new PublicKey(mint_meta.pool);
        const pool_info = await global.CONNECTION.getAccountInfo(pool, COMMITMENT);
        if (!pool_info) throw new Error('DAMM v2 pool not found.');
        const state = DAMMV2StateStruct.decode(pool_info.data);
        const input_mint = buy ? SOL_MINT : mint_meta.mint_pubkey;
        const output_mint = buy ? mint_meta.mint_pubkey : SOL_MINT;
        const input_program = await this.get_token_program(input_mint);
        const output_program = await this.get_token_program(output_mint);
        if (!state.token_a_mint.equals(input_mint) && !state.token_b_mint.equals(input_mint))
            throw new Error('DAMM v2 pool does not contain the input mint.');
        if (!state.token_a_mint.equals(output_mint) && !state.token_b_mint.equals(output_mint))
            throw new Error('DAMM v2 pool does not contain the output mint.');
        const input_is_token_a = state.token_a_mint.equals(input_mint);
        const input_ata = trade.calc_ata(trader.publicKey, input_mint, input_program);
        const output_ata = trade.calc_ata(trader.publicKey, output_mint, output_program);
        const minimum_amount_out = this.calc_damm_v2_minimum_amount_out(amount_in, input_is_token_a, state, slippage);
        const [pool_authority] = PublicKey.findProgramAddressSync(
            [Buffer.from('pool_authority')],
            METEORA_DAMM_V2_PROGRAM_ID
        );
        const [event_authority] = PublicKey.findProgramAddressSync(
            [Buffer.from('__event_authority')],
            METEORA_DAMM_V2_PROGRAM_ID
        );
        const instructions: TransactionInstruction[] = [
            createAssociatedTokenAccountIdempotentInstruction(
                trader.publicKey,
                output_ata,
                trader.publicKey,
                output_mint,
                output_program
            ),
            createAssociatedTokenAccountIdempotentInstruction(
                trader.publicKey,
                input_ata,
                trader.publicKey,
                input_mint,
                input_program
            )
        ];
        if (buy) {
            instructions.push(
                SystemProgram.transfer({ fromPubkey: trader.publicKey, toPubkey: input_ata, lamports: amount_in }),
                createSyncNativeInstruction(input_ata)
            );
        }
        instructions.push(
            new TransactionInstruction({
                keys: [
                    { pubkey: pool_authority, isSigner: false, isWritable: false },
                    { pubkey: pool, isSigner: false, isWritable: true },
                    { pubkey: input_ata, isSigner: false, isWritable: true },
                    { pubkey: output_ata, isSigner: false, isWritable: true },
                    { pubkey: state.token_a_vault, isSigner: false, isWritable: true },
                    { pubkey: state.token_b_vault, isSigner: false, isWritable: true },
                    { pubkey: state.token_a_mint, isSigner: false, isWritable: false },
                    { pubkey: state.token_b_mint, isSigner: false, isWritable: false },
                    { pubkey: trader.publicKey, isSigner: true, isWritable: false },
                    {
                        pubkey: state.token_a_mint.equals(input_mint) ? input_program : output_program,
                        isSigner: false,
                        isWritable: false
                    },
                    {
                        pubkey: state.token_b_mint.equals(input_mint) ? input_program : output_program,
                        isSigner: false,
                        isWritable: false
                    },
                    { pubkey: METEORA_DAMM_V2_PROGRAM_ID, isSigner: false, isWritable: true },
                    { pubkey: event_authority, isSigner: false, isWritable: false },
                    { pubkey: METEORA_DAMM_V2_PROGRAM_ID, isSigner: false, isWritable: false }
                ],
                programId: METEORA_DAMM_V2_PROGRAM_ID,
                data: this.damm_v2_swap_data(amount_in, minimum_amount_out)
            }),
            createCloseAccountInstruction(buy ? input_ata : output_ata, trader.publicKey, trader.publicKey)
        );
        return instructions;
    }
}
