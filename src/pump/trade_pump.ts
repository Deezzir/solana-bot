import {
    AccountInfo,
    AddressLookupTableAccount,
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
    ASSOCIATED_TOKEN_PROGRAM_ID,
    decode_token_account,
    createAssociatedTokenAccountIdempotentInstruction,
    createCloseAccountInstruction,
    TOKEN_2022_PROGRAM_ID,
    TOKEN_PROGRAM_ID
} from '../common/token';
import {
    COMMITMENT,
    IPFS,
    METAPLEX_PROGRAM_ID,
    PUMP_AMM_EVENT_AUTHORITY_ACCOUNT,
    PUMP_AMM_GLOBAL_ACCOUNT,
    PUMP_AMM_PROGRAM_ID,
    PUMP_BONDING_SEED,
    PUMP_STATE_HEADER,
    PUMP_GLOBAL_HEADER,
    PUMP_QUOTE_CONTROL_HEADER,
    PUMP_TOKEN_DECIMALS,
    PUMP_DEFAULT_MINT_META,
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
    PUMP_AMM_BUY_EXACT_OUT_DISCRIMINATOR,
    PUMP_SELL_DISCRIMINATOR,
    PUMP_SWAP_PERCENTAGE,
    PUMP_CREATE_V1_DISCRIMINATOR,
    PUMP_IPFS_API_URL,
    PUMP_AMM_STATE_HEADER,
    PUMP_LTA_ACCOUNT,
    PUMP_QUOTE_LTA_ACCOUNT,
    PUMP_AMM_CREATOR_VAULT_SEED,
    RENT_PROGRAM_ID,
    PUMP_CREATOR_VAULT_SEED,
    PUMP_EXTEND_DISCRIMINATOR,
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
    PUMP_COLLECT_CREATOR_FEE_DISCRIMINATOR,
    PUMP_AMM_COLLECT_CREATOR_FEE_DISCRIMINATOR,
    PUMP_CLAIM_CASHBACK_DISCRIMINATOR,
    PUMP_CLAIM_CASHBACK_V2_DISCRIMINATOR,
    PUMP_COLLECT_CREATOR_FEE_V2_DISCRIMINATOR,
    PUMP_CLAIM_TOKEN_INCENTIVES_DISCRIMINATOR,
    PROGRAM_COMPUTE_UNIT_LIMITS
} from '../constants';
import { readFileSync } from 'fs';
import { basename } from 'path';
import base58 from 'bs58';
import { define_decoder_struct, skip, u8, u64, i128, discriminator, pubkey, u16, bool } from '../common/struct_decoder';

type State = ReturnType<typeof StateStruct.decode>;

type AMMState = ReturnType<typeof AMMStateStruct.decode> & {
    base_vault_balance: bigint;
    quote_vault_balance: bigint;
    supply: bigint;
};

type PumpClaimableAsset = trade.ClaimableAsset & {
    vault: PublicKey;
    vault_ata: PublicKey;
    curve: 'v1' | 'v2';
    quote_mint?: PublicKey;
    quote_token_program?: PublicKey;
    claim?: 'cashback' | 'incentives';
    program?: PublicKey;
    accumulator?: PublicKey;
    global_accumulator?: PublicKey;
};

const PUMP_COMPUTE_UNIT_LIMIT = PROGRAM_COMPUTE_UNIT_LIMITS[common.Program.Pump];

class PumpMintMeta implements trade.IMintMeta {
    mint!: string;
    name: string = 'Unknown';
    symbol: string = 'Unknown';
    base_vault!: string;
    quote_vault!: string;
    creator_vault!: string;
    creator_vault_ata!: string;
    quote_mint: string = SOL_MINT.toBase58();
    amm_pool: string | null = null;
    sol_reserves: bigint = BigInt(0);
    token_reserves: bigint = BigInt(0);
    total_supply: bigint = BigInt(0);
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

    public get token_quote_mc(): number {
        return this.market_cap;
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
            creator_vault: this.creator_vault,
            creator_vault_ata: this.creator_vault_ata,
            amm_pool: this.amm_pool,
            sol_reserves: this.sol_reserves.toString(),
            token_reserves: this.token_reserves.toString(),
            total_supply: this.total_supply.toString(),
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
            quote_mint: normalize_quote_mint(data.quote_mint as string | undefined).toBase58(),
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
    is_cashback: bool(),
    quote_mint: pubkey()
});

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

const UserVolumeAccumulatorStruct = define_decoder_struct({
    discriminator: discriminator(Buffer.from([86, 255, 112, 14, 102, 53, 154, 250])),
    user: pubkey(),
    needs_claim: bool(),
    total_unclaimed_tokens: u64(),
    claimed_tokens: skip(8),
    volume: skip(8),
    timestamp: skip(8),
    has_claimed_tokens: skip(1),
    cashback_earned: u64(),
    total_cashback_claimed: u64()
});

const GlobalVolumeAccumulatorStruct = define_decoder_struct({
    discriminator: discriminator(Buffer.from([202, 42, 246, 43, 142, 190, 30, 255])),
    padding: skip(24),
    mint: pubkey()
});

export class Provider implements trade.IProgramProvider {
    public get_name(): string {
        return common.Program.Pump;
    }

    public get_lta_addresses(): PublicKey[] {
        return [PUMP_QUOTE_LTA_ACCOUNT, PUMP_LTA_ACCOUNT];
    }

    public deserialize_mint_meta(data: trade.SerializedMintMeta): PumpMintMeta {
        return PumpMintMeta.deserialize(data);
    }

    public async get_rewards(trader: Keypair): Promise<PumpClaimableAsset[]> {
        const [creator_vault, creator_vault_ata] = await this.calc_creator_vault(trader.publicKey);
        const [creator_vault_info, creator_vault_rent, amm_pools] = await Promise.all([
            global.CONNECTION.getAccountInfo(creator_vault, COMMITMENT),
            global.CONNECTION.getMinimumBalanceForRentExemption(0, COMMITMENT),
            trade.get_program_accounts_v2(PUMP_AMM_PROGRAM_ID, [
                { memcmp: { offset: AMMStateStruct.get_offset('creator'), bytes: trader.publicKey.toBase58() } },
                { memcmp: { offset: 0, bytes: base58.encode(PUMP_AMM_STATE_HEADER) } }
            ])
        ]);
        const pump_fees = (creator_vault_info?.lamports ?? 0n) - creator_vault_rent;
        const assets = await this.get_quote_rewards(creator_vault, 'creator_reward', 'v1');
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
        const [amm_creator_vault] = await this.calc_amm_creator_vault(trader.publicKey);
        const amm_assets = await Promise.all(
            amm_pools.map(async ({ account }) => {
                const state = AMMStateStruct.decode(account.data);
                const quote_mint_info = await global.CONNECTION.getAccountInfo(state.quote_mint, COMMITMENT);
                if (!quote_mint_info) throw new Error(`Pump AMM quote mint is missing: ${state.quote_mint}`);
                const quote_token_program = quote_mint_info.owner;
                const vault_ata = await trade.calc_ata(amm_creator_vault, state.quote_mint, quote_token_program);
                const fees = await trade.get_vault_balance(vault_ata).catch(() => ({ balance: 0n, decimals: 0 }));
                if (fees.balance === 0n) return null;
                return {
                    mint: state.quote_mint,
                    raw_amount: fees.balance,
                    decimals: fees.decimals,
                    source: 'creator_reward' as const,
                    vault: amm_creator_vault,
                    vault_ata,
                    curve: 'v2' as const,
                    quote_mint: state.quote_mint,
                    quote_token_program
                };
            })
        );
        assets.push(...amm_assets.filter((asset) => asset !== null));

        const reward_assets = await Promise.all(
            [
                { program: PUMP_PROGRAM_ID, global: PUMP_GLOBAL_VOLUME_ACCUMULATOR },
                { program: PUMP_AMM_PROGRAM_ID, global: PUMP_AMM_GLOBAL_VOLUME_ACCUMULATOR }
            ].map(async ({ program, global: global_accumulator }) => {
                const accumulator = await this.calc_user_volume_accumulator(trader.publicKey, program);
                const [accumulator_info, global_info] = await Promise.all([
                    global.CONNECTION.getAccountInfo(accumulator, COMMITMENT),
                    global.CONNECTION.getAccountInfo(global_accumulator, COMMITMENT)
                ]);
                if (!accumulator_info || !accumulator_info.owner.equals(program)) return [];
                const state = UserVolumeAccumulatorStruct.decode(accumulator_info.data);
                if (!state.user.equals(trader.publicKey)) return [];
                const claimable: PumpClaimableAsset[] = [];
                const quote_cashback = await this.get_quote_rewards(
                    accumulator,
                    'cashback_reward',
                    program.equals(PUMP_PROGRAM_ID) ? 'v1' : 'v2'
                );
                claimable.push(
                    ...quote_cashback.map((asset) => ({ ...asset, claim: 'cashback' as const, program, accumulator }))
                );
                const cashback = state.cashback_earned - state.total_cashback_claimed;
                if (cashback > 0n) {
                    claimable.push({
                        mint: SOL_MINT,
                        raw_amount: cashback,
                        decimals: 9,
                        source: 'cashback_reward',
                        vault: accumulator,
                        vault_ata: await trade.calc_ata(accumulator, SOL_MINT),
                        curve: program.equals(PUMP_PROGRAM_ID) ? 'v1' : 'v2',
                        claim: 'cashback',
                        program,
                        accumulator
                    });
                }
                if (state.needs_claim && state.total_unclaimed_tokens > 0n && global_info) {
                    const mint = GlobalVolumeAccumulatorStruct.decode(global_info.data).mint;
                    const mint_info = await global.CONNECTION.getAccountInfo(mint, COMMITMENT);
                    if (!mint_info) return claimable;
                    const supply = await trade.get_token_supply(mint);
                    claimable.push({
                        mint,
                        raw_amount: state.total_unclaimed_tokens,
                        decimals: supply.decimals,
                        source: 'token_incentive_reward',
                        vault: accumulator,
                        vault_ata: await trade.calc_ata(accumulator, mint, mint_info.owner),
                        curve: program.equals(PUMP_PROGRAM_ID) ? 'v1' : 'v2',
                        claim: 'incentives',
                        program,
                        accumulator,
                        global_accumulator,
                        quote_token_program: mint_info.owner
                    });
                }
                return claimable;
            })
        );
        assets.push(...reward_assets.flat());
        return assets;
    }

