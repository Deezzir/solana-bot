import {
    AddressLookupTableAccount,
    AccountInfo,
    Commitment,
    Keypair,
    PublicKey,
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
    RENT_PROGRAM_ID,
    RAYDIUM_API_URL,
    PriorityLevel,
    RAYDIUM_CPMM_AUTHORITY,
    RAYDIUM_CPMM_CREATOR_FEE_CLAIM_DISCRIMINATOR,
    RAYDIUM_CPMM_POOL_STATE_HEADER,
    RAYDIUM_CPMM_PROGRAM_ID,
    RAYDIUM_CPMM_SWAP_DISCRIMINATOR,
    RAYDIUM_CPMM_SWAP_EXACT_OUT_DISCRIMINATOR,
    RAYDIUM_LAUNCHPAD_AUTHORITY,
    RAYDIUM_LAUNCHPAD_API_URL,
    RAYDIUM_LAUNCHPAD_BUY_DISCRIMINATOR,
    RAYDIUM_LAUNCHPAD_BUY_EXACT_OUT_DISCRIMINATOR,
    RAYDIUM_LAUNCHPAD_EVENT_AUTHORITY,
    RAYDIUM_LAUNCHPAD_GLOBAL_CONFIG,
    RAYDIUM_LAUNCHPAD_PLATFORM_CONFIG,
    RAYDIUM_LAUNCHPAD_CREATE_PARAMS,
    RAYDIUM_DEFAULT_MINT_META,
    RAYDIUM_LAUNCHPAD_CREATE_DISCRIMINATOR,
    RAYDIUM_LAUNCHPAD_POOL_HEADER,
    RAYDIUM_LAUNCHPAD_POOL_SEED,
    RAYDIUM_LAUNCHPAD_PROGRAM_ID,
    RAYDIUM_LAUNCHPAD_SELL_DISCRIMINATOR,
    RAYDIUM_LAUNCHPAD_VAULT_SEED,
    RAYDIUM_LTA_ACCOUNT,
    SOL_MINT,
    SYSTEM_PROGRAM_ID,
    TRADE_DEFAULT_TOKEN_DECIMALS,
    PROGRAM_COMPUTE_UNIT_LIMITS
} from '../constants';
import {
    ASSOCIATED_TOKEN_PROGRAM_ID,
    decode_token_account,
    createAssociatedTokenAccountIdempotentInstruction,
    TOKEN_PROGRAM_ID
} from '../common/token';
import base58 from 'bs58';
import { define_decoder_struct, skip, u8, u16, u64, discriminator, pubkey } from '../common/struct_decoder';

type CreateOptions = {
    global_config?: string;
    quote_mint?: string;
    fundraising?: string;
};

type CPMMState = ReturnType<typeof CPMMStateStruct.decode> & {
    token_0_reserves: bigint;
    token_1_reserves: bigint;
    supply: bigint;
};

type RaydiumClaimableAsset = trade.ClaimableAsset & {
    state: ReturnType<typeof CPMMStateStruct.decode>;
    pool: PublicKey;
};

const RAYDIUM_COMPUTE_UNIT_LIMIT = PROGRAM_COMPUTE_UNIT_LIMITS[common.Program.Raydium];

const LaunchConfigStruct = define_decoder_struct({
    header: skip(16),
    curve_type: u8(),
    index: u16(),
    migrate_fee: u64(),
    trade_fee_rate: u64(),
    max_share_fee_rate: u64(),
    min_supply: u64(),
    max_lock_rate: u64(),
    min_sell_rate: u64(),
    min_migrate_rate: u64(),
    min_fundraising: u64(),
    quote_mint: pubkey()
});

const StateStruct = define_decoder_struct({
    discriminator: discriminator(Buffer.from(RAYDIUM_LAUNCHPAD_POOL_HEADER)),
    epoch: skip(u64().size),
    auth_bump: skip(u8().size),
    status: u8(),
    base_decimals: u8(),
    quote_decimals: u8(),
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
    global_config: pubkey(),
    platform_config: pubkey(),
    base_mint: pubkey(),
    quote_mint: pubkey(),
    base_vault: pubkey(),
    quote_vault: pubkey(),
    creator: pubkey(),
    padding: skip(8 * u64().size)
});

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

export class RaydiumMintMeta implements trade.IMintMeta {
    mint!: string;
    quote_mint: string = SOL_MINT.toBase58();
    name: string = 'Unknown';
    symbol: string = 'Unknown';
    base_vault!: string;
    quote_vault!: string;
    pool!: string;
    config!: string;
    global_config: string = RAYDIUM_LAUNCHPAD_GLOBAL_CONFIG.toBase58();
    creator!: string;
    sol_reserves: bigint = BigInt(0);
    token_reserves: bigint = BigInt(0);
    total_supply: bigint = BigInt(0);
    market_cap: number = 0;
    complete: boolean = false;
    observation_state: string | null = null;
    fee: number = 0.0125;
    token_program_id!: string;
    token_decimals: number = TRADE_DEFAULT_TOKEN_DECIMALS;

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

    public get token_quote_mc(): number {
        return this.market_cap;
    }

    public get migrated(): boolean {
        return this.observation_state !== null;
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
            base_vault: this.base_vault,
            quote_vault: this.quote_vault,
            pool: this.pool,
            config: this.config,
            global_config: this.global_config,
            creator: this.creator,
            sol_reserves: this.sol_reserves.toString(),
            token_reserves: this.token_reserves.toString(),
            total_supply: this.total_supply.toString(),
            market_cap: this.market_cap,
            complete: this.complete,
            observation_state: this.observation_state,
            fee: this.fee,
            token_decimals: this.token_decimals,
            token_program_id: this.token_program_id
        };
    }

    public static deserialize(data: trade.SerializedMintMeta): RaydiumMintMeta {
        return new RaydiumMintMeta({
            mint: data.mint as string,
            name: data.name as string,
            symbol: data.symbol as string,
            quote_mint: normalize_quote_mint(data.quote_mint as string | undefined).toBase58(),
            base_vault: data.base_vault as string,
            quote_vault: data.quote_vault as string,
            pool: data.pool as string,
            config: data.config as string,
            global_config: (data.global_config as string) ?? RAYDIUM_LAUNCHPAD_GLOBAL_CONFIG.toBase58(),
            creator: data.creator as string,
            sol_reserves: BigInt(data.sol_reserves as string),
            token_reserves: BigInt(data.token_reserves as string),
            total_supply: BigInt(data.total_supply as string),
            market_cap: data.market_cap as number,
            complete: data.complete as boolean,
            observation_state: data.observation_state as string | null,
            fee: data.fee as number,
            token_decimals: (data.token_decimals as number | undefined) ?? TRADE_DEFAULT_TOKEN_DECIMALS,
            token_program_id: data.token_program_id as string
        });
    }
}

export class RaydiumTrader implements trade.IProgramTrader {
    protected readonly compute_unit_limit = RAYDIUM_COMPUTE_UNIT_LIMIT;
    protected readonly mint_meta_defaults = RAYDIUM_DEFAULT_MINT_META;

    public get_name(): string {
        return common.Program.Raydium;
    }

    public get_lta_addresses(): PublicKey[] {
        return [RAYDIUM_LTA_ACCOUNT];
    }

    public deserialize_mint_meta(data: trade.SerializedMintMeta): RaydiumMintMeta {
        return RaydiumMintMeta.deserialize(data);
    }

    public get_compute_unit_limit(): number | undefined {
        return this.compute_unit_limit;
    }

