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
    ASSOCIATED_TOKEN_PROGRAM_ID,
    createAssociatedTokenAccountIdempotentInstruction,
    createCloseAccountInstruction,
    createSyncNativeInstruction,
    TOKEN_2022_PROGRAM_ID,
    TOKEN_PROGRAM_ID
} from '@solana/spl-token';
import {
    COMMITMENT,
    IPFS,
    METAPLEX_PROGRAM_ID,
    PUMP_AMM_EVENT_AUTHORITY_ACCOUNT,
    PUMP_AMM_GLOBAL_ACCOUNT,
    PUMP_AMM_PROGRAM_ID,
    PUMP_BONDING_SEED,
    PUMP_STATE_HEADER,
    PUMP_TOKEN_DECIMALS,
    PUMP_EVENT_AUTHORITY_ACCOUNT,
    PUMP_FEE_PERCENTAGE,
    PUMP_API_URL,
    PUMP_GLOBAL_ACCOUNT,
    METAPLEX_META_SEED,
    PUMP_MINT_AUTHORITY_ACCOUNT,
    PUMP_PROGRAM_ID,
    SOL_MINT,
    SYSTEM_PROGRAM_ID,
    PUMP_BUY_V2_DISCRIMINATOR,
    PUMP_SELL_V2_DISCRIMINATOR,
    PUMP_AMM_BUY_EXACT_QUOTE_IN_DISCRIMINATOR,
    PUMP_SELL_DISCRIMINATOR,
    PUMP_SWAP_PERCENTAGE,
    PriorityLevel,
    PUMP_CREATE_V1_DISCRIMINATOR,
    PUMP_IPFS_API_URL,
    PUMP_AMM_STATE_HEADER,
    PUMP_LTA_ACCOUNT,
    TRADE_MAX_SLIPPAGE,
    PUMP_AMM_CREATOR_VAULT_SEED,
    RENT_PROGRAM_ID,
    PUMP_CREATOR_VAULT_SEED,
    PUMP_EXTEND_DISCRIMINATOR,
    TRADE_MAX_WALLETS_PER_CREATE_BUNDLE,
    TRADE_MAX_WALLETS_PER_CREATE_TX,
    PUMP_GLOBAL_VOLUME_ACCUMULATOR,
    PUMP_USER_VOLUME_ACCUMULATOR_SEED,
    PUMP_AMM_GLOBAL_VOLUME_ACCUMULATOR,
    PUMP_FEE_CONFIG,
    PUMP_FEE_PROGRAM_ID,
    PUMP_AMM_FEE_CONFIG,
    PUMP_BUYBACK_FEE_RECIPIENTS,
    PUMP_FEE_RECIPIENTS,
    MAYHEM_FEE_RECIPIENTS,
    MAYHEM_PROGRAM_ID,
    MAYHEM_GLOBAL_ACCOUNT,
    MAYHEM_SOL_VAULT,
    PUMP_CREATE_V2_DISCRIMINATOR,
    PUMP_AMM_POOL_SEED_2,
    PUMP_AMM_POOL_SEED,
    PUMP_POOL_AUTHORITY_SEED,
    PUMP_SHARING_CONFIG_SEED,
    MAYHEM_STATE_SEED,
    ACCOUNT_SUBSCRIPTION_FLUSH_MS,
    PUMP_COLLECT_CREATOR_FEE_DISCRIMINATOR,
    PUMP_AMM_COLLECT_CREATOR_FEE_DISCRIMINATOR
} from '../constants';
import { readFileSync } from 'fs';
import { basename } from 'path';
import base58 from 'bs58';
import { define_decoder_struct, skip, u8, u64, i128, discriminator, pubkey, u16, bool } from '../common/struct_decoder';

class PumpMintMeta implements trade.IMintMeta {
    mint!: string;
    name: string = 'Unknown';
    symbol: string = 'Unknown';
    base_vault!: string;
    quote_vault!: string;
    creator_vault!: string;
    creator_vault_ata!: string;
    amm_pool: string | null = null;
    sol_reserves: bigint = BigInt(0);
    token_reserves: bigint = BigInt(0);
    total_supply: bigint = BigInt(0);
    usd_market_cap: number = 0;
    market_cap: number = 0;
    complete: boolean = false;
    fee: number = PUMP_FEE_PERCENTAGE;
    token_program_id!: string;
    is_mayhem: boolean = false;
    is_cashback: boolean = false;

    constructor(data: Partial<PumpMintMeta> = {}) {
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
        if (this.amm_pool) return true;
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
            creator_vault: this.creator_vault,
            creator_vault_ata: this.creator_vault_ata,
            amm_pool: this.amm_pool,
            sol_reserves: this.sol_reserves.toString(),
            token_reserves: this.token_reserves.toString(),
            total_supply: this.total_supply.toString(),
            usd_market_cap: this.usd_market_cap,
            market_cap: this.market_cap,
            complete: this.complete,
            fee: this.fee,
            token_program_id: this.token_program_id,
            is_mayhem: this.is_mayhem,
            is_cashback: this.is_cashback
        };
    }

    public static deserialize(data: trade.SerializedMintMeta): PumpMintMeta {
        return new PumpMintMeta({
            mint: data.mint as string,
            name: data.name as string,
            symbol: data.symbol as string,
            base_vault: data.base_vault as string,
            quote_vault: data.quote_vault as string,
            creator_vault: data.creator_vault as string,
            creator_vault_ata: data.creator_vault_ata as string,
            amm_pool: data.amm_pool as string | null,
            sol_reserves: BigInt(data.sol_reserves as string),
            token_reserves: BigInt(data.token_reserves as string),
            total_supply: BigInt(data.total_supply as string),
            usd_market_cap: data.usd_market_cap as number,
            market_cap: data.market_cap as number,
            complete: data.complete as boolean,
            fee: data.fee as number,
            token_program_id: data.token_program_id as string,
            is_mayhem: data.is_mayhem as boolean,
            is_cashback: data.is_cashback as boolean
        });
    }
}

const StateStruct = define_decoder_struct({
    discriminator: discriminator(Buffer.from(PUMP_STATE_HEADER)),
    virtual_token_reserves: u64(),
    virtual_sol_reserves: u64(),
    real_token_reserves: u64(),
    real_sol_reserves: u64(),
    supply: u64(),
    complete: bool(),
    creator: pubkey(),
    is_mayhem: bool(),
    is_cashback: bool()
});

type State = ReturnType<typeof StateStruct.decode>;

const AMMStateStruct = define_decoder_struct({
    discriminator: discriminator(Buffer.from(PUMP_AMM_STATE_HEADER)),
    pool_bump: skip(u8().size),
    index: skip(u16().size),
    tx_creator: skip(pubkey().size),
    base_mint: pubkey(),
    quote_mint: pubkey(),
    lp_mint: skip(pubkey().size),
    base_vault: pubkey(),
    quote_vault: pubkey(),
    lp_supply: skip(u64().size),
    creator: pubkey(),
    is_mayhem: bool(),
    is_cashback: bool(),
    virtual_quote_reserves: i128()
});

type AMMState = ReturnType<typeof AMMStateStruct.decode> & {
    base_vault_balance: bigint;
    quote_vault_balance: bigint;
    supply: bigint;
};

type PumpClaimableAsset = trade.ClaimableAsset & {
    vault: PublicKey;
    vault_ata: PublicKey;
    curve: 'v1' | 'v2';
};

export class Trader implements trade.IProgramTrader {
    public get_name(): string {
        return common.Program.Pump;
    }

    public get_lta_addresses(): PublicKey[] {
        return [PUMP_LTA_ACCOUNT];
    }

    public deserialize_mint_meta(data: trade.SerializedMintMeta): PumpMintMeta {
        return PumpMintMeta.deserialize(data);
    }

    public async get_trader_fees(trader: Signer): Promise<PumpClaimableAsset[]> {
        const [amm_creator_vault, amm_creator_vault_ata] = this.calc_amm_creator_vault(trader.publicKey);
        const [creator_vault, creator_vault_ata] = this.calc_creator_vault(trader.publicKey);
        const [creator_vault_info, creator_vault_rent, amm_fees] = await Promise.all([
            global.CONNECTION.getAccountInfo(creator_vault, COMMITMENT),
            global.CONNECTION.getMinimumBalanceForRentExemption(0, COMMITMENT),
            trade.get_vault_balance(amm_creator_vault_ata).catch(() => ({ balance: 0n, decimals: 9 }))
        ]);
        const pump_fees = Math.max(0, (creator_vault_info?.lamports ?? 0) - creator_vault_rent);
        const assets = [];
        if (pump_fees > 0) {
            assets.push({
                mint: SOL_MINT,
                raw_amount: BigInt(pump_fees),
                decimals: 9,
                source: 'creator_reward' as const,
                vault: creator_vault,
                vault_ata: creator_vault_ata,
                curve: 'v1' as const
            });
        }
        if (amm_fees.balance > 0) {
            assets.push({
                mint: SOL_MINT,
                raw_amount: BigInt(amm_fees.balance),
                decimals: 9,
                source: 'creator_reward' as const,
                vault: amm_creator_vault,
                vault_ata: amm_creator_vault_ata,
                curve: 'v2' as const
            });
        }
        return assets;
    }

