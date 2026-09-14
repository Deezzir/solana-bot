import {
    AddressLookupTableAccount,
    AccountInfo,
    Commitment,
    Keypair,
    PublicKey,
    SYSVAR_INSTRUCTIONS_PUBKEY,
    SystemProgram,
    TokenAmount,
    TransactionInstruction
} from '@solana/web3.js';
import * as common from '../common/common';
import * as trade from '../common/trade_common';
import { get_quote_info, normalize_quote_mint, prepare_quote_account, quote_metrics } from '../common/trade_common';
import {
    COMMITMENT,
    IPFS,
    METAPLEX_META_SEED,
    METAPLEX_PROGRAM_ID,
    METEORA_DAMM_V2_API_URL,
    METEORA_CONFIG_HEADER,
    METEORA_DBC_CLAIM_CREATOR_FEE_DISCRIMINATOR,
    METEORA_DBC_CREATE_DISCRIMINATOR,
    METEORA_DBC_CREATE_TOKEN_2022_DISCRIMINATOR,
    METEORA_DAMM_V2_PROGRAM_ID,
    METEORA_DAMM_V2_CLAIM_POSITION_FEE_DISCRIMINATOR,
    METEORA_DAMM_V2_CLAIM_REWARD_DISCRIMINATOR,
    METEORA_DAMM_V2_STATE_HEADER,
    METEORA_DBC_EVENT_AUTHORITY,
    METEORA_DBC_POOL_AUTHORITY,
    METEORA_DBC_PARAMS,
    METEORA_DBC_POOL_SEED,
    METEORA_DBC_VAULT_SEED,
    METEORA_DBC_PROGRAM_ID,
    METEORA_DBC_STATE_HEADER,
    METEORA_LTA_ACCOUNT,
    METEORA_SWAP_DISCRIMINATOR,
    METEORA_SWAP2_DISCRIMINATOR,
    SOL_MINT,
    TOKEN_METADATA_MAX_BYTES,
    PROGRAM_COMPUTE_UNIT_LIMITS
} from '../constants';
import base58 from 'bs58';
import {
    createAssociatedTokenAccountIdempotentInstruction,
    createCloseAccountInstruction,
    createSyncNativeInstruction,
    decode_token_account,
    decode_mint_account,
    TOKEN_2022_PROGRAM_ID,
    TOKEN_PROGRAM_ID
} from '../common/token';
import {
    bytes,
    define_decoder_struct,
    discriminator,
    pubkey,
    skip,
    u128,
    u16,
    u32,
    u8,
    u64
} from '../common/struct_decoder';
import {
    FEE_DENOMINATOR,
    ONE_Q128,
    quote_exact_in,
    damm_fee_numerator,
    TradeDirection,
    CollectFeeMode,
    damm_u256_le
} from './damm_math';
import { DBCQuoteState, dbc_fee_numerator, dbc_rate_limiter_active, quote_dbc_exact_in } from './dbc_math';

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
    quote: DBCQuoteState;
};

type PoolAccount = trade.ProgramAccount & { slot?: bigint };

type MintInfo = {
    token_program: PublicKey;
    extensions: ReturnType<typeof decode_mint_account>['extensions'];
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
    quote: DBCQuoteState;
    creation?: boolean;
};

type MeteoraClaimableAsset = trade.ClaimableAsset & {
    pool: PublicKey;
    kind?: 'damm_fee' | 'damm_reward';
    state?: ReturnType<typeof DBCStateStruct.decode>;
    config?: ReturnType<typeof DBCConfigStruct.decode>;
    damm_state?: ReturnType<typeof DAMMV2StateStruct.decode>;
    position?: PublicKey;
    position_nft_account?: PublicKey;
    reward_index?: number;
    token_program?: PublicKey;
};

const METEORA_COMPUTE_UNIT_LIMIT = PROGRAM_COMPUTE_UNIT_LIMITS[common.Program.Meteora];

class MeteoraMintMeta implements trade.IMintMeta {
    mint!: string;
    quote_mint: string = SOL_MINT.toBase58();
    name: string = 'Unknown';
    symbol: string = 'Unknown';
    pool!: string;

    sol_reserves: bigint = 0n;
    token_reserves: bigint = 0n;
    total_supply: bigint = 0n;
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

    public get token_quote_mc(): number {
        return this.market_cap;
    }

    public get migrated(): boolean {
        return this.damm_v2_data !== undefined;
    }

    public get platform_fee(): number {
        return this.fee;
    }

    public get mint_pubkey(): PublicKey {
        return new PublicKey(this.mint);
    }

    public get quote_mint_pubkey(): PublicKey {
        return new PublicKey(this.quote_mint);
    }

    public get token_program(): PublicKey {
        return new PublicKey(this.token_program_id);
    }

    public serialize(): trade.SerializedMintMeta {
        return {
            token_quote_mc: this.token_quote_mc,
            mint_pubkey: this.mint_pubkey.toBase58(),
            quote_mint_pubkey: this.quote_mint_pubkey.toBase58(),
            token_program: this.token_program.toBase58(),
            migrated: this.migrated,
            platform_fee: this.platform_fee,
            token_name: this.token_name,
            token_symbol: this.token_symbol,
            token_mint: this.token_mint,

            mint: this.mint,
            quote_mint: this.quote_mint,
            name: this.name,
            symbol: this.symbol,
            pool: this.pool,
            sol_reserves: this.sol_reserves.toString(),
            token_reserves: this.token_reserves.toString(),
            total_supply: this.total_supply.toString(),
            complete: this.complete,
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
            quote_mint: normalize_quote_mint(data.quote_mint as string | undefined).toBase58(),
            name: data.name as string,
            symbol: data.symbol as string,
            pool: data.pool as string,
            sol_reserves: BigInt(data.sol_reserves as string),
            token_reserves: BigInt(data.token_reserves as string),
            total_supply: BigInt(data.total_supply as string),
            complete: data.complete as boolean,
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
    protocol_fee_percent: u8(),
    pool_fee_padding_0: skip(1),
    referral_fee_percent: u8(),
    pool_fee_padding_1: skip(3),
    compounding_fee_bps: u16(),
    dynamic_fee_initialized: u8(),
    dynamic_fee_padding: skip(7),
    dynamic_fee_max_volatility_accumulator: skip(4),
    dynamic_fee_variable_fee_control: u32(),
    dynamic_fee_bin_step: u16(),
    dynamic_fee_padding_0: skip(14),
    dynamic_fee_price_references: skip(32),
    dynamic_fee_volatility_accumulator: u128(),
    dynamic_fee_padding_1: skip(16),
    init_sqrt_price: u128(),
    token_a_mint: pubkey(),
    token_b_mint: pubkey(),
    token_a_vault: pubkey(),
    token_b_vault: pubkey(),
    whitelisted_vault: skip(32),
    pool_padding_0: skip(32),
    liquidity: u128(),
    pool_padding_1: skip(16),
    protocol_a_fee: skip(8),
    protocol_b_fee: skip(8),
    pool_padding_2: skip(16),
    sqrt_min_price: u128(),
    sqrt_max_price: u128(),
    sqrt_price: u128(),
    activation_point: u64(),
    activation_type: u8(),
    pool_status: u8(),
    token_a_flag: u8(),
    token_b_flag: u8(),
    collect_fee_mode: u8(),
    pool_type: skip(1),
    fee_version: u8(),
    pool_padding_3: skip(1),
    fee_a_per_liquidity: bytes(32),
    fee_b_per_liquidity: bytes(32),
    permanent_lock_liquidity: skip(16),
    metrics: skip(80),
    creator: skip(32),
    token_a_amount: u64(),
    token_b_amount: u64(),
    layout_version: u8(),
    pool_padding_4: skip(7),
    pool_padding_5: skip(24),
    reward_infos: bytes(384)
});

const DAMMV2PositionStruct = define_decoder_struct({
    discriminator: discriminator(Buffer.from([170, 188, 143, 228, 122, 64, 247, 208])),
    pool: pubkey(),
    nft_mint: pubkey(),
    fee_a_checkpoint: bytes(32),
    fee_b_checkpoint: bytes(32),
    fee_a_pending: u64(),
    fee_b_pending: u64(),
    unlocked_liquidity: u128(),
    vested_liquidity: u128(),
    permanent_locked_liquidity: u128(),
    metrics: skip(16),
    reward_infos: bytes(96),
    padding: skip(96)
});
const DBCCurvePointStruct = define_decoder_struct({ sqrt_price: u128(), liquidity: u128() });

const DBCConfigStruct = define_decoder_struct({
    discriminator: discriminator(Buffer.from(METEORA_CONFIG_HEADER)),
    quote_mint: pubkey(),
    fee_claimer: skip(32),
    leftover_receiver: skip(32),
    cliff_fee_numerator: u64(),
    period_frequency: u64(),
    reduction_factor: u64(),
    number_of_periods: u16(),
    base_fee_mode: u8(),
    base_fee_padding: skip(5),
    dynamic_fee_initialized: u8(),
    dynamic_fee_padding: skip(7),
    max_volatility_accumulator: u32(),
    variable_fee_control: u32(),
    bin_step: u16(),
    filter_period: u16(),
    decay_period: u16(),
    dynamic_reduction_factor: u16(),
    dynamic_fee_padding_2: skip(8),
    bin_step_u128: u128(),
    liquidity_vesting_padding: skip(48),
    collect_fee_mode: u8(),
    migration_option: u8(),
    activation_type: u8(),
    token_decimal: u8(),
    version: skip(1),
    token_type: u8(),
    quote_token_flag: u8(),
    partner_locked_lp_percentage: skip(1),
    partner_lp_percentage: skip(1),
    creator_locked_lp_percentage: skip(1),
    creator_lp_percentage: skip(1),
    migration_fee_option: skip(1),
    fixed_token_supply_flag: u8(),
    creator_trading_fee_percentage: skip(1),
    config_padding: skip(10),
    swap_base_amount: u64(),
    migration_quote_threshold: u64(),
    migration_base_threshold: u64(),
    migration_sqrt_price: u128(),
    vesting_amount_per_period: u64(),
    vesting_cliff_duration: skip(8),
    vesting_frequency: skip(8),
    vesting_number_of_periods: u64(),
    vesting_cliff_unlock_amount: u64(),
    vesting_padding: skip(8),
    pre_migration_token_supply: u64(),
    post_migration_token_supply: skip(8),
    config_padding_3: skip(5),
    enable_first_swap_with_min_fee: u8(),
    config_padding_4: skip(26),
    sqrt_start_price: u128(),
    curve: {
        size: METEORA_DBC_PARAMS.curve_points * DBCCurvePointStruct.get_size(),
        decode: (data: Buffer, offset: number) => {
            const curve: ReturnType<typeof DBCCurvePointStruct.decode>[] = [];
            for (let i = 0; i < METEORA_DBC_PARAMS.curve_points; i++) {
                const point = DBCCurvePointStruct.decode(data.subarray(offset + i * DBCCurvePointStruct.get_size()));
                if (point.liquidity === 0n || point.sqrt_price === 0n) break;
                curve.push(point);
            }
            return curve;
        }
    }
});

const DBCStateStruct = define_decoder_struct({
    discriminator: discriminator(Buffer.from(METEORA_DBC_STATE_HEADER)),
    last_update_timestamp: u64(),
    volatility_padding: skip(8),
    sqrt_price_reference: u128(),
    volatility_accumulator: u128(),
    volatility_reference: u128(),
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
    activation_point: u64(),
    pool_type: skip(1),
    is_migrated: u8(),
    state_flags: skip(5),
    state_padding_2: skip(33),
    finish_curve_timestamp: skip(8),
    creator_base_fee: u64(),
    creator_quote_fee: u64()
});
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