    public async get_trader_rewards(trader: Keypair): Promise<RaydiumClaimableAsset[]> {
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

    public async claim_trader_rewards(
        trader: Keypair,
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
            const creator_token_0 = await trade.calc_ata(trader.publicKey, state.token_0_mint, state.token_0_program);
            const creator_token_1 = await trade.calc_ata(trader.publicKey, state.token_1_mint, state.token_1_program);
            instructions.push(
                createAssociatedTokenAccountIdempotentInstruction(
                    trader,
                    creator_token_0,
                    trader.publicKey,
                    state.token_0_mint,
                    state.token_0_program
                ),
                createAssociatedTokenAccountIdempotentInstruction(
                    trader,
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
        return await trade.send_tx(
            instructions,
            [trader],
            priority,
            undefined,
            false,
            undefined,
            this.compute_unit_limit
        );
    }

    public async buy_token(
        amount: TokenAmount,
        buyer: Keypair,
        mint_meta: RaydiumMintMeta,
        slippage: number = 0.05,
        priority?: PriorityLevel,
        protection_tip?: number,
        mev_protect: boolean = false
    ): Promise<String> {
        const [instructions, ltas] = await this.buy_token_instructions(amount, buyer, mint_meta, slippage);
        return await trade.send_tx(
            instructions,
            [buyer],
            priority,
            protection_tip,
            mev_protect,
            ltas,
            this.compute_unit_limit
        );
    }

    public async buy_token_instructions(
        amount: TokenAmount,
        buyer: Keypair,
        mint_meta: RaydiumMintMeta,
        slippage: number = 0.05
    ): Promise<[TransactionInstruction[], AddressLookupTableAccount[]?]> {
        trade.validate_trade_parameters(amount, slippage);
        const lta = await trade.get_ltas([RAYDIUM_LTA_ACCOUNT]);
        if (mint_meta.complete) {
            const instructions = await this.get_buy_cpmm_instructions(amount, buyer, mint_meta, slippage);
            return [instructions, lta];
        }
        const instructions = await this.get_buy_instructions(amount, buyer, mint_meta, slippage);
        return [instructions, lta];
    }

    public async sell_token(
        token_amount: TokenAmount,
        seller: Keypair,
        mint_meta: RaydiumMintMeta,
        slippage: number = 0.05,
        priority: PriorityLevel,
        protection_tip?: number,
        mev_protect: boolean = false
    ): Promise<String> {
        const [instructions, ltas] = await this.sell_token_instructions(token_amount, seller, mint_meta, slippage);
        return await trade.send_tx(
            instructions,
            [seller],
            priority,
            protection_tip,
            mev_protect,
            ltas,
            this.compute_unit_limit
        );
    }

    public async sell_token_instructions(
        token_amount: TokenAmount,
        seller: Keypair,
        mint_meta: RaydiumMintMeta,
        slippage: number = 0.05
    ): Promise<[TransactionInstruction[], AddressLookupTableAccount[]?]> {
        trade.validate_trade_parameters(token_amount, slippage);
        const lta = await trade.get_ltas([RAYDIUM_LTA_ACCOUNT]);
        if (mint_meta.complete) {
            const instructions = await this.get_sell_cpmm_instructions(token_amount, seller, mint_meta, slippage);
            return [instructions, lta];
        }
        const instructions = await this.get_sell_instructions(token_amount, seller, mint_meta, slippage);
        return [instructions, lta];
    }

    public async buy_sell_instructions(
        amount: TokenAmount,
        trader: Keypair,
        mint_meta: RaydiumMintMeta,
        slippage: number = 0.05
    ): Promise<[TransactionInstruction[], TransactionInstruction[], AddressLookupTableAccount[]?]> {
        trade.validate_trade_parameters(amount, slippage);
        const amount_raw = BigInt(amount.amount);
        const token_amount_raw = this.calc_token_amount_raw(amount_raw, mint_meta);
        const buy_instructions = mint_meta.complete
            ? await this.get_buy_cpmm_instructions(amount, trader, mint_meta, slippage, token_amount_raw)
            : await this.get_buy_instructions(amount, trader, mint_meta, slippage, token_amount_raw);
        const [sell_instructions, lta] = await this.sell_token_instructions(
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
        amount: TokenAmount,
        trader: Keypair,
        mint_meta: RaydiumMintMeta,
        slippage: number = 0.05,
        interval_ms?: number,
        priority?: PriorityLevel,
        protection_tip?: number,
        mev_protect: boolean = false
    ): Promise<[String, String]> {
        const [buy_instructions, sell_instructions, ltas] = await this.buy_sell_instructions(
            amount,
            trader,
            mint_meta,
            slippage
        );

        if (interval_ms && interval_ms > 0) {
            const buy_signature = await trade.send_tx(
                buy_instructions,
                [trader],
                priority,
                protection_tip,
                mev_protect,
                ltas,
                this.compute_unit_limit
            );
            await common.sleep(interval_ms);
            const sell_signature = await trade.retry_send_tx(
                sell_instructions,
                [trader],
                priority,
                protection_tip,
                mev_protect,
                ltas,
                this.compute_unit_limit
            );
            return [buy_signature, sell_signature];
        }

        const signature = await trade.send_tx(
            [...buy_instructions, ...sell_instructions],
            [trader],
            priority,
            protection_tip,
            mev_protect,
            ltas,
            this.compute_unit_limit
        );
        return [signature, signature];
    }

    public async buy_sell_bundle(
        amount: TokenAmount,
        trader: Keypair,
        mint_meta: RaydiumMintMeta,
        tip: number,
        slippage: number = 0.05,
        priority?: PriorityLevel
    ): Promise<String> {
        const [buy_instructions, sell_instructions, ltas] = await this.buy_sell_instructions(
            amount,
            trader,
            mint_meta,
            slippage
        );
        return await trade.send_bundle(
            [buy_instructions, sell_instructions],
            [[trader], [trader]],
            tip,
            priority,
            ltas,
            this.compute_unit_limit
        );
    }

    public async get_mint_meta(mint: PublicKey): Promise<RaydiumMintMeta | undefined> {
        try {
            let mint_meta = await this.default_mint_meta(mint);
            mint_meta = await this.update_mint_meta(mint_meta);
            return mint_meta;
        } catch (error) {
            return undefined;
        }
    }

    public async get_random_mints(count: number): Promise<RaydiumMintMeta[]> {
        return trade.sample_mint_sources(
            count,
            (size) => this.get_random_graduated_mints(size),
            (size) => this.get_random_ungraduated_mints(size)
        );
    }

    public async create_token(
        mint: Keypair,
        creator: Keypair,
        token_name: string,
        token_symbol: string,
        meta_cid: string,
        amount: TokenAmount = trade.get_sol_token_amount(0),
        traders?: [Keypair, TokenAmount][],
        bundle_tip?: number,
        priority?: PriorityLevel,
        config?: object
    ): Promise<String> {
        trade.validate_create_token_parameters(amount, traders, bundle_tip);
        const { global_config, quote_mint, fundraising, fee, reserves, remaining_accounts } =
            await this.get_create_settings(config as CreateOptions);
        let mint_meta = await this.default_mint_meta(mint.publicKey, {
            name: token_name,
            symbol: token_symbol,
            creator: creator.publicKey.toBase58(),
            config: this.get_create_platform().toBase58(),
            global_config: global_config.toBase58(),
            quote_mint: quote_mint.toBase58(),
            token_program: TOKEN_PROGRAM_ID.toBase58()
        });
        Object.assign(mint_meta, reserves, { fee });
        const create_instructions = await this.get_create_token_instructions(
            creator,
            token_name,
            token_symbol,
            meta_cid,
            mint,
            quote_mint,
            global_config,
            fundraising,
            remaining_accounts
        );
        if (BigInt(amount.amount) > 0n)
            create_instructions.push(...(await this.get_buy_instructions(amount, creator, mint_meta, 0.05)));

        const ltas = global.TRANSACTION_VERSION === 1 ? [] : await trade.get_ltas(this.get_lta_addresses());
        if (!traders)
            return trade.retry_send_tx(
                create_instructions,
                [creator, mint],
                priority,
                undefined,
                false,
                ltas,
                this.compute_unit_limit
            );

        if (BigInt(amount.amount) > 0n) mint_meta = this.update_mint_meta_reserves(mint_meta, amount, 'buy');

        const buyers: trade.InitialBuy[] = [];
        for (const [buyer, buy_amount] of traders) {
            buyers.push({ buyer, instructions: await this.get_buy_instructions(buy_amount, buyer, mint_meta, 0.05) });
            mint_meta = this.update_mint_meta_reserves(mint_meta, buy_amount, 'buy');
        }
        return trade.send_create_bundle({
            instructions: create_instructions,
            creator,
            mint,
            buyers,
            tip: bundle_tip!,
            priority,
            alts: ltas,
            token_program: mint_meta.token_program,
            wallet_compute_units: this.compute_unit_limit!
        });
    }

    public async create_token_metadata(meta: common.IPFSMetadata, image_path: string): Promise<string> {
        return await common.upload_metadata_ipfs(meta, image_path);
    }

    public update_mint_meta_reserves(
        mint_meta: RaydiumMintMeta,
        amount: TokenAmount,
        op: trade.TradeOp
    ): RaydiumMintMeta {
        const swap = this.calc_swap_amounts(BigInt(amount.amount), mint_meta, op);
        mint_meta.sol_reserves += swap.quote_delta;
        mint_meta.token_reserves += swap.base_delta;
        return mint_meta;
    }

    public async subscribe_mint_meta(
        mint_meta: RaydiumMintMeta,
        callback: (mint_meta: RaydiumMintMeta) => void,
        commitment: Commitment = COMMITMENT
    ): Promise<() => void> {
        let launchpad_sub: number | undefined;
        const cpmm_subs: number[] = [];
        let stopped = false;
        let current_mint_meta = mint_meta;
        let latest_slot = 0n;
        let cpmm_started = false;

        const publish = (update: RaydiumMintMeta, slot: bigint = 0n) => {
            if (stopped || (slot && slot < latest_slot)) return;
            if (slot) latest_slot = slot;
            current_mint_meta = update;
            callback(update);
        };
        const unsubscribe = (id: number | undefined) => {
            if (id !== undefined) global.CONNECTION.removeAccountChangeListener(id).catch(() => {});
        };

        const subscribe_cpmm = async (pool: PublicKey) => {
            if (cpmm_started) return;
            cpmm_started = true;
            let state: ReturnType<typeof CPMMStateStruct.decode> | null = null;
            let token_0_balance: bigint | null = null;
            let token_1_balance: bigint | null = null;
            let state_slot = 0n;
            let token_0_slot = 0n;
            let token_1_slot = 0n;
            let vaults_started = false;

            const publish_cpmm = (slot: bigint = 0n) => {
                if (
                    !state ||
                    token_0_balance === null ||
                    token_1_balance === null ||
                    state_slot !== token_0_slot ||
                    state_slot !== token_1_slot
                )
                    return;
                const fields = this.cpmm_mint_fields(
                    { ...state, ...this.calc_cpmm_reserves(state, token_0_balance, token_1_balance) },
                    current_mint_meta.mint_pubkey
                );
                const metrics = this.get_token_metrics(
                    fields.sol_reserves,
                    fields.token_reserves,
                    current_mint_meta.total_supply,
                    fields.quote_decimals,
                    fields.token_decimals
                );
                publish(
                    new RaydiumMintMeta({
                        ...current_mint_meta,
                        pool: pool.toBase58(),
                        ...fields,
                        complete: true,
                        config: state.amm_config.toBase58(),
                        observation_state: state.observation_key.toBase58(),
                        market_cap: metrics.mcap_quote
                    }),
                    slot
                );
            };

            const subscribe_accounts = async () => {
                if (!state || vaults_started) return;
                vaults_started = true;
                cpmm_subs.push(
                    global.CONNECTION.onAccountChange(
                        state.token_0_vault,
                        (info, context) => {
                            token_0_balance = decode_token_account(info).amount;
                            token_0_slot = context.slot;
                            publish_cpmm(context.slot);
                        },
                        { commitment }
                    ),
                    global.CONNECTION.onAccountChange(
                        state.token_1_vault,
                        (info, context) => {
                            token_1_balance = decode_token_account(info).amount;
                            token_1_slot = context.slot;
                            publish_cpmm(context.slot);
                        },
                        { commitment }
                    )
                );

                const response = await global.CONNECTION.getMultipleAccountsInfoAndContext(
                    [pool, state.token_0_vault, state.token_1_vault],
                    commitment
                );
                const [state_info, token_0_info, token_1_info] = response.value;
                if (state_info && response.context.slot >= state_slot) {
                    state = CPMMStateStruct.decode(state_info.data);
                    state_slot = response.context.slot;
                }
                if (token_0_info && response.context.slot >= token_0_slot) {
                    token_0_balance = decode_token_account(token_0_info).amount;
                    token_0_slot = response.context.slot;
                }
                if (token_1_info && response.context.slot >= token_1_slot) {
                    token_1_balance = decode_token_account(token_1_info).amount;
                    token_1_slot = response.context.slot;
                }
                publish_cpmm(response.context.slot);
            };

            const process = async (info: AccountInfo<Uint8Array>, slot: bigint = 0n) => {
                if (stopped || (slot && slot < latest_slot)) return;
                state = CPMMStateStruct.decode(info.data);
                state_slot = slot;
                await subscribe_accounts();
                publish_cpmm(slot);
            };

            cpmm_subs.push(
                global.CONNECTION.onAccountChange(pool, (info, context) => void process(info, context.slot), {
                    commitment
                })
            );
            const response = await global.CONNECTION.getAccountInfoAndContext(pool, commitment);
            if (response.value) await process(response.value, response.context.slot);
        };

        const cpmm = mint_meta.migrated
            ? { pubkey: new PublicKey(mint_meta.pool) }
            : mint_meta.creator && !mint_meta.complete
              ? null
              : await this.get_cpmm_from_mint(
                    mint_meta.mint_pubkey,
                    mint_meta.creator ? mint_meta.quote_mint_pubkey : undefined
                );
        if (cpmm) {
            await subscribe_cpmm(cpmm.pubkey);
        } else {
            const pool = mint_meta.creator
                ? new PublicKey(mint_meta.pool)
                : (await this.get_launch_pool(mint_meta.mint_pubkey, new PublicKey(mint_meta.pool))).pubkey;
            const process_launchpad = async (info: AccountInfo<Uint8Array>, slot: bigint = 0n) => {
                if (stopped || (slot && slot < latest_slot)) return;
                const state = StateStruct.decode(info.data);
                const metrics = this.get_token_metrics(
                    state.real_quote + state.virtual_quote,
                    state.virtual_base - state.real_base,
                    state.supply,
                    state.quote_decimals,
                    state.base_decimals
                );
                publish(
                    new RaydiumMintMeta({
                        ...current_mint_meta,
                        sol_reserves: state.real_quote + state.virtual_quote,
                        token_reserves: state.virtual_base - state.real_base,
                        total_supply: state.supply,
                        pool: pool.toBase58(),
                        quote_mint: state.quote_mint.toBase58(),
                        token_decimals: state.base_decimals,
                        global_config: state.global_config.toBase58(),
                        base_vault: state.base_vault.toBase58(),
                        quote_vault: state.quote_vault.toBase58(),
                        complete: state.status !== 0,
                        config: state.platform_config.toBase58(),
                        creator: state.creator.toBase58(),
                        market_cap: metrics.mcap_quote
                    }),
                    slot
                );
                if (state.status === 0 || cpmm_started) return;
                const migrated = await this.get_cpmm_from_mint(mint_meta.mint_pubkey, state.quote_mint);
                if (!migrated || (slot && slot < latest_slot)) return;
                unsubscribe(launchpad_sub);
                launchpad_sub = undefined;
                await subscribe_cpmm(migrated.pubkey);
            };

            launchpad_sub = global.CONNECTION.onAccountChange(
                pool,
                (info, context) => void process_launchpad(info, context.slot),
                { commitment }
            );
            const response = await global.CONNECTION.getAccountInfoAndContext(pool, commitment);
            if (response.value) await process_launchpad(response.value, response.context.slot);
        }
        return () => {
            stopped = true;
            unsubscribe(launchpad_sub);
            cpmm_subs.forEach(unsubscribe);
        };
    }

    public async update_mint_meta(mint_meta: RaydiumMintMeta): Promise<RaydiumMintMeta> {
        try {
            const launch_pool =
                !mint_meta.migrated && mint_meta.creator
                    ? await this.get_launch_pool(mint_meta.mint_pubkey, new PublicKey(mint_meta.pool))
                    : undefined;
            const launch_state = launch_pool ? StateStruct.decode(launch_pool.account.data) : undefined;
            const cpmm_pool = mint_meta.migrated
                ? { pubkey: new PublicKey(mint_meta.pool), account: undefined }
                : launch_state?.status === 0
                  ? null
                  : await this.get_cpmm_from_mint(mint_meta.mint_pubkey, launch_state?.quote_mint);

            if (!cpmm_pool && (!mint_meta.complete || launch_state)) {
                const pool =
                    launch_pool ?? (await this.get_launch_pool(mint_meta.mint_pubkey, new PublicKey(mint_meta.pool)));
                const state = launch_state ?? StateStruct.decode(pool.account.data);
                const metrics = this.get_token_metrics(
                    state.real_quote + state.virtual_quote,
                    state.virtual_base - state.real_base,
                    state.supply,
                    state.quote_decimals,
                    state.base_decimals
                );
                return new RaydiumMintMeta({
                    ...mint_meta,
                    quote_mint: state.quote_mint.toString(),
                    token_decimals: state.base_decimals,
                    pool: pool.pubkey.toBase58(),
                    global_config: state.global_config.toBase58(),
                    base_vault: state.base_vault.toBase58(),
                    quote_vault: state.quote_vault.toBase58(),
                    market_cap: metrics.mcap_quote,
                    sol_reserves: state.real_quote + state.virtual_quote,
                    token_reserves: state.virtual_base - state.real_base,
                    total_supply: state.supply,
                    complete: state.status !== 0,
                    config: state.platform_config.toString(),
                    creator: state.creator.toString()
                });
            }

            if (cpmm_pool) {
                const state = await this.get_cpmm_state(cpmm_pool.pubkey, mint_meta.mint_pubkey, cpmm_pool.account);
                const fields = this.cpmm_mint_fields(state, mint_meta.mint_pubkey);
                const metrics = this.get_token_metrics(
                    fields.sol_reserves,
                    fields.token_reserves,
                    state.supply,
                    fields.quote_decimals,
                    fields.token_decimals
                );
                return new RaydiumMintMeta({
                    ...mint_meta,
                    market_cap: metrics.mcap_quote,
                    pool: cpmm_pool.pubkey.toBase58(),
                    ...fields,
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

    public async default_mint_meta(mint: PublicKey, data?: object): Promise<RaydiumMintMeta> {
        const decoded = data as Record<string, unknown> | undefined;
        const meta = decoded
            ? {
                  token_name: typeof decoded.name === 'string' ? decoded.name : 'Unknown',
                  token_symbol: typeof decoded.symbol === 'string' ? decoded.symbol : 'Unknown',
                  token_decimal: (decoded.token_decimals as number | undefined) ?? TRADE_DEFAULT_TOKEN_DECIMALS,
                  token_program:
                      typeof decoded.token_program === 'string'
                          ? new PublicKey(decoded.token_program)
                          : TOKEN_PROGRAM_ID
              }
            : await trade.get_token_meta(mint).catch(() => {
                  return {
                      token_name: 'Unknown',
                      token_symbol: 'Unknown',
                      token_program: TOKEN_PROGRAM_ID,
                      token_decimal: TRADE_DEFAULT_TOKEN_DECIMALS
                  };
              });
        const quote_mint = new PublicKey((decoded?.quote_mint as string | undefined) ?? SOL_MINT);
        const pool =
            typeof decoded?.pool === 'string' ? new PublicKey(decoded.pool) : await this.calc_pool(mint, quote_mint);
        const [derived_base_vault, derived_quote_vault] = await this.calc_vault(mint, pool, quote_mint);
        const base_vault =
            typeof decoded?.base_vault === 'string' ? new PublicKey(decoded.base_vault) : derived_base_vault;
        const quote_vault =
            typeof decoded?.quote_vault === 'string' ? new PublicKey(decoded.quote_vault) : derived_quote_vault;

        return new RaydiumMintMeta({
            mint: mint.toString(),
            quote_mint: quote_mint.toBase58(),
            symbol: meta.token_symbol,
            name: meta.token_name,
            pool: pool.toString(),
            config: typeof decoded?.config === 'string' ? decoded.config : undefined,
            global_config:
                typeof decoded?.global_config === 'string'
                    ? decoded.global_config
                    : RAYDIUM_LAUNCHPAD_GLOBAL_CONFIG.toBase58(),
            creator: typeof decoded?.creator === 'string' ? decoded.creator : undefined,
            base_vault: base_vault.toString(),
            quote_vault: quote_vault.toString(),
            ...this.mint_meta_defaults,
            market_cap: quote_mint.equals(SOL_MINT) ? this.mint_meta_defaults.market_cap : 0,
            token_program_id: meta.token_program.toString(),
            token_decimals: meta.token_decimal
        });
    }

    public async estimate_buy_output(
        mint_meta: RaydiumMintMeta,
        quote_amount: TokenAmount,
        slippage: number
    ): Promise<trade.OutputEstimate> {
        const raw_amount = this.calc_token_amount_raw(BigInt(quote_amount.amount), mint_meta);
        const minimum_raw_amount = trade.apply_slippage_down(raw_amount, slippage);
        return {
            expected: {
                amount: raw_amount.toString(),
                decimals: mint_meta.token_decimals,
                uiAmount: Number(raw_amount) / 10 ** mint_meta.token_decimals
            },
            minimum: {
                amount: minimum_raw_amount.toString(),
                decimals: mint_meta.token_decimals,
                uiAmount: Number(minimum_raw_amount) / 10 ** mint_meta.token_decimals
            }
        };
    }

    public async estimate_sell_output(
        mint_meta: RaydiumMintMeta,
        token_amount: TokenAmount,
        slippage: number
    ): Promise<trade.OutputEstimate> {
        const quote = await get_quote_info(mint_meta.quote_mint_pubkey);
        const raw_amount = this.calc_quote_amount_raw(BigInt(token_amount.amount), mint_meta);
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

    private create_data(
        name: string,
        symbol: string,
        uri: string,
        fundraising = RAYDIUM_LAUNCHPAD_CREATE_PARAMS.fundraising
    ): Buffer {
        const string = (value: string) => {
            const data = Buffer.alloc(4 + Buffer.byteLength(value));
            data.writeUInt32LE(Buffer.byteLength(value));
            data.write(value, 4);
            return data;
        };
        const { supply, total_sell } = RAYDIUM_LAUNCHPAD_CREATE_PARAMS;
        const curve = Buffer.alloc(26);
        curve.writeUInt8(0);
        curve.writeBigUInt64LE(supply, 1);
        curve.writeBigUInt64LE(total_sell, 9);
        curve.writeBigUInt64LE(fundraising, 17);
        curve.writeUInt8(1, 25);
        return Buffer.concat([
            Buffer.from(RAYDIUM_LAUNCHPAD_CREATE_DISCRIMINATOR),
            Buffer.from([TRADE_DEFAULT_TOKEN_DECIMALS]),
            string(name),
            string(symbol),
            string(uri),
            curve,
            Buffer.alloc(25)
        ]);
    }

    private async get_random_ungraduated_mints(count: number): Promise<RaydiumMintMeta[]> {
        if (count <= 0) return [];
        const limit = Math.min(100, Math.max(20, count * 3));
        try {
            const url = new URL(`${RAYDIUM_LAUNCHPAD_API_URL}/get/list`);
            url.searchParams.set('sort', 'lastTrade');
            url.searchParams.set('size', String(limit));
            url.searchParams.set('mintType', 'default');
            const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
            const data = await response.json();
            if (!response.ok || !data.success || !Array.isArray(data.data?.rows))
                throw new Error('LaunchLab mint discovery failed.');
            const candidates = data.data.rows
                .filter((row: { mintB?: { address: string } }) => row.mintB?.address === SOL_MINT.toBase58())
                .map((row: { mint: string }) => row.mint) as string[];
            return trade.resolve_random_mints(candidates, count, async (mint) => {
                const meta = await this.get_mint_meta(mint);
                return meta && !meta.migrated && meta.sol_reserves > 0n && meta.token_reserves > 0n ? meta : undefined;
            });
        } catch (error) {
            common.error(common.red(`Failed fetching LaunchLab mints: ${error}`));
            return [];
        }
    }

    protected get_create_platform(): PublicKey {
        return RAYDIUM_LAUNCHPAD_PLATFORM_CONFIG;
    }

    private async calc_global_config(options: CreateOptions): Promise<PublicKey> {
        if (options.global_config) return new PublicKey(options.global_config);
        if (!options.quote_mint) return RAYDIUM_LAUNCHPAD_GLOBAL_CONFIG;
        const [config] = await PublicKey.findProgramAddress(
            [Buffer.from('global_config'), new PublicKey(options.quote_mint).toBytes(), new Uint8Array([0, 0, 0])],
            RAYDIUM_LAUNCHPAD_PROGRAM_ID
        );
        return config;
    }

    private async get_create_settings(options: CreateOptions = {}) {
        const global_config = await this.calc_global_config(options);
        const platform = this.get_create_platform();
        const [config_info, platform_info] = await global.CONNECTION.getMultipleAccountsInfo(
            [global_config, platform],
            COMMITMENT
        );
        if (!config_info?.owner.equals(RAYDIUM_LAUNCHPAD_PROGRAM_ID))
            throw new Error('Invalid LaunchLab global config');
        if (!platform_info?.owner.equals(RAYDIUM_LAUNCHPAD_PROGRAM_ID))
            throw new Error('Invalid LaunchLab platform config');
        const settings = LaunchConfigStruct.decode(config_info.data);
        if (settings.curve_type !== 0) throw new Error('Only constant-product LaunchLab curves are supported');
        const quote_mint = settings.quote_mint;
        if (options.quote_mint && !new PublicKey(options.quote_mint).equals(quote_mint))
            throw new Error('Quote mint does not match LaunchLab global config');
        if (!quote_mint.equals(SOL_MINT) && options.fundraising === undefined)
            throw new Error('Non-SOL LaunchLab creation requires config.fundraising in raw quote units');
        const fundraising = BigInt(options.fundraising ?? RAYDIUM_LAUNCHPAD_CREATE_PARAMS.fundraising);
        if (fundraising < settings.min_fundraising || fundraising <= settings.migrate_fee)
            throw new Error('Invalid LaunchLab fundraising amount (raw quote units)');
        const platform_data = Buffer.from(platform_info.data);
        return {
            global_config,
            quote_mint,
            fundraising,
            fee:
                Number(
                    settings.trade_fee_rate + platform_data.readBigUInt64LE(104) + platform_data.readBigUInt64LE(720)
                ) / 1_000_000,
            reserves: this.calc_initial_reserves(fundraising, settings.migrate_fee),
            remaining_accounts: await this.calc_create_remaining_accounts(platform, global_config, platform_data)
        };
    }

    private calc_initial_reserves(fundraising: bigint, migrate_fee: bigint) {
        const { supply, total_sell } = RAYDIUM_LAUNCHPAD_CREATE_PARAMS;
        const remaining = supply - total_sell;
        const raised = fundraising - migrate_fee;
        const denominator = (raised * total_sell) / remaining - fundraising;
        if (denominator <= 0n) throw new Error('Invalid LaunchLab initial curve');
        return {
            token_reserves: (raised * total_sell * total_sell) / remaining / denominator,
            sol_reserves: (fundraising * fundraising) / denominator
        };
    }

    private async calc_create_remaining_accounts(platform: PublicKey, global_config: PublicKey, data: Buffer) {
        const seeds = [
            [832, 'platform_allow_config'],
            [833, 'platform_curve_rule']
        ] as const;
        return Promise.all(
            seeds
                .filter(([offset]) => data[offset])
                .map(async ([, seed]) => {
                    const [address] = await PublicKey.findProgramAddress(
                        [Buffer.from(seed), platform.toBytes(), global_config.toBytes()],
                        RAYDIUM_LAUNCHPAD_PROGRAM_ID
                    );
                    return address;
                })
        );
    }

    private async get_create_token_instructions(
        creator: Keypair,
        token_name: string,
        token_symbol: string,
        meta_cid: string,
        mint: Keypair,
        quote_mint: PublicKey = SOL_MINT,
        global_config: PublicKey = RAYDIUM_LAUNCHPAD_GLOBAL_CONFIG,
        fundraising: bigint = RAYDIUM_LAUNCHPAD_CREATE_PARAMS.fundraising,
        remaining_accounts: PublicKey[] = []
    ): Promise<TransactionInstruction[]> {
        const pool = await this.calc_pool(mint.publicKey, quote_mint);
        const [base_vault, quote_vault] = await this.calc_vault(mint.publicKey, pool, quote_mint);
        const quote = await get_quote_info(quote_mint);
        const [metadata] = await PublicKey.findProgramAddress(
            [METAPLEX_META_SEED, METAPLEX_PROGRAM_ID.toBytes(), mint.publicKey.toBytes()],
            METAPLEX_PROGRAM_ID
        );
        return [
            new TransactionInstruction({
                programId: RAYDIUM_LAUNCHPAD_PROGRAM_ID,
                data: this.create_data(token_name, token_symbol, `${IPFS}${meta_cid}`, fundraising),
                keys: [
                    { pubkey: creator.publicKey, isSigner: true, isWritable: true },
                    { pubkey: creator.publicKey, isSigner: false, isWritable: false },
                    { pubkey: global_config, isSigner: false, isWritable: false },
                    { pubkey: this.get_create_platform(), isSigner: false, isWritable: false },
                    { pubkey: RAYDIUM_LAUNCHPAD_AUTHORITY, isSigner: false, isWritable: false },
                    { pubkey: pool, isSigner: false, isWritable: true },
                    { pubkey: mint.publicKey, isSigner: true, isWritable: true },
                    { pubkey: quote_mint, isSigner: false, isWritable: false },
                    { pubkey: base_vault, isSigner: false, isWritable: true },
                    { pubkey: quote_vault, isSigner: false, isWritable: true },
                    { pubkey: metadata, isSigner: false, isWritable: true },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: quote.token_program, isSigner: false, isWritable: false },
                    { pubkey: METAPLEX_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: RENT_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: RAYDIUM_LAUNCHPAD_EVENT_AUTHORITY, isSigner: false, isWritable: false },
                    { pubkey: RAYDIUM_LAUNCHPAD_PROGRAM_ID, isSigner: false, isWritable: false },
                    ...remaining_accounts.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false }))
                ]
            })
        ];
    }

    private async get_random_graduated_mints(count: number): Promise<RaydiumMintMeta[]> {
        if (count <= 0) return [];
        const limit = Math.min(100, Math.max(20, count * 3));
        const sol = SOL_MINT.toBase58();
        try {
            const url = new URL(`${RAYDIUM_API_URL}/pools/info/mint`);
            url.searchParams.set('mint1', sol);
            url.searchParams.set('poolType', 'standard');
            url.searchParams.set('poolSortField', 'volume24h');
            url.searchParams.set('sortType', 'desc');
            url.searchParams.set('pageSize', String(limit));
            url.searchParams.set('page', '1');
            const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
            const data = await response.json();
            if (!response.ok || !data.success || !Array.isArray(data.data?.data))
                throw new Error('CPMM mint discovery failed.');
            const candidates = data.data.data
                .filter(
                    (pool: { programId: string; tvl: number }) =>
                        pool.programId === RAYDIUM_CPMM_PROGRAM_ID.toBase58() && pool.tvl > 0
                )
                .flatMap((pool: { mintA: { address: string }; mintB: { address: string } }) =>
                    pool.mintA.address === sol
                        ? [pool.mintB.address]
                        : pool.mintB.address === sol
                          ? [pool.mintA.address]
                          : []
                ) as string[];
            return trade.resolve_random_mints(candidates, count, async (mint) => {
                const meta = await this.get_mint_meta(mint);
                return meta && meta.migrated && meta.sol_reserves > 0n && meta.token_reserves > 0n ? meta : undefined;
            });
        } catch (error) {
            common.error(common.red(`Failed fetching CPMM mints: ${error}`));
            return [];
        }
    }

    private calc_token_amount_raw(quote_amount_raw: bigint, token: Partial<RaydiumMintMeta>): bigint {
        return this.calc_swap_amounts(quote_amount_raw, token, 'buy').output_amount;
    }

    private calc_quote_amount_raw(token_amount_raw: bigint, token: Partial<RaydiumMintMeta>): bigint {
        return this.calc_swap_amounts(token_amount_raw, token, 'sell').output_amount;
    }

    private calc_swap_amounts(amount: bigint, token: Partial<RaydiumMintMeta>, op: trade.TradeOp) {
        if (!token.sol_reserves || !token.token_reserves || token.fee === undefined || amount <= 0n)
            return { output_amount: 0n, base_delta: 0n, quote_delta: 0n };
        if (op === 'buy') {
            const quote_delta = amount - this.calc_fee(amount, token.fee);
            if (quote_delta <= 0n) return { output_amount: 0n, base_delta: 0n, quote_delta: 0n };
            const output_amount =
                token.token_reserves -
                (token.sol_reserves * token.token_reserves) / (token.sol_reserves + quote_delta) -
                1n;
            return { output_amount, base_delta: -output_amount, quote_delta };
        }
        // CPMM charges input fees; LaunchLab charges fees from gross quote output.
        const cpmm = Boolean(token.observation_state);
        const base_delta = cpmm ? amount - this.calc_fee(amount, token.fee) : amount;
        const gross_output = (base_delta * token.sol_reserves) / (token.token_reserves + base_delta);
        return {
            output_amount: cpmm ? gross_output : gross_output - this.calc_fee(gross_output, token.fee),
            base_delta,
            quote_delta: -gross_output
        };
    }

    private calc_fee(amount: bigint, rate: number): bigint {
        const fee_rate = BigInt(Math.round(rate * 1_000_000));
        return (amount * fee_rate + 999_999n) / 1_000_000n;
    }

    private swap_data(amount_in: bigint, minimum_amount_out: bigint, op: trade.TradeOp): Buffer {
        const discriminator = op === 'buy' ? RAYDIUM_LAUNCHPAD_BUY_DISCRIMINATOR : RAYDIUM_LAUNCHPAD_SELL_DISCRIMINATOR;
        const instruction_buf = Buffer.from(discriminator);
        const amount_buf = Buffer.alloc(8);
        amount_buf.writeBigUInt64LE(amount_in, 0);
        const token_amount_buf = Buffer.alloc(8);
        token_amount_buf.writeBigUInt64LE(minimum_amount_out, 0);
        const share_fee_rate = Buffer.alloc(8);
        share_fee_rate.writeBigUInt64LE(0n, 0);
        return Buffer.concat([instruction_buf, amount_buf, token_amount_buf, share_fee_rate]);
    }

    private swap_cpmm_data(amount_in: bigint, minimum_amount_out: bigint): Buffer {
        const instruction_buf = Buffer.from(RAYDIUM_CPMM_SWAP_DISCRIMINATOR);
        const amount_buf = Buffer.alloc(8);
        amount_buf.writeBigUInt64LE(amount_in, 0);
        const token_amount_buf = Buffer.alloc(8);
        token_amount_buf.writeBigUInt64LE(minimum_amount_out, 0);
        return Buffer.concat([instruction_buf, amount_buf, token_amount_buf]);
    }

    private async calc_volume_accumulator(target: PublicKey, quote_mint: PublicKey = SOL_MINT): Promise<PublicKey> {
        const [user_volume_accumulator] = await PublicKey.findProgramAddress(
            [target.toBytes(), quote_mint.toBytes()],
            RAYDIUM_LAUNCHPAD_PROGRAM_ID
        );
        return user_volume_accumulator;
    }

    private buy_exact_out_data(amount_raw: bigint, token_amount: bigint, slippage: number, cpmm: boolean): Buffer {
        const max_amount_raw = trade.apply_slippage_up(amount_raw, slippage);
        const data = Buffer.alloc(cpmm ? 24 : 32);
        Buffer.from(
            cpmm ? RAYDIUM_CPMM_SWAP_EXACT_OUT_DISCRIMINATOR : RAYDIUM_LAUNCHPAD_BUY_EXACT_OUT_DISCRIMINATOR
        ).copy(data);
        data.writeBigUInt64LE(cpmm ? max_amount_raw : token_amount, 8);
        data.writeBigUInt64LE(cpmm ? token_amount : max_amount_raw, 16);
        return data;
    }

    private async get_buy_instructions(
        amount: TokenAmount,
        buyer: Keypair,
        mint_meta: Partial<RaydiumMintMeta>,
        slippage: number = 0.05,
        exact_out_amount?: bigint
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

        const amount_raw = BigInt(amount.amount);
        const mint = new PublicKey(mint_meta.mint);
        const quote_mint = new PublicKey(mint_meta.quote_mint!);
        const quote = await prepare_quote_account(
            buyer,
            quote_mint,
            exact_out_amount === undefined ? amount_raw : trade.apply_slippage_up(amount_raw, slippage)
        );
        const token_program = new PublicKey(mint_meta.token_program_id ?? TOKEN_PROGRAM_ID);
        const quote_vault = new PublicKey(mint_meta.quote_vault);
        const base_vault = new PublicKey(mint_meta.base_vault);
        const pool = new PublicKey(mint_meta.pool);
        const config = new PublicKey(mint_meta.config);
        const creator = new PublicKey(mint_meta.creator);

        const platform_volume_accumulator = await this.calc_volume_accumulator(config, quote_mint);
        const creator_volume_accumulator = await this.calc_volume_accumulator(creator, quote_mint);

        const token_ata = await trade.calc_ata(buyer.publicKey, mint, token_program);
        const wsol_ata = quote.ata;

        const token_amount_raw = trade.apply_slippage_down(this.calc_token_amount_raw(amount_raw, mint_meta), slippage);
        const instruction_data =
            exact_out_amount === undefined
                ? this.swap_data(amount_raw, token_amount_raw, 'buy')
                : this.buy_exact_out_data(amount_raw, exact_out_amount, slippage, false);

        return [
            createAssociatedTokenAccountIdempotentInstruction(buyer, token_ata, buyer.publicKey, mint, token_program),
            ...quote.setup,
            new TransactionInstruction({
                keys: [
                    { pubkey: buyer.publicKey, isSigner: true, isWritable: true },
                    { pubkey: RAYDIUM_LAUNCHPAD_AUTHORITY, isSigner: false, isWritable: false },
                    {
                        pubkey: new PublicKey(mint_meta.global_config ?? RAYDIUM_LAUNCHPAD_GLOBAL_CONFIG),
                        isSigner: false,
                        isWritable: false
                    },
                    { pubkey: config, isSigner: false, isWritable: false },
                    { pubkey: pool, isSigner: false, isWritable: true },
                    { pubkey: token_ata, isSigner: false, isWritable: true },
                    { pubkey: wsol_ata, isSigner: false, isWritable: true },
                    { pubkey: base_vault, isSigner: false, isWritable: true },
                    { pubkey: quote_vault, isSigner: false, isWritable: true },
                    { pubkey: mint, isSigner: false, isWritable: false },
                    { pubkey: quote_mint, isSigner: false, isWritable: false },
                    { pubkey: token_program, isSigner: false, isWritable: false },
                    { pubkey: quote.token_program, isSigner: false, isWritable: false },
                    { pubkey: RAYDIUM_LAUNCHPAD_EVENT_AUTHORITY, isSigner: false, isWritable: false },
                    { pubkey: RAYDIUM_LAUNCHPAD_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: platform_volume_accumulator, isSigner: false, isWritable: true },
                    { pubkey: creator_volume_accumulator, isSigner: false, isWritable: true }
                ],
                programId: RAYDIUM_LAUNCHPAD_PROGRAM_ID,
                data: instruction_data
            }),
            ...quote.cleanup
        ];
    }

    private async get_sell_instructions(
        token_amount: TokenAmount,
        seller: Keypair,
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
        const quote_mint = new PublicKey(mint_meta.quote_mint!);
        const quote = await prepare_quote_account(seller, quote_mint);
        const token_program = new PublicKey(mint_meta.token_program_id ?? TOKEN_PROGRAM_ID);
        const quote_vault = new PublicKey(mint_meta.quote_vault);
        const base_vault = new PublicKey(mint_meta.base_vault);
        const pool = new PublicKey(mint_meta.pool);
        const config = new PublicKey(mint_meta.config);
        const creator = new PublicKey(mint_meta.creator);

        const platform_volume_accumulator = await this.calc_volume_accumulator(config, quote_mint);
        const creator_volume_accumulator = await this.calc_volume_accumulator(creator, quote_mint);

        const token_amount_raw = BigInt(token_amount.amount);
        const quote_amount_raw = trade.apply_slippage_down(
            this.calc_quote_amount_raw(token_amount_raw, mint_meta),
            slippage
        );

        const instruction_data = this.swap_data(token_amount_raw, quote_amount_raw, 'sell');
        const token_ata = await trade.calc_ata(seller.publicKey, mint, token_program);
        const wsol_ata = quote.ata;

        return [
            ...quote.setup,
            new TransactionInstruction({
                keys: [
                    { pubkey: seller.publicKey, isSigner: true, isWritable: true },
                    { pubkey: RAYDIUM_LAUNCHPAD_AUTHORITY, isSigner: false, isWritable: false },
                    {
                        pubkey: new PublicKey(mint_meta.global_config ?? RAYDIUM_LAUNCHPAD_GLOBAL_CONFIG),
                        isSigner: false,
                        isWritable: false
                    },
                    { pubkey: config, isSigner: false, isWritable: false },
                    { pubkey: pool, isSigner: false, isWritable: true },
                    { pubkey: token_ata, isSigner: false, isWritable: true },
                    { pubkey: wsol_ata, isSigner: false, isWritable: true },
                    { pubkey: base_vault, isSigner: false, isWritable: true },
                    { pubkey: quote_vault, isSigner: false, isWritable: true },
                    { pubkey: mint, isSigner: false, isWritable: false },
                    { pubkey: quote_mint, isSigner: false, isWritable: false },
                    { pubkey: token_program, isSigner: false, isWritable: false },
                    { pubkey: quote.token_program, isSigner: false, isWritable: false },
                    { pubkey: RAYDIUM_LAUNCHPAD_EVENT_AUTHORITY, isSigner: false, isWritable: false },
                    { pubkey: RAYDIUM_LAUNCHPAD_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: platform_volume_accumulator, isSigner: false, isWritable: true },
                    { pubkey: creator_volume_accumulator, isSigner: false, isWritable: true }
                ],
                programId: RAYDIUM_LAUNCHPAD_PROGRAM_ID,
                data: instruction_data
            }),
            ...quote.cleanup
        ];
    }

    private async get_buy_cpmm_instructions(
        amount: TokenAmount,
        buyer: Keypair,
        mint_meta: RaydiumMintMeta,
        slippage: number = 0.05,
        exact_out_amount?: bigint
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

        const amount_raw = BigInt(amount.amount);
        const mint = new PublicKey(mint_meta.mint);
        const quote_mint = mint_meta.quote_mint_pubkey;
        const quote = await prepare_quote_account(
            buyer,
            quote_mint,
            exact_out_amount === undefined ? amount_raw : trade.apply_slippage_up(amount_raw, slippage)
        );
        const pool = new PublicKey(mint_meta.pool);
        const observation_state = new PublicKey(mint_meta.observation_state);
        const quote_vault = new PublicKey(mint_meta.quote_vault);
        const base_vault = new PublicKey(mint_meta.base_vault);
        const config = new PublicKey(mint_meta.config);

        const token_amount_raw = trade.apply_slippage_down(this.calc_token_amount_raw(amount_raw, mint_meta), slippage);

        const instruction_data =
            exact_out_amount === undefined
                ? this.swap_cpmm_data(amount_raw, token_amount_raw)
                : this.buy_exact_out_data(amount_raw, exact_out_amount, slippage, true);
        const token_ata = await trade.calc_ata(buyer.publicKey, mint, mint_meta.token_program);
        const wsol_ata = quote.ata;

        return [
            createAssociatedTokenAccountIdempotentInstruction(
                buyer,
                token_ata,
                buyer.publicKey,
                mint,
                mint_meta.token_program
            ),
            ...quote.setup,
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
                    { pubkey: quote.token_program, isSigner: false, isWritable: false },
                    { pubkey: mint_meta.token_program, isSigner: false, isWritable: false },
                    { pubkey: quote_mint, isSigner: false, isWritable: false },
                    { pubkey: mint, isSigner: false, isWritable: false },
                    { pubkey: observation_state, isSigner: false, isWritable: true }
                ],
                programId: RAYDIUM_CPMM_PROGRAM_ID,
                data: instruction_data
            }),
            ...quote.cleanup
        ];
    }

    private async get_sell_cpmm_instructions(
        token_amount: TokenAmount,
        seller: Keypair,
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
        const quote_mint = mint_meta.quote_mint_pubkey;
        const quote = await prepare_quote_account(seller, quote_mint);
        const pool = new PublicKey(mint_meta.pool);
        const observation_state = new PublicKey(mint_meta.observation_state);
        const quote_vault = new PublicKey(mint_meta.quote_vault);
        const base_vault = new PublicKey(mint_meta.base_vault);
        const config = new PublicKey(mint_meta.config);

        const token_amount_raw = BigInt(token_amount.amount);
        const instruction_data = this.swap_cpmm_data(
            token_amount_raw,
            trade.apply_slippage_down(this.calc_quote_amount_raw(token_amount_raw, mint_meta), slippage)
        );
        const token_ata = await trade.calc_ata(
            seller.publicKey,
            new PublicKey(mint_meta.mint),
            mint_meta.token_program
        );
        const wsol_ata = quote.ata;

        return [
            ...quote.setup,
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
                    { pubkey: quote.token_program, isSigner: false, isWritable: false },
                    { pubkey: mint, isSigner: false, isWritable: false },
                    { pubkey: quote_mint, isSigner: false, isWritable: false },
                    { pubkey: observation_state, isSigner: false, isWritable: true }
                ],
                programId: RAYDIUM_CPMM_PROGRAM_ID,
                data: instruction_data
            }),
            ...quote.cleanup
        ];
    }

