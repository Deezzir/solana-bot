import {
    AccountInfo,
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
    METEORA_DAMM_V1_PROGRAM_ID,
    METEORA_DAMM_V1_STATE_HEADER,
    METEORA_DAMM_V2_PROGRAM_ID,
    METEORA_DAMM_V2_STATE_HEADER,
    METEORA_DBC_EVENT_AUTHORITY,
    METEORA_DBC_POOL_AUTHORITY,
    METEORA_DBC_PROGRAM_ID,
    METEORA_DBC_STATE_HEADER,
    METEORA_LTA_ACCOUNT,
    METEORA_SWAP_DISCRIMINATOR,
    METEORA_VAULT_HEADER,
    METEORA_VAULT_PROGRAM_ID,
    PriorityLevel,
    SOL_MINT,
    TRADE_MAX_SLIPPAGE
} from '../constants';
import base58 from 'bs58';
import {
    createAssociatedTokenAccountIdempotentInstruction,
    createCloseAccountInstruction,
    createSyncNativeInstruction,
    TOKEN_PROGRAM_ID
} from '@solana/spl-token';

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
    damm_v1_data?: DAMMV1Data;
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
        if (this.complete) return true;
        return false;
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
            damm_v1_data: this.damm_v1_data,
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
            damm_v1_data: data.damm_v1_data as DAMMV1Data,
            damm_v2_data: data.damm_v2_data as DAMMV2Data
        });
    }
}

const DAMM_V1_STATE_OFFSETS = {
    BASE_MINT: 0x28,
    QUOTE_MINT: 0x48,
    A_VAULT: 0x68,
    B_VAULT: 0x88,
    A_VAULT_LP: 0xa8,
    B_VAULT_LP: 0xc8,
    A_PROTOCOL_TOKEN_FEE: 0xea,
    B_PROTOCOL_TOKEN_FEE: 0x10a,
    TRADE_FEE_NUMERATOR: 0x14a,
    TRADE_FEE_DENOMINATOR: 0x152
};
const DAMM_V2_STATE_OFFSETS = {
    BASE_MINT: 0xa0
};
const CONFIG_OFFSETS = {
    QUOTE_MINT: 0x08,
    FEE_CLAIMER: 0x28,
    LEFTOVER_RECEIVER: 0x48,
    COLLECT_FEE_MODE: 0xe8,
    MIGRATION_OPTION: 0xe9,
    ACTIVATION_TYPE: 0xea,
    TOKEN_DECIMAL: 0xeb,
    VERSION: 0xec,
    TOKEN_TYPE: 0xed,
    QUOTE_TOKEN_FLAG: 0xee,
    PARTNER_LOCKED_LP_PERCENTAGE: 0xef,
    PARTNER_LP_PERCENTAGE: 0xf0,
    CREATOR_LOCKED_LP_PERCENTAGE: 0xf1,
    CREATOR_LP_PERCENTAGE: 0xf2,
    MIGRATION_FEE_OPTION: 0xf3,
    FIXED_TOKEN_SUPPLY_FLAG: 0xf4,
    CREATOR_TRADING_FEE_PERCENTAGE: 0xf5,
    SWAP_BASE_AMOUNT: 0x100,
    MIGRATION_QUOTE_THRESHOLD: 0x108,
    MIGRATION_BASE_THRESHOLD: 0x110,
    MIGRATION_SQRT_PRICE: 0x118,
    PRE_MIGRATION_TOKEN_SUPPLY: 0x158,
    POST_MIGRATION_TOKEN_SUPPLY: 0x160,
    SQRT_START_PRICE: 0x188
};
const DBC_STATE_OFFSETS = {
    CONFIG: 0x48,
    CREATOR: 0x68,
    BASE_MINT: 0x88,
    BASE_VAULT: 0xa8,
    QUOTE_VAULT: 0xc8,
    BASE_RESERVE: 0xe8,
    QUOTE_RESERVE: 0xf0,
    PROTOCOL_BASE_FEE: 0xf8,
    PROTOCOL_QUOTE_FEE: 0x100,
    PARTNER_BASE_FEE: 0x108,
    PARTNER_QUOTE_FEE: 0x110,
    SQRT_PRICE: 0x118,
    ACTIVATION_POINT: 0x128,
    POOL_TYPE: 0x130,
    IS_MIGRATED: 0x131,
    IS_PARTNER_WITHDRAW_SURPLUS: 0x132,
    IS_PROTOCOL_WITHDRAW_SURPLUS: 0x133,
    MIGRATION_PROGRESS: 0x134,
    IS_WITHDRAW_LEFTOVER: 0x135,
    IS_CREATOR_WITHDRAW_SURPLUS: 0x136,
    FINISH_CURVE_TIMESTAMP: 0x158,
    CREATOR_BASE_FEE: 0x160,
    CREATOR_QUOTE_FEE: 0x168
};
const VAULT_STATE_OFFSETS = {
    TOTAL_AMOUNT: 0xb,
    TOKEN_VAULT: 0x13,
    TOKEN_VAULT_LP_MINT: 0x73
};
enum DAMMVersion {
    V1 = 1,
    V2 = 2
}
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
    migration_option: DAMMVersion;
};
type DAMMV1State = {
    pool: PublicKey;
    base_vault_authority: PublicKey;
    quote_vault_authority: PublicKey;
    base_vault: PublicKey;
    quote_vault: PublicKey;
    base_vault_lp: PublicKey;
    quote_vault_lp: PublicKey;
    base_vault_lp_mint: PublicKey;
    quote_vault_lp_mint: PublicKey;
    base_protocol_token_fee: PublicKey;
    quote_protocol_token_fee: PublicKey;
    base_reserve: bigint;
    quote_reserve: bigint;
    trade_fee: number;
};
type VaultState = {
    token_vault: PublicKey;
    token_vault_lp_mint: PublicKey;
    token_reserve: bigint;
};