    public async get_rewards(trader: Keypair): Promise<MeteoraClaimableAsset[]> {
        const pools = await trade.get_program_accounts_v2(METEORA_DBC_PROGRAM_ID, [
            { memcmp: { offset: DBCStateStruct.get_offset('creator'), bytes: trader.publicKey.toBase58() } },
            { memcmp: { offset: 0, bytes: base58.encode(METEORA_DBC_STATE_HEADER) } }
        ]);

        const assets = await Promise.all(
            pools.map(async ({ pubkey, account }) => {
                const state = DBCStateStruct.decode(account.data);
                if (state.creator_base_fee === 0n && state.creator_quote_fee === 0n) return [];

                const config_info = await global.CONNECTION.getAccountInfo(state.config, COMMITMENT);
                if (!config_info) {
                    return [];
                }

                const config = DBCConfigStruct.decode(config_info.data);
                if (config.token_type !== 0 || config.quote_token_flag !== 0) {
                    return [];
                }
                const claimable: MeteoraClaimableAsset[] = [];
                if (state.creator_base_fee > 0n) {
                    const supply = await trade.get_token_supply(state.base_mint);
                    claimable.push({
                        mint: state.base_mint,
                        raw_amount: state.creator_base_fee,
                        decimals: supply.decimals,
                        source: 'creator_reward' as const,
                        state,
                        config,
                        pool: pubkey
                    });
                }
                if (state.creator_quote_fee > 0n) {
                    const quote = await get_quote_info(config.quote_mint);
                    claimable.push({
                        mint: config.quote_mint,
                        raw_amount: state.creator_quote_fee,
                        decimals: quote.decimals,
                        source: 'creator_reward' as const,
                        state,
                        config,
                        pool: pubkey
                    });
                }
                return claimable;
            })
        );
        return [...assets.flat(), ...(await this.get_damm_v2_position_rewards(trader))];
    }