    private async calc_vault(
        mint: PublicKey,
        pool: PublicKey,
        quote_mint: PublicKey = SOL_MINT
    ): Promise<[PublicKey, PublicKey]> {
        const [base_vault] = await PublicKey.findProgramAddress(
            [RAYDIUM_LAUNCHPAD_VAULT_SEED, pool.toBytes(), mint.toBytes()],
            RAYDIUM_LAUNCHPAD_PROGRAM_ID
        );
        const [quote_vault] = await PublicKey.findProgramAddress(
            [RAYDIUM_LAUNCHPAD_VAULT_SEED, pool.toBytes(), quote_mint.toBytes()],
            RAYDIUM_LAUNCHPAD_PROGRAM_ID
        );
        return [base_vault, quote_vault];
    }

    private async calc_pool(base_mint: PublicKey, quote_mint: PublicKey = SOL_MINT): Promise<PublicKey> {
        const [vault] = await PublicKey.findProgramAddress(
            [RAYDIUM_LAUNCHPAD_POOL_SEED, base_mint.toBytes(), quote_mint.toBytes()],
            RAYDIUM_LAUNCHPAD_PROGRAM_ID
        );
        return vault;
    }

    private get_token_metrics(
        quote_reserves: bigint,
        base_reserves: bigint,
        supply: bigint,
        quote_decimals = 9,
        base_decimals = TRADE_DEFAULT_TOKEN_DECIMALS
    ): trade.TokenMetrics {
        if (base_reserves <= 0 || quote_reserves <= 0) throw new RangeError('Invalid curve reserves');
        return quote_metrics(Number(quote_reserves) / Number(base_reserves), supply, quote_decimals, base_decimals);
    }