    private async get_quote_rewards(
        vault: PublicKey,
        source: 'creator_reward' | 'cashback_reward',
        curve: PumpClaimableAsset['curve']
    ): Promise<PumpClaimableAsset[]> {
        const accounts = await Promise.all(
            [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map((programId) =>
                global.CONNECTION.getTokenAccountsByOwner(vault, { programId }, COMMITMENT)
            )
        );
        const assets: PumpClaimableAsset[] = [];
        for (const { pubkey, account } of accounts.flatMap(({ value }) => value)) {
            const token = decode_token_account(account);
            if (token.amount === 0n || token.mint.equals(SOL_MINT) || !token.owner.equals(vault)) continue;
            const ata = await trade.calc_ata(vault, token.mint, account.owner);
            if (!pubkey.equals(ata)) continue;
            const quote = await get_quote_info(token.mint);
            if (!quote.token_program.equals(account.owner))
                throw new Error(`Invalid quote token program: ${token.mint}`);
            assets.push({
                mint: token.mint,
                raw_amount: token.amount,
                decimals: quote.decimals,
                source,
                vault,
                vault_ata: ata,
                curve,
                quote_mint: token.mint,
                quote_token_program: quote.token_program
            });
        }
        return assets;
    }

    public async claim_rewards_instructions(
        trader: Keypair,
        assets: PumpClaimableAsset[]
    ): Promise<TransactionInstruction[]> {
        if (assets.length === 0) throw new Error(`No assets were provided`);

        const instructions: TransactionInstruction[] = [];

        for (const asset of assets) {
            if (asset.claim === 'cashback') {
                if (!asset.program || !asset.accumulator)
                    throw new Error('Pump cashback claim is missing account data.');
                if (asset.program.equals(PUMP_PROGRAM_ID) && asset.mint.equals(SOL_MINT)) {
                    instructions.push(
                        new TransactionInstruction({
                            programId: asset.program,
                            data: Buffer.from(PUMP_CLAIM_CASHBACK_DISCRIMINATOR),
                            keys: [
                                { pubkey: trader.publicKey, isSigner: false, isWritable: true },
                                { pubkey: asset.accumulator, isSigner: false, isWritable: true },
                                { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
                                { pubkey: PUMP_EVENT_AUTHORITY_ACCOUNT, isSigner: false, isWritable: false },
                                { pubkey: asset.program, isSigner: false, isWritable: false }
                            ]
                        })
                    );
                } else {
                    const quote = await get_quote_info(asset.mint);
                    const user_ata = await trade.calc_ata(trader.publicKey, asset.mint, quote.token_program);
                    const accumulator_ata = await trade.calc_ata(asset.accumulator, asset.mint, quote.token_program);
                    const bonding = asset.program.equals(PUMP_PROGRAM_ID);
                    instructions.push(
                        createAssociatedTokenAccountIdempotentInstruction(
                            trader,
                            accumulator_ata,
                            asset.accumulator,
                            asset.mint,
                            quote.token_program
                        ),
                        createAssociatedTokenAccountIdempotentInstruction(
                            trader,
                            user_ata,
                            trader.publicKey,
                            asset.mint,
                            quote.token_program
                        ),
                        new TransactionInstruction({
                            programId: asset.program,
                            data: Buffer.from(
                                bonding ? PUMP_CLAIM_CASHBACK_V2_DISCRIMINATOR : PUMP_CLAIM_CASHBACK_DISCRIMINATOR
                            ),
                            keys: [
                                { pubkey: trader.publicKey, isSigner: false, isWritable: true },
                                { pubkey: asset.accumulator, isSigner: false, isWritable: true },
                                { pubkey: asset.mint, isSigner: false, isWritable: false },
                                { pubkey: quote.token_program, isSigner: false, isWritable: false },
                                ...(bonding
                                    ? [{ pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }]
                                    : []),
                                { pubkey: accumulator_ata, isSigner: false, isWritable: true },
                                { pubkey: user_ata, isSigner: false, isWritable: true },
                                { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
                                {
                                    pubkey: bonding ? PUMP_EVENT_AUTHORITY_ACCOUNT : PUMP_AMM_EVENT_AUTHORITY_ACCOUNT,
                                    isSigner: false,
                                    isWritable: false
                                },
                                { pubkey: asset.program, isSigner: false, isWritable: false }
                            ]
                        }),
                        ...(asset.mint.equals(SOL_MINT)
                            ? [createCloseAccountInstruction(user_ata, trader.publicKey, trader.publicKey)]
                            : [])
                    );
                }
            } else if (asset.claim === 'incentives') {
                if (!asset.program || !asset.accumulator || !asset.global_accumulator || !asset.quote_token_program)
                    throw new Error('Pump incentive claim is missing account data.');
                const user_ata = await trade.calc_ata(trader.publicKey, asset.mint, asset.quote_token_program);
                const global_ata = await trade.calc_ata(
                    asset.global_accumulator,
                    asset.mint,
                    asset.quote_token_program
                );
                instructions.push(
                    createAssociatedTokenAccountIdempotentInstruction(
                        trader,
                        user_ata,
                        trader.publicKey,
                        asset.mint,
                        asset.quote_token_program
                    ),
                    new TransactionInstruction({
                        programId: asset.program,
                        data: Buffer.from(PUMP_CLAIM_TOKEN_INCENTIVES_DISCRIMINATOR),
                        keys: [
                            { pubkey: trader.publicKey, isSigner: false, isWritable: false },
                            { pubkey: user_ata, isSigner: false, isWritable: true },
                            { pubkey: asset.global_accumulator, isSigner: false, isWritable: false },
                            { pubkey: global_ata, isSigner: false, isWritable: true },
                            { pubkey: asset.accumulator, isSigner: false, isWritable: true },
                            { pubkey: asset.mint, isSigner: false, isWritable: false },
                            { pubkey: asset.quote_token_program, isSigner: false, isWritable: false },
                            { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
                            { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                            {
                                pubkey: asset.program.equals(PUMP_PROGRAM_ID)
                                    ? PUMP_EVENT_AUTHORITY_ACCOUNT
                                    : PUMP_AMM_EVENT_AUTHORITY_ACCOUNT,
                                isSigner: false,
                                isWritable: false
                            },
                            { pubkey: asset.program, isSigner: false, isWritable: false },
                            { pubkey: trader.publicKey, isSigner: true, isWritable: true }
                        ]
                    })
                );
            } else if (asset.curve === 'v1' && !asset.mint.equals(SOL_MINT)) {
                const quote = await get_quote_info(asset.mint);
                const creator_ata = await trade.calc_ata(trader.publicKey, asset.mint, quote.token_program);
                instructions.push(
                    createAssociatedTokenAccountIdempotentInstruction(
                        trader,
                        creator_ata,
                        trader.publicKey,
                        asset.mint,
                        quote.token_program
                    ),
                    new TransactionInstruction({
                        programId: PUMP_PROGRAM_ID,
                        data: Buffer.from(PUMP_COLLECT_CREATOR_FEE_V2_DISCRIMINATOR),
                        keys: [
                            { pubkey: trader.publicKey, isSigner: false, isWritable: true },
                            { pubkey: creator_ata, isSigner: false, isWritable: true },
                            { pubkey: asset.vault, isSigner: false, isWritable: true },
                            { pubkey: asset.vault_ata, isSigner: false, isWritable: true },
                            { pubkey: asset.mint, isSigner: false, isWritable: false },
                            { pubkey: quote.token_program, isSigner: false, isWritable: false },
                            { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                            { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
                            { pubkey: PUMP_EVENT_AUTHORITY_ACCOUNT, isSigner: false, isWritable: false },
                            { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false }
                        ]
                    })
                );
            } else if (asset.curve === 'v1') {
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
                if (!asset.quote_mint || !asset.quote_token_program)
                    throw new Error('Pump AMM claim is missing quote token data.');
                const creator_ata = await trade.calc_ata(trader.publicKey, asset.quote_mint, asset.quote_token_program);
                instructions.push(
                    createAssociatedTokenAccountIdempotentInstruction(
                        trader,
                        creator_ata,
                        trader.publicKey,
                        asset.quote_mint,
                        asset.quote_token_program
                    ),
                    new TransactionInstruction({
                        keys: [
                            { pubkey: asset.quote_mint, isSigner: false, isWritable: false },
                            { pubkey: asset.quote_token_program, isSigner: false, isWritable: false },
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
                    ...(asset.quote_mint.equals(SOL_MINT)
                        ? [createCloseAccountInstruction(creator_ata, trader.publicKey, trader.publicKey)]
                        : [])
                );
            }
        }

        if (instructions.length === 0) throw new Error('Invalid assets were provided, no tx was derived');
        return instructions;
    }

    public get_compute_unit_limit(): number | undefined {
        return PUMP_COMPUTE_UNIT_LIMIT;
    }

    public async buy_token_instructions(
        amount: TokenAmount,
        buyer: Keypair,
        mint_meta: PumpMintMeta,
        slippage: number = 0.05
    ): Promise<[TransactionInstruction[], AddressLookupTableAccount[]?]> {
        trade.validate_trade_parameters(amount, slippage);
        const lta = await trade.get_ltas(this.get_lta_addresses());
        if (this.get_amm(mint_meta)) {
            const instructions = await this.get_buy_amm_instructions(amount, buyer, mint_meta, slippage);
            return [instructions, lta];
        }
        const instructions = await this.get_buy_instructions(amount, buyer, mint_meta, slippage);
        return [instructions, lta];
    }

    public async sell_token_instructions(
        token_amount: TokenAmount,
        seller: Keypair,
        mint_meta: PumpMintMeta,
        slippage: number = 0.05
    ): Promise<trade.SellInstructions> {
        trade.validate_trade_parameters(token_amount, slippage);
        const lta = await trade.get_ltas(this.get_lta_addresses());
        if (this.get_amm(mint_meta)) {
            const instructions = await this.get_sell_amm_instructions(token_amount, seller, mint_meta, slippage);
            return { ...instructions, ltas: lta };
        }
        const instructions = await this.get_sell_instructions(token_amount, seller, mint_meta, slippage);
        return { ...instructions, ltas: lta };
    }

    public async buy_sell_instructions(
        amount: TokenAmount,
        trader: Keypair,
        mint_meta: PumpMintMeta,
        slippage: number = 0.05
    ): Promise<trade.BuySellInstructions> {
        trade.validate_trade_parameters(amount, slippage);
        const quote_amount_raw = BigInt(amount.amount);
        const token_amount_raw = this.calc_token_amount_raw(quote_amount_raw, mint_meta);
        const buy_instructions = this.get_amm(mint_meta)
            ? await this.get_buy_amm_instructions(amount, trader, mint_meta, slippage, token_amount_raw)
            : await this.get_buy_instructions(amount, trader, mint_meta, slippage);
        const {
            instructions: sell,
            ltas,
            minimum_quote_output
        } = await this.sell_token_instructions(
            {
                uiAmount: Number(token_amount_raw) / 10 ** PUMP_TOKEN_DECIMALS,
                amount: token_amount_raw.toString(),
                decimals: PUMP_TOKEN_DECIMALS
            },
            trader,
            mint_meta,
            slippage
        );
        return { buy: buy_instructions, sell, ltas, minimum_quote_output };
    }

    public async get_mint_meta(mint: PublicKey): Promise<PumpMintMeta | undefined> {
        try {
            let mint_meta = await this.default_mint_meta(mint);
            mint_meta = await this.update_mint_meta(mint_meta);
            return mint_meta;
        } catch (error) {
            return undefined;
        }
    }

    public async get_random_mints(count: number): Promise<PumpMintMeta[]> {
        return trade.sample_mint_sources(
            count,
            (size) => this.get_random_graduated_mints(size),
            (size) => this.get_random_ungraduated_mints(size)
        );
    }

    public async create_token_instructions(
        mint: Keypair,
        creator: Keypair,
        token_name: string,
        token_symbol: string,
        meta_cid: string,
        config?: object
    ): Promise<trade.CreateTokenInstructions> {
        let version: 'v1' | 'v2' = 'v2';
        let is_mayhem: boolean = false;
        let is_cashback: boolean = false;
        const quote_mint = new PublicKey((config as { quote_mint?: string } | undefined)?.quote_mint ?? SOL_MINT);

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
        if (!quote_mint.equals(SOL_MINT) && (version === 'v1' || is_mayhem))
            throw new Error('Non-SOL Pump creation requires v2 without mayhem.');

        const mint_meta = await this.default_mint_meta(mint.publicKey, {
            name: token_name,
            symbol: token_symbol,
            creator: creator.publicKey,
            token_program: version === 'v1' ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID,
            quote_mint: quote_mint.toBase58(),
            is_mayhem: is_mayhem,
            is_cashback: is_cashback
        });

        if (!quote_mint.equals(SOL_MINT)) {
            const initial = await this.get_initial_quote_reserves(quote_mint);
            mint_meta.sol_reserves = initial.quote_reserves;
            mint_meta.token_reserves = initial.token_reserves;
            mint_meta.total_supply = initial.supply;
            const quote = await get_quote_info(quote_mint);
            mint_meta.market_cap = quote_metrics(
                Number(initial.quote_reserves) / Number(initial.token_reserves),
                initial.supply,
                quote.decimals,
                PUMP_TOKEN_DECIMALS
            ).mcap_quote;
        }

        const create_instructions = await this.get_create_token_instructions(
            creator,
            token_name,
            token_symbol,
            meta_cid,
            mint,
            is_mayhem,
            is_cashback,
            version,
            quote_mint
        );
        const ltas = global.TRANSACTION_VERSION === 1 ? [] : await trade.get_ltas(this.get_lta_addresses());
        return { instructions: create_instructions, mint_meta, ltas };
    }

    public async default_mint_meta(mint: PublicKey, data?: object): Promise<PumpMintMeta> {
        const decoded = data as Record<string, unknown> | undefined;
        const meta = decoded
            ? {
                  token_name: typeof decoded.name === 'string' && decoded.name ? decoded.name : 'Unknown',
                  token_symbol: typeof decoded.symbol === 'string' && decoded.symbol ? decoded.symbol : 'Unknown',
                  creator:
                      decoded.creator instanceof PublicKey
                          ? decoded.creator
                          : typeof decoded.creator === 'string' && decoded.creator
                            ? new PublicKey(decoded.creator)
                            : undefined,
                  token_program:
                      decoded.token_program instanceof PublicKey
                          ? decoded.token_program
                          : typeof decoded.token_program === 'string' && decoded.token_program
                            ? new PublicKey(decoded.token_program)
                            : TOKEN_PROGRAM_ID,
                  is_mayhem: decoded.is_mayhem === true,
                  is_cashback: decoded.is_cashback === true
              }
            : {
                  ...(await trade.get_token_meta(mint).catch(() => ({
                      token_name: 'Unknown',
                      token_symbol: 'Unknown',
                      creator: undefined,
                      token_program: TOKEN_PROGRAM_ID
                  }))),
                  is_mayhem: false,
                  is_cashback: false
              };

        const quote_mint = new PublicKey((decoded?.quote_mint as string | undefined) ?? SOL_MINT);
        let creator_vault: PublicKey | undefined;
        let creator_vault_ata: PublicKey | undefined;
        const [bonding, bonding_ata] = await this.calc_bonding_curve(mint, meta.token_program);
        if (meta.creator) {
            const quote = await get_quote_info(quote_mint);
            [creator_vault, creator_vault_ata] = await this.calc_creator_vault(
                meta.creator,
                quote_mint,
                quote.token_program
            );
        }

        return new PumpMintMeta({
            mint: mint.toString(),
            quote_mint: quote_mint.toBase58(),
            symbol: meta.token_symbol,
            name: meta.token_name,
            amm_pool: null,
            base_vault: bonding.toString(),
            quote_vault: bonding_ata.toString(),
            ...PUMP_DEFAULT_MINT_META,
            market_cap: quote_mint.equals(SOL_MINT) ? PUMP_DEFAULT_MINT_META.market_cap : 0,
            fee: PUMP_FEE_PERCENTAGE,
            creator_vault: creator_vault ? creator_vault.toString() : undefined,
            creator_vault_ata: creator_vault_ata ? creator_vault_ata.toString() : undefined,
            token_program_id: meta.token_program.toString(),
            is_mayhem: meta.is_mayhem,
            is_cashback: meta.is_cashback
        });
    }

    public update_mint_meta_reserves(mint_meta: PumpMintMeta, amount: TokenAmount, op: trade.TradeOp): PumpMintMeta {
        const swap = this.calc_swap_amounts(BigInt(amount.amount), mint_meta, op);
        mint_meta.sol_reserves += swap.quote_delta;
        mint_meta.token_reserves += swap.base_delta;
        return mint_meta;
    }

    public async update_mint_meta(mint_meta: PumpMintMeta): Promise<PumpMintMeta> {
        try {
            const curve_state = mint_meta.amm_pool
                ? undefined
                : await this.get_state(new PublicKey(mint_meta.base_vault));
            let pump_amm = this.get_amm(mint_meta);
            if (!pump_amm && (!curve_state || curve_state.complete))
                pump_amm = await this.calc_amm_from_mint(
                    mint_meta.mint_pubkey,
                    curve_state?.quote_mint ?? mint_meta.quote_mint_pubkey
                );
            const amm_info = pump_amm ? await global.CONNECTION.getAccountInfo(pump_amm, COMMITMENT) : null;

            if (curve_state && !amm_info) {
                const state = curve_state;
                const quote = await get_quote_info(state.quote_mint);
                const [creator_vault, creator_vault_ata] = await this.calc_creator_vault(
                    state.creator,
                    state.quote_mint,
                    quote.token_program
                );
                const metrics = quote_metrics(
                    Number(state.virtual_sol_reserves) / Number(state.virtual_token_reserves),
                    state.supply,
                    quote.decimals,
                    PUMP_TOKEN_DECIMALS
                );
                return new PumpMintMeta({
                    ...mint_meta,
                    amm_pool: null,
                    market_cap: metrics.mcap_quote,
                    total_supply: state.supply,
                    token_reserves: state.virtual_token_reserves,
                    sol_reserves: state.virtual_sol_reserves,
                    complete: state.complete,
                    quote_mint: state.quote_mint.toString(),
                    fee: PUMP_FEE_PERCENTAGE,
                    creator_vault: creator_vault.toString(),
                    creator_vault_ata: creator_vault_ata.toString(),
                    is_mayhem: state.is_mayhem,
                    is_cashback: state.is_cashback
                });
            }
            if (amm_info) {
                const state = await this.get_amm_state_from_data(amm_info.data);
                const quote = await get_quote_info(state.quote_mint);
                const metrics = quote_metrics(
                    Number(state.quote_vault_balance + state.virtual_quote_reserves) / Number(state.base_vault_balance),
                    state.supply,
                    quote.decimals,
                    PUMP_TOKEN_DECIMALS
                );
                const [creator_vault, creator_vault_ata] = await this.calc_amm_creator_vault(
                    state.creator,
                    state.quote_mint,
                    quote.token_program
                );
                return new PumpMintMeta({
                    ...mint_meta,
                    amm_pool: pump_amm!.toBase58(),
                    quote_mint: state.quote_mint.toString(),
                    market_cap: metrics.mcap_quote,
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
            throw new Error('Pump curve or AMM pool not found');
        } catch (error) {
            throw new Error(`Failed to update mint meta reserves: ${error}`);
        }
    }

    public async subscribe_mint_meta(
        mint_meta: PumpMintMeta,
        callback: (mint_meta: PumpMintMeta) => void,
        commitment: Commitment = COMMITMENT
    ): Promise<() => void> {
        const mint = new PublicKey(mint_meta.mint);
        const bonding_curve = new PublicKey(mint_meta.base_vault);
        let bonding_sub_id: number | undefined;
        let amm_state_sub_id: number | undefined;
        let base_vault_sub_id: number | undefined;
        let quote_vault_sub_id: number | undefined;
        let stopped = false;
        let switched_to_amm = false;
        let current_mint_meta = mint_meta;
        let latest_slot = 0n;
        let amm_state: ReturnType<typeof AMMStateStruct.decode> | null = null;
        let base_vault_balance: bigint | null = null;
        let quote_vault_balance: bigint | null = null;
        let base_vault_slot = 0n;
        let quote_vault_slot = 0n;
        let vaults_started = false;
        let amm_pool_address = current_mint_meta.amm_pool;

        const publish = (update: PumpMintMeta, slot: bigint = 0n) => {
            if (stopped || (slot && slot < latest_slot)) return;
            if (slot) latest_slot = slot;
            current_mint_meta = update;
            callback(update);
        };

        const unsubscribe = (id: number | undefined) => {
            if (id !== undefined) global.CONNECTION.removeAccountChangeListener(id).catch(() => {});
        };

        const publish_amm = async (slot: bigint = 0n) => {
            if (
                !amm_state ||
                base_vault_balance === null ||
                quote_vault_balance === null ||
                base_vault_slot !== quote_vault_slot
            )
                return;
            const state = amm_state;
            const base_balance = base_vault_balance;
            const quote_balance = quote_vault_balance;
            const quote = await get_quote_info(state.quote_mint);
            const metrics = quote_metrics(
                Number(quote_balance + state.virtual_quote_reserves) / Number(base_balance),
                current_mint_meta.total_supply,
                quote.decimals,
                PUMP_TOKEN_DECIMALS
            );
            const [creator_vault, creator_vault_ata] = await this.calc_amm_creator_vault(
                state.creator,
                state.quote_mint,
                quote.token_program
            );

            if (base_balance !== base_vault_balance || quote_balance !== quote_vault_balance || state !== amm_state)
                return;

            publish(
                new PumpMintMeta({
                    ...current_mint_meta,
                    market_cap: metrics.mcap_quote,
                    amm_pool: amm_pool_address,
                    quote_mint: state.quote_mint.toBase58(),
                    base_vault: state.base_vault.toString(),
                    quote_vault: state.quote_vault.toString(),
                    sol_reserves: quote_balance + state.virtual_quote_reserves,
                    token_reserves: base_balance,
                    complete: true,
                    fee: PUMP_SWAP_PERCENTAGE,
                    creator_vault: creator_vault.toString(),
                    creator_vault_ata: creator_vault_ata.toString(),
                    is_mayhem: state.is_mayhem,
                    is_cashback: state.is_cashback
                }),
                slot
            );
        };

        const subscribe_amm_accounts = async (state: ReturnType<typeof AMMStateStruct.decode>) => {
            if (vaults_started) return;
            vaults_started = true;
            base_vault_sub_id = global.CONNECTION.onAccountChange(
                state.base_vault,
                (info, context) => {
                    base_vault_balance = decode_token_account(info).amount;
                    base_vault_slot = context.slot;
                    void publish_amm(context.slot).catch(() => {});
                },
                { commitment }
            );
            quote_vault_sub_id = global.CONNECTION.onAccountChange(
                state.quote_vault,
                (info, context) => {
                    quote_vault_balance = decode_token_account(info).amount;
                    quote_vault_slot = context.slot;
                    void publish_amm(context.slot).catch(() => {});
                },
                { commitment }
            );

            const response = await global.CONNECTION.getMultipleAccountsInfoAndContext(
                [state.base_vault, state.quote_vault],
                commitment
            );
            const [base_info, quote_info] = response.value;
            if (base_info && response.context.slot >= base_vault_slot) {
                base_vault_balance = decode_token_account(base_info).amount;
                base_vault_slot = response.context.slot;
            }
            if (quote_info && response.context.slot >= quote_vault_slot) {
                quote_vault_balance = decode_token_account(quote_info).amount;
                quote_vault_slot = response.context.slot;
            }
            await publish_amm(response.context.slot);
        };

        const process_amm_update = async (info: AccountInfo<Uint8Array>, slot: bigint = 0n) => {
            if (stopped || !info?.data || (slot && slot < latest_slot)) return;
            amm_state = AMMStateStruct.decode(info.data);
            await subscribe_amm_accounts(amm_state);
            unsubscribe(amm_state_sub_id);
            amm_state_sub_id = undefined;
        };

        const attach_amm = async (amm: PublicKey) => {
            amm_pool_address = amm.toBase58();
            amm_state_sub_id = global.CONNECTION.onAccountChange(
                amm,
                (info, context) => void process_amm_update(info, context.slot),
                { commitment }
            );
            const response = await global.CONNECTION.getAccountInfoAndContext(amm, commitment);
            if (response.value) await process_amm_update(response.value, response.context.slot);
        };

        const process_bonding_update = async (info: AccountInfo<Uint8Array>, slot: bigint = 0n) => {
            if (stopped || !info?.data || (slot && slot < latest_slot)) return;

            const state = this.decode_state(info.data);
            const quote = await get_quote_info(state.quote_mint);
            const [creator_vault, creator_vault_ata] = await this.calc_creator_vault(
                state.creator,
                state.quote_mint,
                quote.token_program
            );
            const metrics = quote_metrics(
                Number(state.virtual_sol_reserves) / Number(state.virtual_token_reserves),
                state.supply,
                quote.decimals,
                PUMP_TOKEN_DECIMALS
            );
            const amm = state.complete ? await this.calc_amm_from_mint(mint, state.quote_mint) : null;

            if (stopped || switched_to_amm || (slot && slot < latest_slot)) return;

            publish(
                new PumpMintMeta({
                    ...current_mint_meta,
                    market_cap: metrics.mcap_quote,
                    total_supply: state.supply,
                    token_reserves: state.virtual_token_reserves,
                    sol_reserves: state.virtual_sol_reserves,
                    quote_mint: state.quote_mint.toString(),
                    complete: state.complete,
                    fee: PUMP_FEE_PERCENTAGE,
                    amm_pool: current_mint_meta.amm_pool,
                    creator_vault: creator_vault.toString(),
                    creator_vault_ata: creator_vault_ata.toString(),
                    is_mayhem: state.is_mayhem,
                    is_cashback: state.is_cashback
                }),
                slot
            );

            if (state.complete && !switched_to_amm) {
                switched_to_amm = true;
                if (!amm) return;
                unsubscribe(bonding_sub_id);
                bonding_sub_id = undefined;
                void attach_amm(amm);
            }
        };

        const amm_pool = this.get_amm(mint_meta);
        if (amm_pool) {
            switched_to_amm = true;
            await attach_amm(amm_pool);
        } else {
            bonding_sub_id = global.CONNECTION.onAccountChange(
                bonding_curve,
                (info, context) => {
                    void process_bonding_update(info, context.slot).catch(() => {});
                },
                { commitment }
            );
            const response = await global.CONNECTION.getAccountInfoAndContext(bonding_curve, commitment);
            if (response.value) await process_bonding_update(response.value, response.context.slot);
        }

        return () => {
            stopped = true;
            [bonding_sub_id, amm_state_sub_id, base_vault_sub_id, quote_vault_sub_id].forEach(unsubscribe);
        };
    }

    public async estimate_buy_output(
        mint_meta: PumpMintMeta,
        quote_amount: TokenAmount,
        slippage: number
    ): Promise<trade.OutputEstimate> {
        const raw_amount = this.calc_token_amount_raw(BigInt(quote_amount.amount), mint_meta);
        const minimum_raw_amount = trade.apply_slippage_down(raw_amount, slippage);
        return {
            expected: {
                amount: raw_amount.toString(),
                decimals: PUMP_TOKEN_DECIMALS,
                uiAmount: Number(raw_amount) / 10 ** PUMP_TOKEN_DECIMALS
            },
            minimum: {
                amount: minimum_raw_amount.toString(),
                decimals: PUMP_TOKEN_DECIMALS,
                uiAmount: Number(minimum_raw_amount) / 10 ** PUMP_TOKEN_DECIMALS
            }
        };
    }

    public async estimate_sell_output(
        mint_meta: PumpMintMeta,
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

    private get_amm(mint_meta: PumpMintMeta): PublicKey | undefined {
        if (mint_meta.amm_pool !== null) return new PublicKey(mint_meta.amm_pool);
    }

    private calc_token_amount_raw(quote_amount_raw: bigint, meta: Partial<PumpMintMeta>): bigint {
        return this.calc_swap_amounts(quote_amount_raw, meta, 'buy').output_amount;
    }

    private calc_quote_amount_raw(token_amount_raw: bigint, token: Partial<PumpMintMeta>): bigint {
        return this.calc_swap_amounts(token_amount_raw, token, 'sell').output_amount;
    }

    private calc_swap_amounts(amount: bigint, meta: Partial<PumpMintMeta>, op: trade.TradeOp) {
        if (!meta.sol_reserves || !meta.token_reserves || meta.fee === undefined || amount <= 0n)
            return { output_amount: 0n, base_delta: 0n, quote_delta: 0n };
        const fee_rate = BigInt(Math.round(meta.fee * 10000));
        if (op === 'buy') {
            const quote_delta = amount - (amount * fee_rate) / 10000n;
            if (quote_delta <= 0n) return { output_amount: 0n, base_delta: 0n, quote_delta: 0n };
            const output_amount =
                meta.token_reserves -
                (meta.sol_reserves * meta.token_reserves) / (meta.sol_reserves + quote_delta) -
                1n;
            return { output_amount, base_delta: -output_amount, quote_delta };
        }
        const gross_output = (amount * meta.sol_reserves) / (meta.token_reserves + amount);
        return {
            output_amount: gross_output - (gross_output * fee_rate) / 10000n,
            base_delta: amount,
            quote_delta: -gross_output
        };
    }

    private buy_v2_data(sol_amount_raw: bigint, token_amount_raw: bigint, slippage: number): Buffer {
        const instruction_buf = Buffer.from(PUMP_BUY_V2_DISCRIMINATOR);
        const token_amount_buf = Buffer.alloc(8);
        token_amount_buf.writeBigUInt64LE(token_amount_raw, 0);
        const slippage_buf = Buffer.alloc(8);
        slippage_buf.writeBigUInt64LE(trade.apply_slippage_up(sol_amount_raw, slippage), 0);
        return Buffer.concat([instruction_buf, token_amount_buf, slippage_buf]);
    }

    private sell_v2_data(minimum_quote_output: bigint, token_amount_raw: bigint): Buffer {
        const instruction_buf = Buffer.from(PUMP_SELL_V2_DISCRIMINATOR);
        const token_amount_buf = Buffer.alloc(8);
        token_amount_buf.writeBigUInt64LE(token_amount_raw, 0);
        const slippage_buf = Buffer.alloc(8);
        slippage_buf.writeBigUInt64LE(minimum_quote_output, 0);
        return Buffer.concat([instruction_buf, token_amount_buf, slippage_buf]);
    }

    private amm_buy_exact_quote_in_data(sol_amount_raw: bigint, token_amount_raw: bigint, slippage: number): Buffer {
        const instruction_buf = Buffer.from(PUMP_AMM_BUY_EXACT_QUOTE_IN_DISCRIMINATOR);
        const sol_amount_buf = Buffer.alloc(8);
        sol_amount_buf.writeBigUInt64LE(sol_amount_raw, 0);
        const token_amount_buf = Buffer.alloc(8);
        token_amount_buf.writeBigUInt64LE(trade.apply_slippage_down(token_amount_raw, slippage), 0);
        return Buffer.concat([instruction_buf, sol_amount_buf, token_amount_buf, Buffer.from([0])]);
    }

    private amm_buy_exact_out_data(sol_amount_raw: bigint, token_amount_raw: bigint, slippage: number): Buffer {
        const data = Buffer.alloc(25);
        Buffer.from(PUMP_AMM_BUY_EXACT_OUT_DISCRIMINATOR).copy(data);
        data.writeBigUInt64LE(token_amount_raw, 8);
        data.writeBigUInt64LE(trade.apply_slippage_up(sol_amount_raw, slippage), 16);
        return data;
    }

    private amm_sell_data(minimum_quote_output: bigint, token_amount_raw: bigint): Buffer {
        const instruction_buf = Buffer.from(PUMP_SELL_DISCRIMINATOR);
        const token_amount_buf = Buffer.alloc(8);
        token_amount_buf.writeBigUInt64LE(token_amount_raw, 0);
        const slippage_buf = Buffer.alloc(8);
        slippage_buf.writeBigUInt64LE(minimum_quote_output, 0);
        return Buffer.concat([instruction_buf, token_amount_buf, slippage_buf]);
    }

    private async get_buy_instructions(
        amount: TokenAmount,
        buyer: Keypair,
        mint_meta: Partial<PumpMintMeta>,
        slippage: number = 0.05
    ): Promise<TransactionInstruction[]> {
        if (
            !mint_meta.mint ||
            !mint_meta.quote_mint ||
            !mint_meta.base_vault ||
            !mint_meta.quote_vault ||
            !mint_meta.creator_vault ||
            !mint_meta.token_program_id
        )
            throw new Error(`Incomplete mint meta data for buy instructions.`);

        const quote_amount_raw = BigInt(amount.amount);
        const mint = new PublicKey(mint_meta.mint);
        const quote_mint = new PublicKey(mint_meta.quote_mint);
        const token_program = new PublicKey(mint_meta.token_program_id);
        const creator_vault = new PublicKey(mint_meta.creator_vault);
        const user_volume_accumulator = await this.calc_user_volume_accumulator(buyer.publicKey, PUMP_PROGRAM_ID);
        const bonding_curve = new PublicKey(mint_meta.base_vault);
        const assoc_bonding_curve = new PublicKey(mint_meta.quote_vault);

        const token_amount_raw = this.calc_token_amount_raw(quote_amount_raw, mint_meta);
        const instruction_data = this.buy_v2_data(quote_amount_raw, token_amount_raw, slippage);

        const quote = await get_quote_info(quote_mint);

        const fee_recipients = mint_meta.is_mayhem ? MAYHEM_FEE_RECIPIENTS : PUMP_FEE_RECIPIENTS;
        const fee_recipient = fee_recipients[Math.floor(Math.random() * fee_recipients.length)];
        const buyback_fee_recipient =
            PUMP_BUYBACK_FEE_RECIPIENTS[Math.floor(Math.random() * PUMP_BUYBACK_FEE_RECIPIENTS.length)];
        const [
            token_ata,
            quote_ata,
            fee_recipient_ata,
            buyback_fee_recipient_ata,
            quote_bonding_curve_ata,
            creator_vault_ata,
            user_volume_accumulator_ata,
            [sharing_config]
        ] = await Promise.all([
            trade.calc_ata(buyer.publicKey, mint, token_program),
            trade.calc_ata(buyer.publicKey, quote_mint, quote.token_program),
            trade.calc_ata(fee_recipient, quote_mint, quote.token_program),
            trade.calc_ata(buyback_fee_recipient, quote_mint, quote.token_program),
            trade.calc_ata(bonding_curve, quote_mint, quote.token_program),
            trade.calc_ata(creator_vault, quote_mint, quote.token_program),
            trade.calc_ata(user_volume_accumulator, quote_mint, quote.token_program),
            PublicKey.findProgramAddress([PUMP_SHARING_CONFIG_SEED, mint.toBytes()], PUMP_FEE_PROGRAM_ID)
        ]);

        return [
            createAssociatedTokenAccountIdempotentInstruction(buyer, token_ata, buyer.publicKey, mint, token_program),
            new TransactionInstruction({
                keys: [
                    { pubkey: PUMP_GLOBAL_ACCOUNT, isSigner: false, isWritable: false },
                    { pubkey: mint, isSigner: false, isWritable: false },
                    { pubkey: quote_mint, isSigner: false, isWritable: false },
                    { pubkey: token_program, isSigner: false, isWritable: false },
                    { pubkey: quote.token_program, isSigner: false, isWritable: false },
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
        seller: Keypair,
        mint_meta: Partial<PumpMintMeta>,
        slippage: number = 0.05
    ): Promise<trade.SellInstructions> {
        if (
            !mint_meta.mint ||
            !mint_meta.quote_mint ||
            !mint_meta.base_vault ||
            !mint_meta.quote_vault ||
            !mint_meta.creator_vault ||
            !mint_meta.token_program_id
        )
            throw new Error(`Incomplete mint meta data for sell instructions.`);
        if (token_amount.amount === null) throw new Error(`Invalid token amount: ${token_amount.amount}`);

        const mint = new PublicKey(mint_meta.mint);
        const quote_mint = new PublicKey(mint_meta.quote_mint);
        const token_program = new PublicKey(mint_meta.token_program_id);
        const creator_vault = new PublicKey(mint_meta.creator_vault);
        const user_volume_accumulator = await this.calc_user_volume_accumulator(seller.publicKey, PUMP_PROGRAM_ID);
        const bonding_curve = new PublicKey(mint_meta.base_vault);
        const assoc_bonding_curve = new PublicKey(mint_meta.quote_vault);
        const token_amount_raw = BigInt(token_amount.amount);
        const minimum_quote_output = trade.apply_slippage_down(
            this.calc_quote_amount_raw(token_amount_raw, mint_meta),
            slippage
        );
        const instruction_data = this.sell_v2_data(minimum_quote_output, token_amount_raw);

        const quote = await get_quote_info(quote_mint);

        const fee_recipients = mint_meta.is_mayhem ? MAYHEM_FEE_RECIPIENTS : PUMP_FEE_RECIPIENTS;
        const fee_recipient = fee_recipients[Math.floor(Math.random() * fee_recipients.length)];
        const buyback_fee_recipient =
            PUMP_BUYBACK_FEE_RECIPIENTS[Math.floor(Math.random() * PUMP_BUYBACK_FEE_RECIPIENTS.length)];
        const [
            token_ata,
            quote_ata,
            fee_recipient_ata,
            buyback_fee_recipient_ata,
            quote_bonding_curve_ata,
            creator_vault_ata,
            user_volume_accumulator_ata,
            [sharing_config]
        ] = await Promise.all([
            trade.calc_ata(seller.publicKey, mint, token_program),
            trade.calc_ata(seller.publicKey, quote_mint, quote.token_program),
            trade.calc_ata(fee_recipient, quote_mint, quote.token_program),
            trade.calc_ata(buyback_fee_recipient, quote_mint, quote.token_program),
            trade.calc_ata(bonding_curve, quote_mint, quote.token_program),
            trade.calc_ata(creator_vault, quote_mint, quote.token_program),
            trade.calc_ata(user_volume_accumulator, quote_mint, quote.token_program),
            PublicKey.findProgramAddress([PUMP_SHARING_CONFIG_SEED, mint.toBytes()], PUMP_FEE_PROGRAM_ID)
        ]);

        const instructions = [
            new TransactionInstruction({
                keys: [
                    { pubkey: PUMP_GLOBAL_ACCOUNT, isSigner: false, isWritable: false },
                    { pubkey: mint, isSigner: false, isWritable: false },
                    { pubkey: quote_mint, isSigner: false, isWritable: false },
                    { pubkey: token_program, isSigner: false, isWritable: false },
                    { pubkey: quote.token_program, isSigner: false, isWritable: false },
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
        return {
            instructions,
            minimum_quote_output: { amount: minimum_quote_output.toString(), decimals: quote.decimals, uiAmount: null }
        };
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

        const creator_buf = creator.toBytes();

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
        creator: Keypair,
        token_name: string,
        token_symbol: string,
        meta_cid: string,
        mint: Keypair,
        mayhem_mode: boolean = false,
        cashback_mode: boolean = false,
        version: 'v1' | 'v2' = 'v2',
        quote_mint: PublicKey = SOL_MINT
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
        const [bonding, assoc_ata] = await this.calc_bonding_curve(mint.publicKey, token_program);
        const quote = await get_quote_info(quote_mint);
        const [quote_control, quote_vault] = await Promise.all([
            this.calc_quote_control(),
            trade.calc_ata(bonding, quote_mint, quote.token_program)
        ]);
        if (!quote_mint.equals(SOL_MINT) && (version === 'v1' || mayhem_mode))
            throw new Error('Non-SOL Pump creation requires v2 without mayhem.');

        let create_instructions: TransactionInstruction;
        if (version === 'v2') {
            const [mayhem_state, mayhem_token_vault] = await this.calc_mayhem_state(mint.publicKey);
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
                    { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
                    ...(!quote_mint.equals(SOL_MINT)
                        ? [
                              { pubkey: quote_mint, isSigner: false, isWritable: false },
                              { pubkey: quote_vault, isSigner: false, isWritable: true },
                              { pubkey: quote.token_program, isSigner: false, isWritable: false },
                              { pubkey: quote_control, isSigner: false, isWritable: false }
                          ]
                        : [])
                ],
                programId: PUMP_PROGRAM_ID,
                data: instruction_data
            });
        } else {
            const [metaplex] = await PublicKey.findProgramAddress(
                [METAPLEX_META_SEED, METAPLEX_PROGRAM_ID.toBytes(), mint.publicKey.toBytes()],
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

    private async calc_bonding_curve(mint: PublicKey, token_program: PublicKey): Promise<[PublicKey, PublicKey]> {
        if (!token_program.equals(TOKEN_2022_PROGRAM_ID) && !token_program.equals(TOKEN_PROGRAM_ID)) {
            throw new Error(`Invalid token program: ${token_program.toString()}`);
        }
        const [bonding_curve] = await PublicKey.findProgramAddress(
            [PUMP_BONDING_SEED, mint.toBytes()],
            PUMP_PROGRAM_ID
        );
        const [bonding_curve_ata] = await PublicKey.findProgramAddress(
            [bonding_curve.toBytes(), token_program.toBytes(), mint.toBytes()],
            ASSOCIATED_TOKEN_PROGRAM_ID
        );
        return [bonding_curve, bonding_curve_ata];
    }

    private async get_initial_quote_reserves(quote_mint: PublicKey) {
        const control = await this.calc_quote_control();
        const [global_info, control_info] = await global.CONNECTION.getMultipleAccountsInfo(
            [PUMP_GLOBAL_ACCOUNT, control],
            COMMITMENT
        );
        if (!global_info?.owner.equals(PUMP_PROGRAM_ID)) throw new Error('Invalid Pump global account');
        const data = Buffer.from(global_info.data);
        if (data.length < 1045 || !data.subarray(0, 8).equals(Buffer.from(PUMP_GLOBAL_HEADER)))
            throw new Error('Invalid Pump global layout');
        let quote_reserves: bigint | undefined;
        if (quote_mint.equals(SOL_MINT)) quote_reserves = data.readBigUInt64LE(81);
        else if (new PublicKey(data.subarray(1013, 1045)).equals(quote_mint))
            quote_reserves = data.readBigUInt64LE(1005);
        else {
            if (!control_info?.owner.equals(PUMP_PROGRAM_ID)) throw new Error('Invalid Pump quote control');
            const quotes = Buffer.from(control_info.data);
            if (quotes.length < 108 || !quotes.subarray(0, 8).equals(Buffer.from(PUMP_QUOTE_CONTROL_HEADER)))
                throw new Error('Invalid Pump quote control layout');
            const count = quotes.readUInt32LE(104);
            if (108 + count * 40 > quotes.length) throw new Error('Truncated Pump quote control');
            for (let index = 0; index < count; index++) {
                const offset = 108 + index * 40;
                if (new PublicKey(quotes.subarray(offset, offset + 32)).equals(quote_mint)) {
                    quote_reserves = quotes.readBigUInt64LE(offset + 32);
                    break;
                }
            }
        }
        if (!quote_reserves) throw new Error(`Pump does not allow quote mint ${quote_mint}`);
        return { quote_reserves, token_reserves: data.readBigUInt64LE(73), supply: data.readBigUInt64LE(97) };
    }

    private async calc_quote_control(): Promise<PublicKey> {
        const [control] = await PublicKey.findProgramAddress([Buffer.from('quote-control')], PUMP_PROGRAM_ID);
        return control;
    }

    private async calc_mayhem_state(mint: PublicKey): Promise<[PublicKey, PublicKey]> {
        const [state] = await PublicKey.findProgramAddress([MAYHEM_STATE_SEED, mint.toBytes()], MAYHEM_PROGRAM_ID);
        const [token_vault] = await PublicKey.findProgramAddress(
            [MAYHEM_SOL_VAULT.toBytes(), TOKEN_2022_PROGRAM_ID.toBytes(), mint.toBytes()],
            ASSOCIATED_TOKEN_PROGRAM_ID
        );
        return [state, token_vault];
    }

    private async calc_pool_v2(mint: PublicKey): Promise<PublicKey> {
        const [pool] = await PublicKey.findProgramAddress([PUMP_AMM_POOL_SEED_2, mint.toBytes()], PUMP_AMM_PROGRAM_ID);
        return pool;
    }

    private async calc_creator_vault(
        creator: PublicKey,
        quote_mint: PublicKey = SOL_MINT,
        token_program: PublicKey = TOKEN_PROGRAM_ID
    ): Promise<[PublicKey, PublicKey]> {
        const [creator_vault] = await PublicKey.findProgramAddress(
            [PUMP_CREATOR_VAULT_SEED, creator.toBytes()],
            PUMP_PROGRAM_ID
        );
        const creator_vault_ata = await trade.calc_ata(creator_vault, quote_mint, token_program);
        return [creator_vault, creator_vault_ata];
    }

    private async calc_amm_creator_vault(
        creator: PublicKey,
        quote_mint: PublicKey = SOL_MINT,
        token_program: PublicKey = TOKEN_PROGRAM_ID
    ): Promise<[PublicKey, PublicKey]> {
        const [creator_vault] = await PublicKey.findProgramAddress(
            [PUMP_AMM_CREATOR_VAULT_SEED, creator.toBytes()],
            PUMP_AMM_PROGRAM_ID
        );
        const creator_vault_ata = await trade.calc_ata(creator_vault, quote_mint, token_program);
        return [creator_vault, creator_vault_ata];
    }

    private async calc_user_volume_accumulator(user: PublicKey, program: PublicKey): Promise<PublicKey> {
        const [user_volume_accumulator] = await PublicKey.findProgramAddress(
            [PUMP_USER_VOLUME_ACCUMULATOR_SEED, user.toBytes()],
            program
        );
        return user_volume_accumulator;
    }

    private decode_state(data: Uint8Array): State {
        const input =
            data.byteLength === StateStruct.get_offset('quote_mint') ? Buffer.concat([data, SOL_MINT.toBytes()]) : data;
        const state = StateStruct.decode(input);
        if (state.quote_mint.equals(PublicKey.default)) state.quote_mint = SOL_MINT;
        return state;
    }

    private async get_state(bond_curve_addr: PublicKey): Promise<State | null> {
        const info = await global.CONNECTION.getAccountInfo(bond_curve_addr, COMMITMENT);
        return info ? this.decode_state(info.data) : null;
    }

    async get_amm_state(amm: PublicKey): Promise<AMMState> {
        const info = await global.CONNECTION.getAccountInfo(amm, COMMITMENT);
        if (!info || !info.data) throw new Error('Unexpected AMM state');
        return this.get_amm_state_from_data(info.data);
    }

    private async get_amm_state_from_data(data: Uint8Array): Promise<AMMState> {
        const state = AMMStateStruct.decode(data);
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

    private async calc_amm_from_mint(mint: PublicKey, quote_mint: PublicKey = SOL_MINT): Promise<PublicKey> {
        const [creator] = await PublicKey.findProgramAddress(
            [PUMP_POOL_AUTHORITY_SEED, mint.toBytes()],
            PUMP_PROGRAM_ID
        );
        const [amm] = await PublicKey.findProgramAddress(
            [PUMP_AMM_POOL_SEED, new Uint8Array([0, 0]), creator.toBytes(), mint.toBytes(), quote_mint.toBytes()],
            PUMP_AMM_PROGRAM_ID
        );
        return amm;
    }

    private async get_buy_amm_instructions(
        amount: TokenAmount,
        buyer: Keypair,
        mint_meta: Partial<PumpMintMeta>,
        slippage: number = 0.05,
        exact_out_amount?: bigint
    ): Promise<TransactionInstruction[]> {
        if (
            !mint_meta.mint ||
            !mint_meta.quote_mint ||
            !mint_meta.amm_pool ||
            !mint_meta.base_vault ||
            !mint_meta.quote_vault ||
            !mint_meta.creator_vault ||
            !mint_meta.creator_vault_ata ||
            !mint_meta.token_program_id
        )
            throw new Error(`Incomplete mint meta data for buy instructions.`);

        const quote_amount_raw = BigInt(amount.amount);
        const mint = new PublicKey(mint_meta.mint);
        const quote_mint = new PublicKey(mint_meta.quote_mint);
        const token_program = new PublicKey(mint_meta.token_program_id);
        const amm = new PublicKey(mint_meta.amm_pool);
        const quote = await prepare_quote_account(
            buyer,
            quote_mint,
            exact_out_amount === undefined ? quote_amount_raw : trade.apply_slippage_up(quote_amount_raw, slippage)
        );
        const creator_vault = new PublicKey(mint_meta.creator_vault);
        const creator_vault_ata = await trade.calc_ata(creator_vault, quote_mint, quote.token_program);
        const user_volume_accumulator = await this.calc_user_volume_accumulator(buyer.publicKey, PUMP_AMM_PROGRAM_ID);
        const bonding_curve = new PublicKey(mint_meta.base_vault);
        const assoc_bonding_curve = new PublicKey(mint_meta.quote_vault);

        const token_amount_raw = exact_out_amount ?? this.calc_token_amount_raw(quote_amount_raw, mint_meta);
        const instruction_data =
            exact_out_amount === undefined
                ? this.amm_buy_exact_quote_in_data(quote_amount_raw, token_amount_raw, slippage)
                : this.amm_buy_exact_out_data(quote_amount_raw, token_amount_raw, slippage);
        const token_ata = await trade.calc_ata(buyer.publicKey, mint, token_program);
        const quote_ata = quote.ata;
        const quote_user_accumulator_ata = await trade.calc_ata(
            user_volume_accumulator,
            quote_mint,
            quote.token_program
        );
        const pool_v2 = await this.calc_pool_v2(mint);
        const fee_recipients = mint_meta.is_mayhem ? MAYHEM_FEE_RECIPIENTS : PUMP_FEE_RECIPIENTS;
        const fee_recipient = fee_recipients[Math.floor(Math.random() * fee_recipients.length)];
        const fee_recipient_ata = await trade.calc_ata(fee_recipient, quote_mint, quote.token_program);
        const buyback_fee_recipient =
            PUMP_BUYBACK_FEE_RECIPIENTS[Math.floor(Math.random() * PUMP_BUYBACK_FEE_RECIPIENTS.length)];
        const buyback_fee_recipient_ata = await trade.calc_ata(buyback_fee_recipient, quote_mint, quote.token_program);

        return [
            createAssociatedTokenAccountIdempotentInstruction(buyer, token_ata, buyer.publicKey, mint, token_program),
            ...quote.setup,
            new TransactionInstruction({
                keys: [
                    { pubkey: amm, isSigner: false, isWritable: true },
                    { pubkey: buyer.publicKey, isSigner: true, isWritable: true },
                    { pubkey: PUMP_AMM_GLOBAL_ACCOUNT, isSigner: false, isWritable: false },
                    { pubkey: mint, isSigner: false, isWritable: false },
                    { pubkey: quote_mint, isSigner: false, isWritable: false },
                    { pubkey: token_ata, isSigner: false, isWritable: true },
                    { pubkey: quote_ata, isSigner: false, isWritable: true },
                    { pubkey: bonding_curve, isSigner: false, isWritable: true },
                    { pubkey: assoc_bonding_curve, isSigner: false, isWritable: true },
                    { pubkey: fee_recipient, isSigner: false, isWritable: false },
                    { pubkey: fee_recipient_ata, isSigner: false, isWritable: true },
                    { pubkey: token_program, isSigner: false, isWritable: false },
                    { pubkey: quote.token_program, isSigner: false, isWritable: false },
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
                        ? [{ pubkey: quote_user_accumulator_ata, isSigner: false, isWritable: true }]
                        : []),
                    { pubkey: pool_v2, isSigner: false, isWritable: false },
                    { pubkey: buyback_fee_recipient, isSigner: false, isWritable: true },
                    { pubkey: buyback_fee_recipient_ata, isSigner: false, isWritable: true }
                ],
                programId: PUMP_AMM_PROGRAM_ID,
                data: instruction_data
            }),
            ...quote.cleanup
        ];
    }

    private async get_sell_amm_instructions(
        token_amount: TokenAmount,
        seller: Keypair,
        mint_meta: Partial<PumpMintMeta>,
        slippage: number = 0.05
    ): Promise<trade.SellInstructions> {
        if (
            !mint_meta.mint ||
            !mint_meta.quote_mint ||
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
        const quote_mint = new PublicKey(mint_meta.quote_mint);
        const token_program = new PublicKey(mint_meta.token_program_id);
        const amm = new PublicKey(mint_meta.amm_pool);
        const quote = await prepare_quote_account(seller, quote_mint);
        const creator_vault = new PublicKey(mint_meta.creator_vault);
        const creator_vault_ata = await trade.calc_ata(creator_vault, quote_mint, quote.token_program);
        const user_volume_accumulator = await this.calc_user_volume_accumulator(seller.publicKey, PUMP_AMM_PROGRAM_ID);
        const bonding_curve = new PublicKey(mint_meta.base_vault);
        const assoc_bonding_curve = new PublicKey(mint_meta.quote_vault);
        const token_amount_raw = BigInt(token_amount.amount);

        const minimum_quote_output = trade.apply_slippage_down(
            this.calc_quote_amount_raw(token_amount_raw, mint_meta),
            slippage
        );
        const instruction_data = this.amm_sell_data(minimum_quote_output, token_amount_raw);
        const token_ata = await trade.calc_ata(seller.publicKey, mint, token_program);
        const quote_ata = quote.ata;
        const quote_user_accumulator_ata = await trade.calc_ata(
            user_volume_accumulator,
            quote_mint,
            quote.token_program
        );
        const pool_v2 = await this.calc_pool_v2(mint);
        const fee_recipients = mint_meta.is_mayhem ? MAYHEM_FEE_RECIPIENTS : PUMP_FEE_RECIPIENTS;
        const fee_recipient = fee_recipients[Math.floor(Math.random() * fee_recipients.length)];
        const fee_recipient_ata = await trade.calc_ata(fee_recipient, quote_mint, quote.token_program);
        const buyback_fee_recipient =
            PUMP_BUYBACK_FEE_RECIPIENTS[Math.floor(Math.random() * PUMP_BUYBACK_FEE_RECIPIENTS.length)];
        const buyback_fee_recipient_ata = await trade.calc_ata(buyback_fee_recipient, quote_mint, quote.token_program);

        const instructions = [
            ...quote.setup,
            new TransactionInstruction({
                keys: [
                    { pubkey: amm, isSigner: false, isWritable: true },
                    { pubkey: seller.publicKey, isSigner: true, isWritable: true },
                    { pubkey: PUMP_AMM_GLOBAL_ACCOUNT, isSigner: false, isWritable: false },
                    { pubkey: mint, isSigner: false, isWritable: false },
                    { pubkey: quote_mint, isSigner: false, isWritable: false },
                    { pubkey: token_ata, isSigner: false, isWritable: true },
                    { pubkey: quote_ata, isSigner: false, isWritable: true },
                    { pubkey: bonding_curve, isSigner: false, isWritable: true },
                    { pubkey: assoc_bonding_curve, isSigner: false, isWritable: true },
                    { pubkey: fee_recipient, isSigner: false, isWritable: false },
                    { pubkey: fee_recipient_ata, isSigner: false, isWritable: true },
                    { pubkey: token_program, isSigner: false, isWritable: false },
                    { pubkey: quote.token_program, isSigner: false, isWritable: false },
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
                              { pubkey: quote_user_accumulator_ata, isSigner: false, isWritable: true },
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
            ...quote.cleanup
        ];
        return {
            instructions,
            minimum_quote_output: { amount: minimum_quote_output.toString(), decimals: quote.decimals, uiAmount: null }
        };
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
        const offset = Math.floor(Math.random() * 20) * limit;

        try {
            const url = new URL(`${PUMP_API_URL}/coins`);
            url.searchParams.set('offset', String(offset));
            url.searchParams.set('limit', String(limit));
            url.searchParams.set('sort', 'last_trade_timestamp');
            url.searchParams.set('order', 'DESC');
            url.searchParams.set('includeNsfw', 'false');
            const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
            const data = await response.json();
            if (!response.ok || !Array.isArray(data)) return [];
            return trade.resolve_random_mints(
                data.map((item: { mint: string }) => item.mint),
                count,
                async (mint) => {
                    const meta = await this.get_mint_meta(mint);
                    return meta && !meta.migrated ? meta : undefined;
                }
            );
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
                                    Buffer.from(acc.account.data),
                                    AMMStateStruct.get_offset('lp_supply') - AMMStateStruct.get_offset('base_mint'),
                                    8
                                ) < 4000000000000n
                            )
                                continue;
                            this.graduated_mints_cache.push(new PublicKey(acc.account.data.subarray(0, 32)));
                        }
                    }
                }
            } catch (error) {
                this.graduated_mints_cache = null;
                return [];
            }
        }

        return trade.resolve_random_mints(
            this.graduated_mints_cache.map((mint) => mint.toBase58()),
            count,
            async (mint) => {
                const meta = await this.get_mint_meta(mint);
                return meta?.migrated ? meta : undefined;
            }
        );
    }
}