    public async claim_rewards_instructions(
        trader: Keypair,
        assets: MeteoraClaimableAsset[]
    ): Promise<TransactionInstruction[]> {
        if (assets.length === 0) throw new Error(`No assets were provided`);

        const created_atas = new Set<string>();
        const add_ata = async (mint: PublicKey) => {
            const ata = await trade.calc_ata(trader.publicKey, mint);
            if (!created_atas.has(ata.toBase58())) {
                instructions.push(
                    createAssociatedTokenAccountIdempotentInstruction(trader, ata, trader.publicKey, mint)
                );
                created_atas.add(ata.toBase58());
            }
            return ata;
        };

        const instructions: TransactionInstruction[] = [];

        const claimed_pools = new Set<string>();
        const claimed_positions = new Set<string>();
        for (const asset of assets) {
            if (asset.kind) {
                if (!asset.damm_state || !asset.position || !asset.position_nft_account) continue;
                if (asset.kind === 'damm_fee') {
                    if (claimed_positions.has(asset.position.toBase58())) continue;
                    claimed_positions.add(asset.position.toBase58());
                }
                const state = asset.damm_state;
                const [token_a_program, token_b_program] = await Promise.all([
                    this.get_token_program(state.token_a_mint),
                    this.get_token_program(state.token_b_mint)
                ]);
                const token_a_ata = await trade.calc_ata(trader.publicKey, state.token_a_mint, token_a_program);
                const token_b_ata = await trade.calc_ata(trader.publicKey, state.token_b_mint, token_b_program);
                for (const [mint, ata, program] of [
                    [state.token_a_mint, token_a_ata, token_a_program],
                    [state.token_b_mint, token_b_ata, token_b_program]
                ] as const) {
                    if (!created_atas.has(ata.toBase58())) {
                        instructions.push(
                            createAssociatedTokenAccountIdempotentInstruction(
                                trader,
                                ata,
                                trader.publicKey,
                                mint,
                                program
                            )
                        );
                        created_atas.add(ata.toBase58());
                    }
                }
                const [pool_authority] = await PublicKey.findProgramAddress(
                    [Buffer.from('pool_authority')],
                    METEORA_DAMM_V2_PROGRAM_ID
                );
                const [event_authority] = await PublicKey.findProgramAddress(
                    [Buffer.from('__event_authority')],
                    METEORA_DAMM_V2_PROGRAM_ID
                );
                if (asset.kind === 'damm_fee') {
                    instructions.push(
                        new TransactionInstruction({
                            programId: METEORA_DAMM_V2_PROGRAM_ID,
                            data: Buffer.from(METEORA_DAMM_V2_CLAIM_POSITION_FEE_DISCRIMINATOR),
                            keys: [
                                { pubkey: pool_authority, isSigner: false, isWritable: false },
                                { pubkey: asset.pool, isSigner: false, isWritable: false },
                                { pubkey: asset.position, isSigner: false, isWritable: true },
                                { pubkey: token_a_ata, isSigner: false, isWritable: true },
                                { pubkey: token_b_ata, isSigner: false, isWritable: true },
                                { pubkey: state.token_a_vault, isSigner: false, isWritable: true },
                                { pubkey: state.token_b_vault, isSigner: false, isWritable: true },
                                { pubkey: state.token_a_mint, isSigner: false, isWritable: false },
                                { pubkey: state.token_b_mint, isSigner: false, isWritable: false },
                                { pubkey: asset.position_nft_account, isSigner: false, isWritable: false },
                                { pubkey: trader.publicKey, isSigner: true, isWritable: false },
                                { pubkey: token_a_program, isSigner: false, isWritable: false },
                                { pubkey: token_b_program, isSigner: false, isWritable: false },
                                { pubkey: event_authority, isSigner: false, isWritable: false },
                                { pubkey: METEORA_DAMM_V2_PROGRAM_ID, isSigner: false, isWritable: false }
                            ]
                        })
                    );
                } else if (asset.reward_index !== undefined && asset.token_program) {
                    const reward_ata = await trade.calc_ata(trader.publicKey, asset.mint, asset.token_program);
                    if (!created_atas.has(reward_ata.toBase58())) {
                        instructions.push(
                            createAssociatedTokenAccountIdempotentInstruction(
                                trader,
                                reward_ata,
                                trader.publicKey,
                                asset.mint,
                                asset.token_program
                            )
                        );
                        created_atas.add(reward_ata.toBase58());
                    }
                    const data = Buffer.from([...METEORA_DAMM_V2_CLAIM_REWARD_DISCRIMINATOR, asset.reward_index, 0]);
                    const reward = this.damm_reward_info(state.reward_infos, asset.reward_index);
                    instructions.push(
                        new TransactionInstruction({
                            programId: METEORA_DAMM_V2_PROGRAM_ID,
                            data,
                            keys: [
                                { pubkey: pool_authority, isSigner: false, isWritable: false },
                                { pubkey: asset.pool, isSigner: false, isWritable: true },
                                { pubkey: asset.position, isSigner: false, isWritable: true },
                                { pubkey: reward.vault, isSigner: false, isWritable: true },
                                { pubkey: asset.mint, isSigner: false, isWritable: false },
                                { pubkey: reward_ata, isSigner: false, isWritable: true },
                                { pubkey: asset.position_nft_account, isSigner: false, isWritable: false },
                                { pubkey: trader.publicKey, isSigner: true, isWritable: false },
                                { pubkey: asset.token_program, isSigner: false, isWritable: false },
                                { pubkey: event_authority, isSigner: false, isWritable: false },
                                { pubkey: METEORA_DAMM_V2_PROGRAM_ID, isSigner: false, isWritable: false }
                            ]
                        })
                    );
                }
                continue;
            }
            if (claimed_pools.has(asset.pool.toBase58())) continue;
            claimed_pools.add(asset.pool.toBase58());
            const state = asset.state!;
            const config = asset.config!;

            const base_ata = await add_ata(state.base_mint);
            const quote_ata = await add_ata(config.quote_mint);
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
        return instructions;
    }

    public async buy_token_instructions(
        amount: TokenAmount,
        buyer: Keypair,
        mint_meta: MeteoraMintMeta,
        slippage: number
    ): Promise<[TransactionInstruction[], AddressLookupTableAccount[]?]> {
        trade.validate_trade_parameters(amount, slippage);
        const lta = await trade.get_ltas([METEORA_LTA_ACCOUNT]);
        if (mint_meta.migrated) {
            if (!mint_meta.damm_v2_data) throw new Error('Missing DAMM v2 pool data.');
            return [await this.get_buy_damm_v2_instructions(amount, buyer, mint_meta, slippage), lta];
        }
        return [await this.get_buy_dbc_instructions(amount, buyer, mint_meta, slippage), lta];
    }

    public async sell_token_instructions(
        token_amount: TokenAmount,
        seller: Keypair,
        mint_meta: MeteoraMintMeta,
        slippage: number
    ): Promise<[TransactionInstruction[], AddressLookupTableAccount[]?]> {
        trade.validate_trade_parameters(token_amount, slippage);
        const lta = await trade.get_ltas([METEORA_LTA_ACCOUNT]);
        if (mint_meta.migrated) {
            if (!mint_meta.damm_v2_data) throw new Error('Missing DAMM v2 pool data.');
            return [await this.get_sell_damm_v2_instructions(token_amount, seller, mint_meta, slippage), lta];
        }
        return [await this.get_sell_dbc_instructions(token_amount, seller, mint_meta, slippage), lta];
    }

    public async buy_sell_instructions(
        amount: TokenAmount,
        trader: Keypair,
        mint_meta: MeteoraMintMeta,
        slippage: number
    ): Promise<[TransactionInstruction[], TransactionInstruction[], AddressLookupTableAccount[]?]> {
        trade.validate_trade_parameters(amount, slippage);
        const quote_amount_raw = BigInt(amount.amount);
        let buy_instructions: TransactionInstruction[];
        let token_amount_raw: bigint;
        if (mint_meta.migrated) {
            const result = await this.get_damm_v2_swap_instructions(
                quote_amount_raw,
                trader,
                mint_meta,
                'buy',
                slippage,
                true
            );
            buy_instructions = result.instructions;
            token_amount_raw = result.output_amount;
        } else {
            if (dbc_rate_limiter_active(mint_meta.dbc_data!.quote))
                throw new Error(
                    'DBC rate-limited pools do not allow atomic buy/sell cycles while the limiter is active.'
                );
            token_amount_raw = this.calc_dbc_token_amount_raw(quote_amount_raw, mint_meta.dbc_data!);
            buy_instructions = await this.get_buy_dbc_instructions(
                amount,
                trader,
                mint_meta,
                slippage,
                token_amount_raw
            );
            mint_meta = this.update_mint_meta_reserves(new MeteoraMintMeta({ ...mint_meta }), amount, 'buy');
            if (mint_meta.complete)
                throw new Error('An atomic buy/sell cannot complete the DBC curve. Reduce the buy amount.');
        }
        const [sell_instructions, lta] = await this.sell_token_instructions(
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

    public async create_token_instructions(
        mint: Keypair,
        creator: Keypair,
        token_name: string,
        token_symbol: string,
        meta_cid: string,
        config?: object,
        creator_buy: boolean = false
    ): Promise<trade.CreateTokenInstructions> {
        const config_address = config && 'config' in config ? config.config : undefined;
        if (typeof config_address !== 'string')
            throw new Error('Meteora creation requires a DBC config address in config.config.');
        const config_pubkey = new PublicKey(config_address);
        const account = await global.CONNECTION.getAccountInfo(config_pubkey, COMMITMENT);
        if (!account || !account.owner.equals(METEORA_DBC_PROGRAM_ID))
            throw new Error('Invalid Meteora DBC config account.');
        const config_data = DBCConfigStruct.decode(account.data);
        const quote_info = await get_quote_info(config_data.quote_mint);
        if (config_data.quote_token_flag !== (quote_info.token_program.equals(TOKEN_PROGRAM_ID) ? 0 : 1))
            throw new Error('DBC quote token program does not match its config.');
        if (config_data.token_type !== 0 && config_data.token_type !== 1)
            throw new Error('Unsupported DBC token type.');
        if (config_data.base_fee_mode !== 0 && config_data.base_fee_mode !== 1)
            throw new Error('New DBC pools require a linear or exponential fee scheduler.');
        if (config_data.migration_option !== 1) throw new Error('New DBC pools require DAMM v2 migration.');

        const mint_meta = await this.create_mint_meta(
            mint.publicKey,
            config_pubkey,
            config_data,
            token_name,
            token_symbol,
            quote_info.decimals
        );
        const create_instructions = await this.get_create_token_instructions(
            creator,
            token_name,
            token_symbol,
            meta_cid,
            mint,
            mint_meta
        );

        if (!creator_buy) mint_meta.dbc_data!.quote.first_swap_with_min_fee = false;
        const ltas = global.TRANSACTION_VERSION === 1 ? [] : await trade.get_ltas(this.get_lta_addresses());
        return { instructions: create_instructions, mint_meta, ltas };
    }

    public create_token_metadata(meta: common.IPFSMetadata, image_path: string): Promise<string> {
        return common.upload_metadata_ipfs(meta, image_path);
    }

    public async get_random_mints(count: number): Promise<MeteoraMintMeta[]> {
        return trade.sample_mint_sources(
            count,
            (size) => this.get_random_graduated_mints(size),
            (size) => this.get_random_ungraduated_mints(size)
        );
    }

    public async get_mint_meta(mint: PublicKey): Promise<MeteoraMintMeta | undefined> {
        try {
            let mint_meta = await this.default_mint_meta(mint);
            mint_meta = await this.update_mint_meta(mint_meta);
            return mint_meta;
        } catch (error) {
            console.error(`Error fetching mint meta: ${error}`);
            return undefined;
        }
    }

    public get_compute_unit_limit(): number | undefined {
        return METEORA_COMPUTE_UNIT_LIMIT;
    }

    public async subscribe_mint_meta(
        mint_meta: MeteoraMintMeta,
        callback: (mint_meta: MeteoraMintMeta) => void,
        commitment: Commitment = COMMITMENT
    ): Promise<() => void> {
        if (!mint_meta.dbc_data && !mint_meta.damm_v2_data) mint_meta = await this.update_mint_meta(mint_meta);
        const quote = await get_quote_info(mint_meta.quote_mint_pubkey);
        let dbc_sub: number | undefined;
        let damm_sub: number | undefined;
        let stopped = false;
        let current_mint_meta = mint_meta;
        let latest_slot = 0n;
        let damm_started = false;

        const publish = (update: MeteoraMintMeta, slot: bigint = 0n) => {
            if (stopped || (slot && slot < latest_slot)) return;
            if (slot) latest_slot = slot;
            current_mint_meta = update;
            callback(update);
        };
        const unsubscribe = (id: number | undefined) => {
            if (id !== undefined) global.CONNECTION.removeAccountChangeListener(id).catch(() => {});
        };
        const subscribe_damm = async (pool: trade.ProgramAccount, slot?: bigint) => {
            if (damm_started) return;
            damm_started = true;
            publish(await this.damm_v2_mint_meta(current_mint_meta, pool, slot, quote.decimals), slot);
            damm_sub = global.CONNECTION.onAccountChange(
                pool.pubkey,
                (account, context) => {
                    if (stopped) return;
                    void this.damm_v2_mint_meta(
                        current_mint_meta,
                        { pubkey: pool.pubkey, account },
                        context.slot,
                        quote.decimals
                    )
                        .then((meta) => publish(meta, context.slot))
                        .catch((error) => common.warn(`Failed to update DAMM metadata: ${error}`));
                },
                { commitment }
            );
        };
        const mint = new PublicKey(mint_meta.mint);
        if (mint_meta.migrated) {
            const pool = await this.get_pool(new PublicKey(mint_meta.pool), commitment);
            await subscribe_damm(pool, pool.slot);
        } else {
            const dbc_pool = new PublicKey(mint_meta.pool);
            const process_dbc = async (account: AccountInfo<Uint8Array>, slot: bigint = 0n) => {
                if (stopped || damm_started || (slot && slot < latest_slot)) return;
                const state = DBCStateStruct.decode(account.data);
                const quote_state = this.dbc_quote_state(state, current_mint_meta.dbc_data!.quote.config, slot);
                const metrics = quote_metrics(
                    this.calc_token_price(common.read_biguint_le(state.sqrt_price, 0, 16)),
                    current_mint_meta.total_supply,
                    quote.decimals,
                    current_mint_meta.token_decimal
                );
                publish(
                    new MeteoraMintMeta({
                        ...current_mint_meta,
                        pool: dbc_pool.toBase58(),
                        sol_reserves: state.quote_reserve,
                        token_reserves: state.base_reserve,
                        dbc_data: {
                            sqrt_price: common.read_biguint_le(state.sqrt_price, 0, 16),
                            base_vault: state.base_vault.toBase58(),
                            quote_vault: state.quote_vault.toBase58(),
                            config: state.config.toBase58(),
                            quote: quote_state
                        },
                        complete: state.quote_reserve >= quote_state.config.migration_quote_threshold,
                        fee: Number(dbc_fee_numerator(quote_state, 0n, 'buy')) / Number(FEE_DENOMINATOR),
                        market_cap: metrics.mcap_quote
                    }),
                    slot
                );
                if (state.is_migrated !== 1 || damm_started) return;
                const migrated = await this.get_damm_from_mint(mint, current_mint_meta.quote_mint_pubkey);
                if (!migrated || (slot && slot < latest_slot)) return;
                unsubscribe(dbc_sub);
                dbc_sub = undefined;
                await subscribe_damm(migrated, slot);
            };

            dbc_sub = global.CONNECTION.onAccountChange(
                dbc_pool,
                (account, context) => void process_dbc(account, context.slot),
                { commitment }
            );
            const response = await global.CONNECTION.getAccountInfoAndContext(dbc_pool, commitment);
            if (response.value) await process_dbc(response.value, response.context.slot);
        }
        return () => {
            stopped = true;
            unsubscribe(dbc_sub);
            unsubscribe(damm_sub);
        };
    }

    public async update_mint_meta(mint_meta: MeteoraMintMeta): Promise<MeteoraMintMeta> {
        try {
            const mint = new PublicKey(mint_meta.mint);
            if (mint_meta.migrated) {
                const pool = await this.get_pool(new PublicKey(mint_meta.pool));
                return this.damm_v2_mint_meta(mint_meta, pool, pool.slot);
            }
            const dbc_pool = mint_meta.dbc_data
                ? await this.get_pool(new PublicKey(mint_meta.pool))
                : await this.get_dbc_pool_from_mint(mint);
            const state = dbc_pool ? await this.get_dbc_state(mint, dbc_pool, mint_meta) : undefined;
            if (!state || state.is_migrated) {
                const damm = await this.get_damm_from_mint(mint, state?.quote_mint);
                if (damm) return this.damm_v2_mint_meta(mint_meta, damm);
            }

            if (state) {
                const quote = await get_quote_info(state.quote_mint);
                const metrics = quote_metrics(
                    this.calc_token_price(state.sqrt_price),
                    state.total_supply,
                    quote.decimals,
                    state.token_decimals
                );
                return new MeteoraMintMeta({
                    ...mint_meta,
                    dbc_data: {
                        sqrt_price: state.sqrt_price,
                        base_vault: state.base_vault.toString(),
                        quote_vault: state.quote_vault.toString(),
                        config: state.config.toString(),
                        quote: state.quote
                    },
                    damm_v2_data: undefined,
                    sol_reserves: state.quote_reserve,
                    token_reserves: state.base_reserve,
                    total_supply: state.total_supply,
                    token_decimal: state.token_decimals,
                    pool: state.pool.toString(),
                    quote_mint: state.quote_mint.toString(),
                    complete: state.is_migrated || state.quote_reserve >= state.quote.config.migration_quote_threshold,
                    fee: Number(dbc_fee_numerator(state.quote, 0n, 'buy')) / Number(FEE_DENOMINATOR),
                    market_cap: metrics.mcap_quote
                });
            }

            throw new Error('Meteora DBC or DAMM v2 pool not found.');
        } catch (error) {
            throw new Error(`Failed to update mint meta reserves: ${error}`);
        }
    }

    public update_mint_meta_reserves(
        mint_meta: MeteoraMintMeta,
        amount: TokenAmount,
        op: trade.TradeOp
    ): MeteoraMintMeta {
        const info = mint_meta.dbc_data;
        if (!info) return mint_meta;
        const buy = op === 'buy';
        const quote = quote_dbc_exact_in(info.quote, BigInt(amount.amount), op);
        mint_meta.dbc_data = { ...info, sqrt_price: quote.next.sqrt_price, quote: quote.next };
        mint_meta.sol_reserves += buy ? quote.quote_amount : -quote.quote_amount;
        mint_meta.token_reserves += buy ? -quote.base_amount : quote.base_amount;
        mint_meta.complete = mint_meta.sol_reserves >= info.quote.config.migration_quote_threshold;
        return mint_meta;
    }

    public async default_mint_meta(mint: PublicKey, data?: object): Promise<MeteoraMintMeta> {
        const decoded = data as { name?: string; symbol?: string; pool?: string; quote_mint?: string } | undefined;
        const meta = decoded
            ? {
                  token_name: typeof decoded.name === 'string' ? decoded.name : 'Unknown',
                  token_symbol: typeof decoded.symbol === 'string' ? decoded.symbol : 'Unknown',
                  token_supply: 10 ** 18,
                  token_decimal: 9,
                  token_program: TOKEN_PROGRAM_ID
              }
            : await trade.get_token_meta(mint).catch(() => {
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
            quote_mint: decoded?.quote_mint ?? SOL_MINT.toBase58(),
            pool: typeof decoded?.pool === 'string' ? decoded.pool : undefined,
            symbol: meta.token_symbol,
            name: meta.token_name,
            complete: false,
            market_cap: 0,
            sol_reserves: 0n,
            token_reserves: 1000000000000000000n,
            total_supply: BigInt(meta.token_supply),
            token_decimal: meta.token_decimal,
            token_program_id: meta.token_program.toString()
        });
    }

    public async estimate_buy_output(
        mint_meta: MeteoraMintMeta,
        quote_amount: TokenAmount,
        slippage: number
    ): Promise<trade.OutputEstimate> {
        const raw_amount = await this.estimate_output_raw(BigInt(quote_amount.amount), mint_meta, 'buy');
        const minimum_raw_amount = trade.apply_slippage_down(raw_amount, slippage);
        return {
            expected: {
                amount: raw_amount.toString(),
                decimals: mint_meta.token_decimal,
                uiAmount: Number(raw_amount) / 10 ** mint_meta.token_decimal
            },
            minimum: {
                amount: minimum_raw_amount.toString(),
                decimals: mint_meta.token_decimal,
                uiAmount: Number(minimum_raw_amount) / 10 ** mint_meta.token_decimal
            }
        };
    }

    public async estimate_sell_output(
        mint_meta: MeteoraMintMeta,
        token_amount: TokenAmount,
        slippage: number
    ): Promise<trade.OutputEstimate> {
        const quote = await get_quote_info(mint_meta.quote_mint_pubkey);
        const raw_amount = await this.estimate_output_raw(BigInt(token_amount.amount), mint_meta, 'sell');
        const minimum_raw_amount = trade.apply_slippage_down(raw_amount, slippage);
        return {
            expected: {
                amount: raw_amount.toString(),
                decimals: quote.decimals,
                uiAmount: Number(raw_amount) / 10 ** quote.decimals
            },
            minimum: {
                amount: minimum_raw_amount.toString(),
                decimals: quote.decimals,
                uiAmount: Number(minimum_raw_amount) / 10 ** quote.decimals
            }
        };
    }

    private async estimate_output_raw(amount: bigint, mint_meta: MeteoraMintMeta, op: trade.TradeOp): Promise<bigint> {
        if (!mint_meta.migrated) {
            if (!mint_meta.dbc_data) throw new Error('Missing DBC quote state.');

            return op === 'buy'
                ? this.calc_dbc_token_amount_raw(amount, mint_meta.dbc_data)
                : this.calc_dbc_sol_amount_raw(amount, mint_meta.dbc_data);
        }

        return (await this.get_damm_v2_quote(amount, mint_meta, op)).output_amount;
    }

    private async get_damm_v2_quote(amount: bigint, mint_meta: MeteoraMintMeta, op: trade.TradeOp) {
        if (!mint_meta.pool || !mint_meta.damm_v2_data) throw new Error('Incomplete DAMM v2 pool data.');
        if (amount <= 0n) throw new RangeError('DAMM v2 swap amount must be positive.');

        const input_mint = op === 'buy' ? mint_meta.quote_mint_pubkey : mint_meta.mint_pubkey;
        const output_mint = op === 'buy' ? mint_meta.mint_pubkey : mint_meta.quote_mint_pubkey;

        const [pool, input_info, output_info] = await Promise.all([
            this.get_pool(new PublicKey(mint_meta.pool)),
            this.get_mint_info(input_mint),
            this.get_mint_info(output_mint)
        ]);

        const state = DAMMV2StateStruct.decode(pool.account.data);
        if (!state.token_a_mint.equals(input_mint) && !state.token_b_mint.equals(input_mint))
            throw new Error('DAMM v2 pool does not contain the input mint.');
        if (!state.token_a_mint.equals(output_mint) && !state.token_b_mint.equals(output_mint))
            throw new Error('DAMM v2 pool does not contain the output mint.');
        const epoch =
            input_info.token_program.equals(TOKEN_2022_PROGRAM_ID) ||
            output_info.token_program.equals(TOKEN_2022_PROGRAM_ID)
                ? (await global.CONNECTION.getEpochInfo(COMMITMENT)).epoch
                : 0n;

        const net_input = amount - this.get_damm_v2_transfer_fee(input_info, amount, epoch);

        const quote = await this.quote_damm_v2_exact_in(
            net_input,
            state.token_a_mint.equals(input_mint),
            state,
            pool.slot
        );

        return {
            pool: pool.pubkey,
            state,
            input_mint,
            output_mint,
            input_program: input_info.token_program,
            output_program: output_info.token_program,
            output_amount: quote.output_amount - this.get_damm_v2_transfer_fee(output_info, quote.output_amount, epoch)
        };
    }

    private damm_reward_info(
        data: Buffer,
        index: number
    ): {
        initialized: boolean;
        mint: PublicKey;
        vault: PublicKey;
        end: bigint;
        rate: bigint;
        stored: bigint;
        last_update: bigint;
    } {
        const offset = index * 192;
        return {
            initialized: data.readUInt8(offset) !== 0,
            mint: new PublicKey(data.subarray(offset + 16, offset + 48)),
            vault: new PublicKey(data.subarray(offset + 48, offset + 80)),
            end: data.readBigUInt64LE(offset + 120),
            rate: data.readBigUInt64LE(offset + 128) + (data.readBigUInt64LE(offset + 136) << 64n),
            stored: damm_u256_le(data.subarray(offset + 144, offset + 176)),
            last_update: data.readBigUInt64LE(offset + 176)
        };
    }

    private async get_damm_v2_position_rewards(trader: Keypair): Promise<MeteoraClaimableAsset[]> {
        const nft_accounts = await global.CONNECTION.getTokenAccountsByOwner(
            trader.publicKey,
            { programId: TOKEN_2022_PROGRAM_ID },
            COMMITMENT
        );
        const positions = await Promise.all(
            nft_accounts.value
                .filter(({ account }) => decode_token_account(account).amount === 1n)
                .map(async ({ pubkey, account }) => {
                    const nft_mint = decode_token_account(account).mint;
                    const [position] = await PublicKey.findProgramAddress(
                        [Buffer.from('position'), nft_mint.toBytes()],
                        METEORA_DAMM_V2_PROGRAM_ID
                    );
                    return { position, nft_account: pubkey };
                })
        );
        if (positions.length === 0) return [];

        const position_infos = await global.CONNECTION.getMultipleAccountsInfo(
            positions.map(({ position }) => position),
            COMMITMENT
        );
        const decoded_positions = positions.flatMap(({ position, nft_account }, index) => {
            const info = position_infos[index];
            if (!info || !info.owner.equals(METEORA_DAMM_V2_PROGRAM_ID)) return [];
            try {
                return [{ position, nft_account, state: DAMMV2PositionStruct.decode(info.data) }];
            } catch {
                return [];
            }
        });
        const pools = [...new Map(decoded_positions.map(({ state }) => [state.pool.toBase58(), state.pool])).values()];
        const pool_infos = await global.CONNECTION.getMultipleAccountsInfo(pools, COMMITMENT);
        const pool_states = new Map<string, ReturnType<typeof DAMMV2StateStruct.decode>>();
        for (let i = 0; i < pools.length; i++) {
            const info = pool_infos[i];
            if (!info || !info.owner.equals(METEORA_DAMM_V2_PROGRAM_ID)) continue;
            try {
                pool_states.set(pools[i].toBase58(), DAMMV2StateStruct.decode(info.data));
            } catch {}
        }
        if (pool_states.size === 0) return [];
        const slot = await global.CONNECTION.getSlot(COMMITMENT);
        const current_time = BigInt((await global.CONNECTION.getBlockTime(slot)) ?? 0);
        const assets: MeteoraClaimableAsset[] = [];
        for (const { position, nft_account, state: position_state } of decoded_positions) {
            const pool_state = pool_states.get(position_state.pool.toBase58());
            if (!pool_state) continue;
            const liquidity =
                position_state.unlocked_liquidity +
                position_state.vested_liquidity +
                position_state.permanent_locked_liquidity;
            const fee_a =
                position_state.fee_a_pending +
                ((liquidity *
                    (damm_u256_le(pool_state.fee_a_per_liquidity) - damm_u256_le(position_state.fee_a_checkpoint))) >>
                    128n);
            const fee_b =
                position_state.fee_b_pending +
                ((liquidity *
                    (damm_u256_le(pool_state.fee_b_per_liquidity) - damm_u256_le(position_state.fee_b_checkpoint))) >>
                    128n);
            if (fee_a > 0n || fee_b > 0n) {
                const [a_supply, b_supply] = await Promise.all([
                    trade.get_token_supply(pool_state.token_a_mint),
                    trade.get_token_supply(pool_state.token_b_mint)
                ]);
                if (fee_a > 0n)
                    assets.push({
                        mint: pool_state.token_a_mint,
                        raw_amount: fee_a,
                        decimals: a_supply.decimals,
                        source: 'position_reward',
                        kind: 'damm_fee',
                        pool: position_state.pool,
                        damm_state: pool_state,
                        position,
                        position_nft_account: nft_account
                    });
                if (fee_b > 0n)
                    assets.push({
                        mint: pool_state.token_b_mint,
                        raw_amount: fee_b,
                        decimals: b_supply.decimals,
                        source: 'position_reward',
                        kind: 'damm_fee',
                        pool: position_state.pool,
                        damm_state: pool_state,
                        position,
                        position_nft_account: nft_account
                    });
            }
            for (let index = 0; index < 2; index++) {
                const reward = this.damm_reward_info(pool_state.reward_infos, index);
                if (!reward.initialized || liquidity === 0n) continue;
                const checkpoint = damm_u256_le(position_state.reward_infos.subarray(index * 48, index * 48 + 32));
                const pending = position_state.reward_infos.readBigUInt64LE(index * 48 + 32);
                const stored =
                    reward.stored +
                    (((BigInt.asUintN(64, current_time < reward.end ? current_time : reward.end) - reward.last_update) *
                        reward.rate) <<
                        128n) /
                        pool_state.liquidity;
                const amount = pending + ((liquidity * (stored - checkpoint)) >> 192n);
                if (amount <= 0n) continue;
                const token_program = await this.get_token_program(reward.mint);
                const supply = await trade.get_token_supply(reward.mint);
                assets.push({
                    mint: reward.mint,
                    raw_amount: amount,
                    decimals: supply.decimals,
                    source: 'position_reward',
                    kind: 'damm_reward',
                    pool: position_state.pool,
                    damm_state: pool_state,
                    position,
                    position_nft_account: nft_account,
                    reward_index: index,
                    token_program
                });
            }
        }
        return assets;
    }

    private async get_create_token_instructions(
        creator: Keypair,
        token_name: string,
        token_symbol: string,
        meta_cid: string,
        mint: Keypair,
        mint_meta: MeteoraMintMeta
    ): Promise<TransactionInstruction[]> {
        const info = mint_meta.dbc_data!;
        const quote = await get_quote_info(mint_meta.quote_mint_pubkey);
        const token_2022 = mint_meta.token_program.equals(TOKEN_2022_PROGRAM_ID);
        const metadata = token_2022
            ? undefined
            : (
                  await PublicKey.findProgramAddress(
                      [METAPLEX_META_SEED, METAPLEX_PROGRAM_ID.toBytes(), mint.publicKey.toBytes()],
                      METAPLEX_PROGRAM_ID
                  )
              )[0];
        return [
            new TransactionInstruction({
                programId: METEORA_DBC_PROGRAM_ID,
                data: this.create_data(token_name, token_symbol, `${IPFS}${meta_cid}`, token_2022),
                keys: [
                    { pubkey: new PublicKey(info.config), isSigner: false, isWritable: false },
                    { pubkey: METEORA_DBC_POOL_AUTHORITY, isSigner: false, isWritable: false },
                    { pubkey: creator.publicKey, isSigner: true, isWritable: false },
                    { pubkey: mint.publicKey, isSigner: true, isWritable: true },
                    { pubkey: quote.mint, isSigner: false, isWritable: false },
                    { pubkey: new PublicKey(mint_meta.pool), isSigner: false, isWritable: true },
                    { pubkey: new PublicKey(info.base_vault), isSigner: false, isWritable: true },
                    { pubkey: new PublicKey(info.quote_vault), isSigner: false, isWritable: true },
                    ...(metadata
                        ? [
                              { pubkey: metadata, isSigner: false, isWritable: true },
                              { pubkey: METAPLEX_PROGRAM_ID, isSigner: false, isWritable: false }
                          ]
                        : []),
                    { pubkey: creator.publicKey, isSigner: true, isWritable: true },
                    { pubkey: quote.token_program, isSigner: false, isWritable: false },
                    { pubkey: mint_meta.token_program, isSigner: false, isWritable: false },
                    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                    { pubkey: METEORA_DBC_EVENT_AUTHORITY, isSigner: false, isWritable: false },
                    { pubkey: METEORA_DBC_PROGRAM_ID, isSigner: false, isWritable: false }
                ]
            })
        ];
    }

    private create_data(name: string, symbol: string, uri: string, token_2022: boolean): Buffer {
        const string = (value: string, max_length: number) => {
            const length = Buffer.byteLength(value);
            if (length > max_length) throw new Error(`Token metadata exceeds ${max_length} bytes.`);
            const data = Buffer.alloc(4 + length);
            data.writeUInt32LE(length);
            data.write(value, 4);
            return data;
        };
        return Buffer.concat([
            Buffer.from(token_2022 ? METEORA_DBC_CREATE_TOKEN_2022_DISCRIMINATOR : METEORA_DBC_CREATE_DISCRIMINATOR),
            string(name, TOKEN_METADATA_MAX_BYTES.name),
            string(symbol, TOKEN_METADATA_MAX_BYTES.symbol),
            string(uri, TOKEN_METADATA_MAX_BYTES.uri)
        ]);
    }

    private async get_random_ungraduated_mints(count: number): Promise<MeteoraMintMeta[]> {
        if (count <= 0) return [];
        const limit = Math.min(100, Math.max(20, count * 3));
        try {
            const pools = await trade.get_program_accounts_v2(
                METEORA_DBC_PROGRAM_ID,
                [
                    { memcmp: { offset: 0, bytes: base58.encode(METEORA_DBC_STATE_HEADER) } },
                    {
                        memcmp: {
                            offset: DBCStateStruct.get_offset('is_migrated'),
                            bytes: base58.encode(Buffer.from([0]))
                        }
                    }
                ],
                { offset: DBCStateStruct.get_offset('base_mint'), length: 32 },
                limit
            );
            return trade.resolve_random_mints(
                pools.map((pool) => new PublicKey(pool.account.data).toBase58()),
                count,
                async (mint) => {
                    const meta = await this.get_mint_meta(mint);
                    return meta && !meta.migrated && meta.sol_reserves > 0n && meta.token_reserves > 0n
                        ? meta
                        : undefined;
                }
            );
        } catch (error) {
            common.error(common.red(`Failed fetching DBC mints: ${error}`));
            return [];
        }
    }

    private async get_random_graduated_mints(count: number): Promise<MeteoraMintMeta[]> {
        if (count <= 0) return [];
        const limit = Math.min(100, Math.max(20, count * 3));
        const sol = SOL_MINT.toBase58();
        const sources = await Promise.allSettled(
            ['token_x', 'token_y'].map(async (field) => {
                const url = new URL(`${METEORA_DAMM_V2_API_URL}/pools`);
                url.searchParams.set('page_size', String(limit));
                url.searchParams.set('filter_by', `${field}=${sol}&&tvl>0`);
                const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
                const data = await response.json();
                if (!response.ok || !Array.isArray(data.data)) throw new Error('DAMM v2 mint discovery failed.');
                return data.data.flatMap((pool: { token_x: { address: string }; token_y: { address: string } }) =>
                    pool.token_x.address === sol
                        ? [pool.token_y.address]
                        : pool.token_y.address === sol
                          ? [pool.token_x.address]
                          : []
                ) as string[];
            })
        );
        const candidates: string[] = [];
        for (const source of sources) {
            if (source.status === 'fulfilled') candidates.push(...source.value);
            else common.error(common.red(`Failed fetching Meteora mints: ${source.reason}`));
        }
        return trade.resolve_random_mints(candidates, count, async (mint) => {
            const meta = await this.get_mint_meta(mint);
            return meta && meta.migrated && meta.sol_reserves > 0n && meta.token_reserves > 0n ? meta : undefined;
        });
    }

    private async create_mint_meta(
        mint: PublicKey,
        config: PublicKey,
        config_data: ReturnType<typeof DBCConfigStruct.decode>,
        name: string,
        symbol: string,
        quote_decimals = 9
    ): Promise<MeteoraMintMeta> {
        const mints = [Buffer.from(mint.toBytes()), Buffer.from(config_data.quote_mint.toBytes())]
            .sort(Buffer.compare)
            .reverse();
        const [pool] = await PublicKey.findProgramAddress(
            [METEORA_DBC_POOL_SEED, config.toBytes(), ...mints],
            METEORA_DBC_PROGRAM_ID
        );
        const [[base_vault], [quote_vault]] = await Promise.all(
            [mint, config_data.quote_mint].map((token) =>
                PublicKey.findProgramAddress(
                    [METEORA_DBC_VAULT_SEED, token.toBytes(), pool.toBytes()],
                    METEORA_DBC_PROGRAM_ID
                )
            )
        );
        const curve = config_data.curve;
        if (curve.length === 0 || config_data.sqrt_start_price === 0n) throw new Error('Invalid DBC creation curve.');
        let supply = config_data.pre_migration_token_supply;
        if (config_data.fixed_token_supply_flag === 0) {
            let curve_amount = 0n;
            let sqrt_price = config_data.sqrt_start_price;
            for (const point of curve) {
                const denominator = sqrt_price * point.sqrt_price;
                curve_amount += (point.liquidity * (point.sqrt_price - sqrt_price) + denominator - 1n) / denominator;
                sqrt_price = point.sqrt_price;
            }
            const buffered_amount =
                config_data.swap_base_amount +
                (config_data.swap_base_amount * METEORA_DBC_PARAMS.swap_buffer_percentage) / 100n;
            supply =
                (buffered_amount < curve_amount ? buffered_amount : curve_amount) +
                config_data.migration_base_threshold +
                config_data.vesting_amount_per_period * config_data.vesting_number_of_periods +
                config_data.vesting_cliff_unlock_amount;
        }
        const { mcap_quote: market_cap } = quote_metrics(
            this.calc_token_price(config_data.sqrt_start_price),
            supply,
            quote_decimals,
            config_data.token_decimal
        );
        return new MeteoraMintMeta({
            mint: mint.toBase58(),
            quote_mint: config_data.quote_mint.toBase58(),
            pool: pool.toBase58(),
            name,
            symbol,
            total_supply: supply,
            token_reserves: supply,
            sol_reserves: 0n,
            token_decimal: config_data.token_decimal,
            token_program_id: (config_data.token_type === 0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID).toBase58(),
            market_cap,
            fee: Number(config_data.cliff_fee_numerator) / Number(FEE_DENOMINATOR),
            dbc_data: {
                config: config.toBase58(),
                base_vault: base_vault.toBase58(),
                quote_vault: quote_vault.toBase58(),
                sqrt_price: config_data.sqrt_start_price,
                creation: true,
                quote: {
                    config: config_data,
                    sqrt_price: config_data.sqrt_start_price,
                    first_swap_with_min_fee: config_data.enable_first_swap_with_min_fee === 1,
                    activation_point: 0n,
                    current_point: 0n,
                    timestamp: BigInt(Math.floor(Date.now() / 1000)),
                    last_update_timestamp: 0n,
                    volatility_accumulator: 0n,
                    volatility_reference: 0n,
                    sqrt_price_reference: config_data.sqrt_start_price
                }
            }
        });
    }

    private calc_token_price(sqrt_price: bigint): number {
        return Number(sqrt_price * sqrt_price) / Number(ONE_Q128);
    }

    private async get_dbc_state(
        mint: PublicKey,
        pool?: PoolAccount | null,
        mint_meta?: MeteoraMintMeta
    ): Promise<DBCState> {
        pool ??= await this.get_dbc_pool_from_mint(mint);
        if (!pool) throw new Error('Pool not found');
        const pool_state = DBCStateStruct.decode(pool.account.data);
        const cached = mint_meta?.dbc_data?.config === pool_state.config.toBase58() ? mint_meta : undefined;
        const [config_info, slot] = await Promise.all([
            cached ? null : global.CONNECTION.getAccountInfo(pool_state.config, COMMITMENT),
            pool.slot ?? global.CONNECTION.getSlot(COMMITMENT)
        ]);
        if (!cached && (!config_info || !config_info.owner.equals(METEORA_DBC_PROGRAM_ID)))
            throw new Error('Invalid DBC config account.');
        const config_state = cached
            ? {
                  ...cached.dbc_data!.quote.config,
                  quote_mint: cached.quote_mint_pubkey,
                  token_decimal: cached.token_decimal,
                  pre_migration_token_supply: cached.total_supply
              }
            : DBCConfigStruct.decode(config_info!.data);

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
            creator: pool_state.creator,
            quote: this.dbc_quote_state(pool_state, config_state, slot)
        };
    }

    private dbc_quote_state(
        state: ReturnType<typeof DBCStateStruct.decode>,
        config: DBCQuoteState['config'],
        slot: bigint
    ): DBCQuoteState {
        const timestamp = BigInt(Math.floor(Date.now() / 1000));
        return {
            config,
            sqrt_price: common.read_biguint_le(state.sqrt_price, 0, 16),
            activation_point: state.activation_point,
            current_point: config.activation_type === 0 ? slot : timestamp,
            timestamp,
            last_update_timestamp: state.last_update_timestamp,
            sqrt_price_reference: state.sqrt_price_reference,
            volatility_accumulator: state.volatility_accumulator,
            volatility_reference: state.volatility_reference,
            first_swap_with_min_fee: false
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

    private async get_pool(pubkey: PublicKey, commitment: Commitment = COMMITMENT) {
        const { value, context } = await global.CONNECTION.getAccountInfoAndContext(pubkey, commitment);
        if (!value) throw new Error('Meteora pool not found');
        return { pubkey, account: value, slot: context.slot };
    }

    private calc_dbc_token_amount_raw(sol_amount_raw: bigint, info: DBCData): bigint {
        return quote_dbc_exact_in(info.quote, sol_amount_raw, 'buy').output_amount;
    }

    private calc_dbc_sol_amount_raw(token_amount_raw: bigint, info: DBCData): bigint {
        return quote_dbc_exact_in(info.quote, token_amount_raw, 'sell').output_amount;
    }

    private async get_damm_from_mint(mint: PublicKey, quote_mint?: PublicKey): Promise<trade.ProgramAccount | null> {
        try {
            const pools = await Promise.all(
                ['token_a_mint', 'token_b_mint'].map((field) =>
                    trade.get_program_accounts_v2(METEORA_DAMM_V2_PROGRAM_ID, [
                        { memcmp: { offset: DAMMV2StateStruct.get_offset(field), bytes: mint.toBase58() } },
                        ...(quote_mint
                            ? [
                                  {
                                      memcmp: {
                                          offset: DAMMV2StateStruct.get_offset(
                                              field === 'token_a_mint' ? 'token_b_mint' : 'token_a_mint'
                                          ),
                                          bytes: quote_mint.toBase58()
                                      }
                                  }
                              ]
                            : []),
                        { memcmp: { offset: 0, bytes: base58.encode(METEORA_DAMM_V2_STATE_HEADER) } }
                    ])
                )
            );
            let first: trade.ProgramAccount | null = null;
            for (const pool of pools.flat()) {
                const state = DAMMV2StateStruct.decode(pool.account.data);
                const quote = state.token_a_mint.equals(mint) ? state.token_b_mint : state.token_a_mint;
                if (quote.equals(mint) || (quote_mint && !quote.equals(quote_mint))) continue;
                if (quote_mint || quote.equals(SOL_MINT)) return pool;
                first ??= pool;
            }
            return first;
        } catch {
            return null;
        }
    }

    private async damm_v2_mint_meta(
        mint_meta: MeteoraMintMeta,
        pool: trade.ProgramAccount,
        slot?: bigint,
        quote_decimals?: number
    ): Promise<MeteoraMintMeta> {
        const state = DAMMV2StateStruct.decode(pool.account.data);
        this.validate_damm_v2_state(state);
        const mint_is_token_a = state.token_a_mint.equals(mint_meta.mint_pubkey);
        const quote_mint = mint_is_token_a ? state.token_b_mint : state.token_a_mint;
        const token_reserves = mint_is_token_a ? state.token_a_amount : state.token_b_amount;
        const sol_reserves = mint_is_token_a ? state.token_b_amount : state.token_a_amount;
        const decimals = quote_decimals ?? (await get_quote_info(quote_mint)).decimals;
        let raw_price: number;
        if (state.collect_fee_mode === CollectFeeMode.Compounding) {
            raw_price = Number(sol_reserves) / Number(token_reserves);
        } else {
            const price = this.calc_token_price(state.sqrt_price);
            raw_price = mint_is_token_a ? price : 1 / price;
        }
        const { mcap_quote: market_cap } = quote_metrics(
            raw_price,
            mint_meta.total_supply,
            decimals,
            mint_meta.token_decimal
        );
        const current_point =
            state.activation_type === 0
                ? (slot ?? (await global.CONNECTION.getSlot(COMMITMENT)))
                : BigInt(Math.floor(Date.now() / 1000));
        const fee_numerator = damm_fee_numerator(
            state,
            0n,
            mint_is_token_a ? TradeDirection.BtoA : TradeDirection.AtoB,
            current_point
        );

        return new MeteoraMintMeta({
            ...mint_meta,
            pool: pool.pubkey.toBase58(),
            quote_mint: quote_mint.toBase58(),
            complete: true,
            sol_reserves,
            token_reserves,
            market_cap,
            fee: Number(fee_numerator) / Number(FEE_DENOMINATOR),
            dbc_data: undefined,
            damm_v2_data: {
                token_a_mint: state.token_a_mint.toBase58(),
                token_b_mint: state.token_b_mint.toBase58(),
                token_a_vault: state.token_a_vault.toBase58(),
                token_b_vault: state.token_b_vault.toBase58(),
                token_a_amount: state.token_a_amount,
                token_b_amount: state.token_b_amount,
                fee_numerator
            }
        });
    }

    private validate_damm_v2_state(state: ReturnType<typeof DAMMV2StateStruct.decode>): void {
        if (state.pool_status !== 0) throw new Error('DAMM v2 pool is disabled.');
        if (state.layout_version !== 1) throw new Error('DAMM v2 pool layout version is not supported.');
        if (state.collect_fee_mode > 2) throw new Error('Unsupported DAMM v2 fee collection mode.');
        if (state.fee_version > 1) throw new Error('Unsupported DAMM v2 fee version.');
    }

    private async get_token_program(mint: PublicKey): Promise<PublicKey> {
        return (await this.get_mint_info(mint)).token_program;
    }

    private async get_mint_info(mint: PublicKey): Promise<MintInfo> {
        if (mint.equals(SOL_MINT)) return { token_program: TOKEN_PROGRAM_ID, extensions: { __option: 'None' } };
        const mint_info = await global.CONNECTION.getAccountInfo(mint, COMMITMENT);
        if (!mint_info) throw new Error(`Mint account not found: ${mint}`);
        const { extensions } = decode_mint_account(mint_info);
        if (extensions.__option === 'Some' && extensions.value.some((extension) => extension.__kind === 'TransferHook'))
            throw new Error('Meteora transfer-hook tokens are not supported.');
        return { token_program: mint_info.owner, extensions };
    }

    private async quote_damm_v2_exact_in(
        amount_in: bigint,
        input_is_token_a: boolean,
        state: ReturnType<typeof DAMMV2StateStruct.decode>,
        slot: bigint
    ) {
        this.validate_damm_v2_state(state);
        const current_point =
            state.activation_type === 0 ? BigInt(slot) : BigInt((await global.CONNECTION.getBlockTime(slot)) ?? 0);
        if (current_point < state.activation_point) throw new Error('DAMM v2 pool is not active.');
        return quote_exact_in(
            state,
            amount_in,
            input_is_token_a ? TradeDirection.AtoB : TradeDirection.BtoA,
            current_point
        );
    }

    private get_damm_v2_transfer_fee(mint_info: MintInfo, amount: bigint, epoch: bigint): bigint {
        if (amount === 0n) return 0n;
        const { extensions } = mint_info;
        const transfer_fee_config =
            extensions.__option === 'Some'
                ? extensions.value.find((extension) => extension.__kind === 'TransferFeeConfig')
                : undefined;
        if (!transfer_fee_config) return 0n;
        const fee =
            epoch >= transfer_fee_config.newerTransferFee.epoch
                ? transfer_fee_config.newerTransferFee
                : transfer_fee_config.olderTransferFee;
        const calculated = (amount * BigInt(fee.transferFeeBasisPoints) + 9999n) / 10000n;
        return calculated > fee.maximumFee ? fee.maximumFee : calculated;
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

    private swap_exact_out_data(amount_out: bigint, maximum_amount_in: bigint): Buffer {
        const data = Buffer.alloc(25);
        Buffer.from(METEORA_SWAP2_DISCRIMINATOR).copy(data);
        data.writeBigUInt64LE(amount_out, 8);
        data.writeBigUInt64LE(maximum_amount_in, 16);
        data.writeUInt8(2, 24);
        return data;
    }

    private async get_buy_dbc_instructions(
        amount: TokenAmount,
        buyer: Keypair,
        mint_meta: Partial<MeteoraMintMeta>,
        slippage: number = 0.05,
        exact_out_amount?: bigint
    ): Promise<TransactionInstruction[]> {
        if (!mint_meta.mint || !mint_meta.dbc_data || !mint_meta.pool)
            throw new Error(`Incomplete mint meta data for buy instructions.`);

        const mint = new PublicKey(mint_meta.mint);
        const pool = new PublicKey(mint_meta.pool);
        const config = new PublicKey(mint_meta.dbc_data.config);
        const base_vault = new PublicKey(mint_meta.dbc_data.base_vault);
        const quote_vault = new PublicKey(mint_meta.dbc_data.quote_vault);
        const amount_raw = BigInt(amount.amount);

        const quote_mint = new PublicKey(mint_meta.quote_mint!);
        const quote_account = await prepare_quote_account(
            buyer,
            quote_mint,
            exact_out_amount === undefined ? amount_raw : trade.apply_slippage_up(amount_raw, slippage)
        );

        if (
            mint_meta.complete ||
            (mint_meta.sol_reserves ?? 0n) >= mint_meta.dbc_data.quote.config.migration_quote_threshold
        )
            throw new Error('Initial buys have completed the DBC curve.');
        const token_amount_raw = trade.apply_slippage_down(
            this.calc_dbc_token_amount_raw(amount_raw, mint_meta.dbc_data),
            slippage
        );

        const instruction_data =
            exact_out_amount === undefined
                ? this.swap_data(amount_raw, token_amount_raw)
                : this.swap_exact_out_data(exact_out_amount, trade.apply_slippage_up(amount_raw, slippage));
        const token_program = mint_meta.dbc_data.creation
            ? new PublicKey(mint_meta.token_program_id!)
            : await this.get_token_program(mint);
        const token_ata = await trade.calc_ata(buyer.publicKey, mint, token_program);
        const wsol_ata = quote_account.ata;

        return [
            createAssociatedTokenAccountIdempotentInstruction(buyer, token_ata, buyer.publicKey, mint, token_program),
            ...quote_account.setup,
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
                    { pubkey: quote_mint, isSigner: false, isWritable: false },
                    { pubkey: buyer.publicKey, isSigner: true, isWritable: false },
                    { pubkey: token_program, isSigner: false, isWritable: false },
                    { pubkey: quote_account.token_program, isSigner: false, isWritable: false },
                    { pubkey: METEORA_DBC_PROGRAM_ID, isSigner: false, isWritable: true },
                    { pubkey: METEORA_DBC_EVENT_AUTHORITY, isSigner: false, isWritable: false },
                    { pubkey: METEORA_DBC_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }
                ],
                programId: METEORA_DBC_PROGRAM_ID,
                data: instruction_data
            }),
            ...quote_account.cleanup
        ];
    }

    private async get_sell_dbc_instructions(
        token_amount: TokenAmount,
        seller: Keypair,
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

        const quote_mint = new PublicKey(mint_meta.quote_mint!);
        const quote_account = await prepare_quote_account(seller, quote_mint);

        const token_amount_raw = BigInt(token_amount.amount);
        const sol_amount_raw = trade.apply_slippage_down(
            this.calc_dbc_sol_amount_raw(token_amount_raw, mint_meta.dbc_data),
            slippage
        );

        const instruction_data = this.swap_data(token_amount_raw, sol_amount_raw);
        const token_program = await this.get_token_program(mint);
        const token_ata = await trade.calc_ata(seller.publicKey, mint, token_program);
        const wsol_ata = quote_account.ata;

        return [
            ...quote_account.setup,
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
                    { pubkey: quote_mint, isSigner: false, isWritable: false },
                    { pubkey: seller.publicKey, isSigner: true, isWritable: false },
                    { pubkey: token_program, isSigner: false, isWritable: false },
                    { pubkey: quote_account.token_program, isSigner: false, isWritable: false },
                    { pubkey: METEORA_DBC_PROGRAM_ID, isSigner: false, isWritable: true },
                    { pubkey: METEORA_DBC_EVENT_AUTHORITY, isSigner: false, isWritable: false },
                    { pubkey: METEORA_DBC_PROGRAM_ID, isSigner: false, isWritable: false }
                ],
                programId: METEORA_DBC_PROGRAM_ID,
                data: instruction_data
            }),
            ...quote_account.cleanup
        ];
    }

    private async get_buy_damm_v2_instructions(
        amount: TokenAmount,
        buyer: Keypair,
        mint_meta: MeteoraMintMeta,
        slippage: number
    ): Promise<TransactionInstruction[]> {
        const amount_raw = BigInt(amount.amount);
        const result = await this.get_damm_v2_swap_instructions(amount_raw, buyer, mint_meta, 'buy', slippage);
        return result.instructions;
    }

    private async get_sell_damm_v2_instructions(
        token_amount: TokenAmount,
        seller: Keypair,
        mint_meta: MeteoraMintMeta,
        slippage: number
    ): Promise<TransactionInstruction[]> {
        if (token_amount.amount === null) throw new Error(`Invalid token amount: ${token_amount.amount}`);
        return (
            await this.get_damm_v2_swap_instructions(BigInt(token_amount.amount), seller, mint_meta, 'sell', slippage)
        ).instructions;
    }

    private async get_damm_v2_swap_instructions(
        amount_in: bigint,
        trader: Keypair,
        mint_meta: MeteoraMintMeta,
        op: trade.TradeOp,
        slippage: number,
        exact_out: boolean = false
    ): Promise<{ instructions: TransactionInstruction[]; output_amount: bigint }> {
        const { pool, state, input_mint, output_mint, input_program, output_program, output_amount } =
            await this.get_damm_v2_quote(amount_in, mint_meta, op);
        const input_ata = await trade.calc_ata(trader.publicKey, input_mint, input_program);
        const output_ata = await trade.calc_ata(trader.publicKey, output_mint, output_program);
        const minimum_amount_out = trade.apply_slippage_down(output_amount, slippage);
        const maximum_amount_in = exact_out ? trade.apply_slippage_up(amount_in, slippage) : amount_in;
        const [pool_authority] = await PublicKey.findProgramAddress(
            [Buffer.from('pool_authority')],
            METEORA_DAMM_V2_PROGRAM_ID
        );
        const [event_authority] = await PublicKey.findProgramAddress(
            [Buffer.from('__event_authority')],
            METEORA_DAMM_V2_PROGRAM_ID
        );
        const instructions: TransactionInstruction[] = [
            createAssociatedTokenAccountIdempotentInstruction(
                trader,
                output_ata,
                trader.publicKey,
                output_mint,
                output_program
            ),
            createAssociatedTokenAccountIdempotentInstruction(
                trader,
                input_ata,
                trader.publicKey,
                input_mint,
                input_program
            )
        ];
        if (input_mint.equals(SOL_MINT)) {
            instructions.push(
                SystemProgram.transfer({
                    fromPubkey: trader.publicKey,
                    toPubkey: input_ata,
                    lamports: maximum_amount_in
                }),
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
                data: exact_out
                    ? this.swap_exact_out_data(output_amount, maximum_amount_in)
                    : this.damm_v2_swap_data(amount_in, minimum_amount_out)
            })
        );
        if (input_mint.equals(SOL_MINT) || output_mint.equals(SOL_MINT))
            instructions.push(
                createCloseAccountInstruction(
                    input_mint.equals(SOL_MINT) ? input_ata : output_ata,
                    trader.publicKey,
                    trader.publicKey
                )
            );
        return { instructions, output_amount };
    }
}