    private async get_cpmm_from_mint(mint: PublicKey, quote_mint?: PublicKey): Promise<trade.ProgramAccount | null> {
        const pools = (
            await Promise.all(
                ['token_0_mint', 'token_1_mint'].map((field) =>
                    trade.get_program_accounts_v2(RAYDIUM_CPMM_PROGRAM_ID, [
                        { memcmp: { offset: CPMMStateStruct.get_offset(field), bytes: mint.toBase58() } },
                        ...(quote_mint
                            ? [
                                  {
                                      memcmp: {
                                          offset: CPMMStateStruct.get_offset(
                                              field === 'token_0_mint' ? 'token_1_mint' : 'token_0_mint'
                                          ),
                                          bytes: quote_mint.toBase58()
                                      }
                                  }
                              ]
                            : []),
                        { memcmp: { offset: 0, bytes: base58.encode(RAYDIUM_CPMM_POOL_STATE_HEADER) } }
                    ])
                )
            )
        ).flat();
        return (
            pools.find(({ account }) => {
                const state = CPMMStateStruct.decode(account.data);
                return state.token_0_mint.equals(SOL_MINT) || state.token_1_mint.equals(SOL_MINT);
            }) ??
            pools[0] ??
            null
        );
    }

    private async get_cpmm_state(
        cpmm_pool: PublicKey,
        base_mint: PublicKey,
        account?: trade.ProgramAccount['account']
    ): Promise<CPMMState> {
        const info = account ?? (await global.CONNECTION.getAccountInfo(cpmm_pool, COMMITMENT));
        if (!info || !info.data) throw new Error('Unexpected CPMM state');

        const state = CPMMStateStruct.decode(info.data);
        const [token_0_reserves, token_1_reserves, supply] = await Promise.all([
            trade.get_vault_balance(state.token_0_vault),
            trade.get_vault_balance(state.token_1_vault),
            trade.get_token_supply(base_mint)
        ]);

        return {
            ...state,
            ...this.calc_cpmm_reserves(state, token_0_reserves.balance, token_1_reserves.balance),
            supply: supply.supply
        };
    }