    public async claim_trader_fees(
        trader: Signer,
        assets: PumpClaimableAsset[],
        priority?: PriorityLevel
    ): Promise<String> {
        if (assets.length === 0) throw new Error(`No assets were provided`);

        const creator_ata = trade.calc_ata(trader.publicKey, SOL_MINT);
        const instructions: TransactionInstruction[] = [];

        for (const asset of assets) {
            if (asset.curve === 'v1') {
                instructions.push(
                    new TransactionInstruction({
                        keys: [
                            { pubkey: trader.publicKey, isSigner: false, isWritable: true },
                            { pubkey: asset.vault, isSigner: false, isWritable: true },
                            { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
                            { pubkey: PUMP_EVENT_AUTHORITY_ACCOUNT, isSigner: false, isWritable: false },
                            { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false }
                        ],
                        programId: PUMP_PROGRAM_ID,
                        data: Buffer.from(PUMP_COLLECT_CREATOR_FEE_DISCRIMINATOR)
                    })
                );
            } else if (asset.curve === 'v2') {
                instructions.push(
                    createAssociatedTokenAccountIdempotentInstruction(
                        trader.publicKey,
                        creator_ata,
                        trader.publicKey,
                        SOL_MINT
                    ),
                    new TransactionInstruction({
                        keys: [
                            { pubkey: SOL_MINT, isSigner: false, isWritable: false },
                            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                            { pubkey: trader.publicKey, isSigner: false, isWritable: false },
                            { pubkey: asset.vault, isSigner: false, isWritable: false },
                            { pubkey: asset.vault_ata, isSigner: false, isWritable: true },
                            { pubkey: creator_ata, isSigner: false, isWritable: true },
                            { pubkey: PUMP_AMM_EVENT_AUTHORITY_ACCOUNT, isSigner: false, isWritable: false },
                            { pubkey: PUMP_AMM_PROGRAM_ID, isSigner: false, isWritable: false }
                        ],
                        programId: PUMP_AMM_PROGRAM_ID,
                        data: Buffer.from(PUMP_AMM_COLLECT_CREATOR_FEE_DISCRIMINATOR)
                    }),
                    createCloseAccountInstruction(creator_ata, trader.publicKey, trader.publicKey)
                );
            }
        }

        if (instructions.length === 0) throw new Error('Invalid assets were provided, no tx was derived');
        return await trade.send_tx(instructions, [trader], priority);
    }

    public async buy_token(
        sol_amount: number,
        buyer: Signer,
        mint_meta: PumpMintMeta,
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
        mint_meta: PumpMintMeta,
        slippage: number = 0.05
    ): Promise<[TransactionInstruction[], AddressLookupTableAccount[]?]> {
        const lta = await trade.get_ltas([PUMP_LTA_ACCOUNT]);
        if (this.get_amm(mint_meta)) {
            const instructions = await this.get_buy_amm_instructions(sol_amount, buyer, mint_meta, slippage);
            return [instructions, lta];
        }
        const instructions = await this.get_buy_instructions(sol_amount, buyer, mint_meta, slippage);
        return [instructions, lta];
    }

    public async sell_token(
        token_amount: TokenAmount,
        seller: Signer,
        mint_meta: PumpMintMeta,
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
        mint_meta: PumpMintMeta,
        slippage: number = 0.05
    ): Promise<[TransactionInstruction[], AddressLookupTableAccount[]?]> {
        const lta = await trade.get_ltas([PUMP_LTA_ACCOUNT]);
        if (this.get_amm(mint_meta)) {
            const instructions = await this.get_sell_amm_instructions(token_amount, seller, mint_meta, slippage);
            return [instructions, lta];
        }
        const instructions = await this.get_sell_instructions(token_amount, seller, mint_meta, slippage);
        return [instructions, lta];
    }

    public async buy_sell_instructions(
        sol_amount: number,
        trader: Signer,
        mint_meta: PumpMintMeta,
        slippage: number = 0.05
    ): Promise<[TransactionInstruction[], TransactionInstruction[], AddressLookupTableAccount[]?]> {
        const sol_amount_raw = BigInt(Math.floor(sol_amount * LAMPORTS_PER_SOL));
        const token_amount_raw = this.calc_token_amount_raw(sol_amount_raw, mint_meta);
        let [buy_instructions, lta] = await this.buy_token_instructions(sol_amount, trader, mint_meta, slippage);
        let [sell_instructions] = await this.sell_token_instructions(
            {
                uiAmount: Number(token_amount_raw) / 10 ** PUMP_TOKEN_DECIMALS,
                amount: token_amount_raw.toString(),
                decimals: PUMP_TOKEN_DECIMALS
            },
            trader,
            mint_meta,
            slippage
        );
        return [buy_instructions, sell_instructions, lta];
    }

    public async get_mint_meta(mint: PublicKey, sol_price: number = 0): Promise<PumpMintMeta | undefined> {
        try {
            let mint_meta = await this.default_mint_meta(mint, sol_price);
            mint_meta = await this.update_mint_meta(mint_meta, sol_price);
            return mint_meta;
        } catch (error) {
            return undefined;
        }
    }

    public async get_random_mints(count: number): Promise<PumpMintMeta[]> {
        const graduated_length = Math.floor(count * Math.random());
        const ungraduated_length = count - graduated_length;
        return (
            await Promise.all([
                this.get_random_graduated_mints(graduated_length),
                this.get_random_ungraduated_mints(ungraduated_length)
            ])
        ).flat();
    }

    public async create_token(
        mint: Keypair,
        creator: Signer,
        token_name: string,
        token_symbol: string,
        meta_cid: string,
        sol_amount: number = 0.0,
        traders?: [Signer, number][],
        bundle_tip?: number,
        priority?: PriorityLevel,
        config?: object
    ): Promise<String> {
        let version: 'v1' | 'v2' = 'v2';
        let is_mayhem: boolean = false;
        let is_cashback: boolean = false;

        if ((traders && !bundle_tip) || (!traders && bundle_tip))
            throw new Error(`Invalid parameters: traders and bundle_tip must be set together`);
        if (traders && (traders.length > TRADE_MAX_WALLETS_PER_CREATE_BUNDLE || traders.length < 1))
            throw new Error(`Invalid parameters: traders must be less than ${TRADE_MAX_WALLETS_PER_CREATE_BUNDLE}`);
        if (config) {
            if ('version' in config) {
                if (typeof config.version !== 'number' || config.version < 1 || config.version > 2) {
                    throw new Error(`Invalid config: version must be 1 or 2`);
                } else {
                    version = config.version === 1 ? 'v1' : 'v2';
                }
            }
            if ('is_mayhem' in config) {
                if (typeof config.is_mayhem !== 'boolean') {
                    throw new Error(`Invalid config: is_mayhem must be a boolean`);
                } else {
                    is_mayhem = config.is_mayhem;
                }
            }
            if ('is_cashback' in config) {
                if (typeof config.is_cashback !== 'boolean') {
                    throw new Error(`Invalid config: is_cashback must be a boolean`);
                } else {
                    is_cashback = config.is_cashback;
                }
            }
        }
        if (version === 'v1' && is_mayhem)
            throw new Error(`Invalid config: is_mayhem can only be true for version 2 tokens`);

        let mint_meta = await this.default_mint_meta(mint.publicKey, 0, {
            name: token_name,
            symbol: token_symbol,
            creator: creator.publicKey,
            token_program: version === 'v1' ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID,
            is_mayhem: is_mayhem,
            is_cashback: is_cashback
        });

        const create_instructions = await this.get_create_token_instructions(
            creator,
            token_name,
            token_symbol,
            meta_cid,
            mint,
            is_mayhem,
            is_cashback,
            version
        );
        if (sol_amount > 0) {
            const buy_instructions = await this.get_buy_instructions(sol_amount, creator, mint_meta, 0.05);
            create_instructions.push(...buy_instructions);
        }

        const ltas = await trade.get_ltas([PUMP_LTA_ACCOUNT]);
        if (!traders) return await trade.retry_send_tx(create_instructions, [creator, mint], priority, undefined, ltas);

        const generated_lta = await trade.generate_trade_lta(
            creator,
            traders.map((tr) => Keypair.fromSecretKey(tr[0].secretKey)),
            mint.publicKey
        );
        mint_meta = this.update_mint_meta_reserves(mint_meta, sol_amount);
        const chunk_size = traders.length <= 4 ? 1 : TRADE_MAX_WALLETS_PER_CREATE_TX;
        const txs = common.chunks(traders, chunk_size);
        const buy_instructions: TransactionInstruction[][] = [];
        const bundle_signers: Signer[][] = [];
        for (const tx of txs) {
            const instructions: TransactionInstruction[] = [];
            for (const trader of tx) {
                const [buyer, buy_amount] = trader;
                instructions.push(...(await this.get_buy_instructions(buy_amount, buyer, mint_meta, 0.05)));
                mint_meta = this.update_mint_meta_reserves(mint_meta, buy_amount);
            }
            buy_instructions.push(instructions);
            bundle_signers.push(tx.map((trader) => trader[0]));
        }
        return await trade.retry_send_bundle(
            [create_instructions, ...buy_instructions],
            [[creator, mint], ...bundle_signers],
            bundle_tip!,
            priority,
            [generated_lta, ...ltas]
        );
    }

    public async default_mint_meta(mint: PublicKey, sol_price: number = 0, data?: object): Promise<PumpMintMeta> {
        let meta: {
            token_name: string;
            token_symbol: string;
            creator?: PublicKey;
            token_program: PublicKey;
            is_mayhem: boolean;
            is_cashback: boolean;
        } = {
            token_name: 'Unknown',
            token_symbol: 'Unknown',
            creator: undefined,
            token_program: TOKEN_PROGRAM_ID,
            is_mayhem: false,
            is_cashback: false
        };
        if (data) {
            if ('name' in data && typeof data.name === 'string' && data.name) meta.token_name = data.name;
            if ('symbol' in data && typeof data.symbol === 'string' && data.symbol) meta.token_symbol = data.symbol;
            if ('creator' in data) {
                if (data.creator instanceof PublicKey) meta.creator = data.creator;
                if (typeof data.creator === 'string' && data.creator) meta.creator = new PublicKey(data.creator);
            }
            if ('token_program' in data) {
                if (data.token_program instanceof PublicKey) meta.token_program = data.token_program;
                if (typeof data.token_program === 'string' && data.token_program)
                    meta.token_program = new PublicKey(data.token_program);
            }
            if ('is_mayhem' in data && typeof data.is_mayhem === 'boolean') meta.is_mayhem = data.is_mayhem;
            if ('is_cashback' in data && typeof data.is_cashback === 'boolean') meta.is_cashback = data.is_cashback;
        } else {
            const token_meta = await trade.get_token_meta(mint).catch(() => null);
            if (token_meta)
                meta = {
                    token_name: token_meta.token_name,
                    token_symbol: token_meta.token_symbol,
                    creator: token_meta.creator,
                    token_program: token_meta.token_program,
                    is_mayhem: false,
                    is_cashback: false
                };
        }

        let creator_vault: PublicKey | undefined;
        let creator_vault_ata: PublicKey | undefined;
        const [bonding, bonding_ata] = this.calc_bonding_curve(mint, meta.token_program);
        if (meta.creator) [creator_vault, creator_vault_ata] = this.calc_creator_vault(meta.creator);

        return new PumpMintMeta({
            mint: mint.toString(),
            symbol: meta.token_symbol,
            name: meta.token_name,
            amm_pool: null,
            base_vault: bonding.toString(),
            quote_vault: bonding_ata.toString(),
            market_cap: 27.95,
            usd_market_cap: 27.95 * sol_price,
            sol_reserves: BigInt(30000000000),
            token_reserves: BigInt(1073000000000000),
            total_supply: BigInt(1000000000000000),
            fee: PUMP_FEE_PERCENTAGE,
            creator_vault: creator_vault ? creator_vault.toString() : undefined,
            creator_vault_ata: creator_vault_ata ? creator_vault_ata.toString() : undefined,
            token_program_id: meta.token_program.toString(),
            is_mayhem: meta.is_mayhem,
            is_cashback: meta.is_cashback
        });
    }

    public async buy_sell_bundle(
        sol_amount: number,
        trader: Signer,
        mint_meta: PumpMintMeta,
        tip: number,
        slippage: number = 0.05,
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
        mint_meta: PumpMintMeta,
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

    public update_mint_meta_reserves(mint_meta: PumpMintMeta, amount: number | TokenAmount): PumpMintMeta {
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

    public async update_mint_meta(mint_meta: PumpMintMeta, sol_price: number = 0): Promise<PumpMintMeta> {
        try {
            const pump_amm = await this.get_amm_from_mint(new PublicKey(mint_meta.mint));
            mint_meta.amm_pool = pump_amm?.toString() ?? null;

            if (!pump_amm && !mint_meta.complete) {
                const state = await this.get_state(new PublicKey(mint_meta.base_vault));
                const [creator_vault, creator_vault_ata] = this.calc_creator_vault(state.creator);
                const metrics = this.get_token_metrics(
                    state.virtual_sol_reserves,
                    state.virtual_token_reserves,
                    state.supply
                );
                return new PumpMintMeta({
                    ...mint_meta,
                    usd_market_cap: metrics.mcap_sol * sol_price,
                    market_cap: metrics.mcap_sol,
                    total_supply: state.supply,
                    token_reserves: state.virtual_token_reserves,
                    sol_reserves: state.virtual_sol_reserves,
                    complete: state.complete,
                    fee: PUMP_FEE_PERCENTAGE,
                    creator_vault: creator_vault.toString(),
                    creator_vault_ata: creator_vault_ata.toString(),
                    is_mayhem: state.is_mayhem,
                    is_cashback: state.is_cashback
                });
            }
            if (pump_amm) {
                const state = await this.get_amm_state(pump_amm);
                const metrics = this.get_token_metrics(
                    state.quote_vault_balance + state.virtual_quote_reserves,
                    state.base_vault_balance,
                    state.supply
                );
                const [creator_vault, creator_vault_ata] = this.calc_amm_creator_vault(state.creator);
                return new PumpMintMeta({
                    ...mint_meta,
                    usd_market_cap: metrics.mcap_sol * sol_price,
                    market_cap: metrics.mcap_sol,
                    total_supply: state.supply,
                    base_vault: state.base_vault.toString(),
                    quote_vault: state.quote_vault.toString(),
                    sol_reserves: state.quote_vault_balance + state.virtual_quote_reserves,
                    token_reserves: state.base_vault_balance,
                    complete: true,
                    fee: PUMP_SWAP_PERCENTAGE,
                    creator_vault: creator_vault.toString(),
                    creator_vault_ata: creator_vault_ata.toString(),
                    is_mayhem: state.is_mayhem,
                    is_cashback: state.is_cashback
                });
            }
            return mint_meta;
        } catch (error) {
            throw new Error(`Failed to update mint meta reserves: ${error}`);
        }
    }

    public async subscribe_mint_meta(
        mint_meta: PumpMintMeta,
        callback: (mint_meta: PumpMintMeta) => void,
        sol_price: number = 0
    ): Promise<() => void> {
        const mint = new PublicKey(mint_meta.mint);
        const bonding_curve = new PublicKey(mint_meta.base_vault);

        let bonding_sub_id: number | undefined;
        let amm_sub_id: number | undefined;
        let flush_timeout: NodeJS.Timeout | null = null;
        let latest_update: PumpMintMeta | null = null;
        let stopped = false;
        let switched_to_amm = false;

        const schedule_flush = () => {
            if (flush_timeout || stopped) return;
            flush_timeout = setTimeout(() => {
                flush_timeout = null;
                if (!latest_update || stopped) return;
                const update = latest_update;
                latest_update = null;
                callback(update);
            }, ACCOUNT_SUBSCRIPTION_FLUSH_MS);
        };

        const publish = (update: PumpMintMeta) => {
            latest_update = update;
            schedule_flush();
        };

        const unsub_bonding = () => {
            if (bonding_sub_id == null) return;
            global.CONNECTION.removeAccountChangeListener(bonding_sub_id).catch(() =>
                common.error(`Failed to unsubscribe from Pump Bonding Curve updates`)
            );
            bonding_sub_id = undefined;
        };

        const unsub_amm = () => {
            if (amm_sub_id == null) return;
            global.CONNECTION.removeAccountChangeListener(amm_sub_id).catch(() =>
                common.error(`Failed to unsubscribe from Pump AMM Pool updates`)
            );
            amm_sub_id = undefined;
        };

        const process_amm_update = async (info: AccountInfo<Buffer>) => {
            if (stopped || !info?.data) return;

            const state = AMMStateStruct.decode(info.data);
            const [base_vault_balance, quote_vault_balance, supply] = await Promise.all([
                trade.get_vault_balance(state.base_vault),
                trade.get_vault_balance(state.quote_vault),
                trade.get_token_supply(state.base_mint)
            ]);

            const metrics = this.get_token_metrics(
                quote_vault_balance.balance + state.virtual_quote_reserves,
                base_vault_balance.balance,
                supply.supply
            );
            const [creator_vault, creator_vault_ata] = this.calc_amm_creator_vault(state.creator);

            publish(
                new PumpMintMeta({
                    ...mint_meta,
                    usd_market_cap: metrics.mcap_sol * sol_price,
                    market_cap: metrics.mcap_sol,
                    total_supply: supply.supply,
                    base_vault: state.base_vault.toString(),
                    quote_vault: state.quote_vault.toString(),
                    sol_reserves: quote_vault_balance.balance + state.virtual_quote_reserves,
                    token_reserves: base_vault_balance.balance,
                    complete: true,
                    fee: PUMP_SWAP_PERCENTAGE,
                    creator_vault: creator_vault.toString(),
                    creator_vault_ata: creator_vault_ata.toString(),
                    is_mayhem: state.is_mayhem,
                    is_cashback: state.is_cashback
                })
            );
        };

        const process_bonding_update = (info: AccountInfo<Buffer>) => {
            if (stopped || !info?.data) return;

            const state = StateStruct.decode(info.data);
            const [creator_vault, creator_vault_ata] = this.calc_creator_vault(state.creator);
            const metrics = this.get_token_metrics(
                state.virtual_sol_reserves,
                state.virtual_token_reserves,
                state.supply
            );

            publish(
                new PumpMintMeta({
                    ...mint_meta,
                    usd_market_cap: metrics.mcap_sol * sol_price,
                    market_cap: metrics.mcap_sol,
                    total_supply: state.supply,
                    token_reserves: state.virtual_token_reserves,
                    sol_reserves: state.virtual_sol_reserves,
                    complete: state.complete,
                    fee: PUMP_FEE_PERCENTAGE,
                    creator_vault: creator_vault.toString(),
                    creator_vault_ata: creator_vault_ata.toString(),
                    is_mayhem: state.is_mayhem,
                    is_cashback: state.is_cashback
                })
            );

            if (state.complete && !switched_to_amm) {
                switched_to_amm = true;
                const amm = this.calc_amm_from_mint(mint);
                amm_sub_id = global.CONNECTION.onAccountChange(amm, process_amm_update, { commitment: COMMITMENT });
                unsub_bonding();
            }
        };

        const amm_pool = await this.get_amm_from_mint(mint);
        if (amm_pool) {
            switched_to_amm = true;
            amm_sub_id = global.CONNECTION.onAccountChange(amm_pool, process_amm_update, { commitment: COMMITMENT });
        } else {
            bonding_sub_id = global.CONNECTION.onAccountChange(bonding_curve, process_bonding_update, {
                commitment: COMMITMENT
            });
        }

        return () => {
            stopped = true;
            if (flush_timeout) clearTimeout(flush_timeout);
            flush_timeout = null;
            latest_update = null;
            unsub_bonding();
            unsub_amm();
        };
    }

    private get_amm(mint_meta: PumpMintMeta): PublicKey | undefined {
        if (mint_meta.amm_pool !== null) return new PublicKey(mint_meta.amm_pool);
    }

    private calc_token_amount_raw(sol_amount_raw: bigint, meta: Partial<PumpMintMeta>): bigint {
        if (!meta.sol_reserves || !meta.token_reserves || !meta.fee) return 0n;
        if (sol_amount_raw <= 0) return 0n;

        const fee = (sol_amount_raw * BigInt(meta.fee * 10000)) / 10000n;
        const n = meta.sol_reserves * meta.token_reserves;
        const new_sol_reserves = meta.sol_reserves + (sol_amount_raw - fee);
        const new_token_reserves = n / new_sol_reserves + 1n;
        return meta.token_reserves - new_token_reserves;
    }

    private calc_sol_amount_raw(token_amount_raw: bigint, token: Partial<PumpMintMeta>): bigint {
        if (!token.sol_reserves || !token.token_reserves || !token.fee) return 0n;
        if (token_amount_raw <= 0) return 0n;

        const n = (token_amount_raw * token.sol_reserves) / (token.token_reserves + token_amount_raw);
        const fee = (n * BigInt(token.fee * 10000)) / 10000n;
        return n - fee;
    }

    private calc_slippage_up(sol_amount: bigint, slippage: number): bigint {
        if (slippage <= 0.0 || slippage >= TRADE_MAX_SLIPPAGE) throw new RangeError('Slippage must be between 0 and 1');
        return sol_amount + (sol_amount * BigInt(Math.floor(slippage * 10000))) / BigInt(10000);
    }

    private calc_slippage_down(sol_amount: bigint, slippage: number): bigint {
        if (slippage <= 0.0 || slippage >= TRADE_MAX_SLIPPAGE) throw new RangeError('Slippage must be between 0 and 1');
        return sol_amount - (sol_amount * BigInt(Math.floor(slippage * 10000))) / BigInt(10000);
    }

    private buy_v2_data(sol_amount_raw: bigint, token_amount_raw: bigint, slippage: number): Buffer {
        const instruction_buf = Buffer.from(PUMP_BUY_V2_DISCRIMINATOR);
        const token_amount_buf = Buffer.alloc(8);
        token_amount_buf.writeBigUInt64LE(token_amount_raw, 0);
        const slippage_buf = Buffer.alloc(8);
        slippage_buf.writeBigUInt64LE(this.calc_slippage_up(sol_amount_raw, slippage), 0);
        return Buffer.concat([instruction_buf, token_amount_buf, slippage_buf]);
    }

    private sell_v2_data(sol_amount_raw: bigint, token_amount_raw: bigint, slippage: number): Buffer {
        const instruction_buf = Buffer.from(PUMP_SELL_V2_DISCRIMINATOR);
        const token_amount_buf = Buffer.alloc(8);
        token_amount_buf.writeBigUInt64LE(token_amount_raw, 0);
        const slippage_buf = Buffer.alloc(8);
        slippage_buf.writeBigUInt64LE(this.calc_slippage_down(sol_amount_raw, slippage), 0);
        return Buffer.concat([instruction_buf, token_amount_buf, slippage_buf]);
    }

    private amm_buy_exact_quote_in_data(sol_amount_raw: bigint, token_amount_raw: bigint, slippage: number): Buffer {
        const instruction_buf = Buffer.from(PUMP_AMM_BUY_EXACT_QUOTE_IN_DISCRIMINATOR);
        const sol_amount_buf = Buffer.alloc(8);
        sol_amount_buf.writeBigUInt64LE(sol_amount_raw, 0);
        const token_amount_buf = Buffer.alloc(8);
        token_amount_buf.writeBigUInt64LE(this.calc_slippage_down(token_amount_raw, slippage), 0);
        return Buffer.concat([instruction_buf, sol_amount_buf, token_amount_buf, Buffer.from([0])]);
    }

    private amm_sell_data(sol_amount_raw: bigint, token_amount_raw: bigint, slippage: number): Buffer {
        const instruction_buf = Buffer.from(PUMP_SELL_DISCRIMINATOR);
        const token_amount_buf = Buffer.alloc(8);
        token_amount_buf.writeBigUInt64LE(token_amount_raw, 0);
        const slippage_buf = Buffer.alloc(8);
        slippage_buf.writeBigUInt64LE(this.calc_slippage_down(sol_amount_raw, slippage), 0);
        return Buffer.concat([instruction_buf, token_amount_buf, slippage_buf]);
    }

    private async get_buy_instructions(
        sol_amount: number,
        buyer: Signer,
        mint_meta: Partial<PumpMintMeta>,
        slippage: number = 0.05
    ): Promise<TransactionInstruction[]> {
        if (
            !mint_meta.mint ||
            !mint_meta.base_vault ||
            !mint_meta.quote_vault ||
            !mint_meta.creator_vault ||
            !mint_meta.token_program_id
        )
            throw new Error(`Incomplete mint meta data for buy instructions.`);

        const mint = new PublicKey(mint_meta.mint);
        const token_program = new PublicKey(mint_meta.token_program_id);
        const creator_vault = new PublicKey(mint_meta.creator_vault);
        const user_volume_accumulator = this.calc_user_volume_accumulator(buyer.publicKey, 'pump');
        const bonding_curve = new PublicKey(mint_meta.base_vault);
        const assoc_bonding_curve = new PublicKey(mint_meta.quote_vault);
        const sol_amount_raw = BigInt(Math.floor(sol_amount * LAMPORTS_PER_SOL));

        const token_amount_raw = this.calc_token_amount_raw(sol_amount_raw, mint_meta);
        const instruction_data = this.buy_v2_data(sol_amount_raw, token_amount_raw, slippage);
        const token_ata = trade.calc_ata(buyer.publicKey, mint, token_program);
        const quote_token_program = TOKEN_PROGRAM_ID;
        const quote_ata = trade.calc_ata(buyer.publicKey, SOL_MINT, quote_token_program);
        const fee_recipients = mint_meta.is_mayhem ? MAYHEM_FEE_RECIPIENTS : PUMP_FEE_RECIPIENTS;
        const fee_recipient = fee_recipients[Math.floor(Math.random() * fee_recipients.length)];
        const buyback_fee_recipient =
            PUMP_BUYBACK_FEE_RECIPIENTS[Math.floor(Math.random() * PUMP_BUYBACK_FEE_RECIPIENTS.length)];
        const fee_recipient_ata = trade.calc_ata(fee_recipient, SOL_MINT, quote_token_program);
        const buyback_fee_recipient_ata = trade.calc_ata(buyback_fee_recipient, SOL_MINT, quote_token_program);
        const quote_bonding_curve_ata = trade.calc_ata(bonding_curve, SOL_MINT, quote_token_program);
        const creator_vault_ata = trade.calc_ata(creator_vault, SOL_MINT, quote_token_program);
        const user_volume_accumulator_ata = trade.calc_ata(user_volume_accumulator, SOL_MINT, quote_token_program);
        const [sharing_config] = PublicKey.findProgramAddressSync(
            [PUMP_SHARING_CONFIG_SEED, mint.toBuffer()],
            PUMP_FEE_PROGRAM_ID
        );

        return [
            createAssociatedTokenAccountIdempotentInstruction(
                buyer.publicKey,
                token_ata,
                buyer.publicKey,
                mint,
                token_program
            ),
            new TransactionInstruction({
                keys: [
                    { pubkey: PUMP_GLOBAL_ACCOUNT, isSigner: false, isWritable: false },
                    { pubkey: mint, isSigner: false, isWritable: false },
                    { pubkey: SOL_MINT, isSigner: false, isWritable: false },
                    { pubkey: token_program, isSigner: false, isWritable: false },
                    { pubkey: quote_token_program, isSigner: false, isWritable: false },
                    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: fee_recipient, isSigner: false, isWritable: true },
                    { pubkey: fee_recipient_ata, isSigner: false, isWritable: true },
                    { pubkey: buyback_fee_recipient, isSigner: false, isWritable: true },
                    { pubkey: buyback_fee_recipient_ata, isSigner: false, isWritable: true },
                    { pubkey: bonding_curve, isSigner: false, isWritable: true },
                    { pubkey: assoc_bonding_curve, isSigner: false, isWritable: true },
                    { pubkey: quote_bonding_curve_ata, isSigner: false, isWritable: true },
                    { pubkey: buyer.publicKey, isSigner: true, isWritable: true },
                    { pubkey: token_ata, isSigner: false, isWritable: true },
                    { pubkey: quote_ata, isSigner: false, isWritable: true },
                    { pubkey: creator_vault, isSigner: false, isWritable: true },
                    { pubkey: creator_vault_ata, isSigner: false, isWritable: true },
                    { pubkey: sharing_config, isSigner: false, isWritable: false },
                    { pubkey: PUMP_GLOBAL_VOLUME_ACCUMULATOR, isSigner: false, isWritable: false },
                    { pubkey: user_volume_accumulator, isSigner: false, isWritable: true },
                    { pubkey: user_volume_accumulator_ata, isSigner: false, isWritable: true },
                    { pubkey: PUMP_FEE_CONFIG, isSigner: false, isWritable: false },
                    { pubkey: PUMP_FEE_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: PUMP_EVENT_AUTHORITY_ACCOUNT, isSigner: false, isWritable: false },
                    { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false }
                ],
                programId: PUMP_PROGRAM_ID,
                data: instruction_data
            })
        ];
    }

    private async get_sell_instructions(
        token_amount: TokenAmount,
        seller: Signer,
        mint_meta: Partial<PumpMintMeta>,
        slippage: number = 0.05
    ): Promise<TransactionInstruction[]> {
        if (
            !mint_meta.mint ||
            !mint_meta.base_vault ||
            !mint_meta.quote_vault ||
            !mint_meta.creator_vault ||
            !mint_meta.token_program_id
        )
            throw new Error(`Incomplete mint meta data for sell instructions.`);
        if (token_amount.amount === null) throw new Error(`Invalid token amount: ${token_amount.amount}`);

        const mint = new PublicKey(mint_meta.mint);
        const token_program = new PublicKey(mint_meta.token_program_id);
        const creator_vault = new PublicKey(mint_meta.creator_vault);
        const user_volume_accumulator = this.calc_user_volume_accumulator(seller.publicKey, 'pump');
        const bonding_curve = new PublicKey(mint_meta.base_vault);
        const assoc_bonding_curve = new PublicKey(mint_meta.quote_vault);
        const token_amount_raw = BigInt(token_amount.amount);
        const sol_amount_raw = this.calc_sol_amount_raw(token_amount_raw, mint_meta);
        const instruction_data = this.sell_v2_data(sol_amount_raw, token_amount_raw, slippage);
        const token_ata = trade.calc_ata(seller.publicKey, mint, token_program);
        const quote_token_program = TOKEN_PROGRAM_ID;
        const quote_ata = trade.calc_ata(seller.publicKey, SOL_MINT, quote_token_program);
        const fee_recipients = mint_meta.is_mayhem ? MAYHEM_FEE_RECIPIENTS : PUMP_FEE_RECIPIENTS;
        const fee_recipient = fee_recipients[Math.floor(Math.random() * fee_recipients.length)];
        const buyback_fee_recipient =
            PUMP_BUYBACK_FEE_RECIPIENTS[Math.floor(Math.random() * PUMP_BUYBACK_FEE_RECIPIENTS.length)];
        const fee_recipient_ata = trade.calc_ata(fee_recipient, SOL_MINT, quote_token_program);
        const buyback_fee_recipient_ata = trade.calc_ata(buyback_fee_recipient, SOL_MINT, quote_token_program);
        const quote_bonding_curve_ata = trade.calc_ata(bonding_curve, SOL_MINT, quote_token_program);
        const creator_vault_ata = trade.calc_ata(creator_vault, SOL_MINT, quote_token_program);
        const user_volume_accumulator_ata = trade.calc_ata(user_volume_accumulator, SOL_MINT, quote_token_program);
        const [sharing_config] = PublicKey.findProgramAddressSync(
            [PUMP_SHARING_CONFIG_SEED, mint.toBuffer()],
            PUMP_FEE_PROGRAM_ID
        );

        return [
            new TransactionInstruction({
                keys: [
                    { pubkey: PUMP_GLOBAL_ACCOUNT, isSigner: false, isWritable: false },
                    { pubkey: mint, isSigner: false, isWritable: false },
                    { pubkey: SOL_MINT, isSigner: false, isWritable: false },
                    { pubkey: token_program, isSigner: false, isWritable: false },
                    { pubkey: quote_token_program, isSigner: false, isWritable: false },
                    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: fee_recipient, isSigner: false, isWritable: true },
                    { pubkey: fee_recipient_ata, isSigner: false, isWritable: true },
                    { pubkey: buyback_fee_recipient, isSigner: false, isWritable: true },
                    { pubkey: buyback_fee_recipient_ata, isSigner: false, isWritable: true },
                    { pubkey: bonding_curve, isSigner: false, isWritable: true },
                    { pubkey: assoc_bonding_curve, isSigner: false, isWritable: true },
                    { pubkey: quote_bonding_curve_ata, isSigner: false, isWritable: true },
                    { pubkey: seller.publicKey, isSigner: true, isWritable: true },
                    { pubkey: token_ata, isSigner: false, isWritable: true },
                    { pubkey: quote_ata, isSigner: false, isWritable: true },
                    { pubkey: creator_vault, isSigner: false, isWritable: true },
                    { pubkey: creator_vault_ata, isSigner: false, isWritable: true },
                    { pubkey: sharing_config, isSigner: false, isWritable: false },
                    { pubkey: user_volume_accumulator, isSigner: false, isWritable: true },
                    { pubkey: user_volume_accumulator_ata, isSigner: false, isWritable: true },
                    { pubkey: PUMP_FEE_CONFIG, isSigner: false, isWritable: false },
                    { pubkey: PUMP_FEE_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: PUMP_EVENT_AUTHORITY_ACCOUNT, isSigner: false, isWritable: false },
                    { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false }
                ],
                programId: PUMP_PROGRAM_ID,
                data: instruction_data
            })
        ];
    }

    private create_data(
        token_name: string,
        token_ticker: string,
        meta_link: string,
        creator: PublicKey,
        mayhem_mode: boolean = false,
        cashback_mode: boolean = false,
        version: 'v1' | 'v2' = 'v2'
    ): Buffer {
        const instruction_buf = Buffer.from(
            version === 'v1' ? PUMP_CREATE_V1_DISCRIMINATOR : PUMP_CREATE_V2_DISCRIMINATOR
        );

        const token_name_bytes = Buffer.from(token_name);
        const token_name_buf = Buffer.alloc(4 + token_name_bytes.length);
        token_name_buf.writeUInt32LE(token_name_bytes.length, 0);
        token_name_bytes.copy(token_name_buf, 4);

        const token_ticker_bytes = Buffer.from(token_ticker);
        const token_ticker_buf = Buffer.alloc(4 + token_ticker_bytes.length);
        token_ticker_buf.writeUInt32LE(token_ticker_bytes.length, 0);
        token_ticker_bytes.copy(token_ticker_buf, 4);

        const meta_link_bytes = Buffer.from(meta_link);
        const meta_link_buf = Buffer.alloc(4 + meta_link_bytes.length);
        meta_link_buf.writeUInt32LE(meta_link_bytes.length, 0);
        meta_link_bytes.copy(meta_link_buf, 4);

        const creator_buf = creator.toBuffer();

        if (version === 'v1')
            return Buffer.concat([instruction_buf, token_name_buf, token_ticker_buf, meta_link_buf, creator_buf]);

        const mayhem_mode_buf = Buffer.alloc(1);
        mayhem_mode_buf.writeUInt8(mayhem_mode ? 1 : 0, 0);

        const cashback_mode_buf = Buffer.alloc(1);
        cashback_mode_buf.writeUInt8(cashback_mode ? 1 : 0, 0);

        return Buffer.concat([
            instruction_buf,
            token_name_buf,
            token_ticker_buf,
            meta_link_buf,
            creator_buf,
            mayhem_mode_buf,
            cashback_mode_buf
        ]);
    }

    private async get_create_token_instructions(
        creator: Signer,
        token_name: string,
        token_symbol: string,
        meta_cid: string,
        mint: Keypair,
        mayhem_mode: boolean = false,
        cashback_mode: boolean = false,
        version: 'v1' | 'v2' = 'v2'
    ): Promise<TransactionInstruction[]> {
        const token_program = version === 'v1' ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
        const meta_link = `${IPFS}${meta_cid}`;
        const instruction_data = this.create_data(
            token_name,
            token_symbol,
            meta_link,
            creator.publicKey,
            mayhem_mode,
            cashback_mode,
            version
        );
        const [bonding, assoc_ata] = this.calc_bonding_curve(mint.publicKey, token_program);

        let create_instructions: TransactionInstruction;
        if (version === 'v2') {
            const [mayhem_state, mayhem_token_vault] = this.calc_mayhem_state(mint.publicKey);
            create_instructions = new TransactionInstruction({
                keys: [
                    { pubkey: mint.publicKey, isSigner: true, isWritable: true },
                    { pubkey: PUMP_MINT_AUTHORITY_ACCOUNT, isSigner: false, isWritable: false },
                    { pubkey: bonding, isSigner: false, isWritable: true },
                    { pubkey: assoc_ata, isSigner: false, isWritable: true },
                    { pubkey: PUMP_GLOBAL_ACCOUNT, isSigner: false, isWritable: false },
                    { pubkey: creator.publicKey, isSigner: true, isWritable: true },
                    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: token_program, isSigner: false, isWritable: false },
                    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: MAYHEM_PROGRAM_ID, isSigner: false, isWritable: true },
                    { pubkey: MAYHEM_GLOBAL_ACCOUNT, isSigner: false, isWritable: false },
                    { pubkey: MAYHEM_SOL_VAULT, isSigner: false, isWritable: true },
                    { pubkey: mayhem_state, isSigner: false, isWritable: true },
                    { pubkey: mayhem_token_vault, isSigner: false, isWritable: true },
                    { pubkey: PUMP_EVENT_AUTHORITY_ACCOUNT, isSigner: false, isWritable: false },
                    { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false }
                ],
                programId: PUMP_PROGRAM_ID,
                data: instruction_data
            });
        } else {
            const [metaplex] = PublicKey.findProgramAddressSync(
                [METAPLEX_META_SEED, METAPLEX_PROGRAM_ID.toBuffer(), mint.publicKey.toBuffer()],
                METAPLEX_PROGRAM_ID
            );
            create_instructions = new TransactionInstruction({
                keys: [
                    { pubkey: mint.publicKey, isSigner: true, isWritable: true },
                    { pubkey: PUMP_MINT_AUTHORITY_ACCOUNT, isSigner: false, isWritable: false },
                    { pubkey: bonding, isSigner: false, isWritable: true },
                    { pubkey: assoc_ata, isSigner: false, isWritable: true },
                    { pubkey: PUMP_GLOBAL_ACCOUNT, isSigner: false, isWritable: false },
                    { pubkey: METAPLEX_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: metaplex, isSigner: false, isWritable: true },
                    { pubkey: creator.publicKey, isSigner: true, isWritable: true },
                    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: token_program, isSigner: false, isWritable: false },
                    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: RENT_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: PUMP_EVENT_AUTHORITY_ACCOUNT, isSigner: false, isWritable: false },
                    { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false }
                ],
                programId: PUMP_PROGRAM_ID,
                data: instruction_data
            });
        }

        return [
            create_instructions,
            new TransactionInstruction({
                keys: [
                    { pubkey: bonding, isSigner: false, isWritable: true },
                    { pubkey: creator.publicKey, isSigner: true, isWritable: true },
                    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: PUMP_EVENT_AUTHORITY_ACCOUNT, isSigner: false, isWritable: false },
                    { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false }
                ],
                programId: PUMP_PROGRAM_ID,
                data: Buffer.from(PUMP_EXTEND_DISCRIMINATOR)
            })
        ];
    }

    private calc_bonding_curve(mint: PublicKey, token_program: PublicKey): [PublicKey, PublicKey] {
        if (!token_program.equals(TOKEN_2022_PROGRAM_ID) && !token_program.equals(TOKEN_PROGRAM_ID)) {
            throw new Error(`Invalid token program: ${token_program.toString()}`);
        }
        const [bonding_curve] = PublicKey.findProgramAddressSync([PUMP_BONDING_SEED, mint.toBuffer()], PUMP_PROGRAM_ID);
        const [bonding_curve_ata] = PublicKey.findProgramAddressSync(
            [bonding_curve.toBuffer(), token_program.toBuffer(), mint.toBuffer()],
            ASSOCIATED_TOKEN_PROGRAM_ID
        );
        return [bonding_curve, bonding_curve_ata];
    }

    private calc_mayhem_state(mint: PublicKey): [PublicKey, PublicKey] {
        const [state] = PublicKey.findProgramAddressSync([MAYHEM_STATE_SEED, mint.toBuffer()], MAYHEM_PROGRAM_ID);
        const [token_vault] = PublicKey.findProgramAddressSync(
            [MAYHEM_SOL_VAULT.toBuffer(), TOKEN_2022_PROGRAM_ID.toBuffer(), mint.toBuffer()],
            ASSOCIATED_TOKEN_PROGRAM_ID
        );
        return [state, token_vault];
    }

    private calc_pool_v2(mint: PublicKey): PublicKey {
        const [pool] = PublicKey.findProgramAddressSync([PUMP_AMM_POOL_SEED_2, mint.toBuffer()], PUMP_AMM_PROGRAM_ID);
        return pool;
    }

    private calc_creator_vault(
        creator: PublicKey,
        token_program: PublicKey = TOKEN_PROGRAM_ID
    ): [PublicKey, PublicKey] {
        const [creator_vault] = PublicKey.findProgramAddressSync(
            [PUMP_CREATOR_VAULT_SEED, creator.toBuffer()],
            PUMP_PROGRAM_ID
        );
        const creator_vault_ata = trade.calc_ata(creator_vault, SOL_MINT, token_program);
        return [creator_vault, creator_vault_ata];
    }

    private calc_amm_creator_vault(
        creator: PublicKey,
        token_program: PublicKey = TOKEN_PROGRAM_ID
    ): [PublicKey, PublicKey] {
        const [creator_vault] = PublicKey.findProgramAddressSync(
            [PUMP_AMM_CREATOR_VAULT_SEED, creator.toBuffer()],
            PUMP_AMM_PROGRAM_ID
        );
        const creator_vault_ata = trade.calc_ata(creator_vault, SOL_MINT, token_program);
        return [creator_vault, creator_vault_ata];
    }

    private calc_user_volume_accumulator(user: PublicKey, program: 'pump' | 'pump-swap'): PublicKey {
        const [user_volume_accumulator] = PublicKey.findProgramAddressSync(
            [PUMP_USER_VOLUME_ACCUMULATOR_SEED, user.toBuffer()],
            program === 'pump' ? PUMP_PROGRAM_ID : PUMP_AMM_PROGRAM_ID
        );
        return user_volume_accumulator;
    }

    private calculate_curve_price(quote_reserves: bigint, base_reserves: bigint): number {
        if (base_reserves <= 0 || quote_reserves <= 0)
            throw new RangeError('Curve state contains invalid reserve data');
        return Number(quote_reserves) / LAMPORTS_PER_SOL / (Number(base_reserves) / Math.pow(10, PUMP_TOKEN_DECIMALS));
    }

    private get_token_metrics(quote_reserves: bigint, base_reserves: bigint, supply: bigint): trade.TokenMetrics {
        const price_sol = this.calculate_curve_price(quote_reserves, base_reserves);
        const mcap_sol = (price_sol * Number(supply)) / Math.pow(10, PUMP_TOKEN_DECIMALS);
        return { price_sol, mcap_sol };
    }

    private async get_state(bond_curve_addr: PublicKey): Promise<State> {
        const info = await global.CONNECTION.getAccountInfo(bond_curve_addr, COMMITMENT);
        if (!info || !info.data) throw new Error('Unexpected curve state');
        return StateStruct.decode(info.data);
    }

    async get_amm_state(amm: PublicKey): Promise<AMMState> {
        const info = await global.CONNECTION.getAccountInfo(amm);
        if (!info || !info.data) throw new Error('Unexpected AMM state');

        const state = AMMStateStruct.decode(info.data);
        const [base_vault_balance, quote_vault_balance, supply] = await Promise.all([
            trade.get_vault_balance(state.base_vault),
            trade.get_vault_balance(state.quote_vault),
            trade.get_token_supply(state.base_mint)
        ]);

        return {
            ...state,
            base_vault_balance: base_vault_balance.balance,
            quote_vault_balance: quote_vault_balance.balance,
            supply: supply.supply
        };
    }

    private calc_amm_from_mint(mint: PublicKey): PublicKey {
        const [creator] = PublicKey.findProgramAddressSync(
            [PUMP_POOL_AUTHORITY_SEED, mint.toBuffer()],
            PUMP_PROGRAM_ID
        );
        const [amm] = PublicKey.findProgramAddressSync(
            [PUMP_AMM_POOL_SEED, new Uint8Array([0, 0]), creator.toBuffer(), mint.toBuffer(), SOL_MINT.toBuffer()],
            PUMP_AMM_PROGRAM_ID
        );
        return amm;
    }

    private async get_amm_from_mint(mint: PublicKey): Promise<PublicKey | null> {
        const amm = this.calc_amm_from_mint(mint);
        const info = await global.CONNECTION.getAccountInfo(amm);
        if (info && info.data) return amm;
        return null;
    }

    private async get_buy_amm_instructions(
        sol_amount: number,
        buyer: Signer,
        mint_meta: Partial<PumpMintMeta>,
        slippage: number = 0.05
    ): Promise<TransactionInstruction[]> {
        if (
            !mint_meta.mint ||
            !mint_meta.amm_pool ||
            !mint_meta.base_vault ||
            !mint_meta.quote_vault ||
            !mint_meta.creator_vault ||
            !mint_meta.creator_vault_ata ||
            !mint_meta.token_program_id
        )
            throw new Error(`Incomplete mint meta data for buy instructions.`);

        const mint = new PublicKey(mint_meta.mint);
        const token_program = new PublicKey(mint_meta.token_program_id);
        const amm = new PublicKey(mint_meta.amm_pool);
        const creator_vault = new PublicKey(mint_meta.creator_vault);
        const creator_vault_ata = new PublicKey(mint_meta.creator_vault_ata);
        const user_volume_accumulator = this.calc_user_volume_accumulator(buyer.publicKey, 'pump-swap');
        const bonding_curve = new PublicKey(mint_meta.base_vault);
        const assoc_bonding_curve = new PublicKey(mint_meta.quote_vault);
        const sol_amount_raw = BigInt(Math.floor(sol_amount * LAMPORTS_PER_SOL));

        const token_amount_raw = this.calc_token_amount_raw(sol_amount_raw, mint_meta);
        const instruction_data = this.amm_buy_exact_quote_in_data(sol_amount_raw, token_amount_raw, slippage);
        const token_ata = trade.calc_ata(buyer.publicKey, mint, token_program);
        const wsol_ata = trade.calc_ata(buyer.publicKey, SOL_MINT);
        const wsol_user_accumulator_ata = trade.calc_ata(user_volume_accumulator, SOL_MINT);
        const pool_v2 = this.calc_pool_v2(mint);
        const fee_recipients = mint_meta.is_mayhem ? MAYHEM_FEE_RECIPIENTS : PUMP_FEE_RECIPIENTS;
        const fee_recipient = fee_recipients[Math.floor(Math.random() * fee_recipients.length)];
        const fee_recipient_ata = trade.calc_ata(fee_recipient, SOL_MINT);
        const buyback_fee_recipient =
            PUMP_BUYBACK_FEE_RECIPIENTS[Math.floor(Math.random() * PUMP_BUYBACK_FEE_RECIPIENTS.length)];
        const buyback_fee_recipient_ata = trade.calc_ata(buyback_fee_recipient, SOL_MINT);

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
                    { pubkey: amm, isSigner: false, isWritable: true },
                    { pubkey: buyer.publicKey, isSigner: true, isWritable: true },
                    { pubkey: PUMP_AMM_GLOBAL_ACCOUNT, isSigner: false, isWritable: false },
                    { pubkey: mint, isSigner: false, isWritable: false },
                    { pubkey: SOL_MINT, isSigner: false, isWritable: false },
                    { pubkey: token_ata, isSigner: false, isWritable: true },
                    { pubkey: wsol_ata, isSigner: false, isWritable: true },
                    { pubkey: bonding_curve, isSigner: false, isWritable: true },
                    { pubkey: assoc_bonding_curve, isSigner: false, isWritable: true },
                    { pubkey: fee_recipient, isSigner: false, isWritable: false },
                    { pubkey: fee_recipient_ata, isSigner: false, isWritable: true },
                    { pubkey: token_program, isSigner: false, isWritable: false },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: PUMP_AMM_EVENT_AUTHORITY_ACCOUNT, isSigner: false, isWritable: false },
                    { pubkey: PUMP_AMM_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: creator_vault_ata, isSigner: false, isWritable: true },
                    { pubkey: creator_vault, isSigner: false, isWritable: false },
                    { pubkey: PUMP_AMM_GLOBAL_VOLUME_ACCUMULATOR, isSigner: false, isWritable: true },
                    { pubkey: user_volume_accumulator, isSigner: false, isWritable: true },
                    { pubkey: PUMP_AMM_FEE_CONFIG, isSigner: false, isWritable: false },
                    { pubkey: PUMP_FEE_PROGRAM_ID, isSigner: false, isWritable: false },
                    ...(mint_meta.is_cashback
                        ? [{ pubkey: wsol_user_accumulator_ata, isSigner: false, isWritable: true }]
                        : []),
                    { pubkey: pool_v2, isSigner: false, isWritable: false },
                    { pubkey: buyback_fee_recipient, isSigner: false, isWritable: true },
                    { pubkey: buyback_fee_recipient_ata, isSigner: false, isWritable: true }
                ],
                programId: PUMP_AMM_PROGRAM_ID,
                data: instruction_data
            }),
            createCloseAccountInstruction(wsol_ata, buyer.publicKey, buyer.publicKey)
        ];
    }

    private async get_sell_amm_instructions(
        token_amount: TokenAmount,
        seller: Signer,
        mint_meta: Partial<PumpMintMeta>,
        slippage: number = 0.05
    ): Promise<TransactionInstruction[]> {
        if (
            !mint_meta.mint ||
            !mint_meta.base_vault ||
            !mint_meta.quote_vault ||
            !mint_meta.amm_pool ||
            !mint_meta.creator_vault ||
            !mint_meta.creator_vault_ata ||
            !mint_meta.token_program_id
        )
            throw new Error(`Incomplete mint meta data for sell instructions.`);
        if (token_amount.amount === null) throw new Error(`Invalid token amount: ${token_amount.amount}`);

        const mint = new PublicKey(mint_meta.mint);
        const token_program = new PublicKey(mint_meta.token_program_id);
        const amm = new PublicKey(mint_meta.amm_pool);
        const creator_vault = new PublicKey(mint_meta.creator_vault);
        const creator_vault_ata = new PublicKey(mint_meta.creator_vault_ata);
        const user_volume_accumulator = this.calc_user_volume_accumulator(seller.publicKey, 'pump-swap');
        const bonding_curve = new PublicKey(mint_meta.base_vault);
        const assoc_bonding_curve = new PublicKey(mint_meta.quote_vault);
        const token_amount_raw = BigInt(token_amount.amount);

        const sol_amount_raw = this.calc_sol_amount_raw(token_amount_raw, mint_meta);
        const instruction_data = this.amm_sell_data(sol_amount_raw, token_amount_raw, slippage);
        const token_ata = trade.calc_ata(seller.publicKey, mint, token_program);
        const wsol_ata = trade.calc_ata(seller.publicKey, SOL_MINT);
        const wsol_user_accumulator_ata = trade.calc_ata(user_volume_accumulator, SOL_MINT);
        const pool_v2 = this.calc_pool_v2(mint);
        const fee_recipients = mint_meta.is_mayhem ? MAYHEM_FEE_RECIPIENTS : PUMP_FEE_RECIPIENTS;
        const fee_recipient = fee_recipients[Math.floor(Math.random() * fee_recipients.length)];
        const fee_recipient_ata = trade.calc_ata(fee_recipient, SOL_MINT);
        const buyback_fee_recipient =
            PUMP_BUYBACK_FEE_RECIPIENTS[Math.floor(Math.random() * PUMP_BUYBACK_FEE_RECIPIENTS.length)];
        const buyback_fee_recipient_ata = trade.calc_ata(buyback_fee_recipient, SOL_MINT);

        return [
            createAssociatedTokenAccountIdempotentInstruction(seller.publicKey, wsol_ata, seller.publicKey, SOL_MINT),
            new TransactionInstruction({
                keys: [
                    { pubkey: amm, isSigner: false, isWritable: true },
                    { pubkey: seller.publicKey, isSigner: true, isWritable: true },
                    { pubkey: PUMP_AMM_GLOBAL_ACCOUNT, isSigner: false, isWritable: false },
                    { pubkey: mint, isSigner: false, isWritable: false },
                    { pubkey: SOL_MINT, isSigner: false, isWritable: false },
                    { pubkey: token_ata, isSigner: false, isWritable: true },
                    { pubkey: wsol_ata, isSigner: false, isWritable: true },
                    { pubkey: bonding_curve, isSigner: false, isWritable: true },
                    { pubkey: assoc_bonding_curve, isSigner: false, isWritable: true },
                    { pubkey: fee_recipient, isSigner: false, isWritable: false },
                    { pubkey: fee_recipient_ata, isSigner: false, isWritable: true },
                    { pubkey: token_program, isSigner: false, isWritable: false },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: PUMP_AMM_EVENT_AUTHORITY_ACCOUNT, isSigner: false, isWritable: false },
                    { pubkey: PUMP_AMM_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: creator_vault_ata, isSigner: false, isWritable: true },
                    { pubkey: creator_vault, isSigner: false, isWritable: false },
                    { pubkey: PUMP_AMM_FEE_CONFIG, isSigner: false, isWritable: false },
                    { pubkey: PUMP_FEE_PROGRAM_ID, isSigner: false, isWritable: false },
                    ...(mint_meta.is_cashback
                        ? [
                              { pubkey: wsol_user_accumulator_ata, isSigner: false, isWritable: true },
                              { pubkey: user_volume_accumulator, isSigner: false, isWritable: true }
                          ]
                        : []),
                    { pubkey: pool_v2, isSigner: false, isWritable: false },
                    { pubkey: buyback_fee_recipient, isSigner: false, isWritable: true },
                    { pubkey: buyback_fee_recipient_ata, isSigner: false, isWritable: true }
                ],
                programId: PUMP_AMM_PROGRAM_ID,
                data: instruction_data
            }),
            createCloseAccountInstruction(wsol_ata, seller.publicKey, seller.publicKey)
        ];
    }

    public async create_token_metadata(meta: common.IPFSMetadata, image_path: string): Promise<string> {
        let formData = new FormData();
        const image_file = new File([readFileSync(image_path)], basename(image_path), {
            type: 'image/png'
        });
        formData.append('file', image_file);
        formData.append('name', meta.name);
        formData.append('symbol', meta.symbol);
        formData.append('description', meta.description);
        formData.append('twitter', meta.twitter || '');
        formData.append('telegram', meta.telegram || '');
        formData.append('website', meta.website || '');
        formData.append('showName', meta.showName ? 'true' : 'false');

        try {
            const response = await fetch(PUMP_IPFS_API_URL, {
                method: 'POST',
                headers: {
                    Accept: 'application/json'
                },
                body: formData
            });
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const data = await response.json();
            return data.metadataUri.split('/').slice(-1)[0];
        } catch (error) {
            throw new Error(`Failed to create token metadata: ${error}`);
        }
    }

    private async get_random_ungraduated_mints(count: number): Promise<PumpMintMeta[]> {
        if (count <= 0) return [];
        const limit = 50;
        count = Math.min(count, limit);
        const offset = Array.from({ length: 20 }, (_, i) => i * limit).sort(() => 0.5 - Math.random())[0];

        try {
            const response = await fetch(
                `${PUMP_API_URL}/coins?offset=${offset}&limit=${limit}&sort=last_trade_timestamp&order=DESC&includeNsfw=false`
            );
            const data = await response.json();
            if (!data || data.statusCode !== undefined) return [];

            const promises = common
                .pick_random(data, count)
                .map((item: any) => this.get_mint_meta(new PublicKey(item.mint)));

            const mints = await Promise.all(promises);
            return mints.filter((mint) => mint !== undefined);
        } catch (err) {
            common.error(common.red(`Failed fetching the mints: ${err}`));
            return [];
        }
    }

    private graduated_mints_cache: PublicKey[] | null = null;
    private async get_random_graduated_mints(count: number): Promise<PumpMintMeta[]> {
        if (count <= 0) return [];
        if (!this.graduated_mints_cache) {
            this.graduated_mints_cache = [];
            try {
                const amms = await trade.get_program_accounts_v2(
                    PUMP_AMM_PROGRAM_ID,
                    [{ memcmp: { offset: 0, bytes: base58.encode(PUMP_AMM_STATE_HEADER) } }],
                    {
                        offset: AMMStateStruct.get_offset('base_mint'),
                        length: AMMStateStruct.get_size() - AMMStateStruct.get_offset('base_mint')
                    }
                );
                if (amms) {
                    for (const chunk of common.chunks(amms, 100)) {
                        for (const acc of chunk) {
                            if (!acc) continue;
                            if (
                                common.read_biguint_le(
                                    acc.account.data,
                                    AMMStateStruct.get_offset('lp_supply') - AMMStateStruct.get_offset('base_mint'),
                                    8
                                ) < 4000000000000n
                            )
                                continue;
                            this.graduated_mints_cache.push(new PublicKey(common.read_bytes(acc.account.data, 0, 32)));
                        }
                    }
                }
            } catch (error) {
                return [];
            }
        }

        return (
            await Promise.all(
                common.pick_random(this.graduated_mints_cache, count).map((mint) => this.get_mint_meta(mint))
            )
        ).filter((meta) => meta !== undefined);
    }
}