type DAMMV1Data = {
    base_vault: string;
    quote_vault: string;
    base_vault_authority: string;
    quote_vault_authority: string;
    base_vault_lp: string;
    quote_vault_lp: string;
    base_vault_lp_mint: string;
    quote_vault_lp_mint: string;
    base_protocol_token_fee: string;
    quote_protocol_token_fee: string;
};

type DAMMV2Data = {};

type DBCData = {
    sqrt_price: bigint;
    config: string;
    base_vault: string;
    quote_vault: string;
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

    public async claim_dev_fees(): Promise<{ signature: String | null; fees: number }> {
        throw new Error('Claiming dev fees is not implemented for Meteora.');
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
            if (mint_meta.damm_v1_data)
                return [await this.get_buy_damm_v1_instructions(sol_amount, buyer, mint_meta, slippage), lta];
            if (mint_meta.damm_v2_data) throw new Error('V2 not implemented');
            else throw new Error('Unknown migration option');
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
            if (mint_meta.damm_v1_data)
                return [await this.get_sell_damm_v1_instructions(token_amount, seller, mint_meta, slippage), lta];
            if (mint_meta.damm_v2_data) throw new Error('V2 not implemented');
            else throw new Error('Unknown migration option');
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
        let token_amount_raw = this.calc_dbc_token_amount_raw(sol_amount_raw, mint_meta.dbc_data!); // TODO: fix type
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
            const damm = await this.get_damm_from_mint(new PublicKey(mint_meta.mint));

            if (damm === null) {
                const state = await this.get_dbc_state(new PublicKey(mint_meta.mint));
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

            if (damm?.version === DAMMVersion.V1) {
                const state = await this.get_damm_v1_state(damm.damm_info);
                const metrics = await this.get_token_metrics(state);
                return new MeteoraMintMeta({
                    ...mint_meta,
                    sol_reserves: state.quote_reserve,
                    token_reserves: state.base_reserve,
                    pool: state.pool.toString(),
                    complete: true,
                    damm_v1_data: {
                        base_vault: state.base_vault.toString(),
                        quote_vault: state.quote_vault.toString(),
                        base_vault_lp: state.base_vault_lp.toString(),
                        quote_vault_lp: state.quote_vault_lp.toString(),
                        base_protocol_token_fee: state.base_protocol_token_fee.toString(),
                        quote_protocol_token_fee: state.quote_protocol_token_fee.toString(),
                        base_vault_authority: state.base_vault_authority.toString(),
                        quote_vault_authority: state.quote_vault_authority.toString(),
                        base_vault_lp_mint: state.base_vault_lp_mint.toString(),
                        quote_vault_lp_mint: state.quote_vault_lp_mint.toString()
                    },
                    usd_market_cap: metrics.mcap_sol * sol_price,
                    market_cap: metrics.mcap_sol,
                    fee: state.trade_fee
                });
            } else if (damm?.version === DAMMVersion.V2) {
            }

            return mint_meta;
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

    private async get_token_metrics(state: DAMMV1State): Promise<trade.TokenMetrics> {
        const token = await trade.get_token_supply(state.base_vault_lp);
        const price_sol = Number(state.quote_reserve) / Number(state.base_reserve);
        const mcap_sol = (price_sol * Number(token.supply)) / Math.pow(10, token.decimals);
        return { price_sol, mcap_sol };
    }

    private calc_token_price(sqrt_price: bigint): number {
        const SCALE_FACTOR = 2n ** 64n;
        const PRECISION = 10n ** 18n;

        const numerator = sqrt_price * sqrt_price * PRECISION;
        const denominator = SCALE_FACTOR * SCALE_FACTOR;
        return Number(numerator / denominator) / 1e18;
    }

    // private calc_dbc_vault(mint: PublicKey, pool: PublicKey): PublicKey {
    //     const [base_vault] = PublicKey.findProgramAddressSync(
    //         [METEORA_DBC_VAULT_SEED, mint.toBuffer(), pool.toBuffer()],
    //         METEORA_DBC_PROGRAM_ID
    //     );
    //     return base_vault;
    // }

    private async get_dbc_state(mint: PublicKey): Promise<DBCState> {
        const pool = await this.get_dbc_pool_from_mint(mint);
        if (!pool) throw new Error('Pool not found');
        const pool_info = pool.account;

        const config = new PublicKey(common.read_bytes(pool_info.data, DBC_STATE_OFFSETS.CONFIG, 32));
        const config_info = await global.CONNECTION.getAccountInfo(config, COMMITMENT);
        if (!config_info || !config_info.data) throw new Error('Unexpected config state');
        const config_header = common.read_bytes(config_info.data, 0, METEORA_CONFIG_HEADER.byteLength);
        if (config_header.compare(METEORA_CONFIG_HEADER) !== 0) throw new Error('Unexpected config header');

        return {
            pool: pool.pubkey,
            base_mint: mint,
            quote_mint: SOL_MINT,
            config,
            token_decimals: config_info.data[CONFIG_OFFSETS.TOKEN_DECIMAL],
            total_supply: common.read_biguint_le(config_info.data, CONFIG_OFFSETS.PRE_MIGRATION_TOKEN_SUPPLY, 8),
            base_vault: new PublicKey(common.read_bytes(pool_info.data, DBC_STATE_OFFSETS.BASE_VAULT, 32)),
            quote_vault: new PublicKey(common.read_bytes(pool_info.data, DBC_STATE_OFFSETS.QUOTE_VAULT, 32)),
            base_reserve: common.read_biguint_le(pool_info.data, DBC_STATE_OFFSETS.BASE_RESERVE, 8),
            quote_reserve: common.read_biguint_le(pool_info.data, DBC_STATE_OFFSETS.QUOTE_RESERVE, 8),
            sqrt_price: common.read_biguint_le(pool_info.data, DBC_STATE_OFFSETS.SQRT_PRICE, 16),
            is_migrated: pool_info.data[DBC_STATE_OFFSETS.IS_MIGRATED] === 1,
            migration_option: pool_info.data[DBC_STATE_OFFSETS.POOL_TYPE] as DAMMVersion,
            creator: new PublicKey(common.read_bytes(pool_info.data, DBC_STATE_OFFSETS.CREATOR, 32))
        };
    }

    private async get_vault_state(vault: PublicKey): Promise<VaultState> {
        const vault_state = await global.CONNECTION.getAccountInfo(vault, COMMITMENT);
        if (!vault_state) throw new Error('Unexpected vault state');
        const vault_header = common.read_bytes(vault_state.data, 0, METEORA_VAULT_HEADER.byteLength);
        if (vault_header.compare(METEORA_VAULT_HEADER) !== 0) throw new Error('Unexpected vault state IDL signature');
        return {
            token_vault: new PublicKey(common.read_bytes(vault_state.data, VAULT_STATE_OFFSETS.TOKEN_VAULT, 32)),
            token_vault_lp_mint: new PublicKey(
                common.read_bytes(vault_state.data, VAULT_STATE_OFFSETS.TOKEN_VAULT_LP_MINT, 32)
            ),
            token_reserve: common.read_biguint_le(vault_state.data, VAULT_STATE_OFFSETS.TOTAL_AMOUNT, 8)
        };
    }

    private async get_damm_v1_state(
        pool_info: Readonly<{
            account: AccountInfo<Buffer>;
            pubkey: PublicKey;
        }>
    ): Promise<DAMMV1State> {
        const base_vault_authority = new PublicKey(
            common.read_bytes(pool_info.account.data, DAMM_V1_STATE_OFFSETS.A_VAULT, 32)
        );
        const quote_vault_authority = new PublicKey(
            common.read_bytes(pool_info.account.data, DAMM_V1_STATE_OFFSETS.B_VAULT, 32)
        );
        const base_vault_state = await this.get_vault_state(base_vault_authority);
        const quote_vault_state = await this.get_vault_state(quote_vault_authority);
        const base_vault_lp = new PublicKey(
            common.read_bytes(pool_info.account.data, DAMM_V1_STATE_OFFSETS.A_VAULT_LP, 32)
        );
        const quote_vault_lp = new PublicKey(
            common.read_bytes(pool_info.account.data, DAMM_V1_STATE_OFFSETS.B_VAULT_LP, 32)
        );
        const quote_reserve = await trade.get_vault_balance(quote_vault_lp);
        const base_reserve = await trade.get_vault_balance(base_vault_lp);
        const trade_fee_numerator = common.read_biguint_le(
            pool_info.account.data,
            DAMM_V1_STATE_OFFSETS.TRADE_FEE_NUMERATOR,
            8
        );
        const trade_fee_denominator = common.read_biguint_le(
            pool_info.account.data,
            DAMM_V1_STATE_OFFSETS.TRADE_FEE_DENOMINATOR,
            8
        );
        const trade_fee = Number(trade_fee_numerator) / Number(trade_fee_denominator);

        return {
            pool: pool_info.pubkey,
            base_vault_lp,
            quote_vault_lp,
            base_protocol_token_fee: new PublicKey(
                common.read_bytes(pool_info.account.data, DAMM_V1_STATE_OFFSETS.A_PROTOCOL_TOKEN_FEE, 32)
            ),
            quote_protocol_token_fee: new PublicKey(
                common.read_bytes(pool_info.account.data, DAMM_V1_STATE_OFFSETS.B_PROTOCOL_TOKEN_FEE, 32)
            ),
            base_vault: base_vault_state.token_vault,
            quote_vault: quote_vault_state.token_vault,
            quote_vault_authority,
            base_vault_authority,
            base_vault_lp_mint: base_vault_state.token_vault_lp_mint,
            quote_vault_lp_mint: quote_vault_state.token_vault_lp_mint,
            base_reserve: base_reserve.balance,
            quote_reserve: quote_reserve.balance,
            trade_fee
        };
    }

    private async get_dbc_pool_from_mint(
        mint: PublicKey
    ): Promise<Readonly<{ account: AccountInfo<Buffer>; pubkey: PublicKey }> | null> {
        try {
            const [pool] = await global.CONNECTION.getProgramAccounts(METEORA_DBC_PROGRAM_ID, {
                filters: [
                    {
                        memcmp: {
                            offset: DBC_STATE_OFFSETS.BASE_MINT,
                            bytes: mint.toBase58()
                        }
                    },
                    {
                        memcmp: {
                            offset: 0,
                            bytes: base58.encode(METEORA_DBC_STATE_HEADER)
                        }
                    }
                ],
                commitment: COMMITMENT
            });
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

    private calc_token_amount_raw(sol_amount_raw: bigint, token: Partial<MeteoraMintMeta>): bigint {
        if (!token.sol_reserves || !token.token_reserves || !token.fee) return 0n;
        if (sol_amount_raw <= 0) return 0n;

        const fee = (sol_amount_raw * BigInt(token.fee * 10000)) / 10000n;
        const n = token.sol_reserves * token.token_reserves;
        const new_sol_reserves = token.sol_reserves + (sol_amount_raw - fee);
        const new_token_reserves = n / new_sol_reserves + 1n;
        return token.token_reserves - new_token_reserves;
    }

    private calc_sol_amount_raw(token_amount_raw: bigint, token: Partial<MeteoraMintMeta>): bigint {
        if (!token.sol_reserves || !token.token_reserves) return 0n;
        if (token_amount_raw <= 0) return 0n;

        return (token_amount_raw * token.sol_reserves) / (token.token_reserves + token_amount_raw);
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
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
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
        const token_ata = trade.calc_ata(seller.publicKey, mint);
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
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
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

    private async get_damm_from_mint(mint: PublicKey): Promise<{
        damm_info: Readonly<{ account: AccountInfo<Buffer>; pubkey: PublicKey }>;
        version: DAMMVersion;
    } | null> {
        try {
            const result = await Promise.all([
                global.CONNECTION.getProgramAccounts(METEORA_DAMM_V1_PROGRAM_ID, {
                    filters: [
                        {
                            memcmp: {
                                offset: DAMM_V1_STATE_OFFSETS.BASE_MINT,
                                bytes: mint.toBase58()
                            }
                        },
                        {
                            memcmp: {
                                offset: DAMM_V1_STATE_OFFSETS.QUOTE_MINT,
                                bytes: SOL_MINT.toBase58()
                            }
                        },
                        {
                            memcmp: {
                                offset: 0,
                                bytes: base58.encode(METEORA_DAMM_V1_STATE_HEADER)
                            }
                        }
                    ],
                    commitment: COMMITMENT
                }),
                global.CONNECTION.getProgramAccounts(METEORA_DAMM_V2_PROGRAM_ID, {
                    filters: [
                        {
                            memcmp: {
                                offset: DAMM_V2_STATE_OFFSETS.BASE_MINT,
                                bytes: mint.toBase58()
                            }
                        },
                        {
                            memcmp: {
                                offset: 0,
                                bytes: base58.encode(METEORA_DAMM_V2_STATE_HEADER)
                            }
                        }
                    ],
                    commitment: COMMITMENT
                })
            ]);
            if (result[0].length > 0) return { damm_info: result[0][0], version: DAMMVersion.V1 };
            if (result[1].length > 0) return { damm_info: result[1][0], version: DAMMVersion.V2 };
            return null;
        } catch (error) {
            return null;
        }
    }

    private async get_buy_damm_v1_instructions(
        sol_amount: number,
        buyer: Signer,
        mint_meta: Partial<MeteoraMintMeta>,
        slippage: number = 0.05
    ): Promise<TransactionInstruction[]> {
        if (!mint_meta.mint || !mint_meta.pool || !mint_meta.damm_v1_data)
            throw new Error(`Incomplete mint meta data for buy instructions.`);

        const mint = new PublicKey(mint_meta.mint);
        const pool = new PublicKey(mint_meta.pool);
        const base_vault_authority = new PublicKey(mint_meta.damm_v1_data.base_vault_authority);
        const quote_vault_authority = new PublicKey(mint_meta.damm_v1_data.quote_vault_authority);
        const base_vault = new PublicKey(mint_meta.damm_v1_data.base_vault);
        const quote_vault = new PublicKey(mint_meta.damm_v1_data.quote_vault);
        const base_vault_lp_mint = new PublicKey(mint_meta.damm_v1_data.base_vault_lp_mint);
        const quote_vault_lp_mint = new PublicKey(mint_meta.damm_v1_data.quote_vault_lp_mint);
        const base_vault_lp = new PublicKey(mint_meta.damm_v1_data.base_vault_lp);
        const quote_vault_lp = new PublicKey(mint_meta.damm_v1_data.quote_vault_lp);
        const quote_protocol_token_fee = new PublicKey(mint_meta.damm_v1_data.quote_protocol_token_fee);

        const sol_amount_raw = BigInt(Math.floor(sol_amount * LAMPORTS_PER_SOL));
        const token_amount_raw = this.calc_slippage_down(
            this.calc_token_amount_raw(sol_amount_raw, mint_meta),
            slippage
        );

        const instruction_data = this.swap_data(sol_amount_raw, token_amount_raw);
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
                    { pubkey: pool, isSigner: false, isWritable: true },
                    { pubkey: wsol_ata, isSigner: false, isWritable: true },
                    { pubkey: token_ata, isSigner: false, isWritable: true },
                    { pubkey: base_vault_authority, isSigner: false, isWritable: true },
                    { pubkey: quote_vault_authority, isSigner: false, isWritable: true },
                    { pubkey: base_vault, isSigner: false, isWritable: true },
                    { pubkey: quote_vault, isSigner: false, isWritable: true },
                    { pubkey: base_vault_lp_mint, isSigner: false, isWritable: true },
                    { pubkey: quote_vault_lp_mint, isSigner: false, isWritable: true },
                    { pubkey: base_vault_lp, isSigner: false, isWritable: true },
                    { pubkey: quote_vault_lp, isSigner: false, isWritable: true },
                    { pubkey: quote_protocol_token_fee, isSigner: false, isWritable: true },
                    { pubkey: buyer.publicKey, isSigner: true, isWritable: true },
                    { pubkey: METEORA_VAULT_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }
                ],
                programId: METEORA_DAMM_V1_PROGRAM_ID,
                data: instruction_data
            }),
            createCloseAccountInstruction(wsol_ata, buyer.publicKey, buyer.publicKey)
        ];
    }

    private async get_sell_damm_v1_instructions(
        token_amount: TokenAmount,
        seller: Signer,
        mint_meta: Partial<MeteoraMintMeta>,
        slippage: number = 0.05
    ): Promise<TransactionInstruction[]> {
        if (!mint_meta.mint || !mint_meta.damm_v1_data || !mint_meta.pool)
            throw new Error(`Incomplete mint meta data for sell instructions.`);
        if (token_amount.amount === null) throw new Error(`Invalid token amount: ${token_amount.amount}`);

        const mint = new PublicKey(mint_meta.mint);
        const pool = new PublicKey(mint_meta.pool);
        const base_vault_authority = new PublicKey(mint_meta.damm_v1_data.base_vault_authority);
        const quote_vault_authority = new PublicKey(mint_meta.damm_v1_data.quote_vault_authority);
        const base_vault = new PublicKey(mint_meta.damm_v1_data.base_vault);
        const quote_vault = new PublicKey(mint_meta.damm_v1_data.quote_vault);
        const base_vault_lp_mint = new PublicKey(mint_meta.damm_v1_data.base_vault_lp_mint);
        const quote_vault_lp_mint = new PublicKey(mint_meta.damm_v1_data.quote_vault_lp_mint);
        const base_vault_lp = new PublicKey(mint_meta.damm_v1_data.base_vault_lp);
        const quote_vault_lp = new PublicKey(mint_meta.damm_v1_data.quote_vault_lp);
        const base_protocol_token_fee = new PublicKey(mint_meta.damm_v1_data.base_protocol_token_fee);

        const token_amount_raw = BigInt(token_amount.amount);
        const instruction_data = this.swap_data(
            token_amount_raw,
            this.calc_slippage_down(this.calc_sol_amount_raw(token_amount_raw, mint_meta), slippage)
        );
        const token_ata = trade.calc_ata(seller.publicKey, mint);
        const wsol_ata = trade.calc_ata(seller.publicKey, SOL_MINT);

        return [
            createAssociatedTokenAccountIdempotentInstruction(seller.publicKey, wsol_ata, seller.publicKey, SOL_MINT),
            new TransactionInstruction({
                keys: [
                    { pubkey: pool, isSigner: false, isWritable: true },
                    { pubkey: wsol_ata, isSigner: false, isWritable: true },
                    { pubkey: token_ata, isSigner: false, isWritable: true },
                    { pubkey: base_vault_authority, isSigner: false, isWritable: true },
                    { pubkey: quote_vault_authority, isSigner: false, isWritable: true },
                    { pubkey: base_vault, isSigner: false, isWritable: true },
                    { pubkey: quote_vault, isSigner: false, isWritable: true },
                    { pubkey: base_vault_lp_mint, isSigner: false, isWritable: true },
                    { pubkey: quote_vault_lp_mint, isSigner: false, isWritable: true },
                    { pubkey: base_vault_lp, isSigner: false, isWritable: true },
                    { pubkey: quote_vault_lp, isSigner: false, isWritable: true },
                    { pubkey: base_protocol_token_fee, isSigner: false, isWritable: true },
                    { pubkey: seller.publicKey, isSigner: true, isWritable: true },
                    { pubkey: METEORA_VAULT_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }
                ],
                programId: METEORA_DAMM_V1_PROGRAM_ID,
                data: instruction_data
            }),
            createCloseAccountInstruction(wsol_ata, seller.publicKey, seller.publicKey)
        ];
    }
}