    private calc_cpmm_reserves(
        state: ReturnType<typeof CPMMStateStruct.decode>,
        token_0_balance: bigint,
        token_1_balance: bigint
    ) {
        return {
            token_0_reserves:
                token_0_balance - state.protocol_fees_token_0 - state.fund_fees_token_0 - state.creator_fees_token_0,
            token_1_reserves:
                token_1_balance - state.protocol_fees_token_1 - state.fund_fees_token_1 - state.creator_fees_token_1
        };
    }

    private cpmm_mint_fields(state: Omit<CPMMState, 'supply'>, mint: PublicKey) {
        const base_is_0 = state.token_0_mint.equals(mint);
        if (!base_is_0 && !state.token_1_mint.equals(mint)) throw new Error('CPMM does not contain base mint');
        return {
            quote_mint: (base_is_0 ? state.token_1_mint : state.token_0_mint).toBase58(),
            quote_decimals: base_is_0 ? state.mint_1_decimals : state.mint_0_decimals,
            token_program_id: (base_is_0 ? state.token_0_program : state.token_1_program).toBase58(),
            token_decimals: base_is_0 ? state.mint_0_decimals : state.mint_1_decimals,
            base_vault: (base_is_0 ? state.token_0_vault : state.token_1_vault).toBase58(),
            quote_vault: (base_is_0 ? state.token_1_vault : state.token_0_vault).toBase58(),
            token_reserves: base_is_0 ? state.token_0_reserves : state.token_1_reserves,
            sol_reserves: base_is_0 ? state.token_1_reserves : state.token_0_reserves
        };
    }

    private async get_launch_pool(mint: PublicKey, hint: PublicKey): Promise<trade.ProgramAccount> {
        const info = await global.CONNECTION.getAccountInfo(hint, COMMITMENT);
        if (info?.owner.equals(RAYDIUM_LAUNCHPAD_PROGRAM_ID) && StateStruct.decode(info.data).base_mint.equals(mint))
            return { pubkey: hint, account: info };
        const [pool] = await trade.get_program_accounts_v2(RAYDIUM_LAUNCHPAD_PROGRAM_ID, [
            { memcmp: { offset: StateStruct.get_offset('base_mint'), bytes: mint.toBase58() } },
            { memcmp: { offset: 0, bytes: base58.encode(RAYDIUM_LAUNCHPAD_POOL_HEADER) } }
        ]);
        if (!pool) throw new Error('LaunchLab pool not found');
        return pool;
    }
}
