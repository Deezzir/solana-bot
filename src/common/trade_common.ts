import {
    Keypair,
    Connection,
    SendTransactionError,
    LAMPORTS_PER_SOL,
    PublicKey,
    Blockhash,
    V1TransactionConfig,
    SystemProgram,
    TokenAmount,
    TransactionInstruction,
    VersionedTransaction,
    TransactionMessage,
    ComputeBudgetProgram,
    Commitment,
    Finality,
    AddressLookupTableAccount,
    AddressLookupTableProgram,
    ParsedTransactionWithMeta,
    ParsedInstruction,
    PartiallyDecodedInstruction
} from '@solana/web3.js';
import {
    decode_token_account,
    decode_mint_account,
    createSyncNativeInstruction,
    TOKEN_2022_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    createAssociatedTokenAccountIdempotentInstruction,
    createBurnInstruction,
    createCloseAccountInstruction,
    createTransferInstruction,
    getAssociatedTokenAddress,
    getMint
} from './token';
import {
    COMMITMENT,
    JITO_ENDPOINTS,
    PriorityLevel,
    TRADE_DEFAULT_TOKEN_DECIMALS,
    TRADE_MAX_WALLETS_PER_CREATE_BUNDLE,
    TRADE_MAX_WALLETS_PER_CREATE_TX,
    TRADE_MAX_SLIPPAGE,
    TRADE_TX_RETRIES,
    TRADE_RETRY_INTERVAL_MS,
    JITO_TIP_ACCOUNTS,
    JITO_BUNDLE_SIZE,
    TRADE_RETRIES,
    JITO_BUNDLE_INTERVAL_MS,
    JITO_MIN_TIP,
    SOL_MINT,
    SENDER_ENDPOINTS,
    SENDER_TIP_ACCOUNTS,
    SYSTEM_PROGRAM_ID,
    COMPUTE_BUDGET_PROGRAM_ID,
    PRIORITY_FEE_TTL_MS,
    CACHE_SIZE_MAX,
    ACCOUNT_READ_CACHE_TTL_MS,
    HELIUS_RPC,
    SENDER_ENDPOINT,
    SENDER_INTERVAL_MS,
    SENDER_MAX_BUNDLE_SIZE,
    SENDER_MAX_MIN_PRIORITY_FEE,
    SENDER_MAX_MIN_TIP,
    TransactionRelay,
    MAX_COMPUTE_UNIT_LIMIT,
    MAX_TRANSACTION_SIGNATURES,
    MAX_TRANSACTION_ACCOUNTS,
    MAX_TRANSACTION_INSTRUCTIONS,
    MAX_LOADED_ACCOUNTS_DATA_SIZE_BYTES,
    LOADED_ACCOUNTS_DATA_PAGE_SIZE_BYTES,
    COMPUTE_UNIT_BUFFER,
    COST_BASIS_TRANSACTION_PAGE_SIZE
} from '../constants';
import * as common from './common';
import bs58 from 'bs58';
import { rate_limit_request } from './rate_limit';
import { get_quote_by_mint } from '../quote';

// Types and interfaces

type TransactionContext = Awaited<ReturnType<Connection['getLatestBlockhashAndContext']>>;
type TransactionOptions = {
    tip_account?: PublicKey;
};

type StringPublicKeys<T> = T extends PublicKey
    ? string
    : T extends bigint
      ? number | bigint
      : T extends object
        ? { [K in keyof T]: StringPublicKeys<T[K]> }
        : T;

export type RawParsedTransaction = StringPublicKeys<ParsedTransactionWithMeta>;
type RawInstruction = RawParsedTransaction['transaction']['message']['instructions'][number];

export type SerializedMintMeta = {
    token_quote_mc: number;
    mint_pubkey: string;
    token_program: string;
    migrated: boolean;
    platform_fee: number;
    token_name: string;
    token_symbol: string;
    token_mint: string;
    [key: string]: unknown;
};

type HeliusRpcResponse<T> = {
    result?: T;
    error?: { code: number; message: string; data?: unknown };
};

type HeliusAsset = {
    token_info?: {
        decimals?: number;
        supply?: number;
        token_program?: string;
        price_info?: { price_per_token?: number };
    };
    content?: { metadata: { name: string; symbol: string } };
    creators?: { address: string }[];
};

export type ProgramAccount = { pubkey: PublicKey; account: { data: Uint8Array } };
type HeliusProgramAccountsPage = {
    accounts: { pubkey: string; account: { data: [string, string] } }[];
    paginationKey: string | null;
};

type HeliusTransactionsForAddressPage = {
    data: RawParsedTransaction[];
    paginationToken: string | null;
};

export interface IMintMeta {
    readonly token_name: string;
    readonly token_symbol: string;
    readonly token_mint: string;
    readonly token_quote_mc: number;
    readonly migrated: boolean;
    readonly platform_fee: number;
    readonly mint_pubkey: PublicKey;
    readonly quote_mint_pubkey: PublicKey;
    readonly token_program: PublicKey;

    serialize(): SerializedMintMeta;
}

export interface ClaimableAsset {
    mint: PublicKey;
    raw_amount: bigint;
    decimals: number;
    source: 'creator_reward' | 'position_reward' | 'cashback_reward' | 'token_incentive_reward';
}

export type TradeOp = 'buy' | 'sell';

export type OutputEstimate = {
    expected: TokenAmount;
    minimum: TokenAmount;
};

export interface IProgramTrader {
    get_name(): string;
    get_lta_addresses(): PublicKey[];
    deserialize_mint_meta(data: SerializedMintMeta): IMintMeta;
    buy_token_instructions(
        quote_amount: TokenAmount,
        buyer: Keypair,
        mint_meta: IMintMeta,
        slippage: number
    ): Promise<[TransactionInstruction[], AddressLookupTableAccount[]?]>;
    sell_token_instructions(
        token_amount: TokenAmount,
        seller: Keypair,
        mint_meta: IMintMeta,
        slippage: number
    ): Promise<[TransactionInstruction[], AddressLookupTableAccount[]?]>;
    buy_sell_instructions(
        quote_amount: TokenAmount,
        trader: Keypair,
        mint_meta: IMintMeta,
        slippage: number
    ): Promise<[TransactionInstruction[], TransactionInstruction[], AddressLookupTableAccount[]?]>;
    create_token_instructions(
        mint: Keypair,
        creator: Keypair,
        token_name: string,
        token_symbol: string,
        meta_cid: string,
        config?: object,
        creator_buy?: boolean
    ): Promise<CreateTokenInstructions>;
    create_token_metadata(meta: common.IPFSMetadata, image_path: string): Promise<string>;
    get_random_mints(count: number): Promise<IMintMeta[]>;
    get_mint_meta(mint: PublicKey): Promise<IMintMeta | undefined>;
    update_mint_meta(mint_meta: IMintMeta): Promise<IMintMeta>;
    subscribe_mint_meta(
        mint_meta: IMintMeta,
        callback: (mint_meta: IMintMeta) => void,
        commitment?: Commitment
    ): Promise<() => void>;
    update_mint_meta_reserves(mint_meta: IMintMeta, amount: TokenAmount, op: TradeOp): IMintMeta;
    default_mint_meta(mint: PublicKey, data?: object): Promise<IMintMeta>;
    get_rewards(trader: Keypair): Promise<ClaimableAsset[]>;
    claim_rewards_instructions(trader: Keypair, assets: ClaimableAsset[]): Promise<TransactionInstruction[]>;
    estimate_buy_output(mint_meta: IMintMeta, quote_amount: TokenAmount, slippage: number): Promise<OutputEstimate>;
    estimate_sell_output(mint_meta: IMintMeta, token_amount: TokenAmount, slippage: number): Promise<OutputEstimate>;
    get_compute_unit_limit(): number | undefined;
}

type PriorityOptions = {
    accounts?: string[];
    transaction?: {
        instructions: TransactionInstruction[];
        signers: Keypair[];
        alts?: AddressLookupTableAccount[];
    };
    priority_level?: PriorityLevel;
};

export type MintAsset = {
    token_name: string;
    token_symbol: string;
    token_decimal: number;
    token_supply: number;
    price_per_token: number;
    mint: PublicKey;
    creator?: PublicKey;
    token_program: PublicKey;
};

export type TokenMetrics = {
    price_quote: number;
    mcap_quote: number;
};

export type TxBalanceChanges = {
    pre_sol_balance: number;
    post_sol_balance: number;
    pre_token_balance: number;
    post_token_balance: number;
    change_sol: number;
    change_tokens: number;
    fees: number;
};

type CostBasis = {
    average_cost_basis: number;
    total_spendings: number;
    total_tokens: number;
    total_fees: number;
};

type JitoBundleSubmission = {
    bundle_id: string;
    endpoint: string;
};

type JitoBundleStatus = 'Invalid' | 'Pending' | 'Failed' | 'Landed';

export type CreateTokenInstructions = {
    instructions: TransactionInstruction[];
    mint_meta: IMintMeta;
    ltas: AddressLookupTableAccount[];
};

// Transaction errors

class RelayRejectionError extends Error {}

export class TransactionSubmissionError extends Error {
    readonly signatures: readonly string[];
    constructor(
        signatures: string | readonly string[],
        cause: unknown,
        readonly outcome: 'unknown' | 'rejected' | 'failed' = 'unknown'
    ) {
        const values = typeof signatures === 'string' ? [signatures] : [...signatures];
        super(`Transaction outcome ${outcome}; signatures ${values.join(', ')}: ${cause}`, { cause });
        this.signatures = values;
        this.name = 'TransactionSubmissionError';
    }
}

class TransactionSimulationError extends Error {
    constructor(readonly transaction_error: unknown) {
        super(`Transaction simulation failed: ${JSON.stringify(transaction_error, common.json_bigint)}`);
        this.name = 'TransactionSimulationError';
    }
}

export class CompileTransactionError extends Error {}

// RPC requests and transaction decoding

function deserialize_instruction(instruction: RawInstruction): ParsedInstruction | PartiallyDecodedInstruction {
    if ('accounts' in instruction) {
        return {
            ...instruction,
            programId: new PublicKey(instruction.programId),
            accounts: instruction.accounts.map((account) => new PublicKey(account))
        };
    }
    return { ...instruction, programId: new PublicKey(instruction.programId) };
}

export function deserialize_parsed_transaction(raw: RawParsedTransaction): ParsedTransactionWithMeta {
    const transaction = raw.transaction;
    const meta = raw.meta;
    const config = transaction.message.transactionConfig;
    const priority_fee = config && 'priorityFee' in config ? config.priorityFee : config?.priorityFeeLamports;
    if (priority_fee != null && typeof priority_fee !== 'number' && typeof priority_fee !== 'bigint')
        throw new Error('Invalid transaction priority fee.');

    return {
        slot: common.rpc_bigint(raw.slot),
        blockTime: raw.blockTime == null ? raw.blockTime : common.rpc_bigint(raw.blockTime),
        version: raw.version,
        transaction: {
            signatures: transaction.signatures,
            message: {
                ...transaction.message,
                transactionConfig: config
                    ? {
                          computeUnitLimit: config.computeUnitLimit ?? undefined,
                          loadedAccountsDataSizeLimit: config.loadedAccountsDataSizeLimit ?? undefined,
                          heapSize: config.heapSize ?? undefined,
                          priorityFeeLamports: priority_fee == null ? undefined : common.rpc_bigint(priority_fee)
                      }
                    : undefined,
                accountKeys: transaction.message.accountKeys.map((account) => ({
                    ...account,
                    pubkey: new PublicKey(account.pubkey)
                })),
                instructions: transaction.message.instructions.map(deserialize_instruction),
                addressTableLookups: transaction.message.addressTableLookups?.map((lookup) => ({
                    ...lookup,
                    accountKey: new PublicKey(lookup.accountKey)
                }))
            }
        },
        meta: meta
            ? {
                  ...meta,
                  fee: common.rpc_bigint(meta.fee),
                  preBalances: meta.preBalances.map(common.rpc_bigint),
                  postBalances: meta.postBalances.map(common.rpc_bigint),
                  computeUnitsConsumed:
                      meta.computeUnitsConsumed === undefined
                          ? undefined
                          : common.rpc_bigint(meta.computeUnitsConsumed),
                  costUnits: meta.costUnits === undefined ? undefined : common.rpc_bigint(meta.costUnits),
                  innerInstructions: meta.innerInstructions?.map((group) => ({
                      ...group,
                      instructions: group.instructions.map(deserialize_instruction)
                  })),
                  loadedAddresses: meta.loadedAddresses
                      ? {
                            writable: meta.loadedAddresses.writable.map((address) => new PublicKey(address)),
                            readonly: meta.loadedAddresses.readonly.map((address) => new PublicKey(address))
                        }
                      : undefined
              }
            : null
    };
}

async function helius_rpc<T>(method: string, params: unknown[]): Promise<T> {
    const response = await rate_limit_request(() =>
        fetch(HELIUS_RPC, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
        })
    );
    const payload = (await response.json()) as HeliusRpcResponse<T>;
    if (!response.ok || payload.error) throw new Error(payload.error?.message || `Helius ${method} request failed.`);
    if (payload.result === undefined) throw new Error(`Helius ${method} returned no result.`);
    return payload.result;
}

export async function get_program_accounts_v2(
    program_id: PublicKey,
    filters: { memcmp: { offset: number; bytes: string } }[],
    data_slice?: { offset: number; length: number },
    max_accounts: number = Infinity
): Promise<ProgramAccount[]> {
    const accounts: ProgramAccount[] = [];
    let pagination_key: string | null = null;
    do {
        const options = {
            encoding: 'base64',
            commitment: COMMITMENT,
            limit: Math.min(1000, max_accounts - accounts.length),
            filters,
            dataSlice: data_slice
        };
        if (pagination_key !== null) Object.assign(options, { paginationKey: pagination_key });
        const page: HeliusProgramAccountsPage = await helius_rpc<HeliusProgramAccountsPage>('getProgramAccountsV2', [
            program_id.toBase58(),
            options
        ]);
        accounts.push(
            ...page.accounts.map(({ pubkey, account }) => ({
                pubkey: new PublicKey(pubkey),
                account: { data: Buffer.from(account.data[0], 'base64') }
            }))
        );
        pagination_key = page.paginationKey;
    } while (pagination_key && accounts.length < max_accounts);
    return accounts.slice(0, max_accounts);
}

// Mint discovery

export async function resolve_random_mints<T extends IMintMeta>(
    candidates: string[],
    count: number,
    get_meta: (mint: PublicKey) => Promise<T | undefined>
): Promise<T[]> {
    if (!Number.isSafeInteger(count) || count <= 0) return [];
    const unique = [...new Set(candidates)].filter(
        (mint) => mint !== SOL_MINT.toBase58() && common.is_valid_pubkey(mint)
    );
    const result: T[] = [];
    while (unique.length && result.length < count) {
        const batch: string[] = [];
        const batch_size = Math.min(5, count - result.length, unique.length);
        for (let i = 0; i < batch_size; i++) {
            const index = Math.floor(Math.random() * unique.length);
            batch.push(unique[index]);
            unique[index] = unique[unique.length - 1];
            unique.pop();
        }
        const metadata = await Promise.all(batch.map((mint) => get_meta(new PublicKey(mint)).catch(() => undefined)));
        for (const meta of metadata) if (meta) result.push(meta);
    }
    return result.slice(0, count);
}

export async function sample_mint_sources<T extends IMintMeta>(
    count: number,
    graduated: (count: number) => Promise<T[]>,
    ungraduated: (count: number) => Promise<T[]>
): Promise<T[]> {
    if (!Number.isSafeInteger(count) || count <= 0) return [];
    const graduated_count = Math.floor((count + 1) * Math.random());
    return (await Promise.all([graduated(graduated_count), ungraduated(count - graduated_count)])).flat();
}

// Trade validation and amount calculations

function validate_trade_amount(amount: TokenAmount | number, allow_zero: boolean): void {
    if (typeof amount === 'number') {
        const raw_amount = sol_to_lamports(amount);
        if (!allow_zero && raw_amount === 0n) throw new RangeError('Buy amount must be positive.');
    } else {
        if (!/^\d+$/.test(amount.amount)) throw new RangeError('Token amount must be an unsigned integer.');
        const raw_amount = BigInt(amount.amount);
        if (!allow_zero && raw_amount === 0n) throw new RangeError('Token amount must be positive.');
        if (raw_amount < 0n || raw_amount > 18_446_744_073_709_551_615n)
            throw new RangeError('Token amount must be a positive u64 integer.');
        if (!Number.isInteger(amount.decimals) || amount.decimals < 0 || amount.decimals > 255)
            throw new RangeError('Token decimals must be an integer between 0 and 255.');
    }
}

export function validate_create_token_parameters(
    amount: TokenAmount | number,
    traders?: [Keypair, TokenAmount | number][],
    bundle_tip?: number
): void {
    if ((traders !== undefined) !== (bundle_tip !== undefined))
        throw new Error('Traders and bundle tip must be set together.');
    const max_wallets = Math.min(
        TRADE_MAX_WALLETS_PER_CREATE_BUNDLE,
        (get_bundle_size() - 1) * TRADE_MAX_WALLETS_PER_CREATE_TX
    );
    if (traders && (traders.length < 1 || traders.length > max_wallets))
        throw new Error(`Initial buyer count must be between 1 and ${max_wallets}.`);
    validate_trade_amount(amount, true);
    if (bundle_tip !== undefined && sol_to_lamports(bundle_tip) === 0n) throw new Error('Bundle tip must be positive.');
    for (const [, amount] of traders ?? []) validate_trade_amount(amount, false);
}

export function validate_trade_parameters(amount: number | TokenAmount, slippage: number): void {
    validate_slippage(slippage);
    validate_trade_amount(amount, false);
}

function validate_slippage(slippage: number): void {
    if (!Number.isFinite(slippage) || slippage <= 0 || slippage >= TRADE_MAX_SLIPPAGE)
        throw new RangeError(`Slippage must be greater than 0 and less than ${TRADE_MAX_SLIPPAGE}.`);
}

export function apply_slippage_up(amount: bigint, slippage: number): bigint {
    return amount + (amount * BigInt(Math.floor(slippage * 10000))) / 10000n;
}

export function apply_slippage_down(amount: bigint, slippage: number): bigint {
    return amount - (amount * BigInt(Math.floor(slippage * 10000))) / 10000n;
}

export function sol_to_lamports(amount: number): bigint {
    const lamports = Math.floor(amount * LAMPORTS_PER_SOL);
    if (amount < 0 || !Number.isSafeInteger(lamports) || (amount > 0 && lamports === 0))
        throw new RangeError('Invalid SOL amount.');
    return BigInt(lamports);
}

export function lamports_to_sol(amount: bigint): number {
    return Number(amount) / LAMPORTS_PER_SOL;
}

export function get_sol_token_amount(amount: number): TokenAmount {
    return get_token_amount(amount, Math.log10(LAMPORTS_PER_SOL));
}

export function get_token_amount(amount: number, decimals: number): TokenAmount {
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error(`Invalid decimals: ${decimals}`);
    const raw_amount = Math.floor(amount * 10 ** decimals);
    if (amount < 0 || !Number.isSafeInteger(raw_amount) || (amount > 0 && raw_amount === 0))
        throw new RangeError('Invalid token amount.');
    return {
        uiAmount: raw_amount / 10 ** decimals,
        amount: BigInt(raw_amount).toString(),
        decimals
    };
}

export function get_token_amount_by_percent(token_amount: TokenAmount, percent: number): TokenAmount {
    if (!Number.isFinite(percent) || percent < 0.0 || percent > 1.0) throw new Error(`Invalid percent: ${percent}`);
    if (percent === 1.0) return token_amount;
    const raw_amount = (BigInt(token_amount.amount) * BigInt(Math.floor(percent * 10000))) / 10000n;
    return {
        uiAmount: Number(raw_amount) / 10 ** token_amount.decimals,
        amount: raw_amount.toString(),
        decimals: token_amount.decimals
    };
}

// Balances, token metadata and transaction history

export async function retry_get_tx(
    signature: string,
    retries: number = TRADE_RETRIES
): Promise<ParsedTransactionWithMeta | null> {
    while (retries > 0) {
        try {
            const transaction = await global.CONNECTION.getParsedTransaction(signature, {
                maxSupportedTransactionVersion: 1,
                commitment: COMMITMENT
            });
            if (transaction) return transaction;
        } catch (error) {}
        retries--;
        await common.sleep(TRADE_RETRY_INTERVAL_MS * (retries + 1));
    }
    return null;
}

function cleanup_ttl_cache<T>(cache: Map<string, { value: T; expires_at: number }>, now: number): void {
    if (cache.size <= CACHE_SIZE_MAX) return;
    for (const [key, item] of cache.entries()) {
        if (item.expires_at <= now) cache.delete(key);
    }
}

const ata_cache = new Map<string, Promise<PublicKey>>();

export function calc_ata(
    owner: PublicKey,
    mint: PublicKey,
    token_program: PublicKey = TOKEN_PROGRAM_ID
): Promise<PublicKey> {
    const key = `${owner.toBase58()}:${mint.toBase58()}:${token_program.toBase58()}`;
    const cached = ata_cache.get(key);
    if (cached) return cached;
    if (ata_cache.size >= CACHE_SIZE_MAX) {
        const oldest = ata_cache.keys().next().value;
        if (oldest !== undefined) ata_cache.delete(oldest);
    }
    const request = getAssociatedTokenAddress(mint, owner, token_program).catch((error) => {
        if (ata_cache.get(key) === request) ata_cache.delete(key);
        throw error;
    });
    ata_cache.set(key, request);
    return request;
}

export async function get_balance_change(signature: string, address: PublicKey): Promise<number> {
    try {
        const tx_details = await global.CONNECTION.getTransaction(signature, {
            commitment: COMMITMENT,
            maxSupportedTransactionVersion: 1
        });
        if (!tx_details) throw new Error(`Transaction not found: ${signature} `);
        const balance_index = tx_details.transaction.message.staticAccountKeys.findIndex((i) => i.equals(address));
        if (balance_index !== undefined && balance_index !== -1) {
            const pre_balance = tx_details?.meta?.preBalances[balance_index] ?? 0n;
            const post_balance = tx_details?.meta?.postBalances[balance_index] ?? 0n;
            return lamports_to_sol(pre_balance - post_balance);
        }
        return 0;
    } catch (err) {
        throw new Error(`Failed to get the balance change: ${err} `);
    }
}

export function calc_token_balance_changes(
    tx: ParsedTransactionWithMeta,
    account: PublicKey,
    mint?: string
): TxBalanceChanges | null {
    if (!tx.meta || tx.meta.err || !tx.meta.postTokenBalances || !tx.meta.preTokenBalances) return null;

    const account_address = account.toBase58();
    const change_sol_index = tx.transaction.message.accountKeys.findIndex((acc) => {
        const pubkey = acc.pubkey as PublicKey | string;
        return typeof pubkey === 'string' ? pubkey === account_address : pubkey.equals(account);
    });
    if (change_sol_index === -1) return null;
    const pre_token_balance_index = tx.meta.preTokenBalances.findIndex(
        (change) => change.owner === account.toString() && (!mint || change.mint === mint)
    );
    const post_token_balance_index = tx.meta.postTokenBalances.findIndex(
        (change) => change.owner === account.toString() && (!mint || change.mint === mint)
    );

    const pre_sol_balance = lamports_to_sol(tx.meta.preBalances[change_sol_index]);
    const post_sol_balance = lamports_to_sol(tx.meta.postBalances[change_sol_index]);

    let pre_token_balance = 0.0;
    let post_token_balance = 0.0;

    if (pre_token_balance_index !== -1)
        pre_token_balance = tx.meta.preTokenBalances[pre_token_balance_index].uiTokenAmount.uiAmount || 0.0;

    if (post_token_balance_index !== -1)
        post_token_balance = tx.meta.postTokenBalances[post_token_balance_index].uiTokenAmount.uiAmount || 0.0;

    const change_sol = post_sol_balance - pre_sol_balance;
    const change_tokens = post_token_balance - pre_token_balance;

    const tips_instructions: ParsedInstruction[] = [];
    for (let i = tx.transaction.message.instructions.length - 1; i >= 0; i--) {
        const instr = tx.transaction.message.instructions[i];
        const program_id = instr.programId as PublicKey | string;
        const is_system_program =
            typeof program_id === 'string'
                ? program_id === SYSTEM_PROGRAM_ID.toBase58()
                : program_id.equals(SYSTEM_PROGRAM_ID);
        if ('parsed' in instr && is_system_program && instr.parsed.type === 'transfer') {
            tips_instructions.push(instr);
        }
        break;
    }
    const tips = lamports_to_sol(
        tips_instructions.reduce(
            (sum: bigint, cur: ParsedInstruction) => sum + common.rpc_bigint(cur.parsed.info.lamports),
            0n
        )
    );

    let tx_fees = 0;
    if (tx.version === 1) {
        tx_fees = lamports_to_sol(tx.transaction.message.transactionConfig?.priorityFeeLamports ?? 0n);
    } else {
        const compute_budget_data = tx.transaction.message.instructions
            .filter((instr): instr is PartiallyDecodedInstruction => {
                const program_id = instr.programId as PublicKey | string;
                const is_compute_budget_program =
                    typeof program_id === 'string'
                        ? program_id === COMPUTE_BUDGET_PROGRAM_ID.toBase58()
                        : program_id.equals(COMPUTE_BUDGET_PROGRAM_ID);
                return 'data' in instr && is_compute_budget_program;
            })
            .map((instr) => {
                const buff = Buffer.from(bs58.decode(instr.data));
                if (buff.length === 5) return common.read_biguint_le(buff, 1, 4);
                if (buff.length === 9) return common.read_biguint_le(buff, 1, 8);
                throw new Error(`Invalid compute budget instruction data length: ${buff.length}`);
            });
        if (compute_budget_data.length === 2) {
            tx_fees = Number(compute_budget_data[0] * compute_budget_data[1]) / (LAMPORTS_PER_SOL * 10 ** 6);
        }
    }

    return {
        pre_sol_balance,
        post_sol_balance,
        pre_token_balance,
        post_token_balance,
        change_sol,
        change_tokens,
        fees: tips + tx_fees
    };
}

export async function get_cost_basis(
    account: PublicKey,
    mint: PublicKey,
    _commitment: Finality = 'finalized',
    _token_program: PublicKey = TOKEN_PROGRAM_ID
): Promise<CostBasis | null> {
    const txs: (ParsedTransactionWithMeta | null)[] = [];
    let pagination_token: string | undefined;
    do {
        const page = await helius_rpc<HeliusTransactionsForAddressPage>('getTransactionsForAddress', [
            account.toBase58(),
            {
                transactionDetails: 'full',
                encoding: 'jsonParsed',
                maxSupportedTransactionVersion: 1,
                sortOrder: 'asc',
                commitment: 'finalized',
                limit: COST_BASIS_TRANSACTION_PAGE_SIZE,
                filters: {
                    status: 'succeeded',
                    tokenAccounts: 'balanceChanged',
                    tokenTransfer: { mint: mint.toBase58() }
                },
                ...(pagination_token ? { paginationToken: pagination_token } : {})
            }
        ]);
        txs.push(...page.data.map(deserialize_parsed_transaction));
        pagination_token = page.paginationToken || undefined;
    } while (pagination_token);
    if (txs.length === 0) return null;

    const changes = txs
        .filter((tx) => tx !== null)
        .map((tx) => calc_token_balance_changes(tx, account, mint.toBase58()))
        .filter((change) => change !== null);

    const purchases = changes.filter((change) => change.change_tokens > 0 && change.change_sol < 0);
    const total_tokens = purchases.reduce((sum: number, cur: TxBalanceChanges) => sum + cur.change_tokens, 0);
    if (total_tokens === 0) return null;
    const total_fees = purchases.reduce((sum: number, cur: TxBalanceChanges) => sum + cur.fees, 0);
    const total_spendings = purchases.reduce((sum: number, cur: TxBalanceChanges) => sum - cur.change_sol, 0);

    return {
        average_cost_basis: (total_spendings - total_fees) / total_tokens,
        total_spendings,
        total_tokens,
        total_fees
    };
}
const token_supply_cache = new Map<string, { value: { supply: bigint; decimals: number }; expires_at: number }>();
const token_supply_inflight = new Map<string, Promise<{ supply: bigint; decimals: number }>>();
export async function get_token_supply(mint: PublicKey): Promise<{ supply: bigint; decimals: number }> {
    const key = mint.toBase58();
    const now = Date.now();

    cleanup_ttl_cache(token_supply_cache, now);

    const cached = token_supply_cache.get(key);
    if (cached && cached.expires_at > now) return cached.value;
    if (cached) token_supply_cache.delete(key);

    const in_flight = token_supply_inflight.get(key);
    if (in_flight) return in_flight;

    const fetch_promise = (async (): Promise<{ supply: bigint; decimals: number }> => {
        try {
            const mint_data = await getMint(global.CONNECTION, mint, COMMITMENT);
            const value = { supply: mint_data.supply, decimals: mint_data.decimals };
            token_supply_cache.set(key, { value, expires_at: Date.now() + ACCOUNT_READ_CACHE_TTL_MS });
            return value;
        } catch (err) {
            const value = {
                supply: BigInt(1_000_000_000 * 10 ** TRADE_DEFAULT_TOKEN_DECIMALS),
                decimals: TRADE_DEFAULT_TOKEN_DECIMALS
            };
            token_supply_cache.set(key, { value, expires_at: Date.now() + ACCOUNT_READ_CACHE_TTL_MS });
            return value;
        }
    })().finally(() => {
        token_supply_inflight.delete(key);
    });

    token_supply_inflight.set(key, fetch_promise);
    return fetch_promise;
}

const vault_balance_cache = new Map<string, { value: { balance: bigint; decimals: number }; expires_at: number }>();
const vault_balance_inflight = new Map<string, Promise<{ balance: bigint; decimals: number }>>();
export async function get_vault_balance(vault: PublicKey): Promise<{ balance: bigint; decimals: number }> {
    const key = vault.toBase58();
    const now = Date.now();

    cleanup_ttl_cache(vault_balance_cache, now);

    const cached = vault_balance_cache.get(key);
    if (cached && cached.expires_at > now) return cached.value;
    if (cached) vault_balance_cache.delete(key);

    const in_flight = vault_balance_inflight.get(key);
    if (in_flight) return in_flight;

    const fetch_promise = (async (): Promise<{ balance: bigint; decimals: number }> => {
        const balance = await global.CONNECTION.getTokenAccountBalance(vault);
        const value = { balance: BigInt(balance.value.amount), decimals: balance.value.decimals };
        vault_balance_cache.set(key, { value, expires_at: Date.now() + ACCOUNT_READ_CACHE_TTL_MS });
        return value;
    })().finally(() => {
        vault_balance_inflight.delete(key);
    });

    vault_balance_inflight.set(key, fetch_promise);
    return fetch_promise;
}

export async function get_balance(pubkey: PublicKey, commitment: Commitment = 'finalized'): Promise<bigint> {
    return global.CONNECTION.getBalance(pubkey, { commitment });
}

export async function get_token_balance(
    owner: PublicKey,
    mint: PublicKey,
    commitment: Commitment = 'finalized',
    program_id: PublicKey = TOKEN_PROGRAM_ID
): Promise<TokenAmount> {
    try {
        const assoc_address = await calc_ata(owner, mint, program_id);
        const account_info = await global.CONNECTION.getTokenAccountBalance(assoc_address, commitment);
        return account_info.value;
    } catch (err) {
        return {
            uiAmount: null,
            amount: '0',
            decimals: 0
        };
    }
}

export async function get_token_meta(mint: PublicKey): Promise<MintAsset> {
    const mint_info = await global.CONNECTION.getAccountInfo(mint, COMMITMENT);
    if (!mint_info || (!mint_info.owner.equals(TOKEN_PROGRAM_ID) && !mint_info.owner.equals(TOKEN_2022_PROGRAM_ID)))
        throw new Error(`Invalid token program for mint ${mint}`);
    try {
        const result = await helius_rpc<HeliusAsset>('getAsset', [mint.toString()]);
        if (result.token_info && result.content && result.creators) {
            const creator = result.creators.at(0);
            return {
                token_name: result.content.metadata.name,
                token_symbol: result.content.metadata.symbol,
                token_decimal: result.token_info.decimals || TRADE_DEFAULT_TOKEN_DECIMALS,
                token_supply: result.token_info.supply || 10 ** 16,
                price_per_token: result.token_info.price_info?.price_per_token || 0.0,
                creator: creator ? new PublicKey(creator.address) : undefined,
                token_program: mint_info.owner,
                mint: mint
            };
        }
        throw new Error(`Failed to get the token metadata`);
    } catch {
        const token = await getMint(global.CONNECTION, mint, COMMITMENT, mint_info.owner);
        return {
            token_name: 'Unknown',
            token_symbol: 'Unknown',
            token_decimal: token.decimals,
            token_supply: Number(token.supply),
            price_per_token: 0,
            token_program: mint_info.owner,
            mint
        };
    }
}

// Relay configuration, tips and transport

function get_transaction_relay(): TransactionRelay {
    return global.TRANSACTION_RELAY ?? TransactionRelay.Sender;
}

export function get_bundle_size(): number {
    return get_transaction_relay() === TransactionRelay.Sender ? SENDER_MAX_BUNDLE_SIZE : JITO_BUNDLE_SIZE;
}

export function get_bundle_interval_ms(): number {
    return get_transaction_relay() === TransactionRelay.Sender ? SENDER_INTERVAL_MS : JITO_BUNDLE_INTERVAL_MS;
}

function get_random_jito_tip_account(): PublicKey {
    const random_tip_account = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
    return new PublicKey(random_tip_account);
}

function get_random_sender_tip_account(): PublicKey {
    const random_tip_account = SENDER_TIP_ACCOUNTS[Math.floor(Math.random() * SENDER_TIP_ACCOUNTS.length)];
    return new PublicKey(random_tip_account);
}

async function relay_rpc<T>(url: string | URL, method: string, params: unknown[]): Promise<T> {
    const response = await rate_limit_request(() =>
        fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
            signal: AbortSignal.timeout(15000)
        })
    );
    const data = (await response.json()) as HeliusRpcResponse<T>;
    if (data.error) {
        if (/already.*processed/i.test(data.error.message)) throw new Error(data.error.message);
        throw new RelayRejectionError(data.error.message);
    }
    if (!response.ok || data.result == null)
        throw new Error(`Relay ${method} returned no result (${response.status}).`);
    return data.result;
}

async function first_relay_response<T>(requests: Promise<T>[]): Promise<T> {
    try {
        return await Promise.any(requests);
    } catch (error) {
        if (
            error instanceof AggregateError &&
            error.errors.length &&
            error.errors.every((cause) => cause instanceof RelayRejectionError)
        )
            throw new RelayRejectionError(error.errors.map(String).join('; '));
        throw error;
    }
}

async function send_jito_bundle(serialized_txs: string[]): Promise<JitoBundleSubmission> {
    return first_relay_response(
        JITO_ENDPOINTS.map(async (endpoint) => ({
            endpoint,
            bundle_id: await relay_rpc<string>(`${endpoint}/bundles`, 'sendBundle', [
                serialized_txs,
                { encoding: 'base64' }
            ])
        }))
    );
}

async function get_jito_bundle_status(submission: JitoBundleSubmission): Promise<JitoBundleStatus | undefined> {
    try {
        const response = await fetch(`${submission.endpoint}/getInflightBundleStatuses`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'getInflightBundleStatuses',
                params: [[submission.bundle_id]]
            })
        });
        const data = await response.json();
        if (data.error) return undefined;
        return data.result?.value?.find(
            (bundle: { bundle_id: string; status: JitoBundleStatus }) => bundle.bundle_id === submission.bundle_id
        )?.status;
    } catch (_error) {
        return undefined;
    }
}

async function send_jito_tx(serialized_tx: string): Promise<string> {
    return first_relay_response(
        JITO_ENDPOINTS.map((endpoint) =>
            relay_rpc<string>(`${endpoint}/transactions`, 'sendTransaction', [serialized_tx, { encoding: 'base64' }])
        )
    );
}

async function send_sender_tx(serialized_tx: string, mev_protect: boolean): Promise<string> {
    return send_sender<string>(
        'sendTransaction',
        [
            serialized_tx,
            {
                encoding: 'base64',
                skipPreflight: true,
                maxRetries: 0
            }
        ],
        mev_protect
    );
}

async function send_sender<T>(
    method: 'sendTransaction' | 'sendBundle',
    params: unknown[],
    mev_protect = false
): Promise<T> {
    const endpoints = SENDER_ENDPOINT ? [SENDER_ENDPOINT] : SENDER_ENDPOINTS;

    const requests = endpoints.map((endpoint) => {
        const url = new URL(`${endpoint}/fast`);
        url.searchParams.append('mev-protect', mev_protect ? 'true' : 'false');
        return relay_rpc<T>(url, method, params);
    });
    return first_relay_response(requests);
}

async function send_sender_bundle(serialized_txs: string[]): Promise<unknown> {
    return send_sender('sendBundle', [serialized_txs, { encoding: 'base64' }]);
}

export function create_tip_instruction(
    payer: PublicKey,
    tip: number,
    provider: TransactionRelay = get_transaction_relay(),
    tip_account?: PublicKey
): TransactionInstruction {
    const minimum_tip = get_minimum_bundle_tip(provider);
    if (!Number.isFinite(tip) || tip < minimum_tip) throw new Error(`Tip is too low, minimum is ${minimum_tip}`);
    const tip_accounts = provider === TransactionRelay.Sender ? SENDER_TIP_ACCOUNTS : JITO_TIP_ACCOUNTS;
    if (tip_account && !tip_accounts.includes(tip_account.toBase58())) throw new Error('Invalid relay tip account.');
    return SystemProgram.transfer({
        fromPubkey: payer,
        toPubkey:
            tip_account ??
            (provider === TransactionRelay.Sender ? get_random_sender_tip_account() : get_random_jito_tip_account()),
        lamports: sol_to_lamports(tip)
    });
}

export function get_minimum_bundle_tip(provider: TransactionRelay = get_transaction_relay()): number {
    return provider === TransactionRelay.Sender ? SENDER_MAX_MIN_TIP : JITO_MIN_TIP;
}

// Priority fee estimation

const priority_cache = new Map<string, { value: number; expires_at: number }>();
const priority_cache_inflight = new Map<string, Promise<number>>();

async function cached_priority_fee(key: string, fetch_fee: () => Promise<number>): Promise<number> {
    const now = Date.now();
    cleanup_ttl_cache(priority_cache, now);
    const cached = priority_cache.get(key);
    if (cached && cached.expires_at > now) return cached.value;
    if (cached) priority_cache.delete(key);
    const in_flight = priority_cache_inflight.get(key);
    if (in_flight) return in_flight;

    const request = fetch_fee()
        .then((fee) => {
            if (!Number.isSafeInteger(fee) || fee < 0) throw new Error('Invalid priority price in micro-lamports/CU.');
            priority_cache.set(key, { value: fee, expires_at: Date.now() + PRIORITY_FEE_TTL_MS });
            return fee;
        })
        .finally(() => priority_cache_inflight.delete(key));
    priority_cache_inflight.set(key, request);
    return request;
}

export async function get_priority_fee_estimate(
    priority_level: PriorityLevel,
    account_keys: PublicKey[]
): Promise<number> {
    const response = await helius_rpc<{ priorityFeeEstimate?: number }>('getPriorityFeeEstimate', [
        {
            accountKeys: account_keys.map((account) => account.toBase58()),
            options: { priorityLevel: priority_level }
        }
    ]);
    return Math.floor(response.priorityFeeEstimate || 0);
}

async function get_priority_fee(priority_opts: PriorityOptions, ctx: TransactionContext): Promise<number> {
    const get_priority_cache_key = (priority_opts: PriorityOptions): string => {
        const priority = (priority_opts.priority_level || 'recommended').toLowerCase();
        const tx_shape = priority_opts.transaction
            ? priority_opts.transaction.instructions.map((ix) => `${ix.programId.toBase58()}`).join('|')
            : 'none';
        return `${priority}::${tx_shape}`;
    };

    if (!priority_opts.transaction)
        throw new Error(`Transaction instructions and signers are required to get priority fee estimate.`);

    const cache_key = get_priority_cache_key(priority_opts);
    return cached_priority_fee(cache_key, async () => {
        let encoded_tx: string | undefined;
        if (priority_opts.transaction) {
            const { instructions, signers, alts } = priority_opts.transaction;
            encoded_tx = bs58.encode((await create_signed_tx(signers, instructions, ctx, alts)).serialize());
        }

        const response = await helius_rpc<{ priorityFeeEstimate?: number }>('getPriorityFeeEstimate', [
            {
                transaction: encoded_tx,
                accountKeys: priority_opts.accounts,
                options: {
                    priorityLevel: priority_opts.priority_level,
                    recommended: priority_opts.priority_level === undefined ? true : undefined
                }
            }
        ]);

        return Math.floor(response.priorityFeeEstimate || 0);
    });
}

async function get_priority_fee_v1(
    instructions: TransactionInstruction[],
    payer: PublicKey,
    units: number,
    priority?: PriorityLevel,
    provider?: TransactionRelay
): Promise<bigint> {
    const accounts = [
        ...new Set([
            payer.toBase58(),
            ...instructions.flatMap((instruction) =>
                instruction.keys.filter((key) => key.isWritable).map((key) => key.pubkey.toBase58())
            )
        ])
    ].map((key) => new PublicKey(key));
    const level = priority ?? PriorityLevel.DEFAULT;
    const cache_key = `v1:${level}:${accounts
        .map((account) => account.toBase58())
        .sort()
        .join(',')}`;
    const price =
        global.PRIORITY_FEE ?? (await cached_priority_fee(cache_key, () => get_priority_fee_estimate(level, accounts)));
    if (!Number.isSafeInteger(price) || price < 0) throw new Error('Invalid priority price in micro-lamports/CU.');
    const fee = (BigInt(price) * BigInt(units) + 999999n) / 1000000n;
    const minimum_fee = provider === TransactionRelay.Sender ? BigInt(SENDER_MAX_MIN_PRIORITY_FEE) : 0n;
    return fee < minimum_fee ? minimum_fee : fee;
}

// Transaction resource estimation, compilation and signing

async function estimate_resource_limits_v1(
    instructions: TransactionInstruction[],
    payer: PublicKey,
    ctx: TransactionContext,
    compute_unit_limit?: number
): Promise<{ computeUnitLimit: number; loadedAccountsDataSizeLimit: number }> {
    const provisional = compile_tx(instructions, payer, ctx.value.blockhash, 1);
    const { value: simulation } = await global.CONNECTION.simulateTransaction(provisional, {
        sigVerify: false,
        commitment: COMMITMENT,
        minContextSlot: ctx.context.slot
    });
    if (simulation.err !== null) throw new TransactionSimulationError(simulation.err);
    if (simulation.unitsConsumed === undefined || simulation.loadedAccountsDataSize === undefined)
        throw new Error('RPC did not return v1 resource estimates.');
    const units_consumed = common.safe_number(simulation.unitsConsumed);
    const loaded_bytes = common.safe_number(simulation.loadedAccountsDataSize);
    if (
        units_consumed <= 0 ||
        units_consumed > MAX_COMPUTE_UNIT_LIMIT ||
        loaded_bytes < 0 ||
        loaded_bytes > MAX_LOADED_ACCOUNTS_DATA_SIZE_BYTES
    )
        throw new Error('RPC returned invalid v1 resource estimates.');
    const units =
        compute_unit_limit ?? Math.min(MAX_COMPUTE_UNIT_LIMIT, Math.ceil(units_consumed * COMPUTE_UNIT_BUFFER));
    if (!Number.isSafeInteger(units) || units < units_consumed || units > MAX_COMPUTE_UNIT_LIMIT)
        throw new Error('Invalid compute unit limit for the simulated transaction.');
    return {
        computeUnitLimit: units,
        loadedAccountsDataSizeLimit: Math.min(
            MAX_LOADED_ACCOUNTS_DATA_SIZE_BYTES,
            (Math.floor(loaded_bytes / LOADED_ACCOUNTS_DATA_PAGE_SIZE_BYTES) + 1) * LOADED_ACCOUNTS_DATA_PAGE_SIZE_BYTES
        )
    };
}

async function prepare_tx(
    instructions: TransactionInstruction[],
    signers: Keypair[],
    ctx: TransactionContext,
    options: {
        version: 0 | 1;
        priority?: PriorityLevel;
        alts?: AddressLookupTableAccount[];
        compute_unit_limit?: number;
        provider?: TransactionRelay;
        tip?: number;
        tip_account?: PublicKey;
        bundle?: boolean;
    }
): Promise<VersionedTransaction> {
    if (signers.length === 0 || instructions.length === 0) throw new Error('Instructions and signers are required.');
    if (instructions.some((instruction) => instruction.programId.equals(ComputeBudgetProgram.programId)))
        throw new Error('Transactions cannot include compute budget instructions.');
    if (options.tip !== undefined)
        instructions = [
            ...instructions,
            create_tip_instruction(signers[0].publicKey, options.tip, options.provider, options.tip_account)
        ];
    const { version, priority, alts, compute_unit_limit, provider, bundle } = options;
    if (
        compute_unit_limit !== undefined &&
        (!Number.isSafeInteger(compute_unit_limit) ||
            compute_unit_limit <= 0 ||
            compute_unit_limit > MAX_COMPUTE_UNIT_LIMIT)
    )
        throw new Error('Invalid compute unit limit.');
    const use_priority_fee = !bundle || priority !== undefined || provider === TransactionRelay.Sender;
    let final_instructions = instructions;
    let config: V1TransactionConfig | undefined;
    if (version === 1) {
        const limits = bundle
            ? {
                  computeUnitLimit: compute_unit_limit ?? MAX_COMPUTE_UNIT_LIMIT,
                  loadedAccountsDataSizeLimit: MAX_LOADED_ACCOUNTS_DATA_SIZE_BYTES
              }
            : await estimate_resource_limits_v1(instructions, signers[0].publicKey, ctx, compute_unit_limit);
        const fee = use_priority_fee
            ? await get_priority_fee_v1(instructions, signers[0].publicKey, limits.computeUnitLimit, priority, provider)
            : 0n;
        config = { ...limits, priorityFeeLamports: fee };
    } else {
        const units =
            compute_unit_limit ??
            (bundle ? MAX_COMPUTE_UNIT_LIMIT : await estimate_compute_unit_limit(instructions, signers, ctx, alts));
        let price = use_priority_fee
            ? (global.PRIORITY_FEE ??
              (await get_priority_fee({ priority_level: priority, transaction: { instructions, signers, alts } }, ctx)))
            : undefined;
        if (provider === TransactionRelay.Sender)
            price = Math.max(price ?? 0, Math.ceil((SENDER_MAX_MIN_PRIORITY_FEE * 1_000_000) / units));
        final_instructions = [
            ComputeBudgetProgram.setComputeUnitLimit({ units }),
            ...(price === undefined ? [] : [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price })]),
            ...instructions
        ];
    }
    return create_signed_tx(signers, final_instructions, ctx, alts, version, config);
}

async function estimate_compute_unit_limit(
    instructions: TransactionInstruction[],
    signers: Keypair[],
    ctx: TransactionContext,
    alts?: AddressLookupTableAccount[]
): Promise<number> {
    const simulation_instructions = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNIT_LIMIT }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }),
        ...instructions
    ];
    const simulation_tx = await create_signed_tx(signers, simulation_instructions, ctx, alts);
    const simulation = await global.CONNECTION.simulateTransaction(simulation_tx, {
        sigVerify: true,
        commitment: COMMITMENT
    });
    if (simulation.value.err) throw new TransactionSimulationError(simulation.value.err);
    if (!simulation.value.unitsConsumed) throw new Error('RPC did not return a compute unit estimate.');
    return Math.min(
        MAX_COMPUTE_UNIT_LIMIT,
        Math.max(1_000, Math.ceil(common.safe_number(simulation.value.unitsConsumed) * COMPUTE_UNIT_BUFFER))
    );
}

export async function get_max_transaction_version(): Promise<0 | 1> {
    try {
        const { context, value } = await global.CONNECTION.getAccountInfoAndContext(
            new PublicKey('txv1aq4pp281K9um3tnPgkfX8UqtFT6wcVW3hNezGLL'),
            'finalized'
        );
        return value &&
            value.owner.equals(new PublicKey('Feature111111111111111111111111111111111111')) &&
            value.data.length >= 9 &&
            value.data[0] === 1 &&
            new DataView(value.data.buffer, value.data.byteOffset, value.data.byteLength).getBigUint64(1, true) <=
                context.slot
            ? 1
            : 0;
    } catch {
        return 0;
    }
}

function compile_tx(
    instructions: TransactionInstruction[],
    payer: PublicKey,
    recent_blockhash: Blockhash,
    version: 0 | 1 = 0,
    alts?: AddressLookupTableAccount[],
    config: V1TransactionConfig = {
        priorityFeeLamports: 0n,
        computeUnitLimit: MAX_COMPUTE_UNIT_LIMIT,
        loadedAccountsDataSizeLimit: MAX_LOADED_ACCOUNTS_DATA_SIZE_BYTES
    }
): VersionedTransaction {
    if (instructions.length === 0 || instructions.length > MAX_TRANSACTION_INSTRUCTIONS)
        throw new CompileTransactionError('Transaction instruction limit exceeded.');
    if (
        version === 1 &&
        instructions.some((instruction) => instruction.programId.equals(ComputeBudgetProgram.programId))
    )
        throw new CompileTransactionError('V1 transactions must configure resources through the message config.');
    const transaction_message = new TransactionMessage({
        payerKey: payer,
        recentBlockhash: recent_blockhash,
        instructions
    });
    const message =
        version === 1 ? transaction_message.compileToV1Message(config) : transaction_message.compileToV0Message(alts);
    const account_count =
        message.staticAccountKeys.length +
        (message.version === 0
            ? message.addressTableLookups.reduce(
                  (count, lookup) => count + lookup.writableIndexes.length + lookup.readonlyIndexes.length,
                  0
              )
            : 0);
    if (account_count > MAX_TRANSACTION_ACCOUNTS || message.header.numRequiredSignatures > MAX_TRANSACTION_SIGNATURES)
        throw new CompileTransactionError('Transaction account or signer limit exceeded.');

    const transaction = new VersionedTransaction(message);
    const max_bytes = version === 1 ? 4096 : 1232;
    if (transaction.serialize().length > max_bytes)
        throw new CompileTransactionError(`Transaction exceeds ${max_bytes} bytes.`);
    return transaction;
}

async function create_signed_tx(
    signers: Keypair[],
    instructions: TransactionInstruction[],
    ctx: TransactionContext,
    alts?: AddressLookupTableAccount[],
    version: 0 | 1 = 0,
    config?: V1TransactionConfig
): Promise<VersionedTransaction> {
    const versioned_tx = compile_tx(instructions, signers[0].publicKey, ctx.value.blockhash, version, alts, config);
    await versioned_tx.sign(signers);
    return versioned_tx;
}

export function pack_tx_groups<T>(
    items: T[],
    instructions_for: (item: T) => TransactionInstruction[],
    payer: PublicKey | ((item: T) => PublicKey),
    version: 0 | 1 = global.TRANSACTION_VERSION ?? 0,
    alts?: AddressLookupTableAccount[],
    trailing_instructions: TransactionInstruction[] | ((payer: PublicKey) => TransactionInstruction[]) = [],
    max_items: number = Infinity
): T[][] {
    const batches: T[][] = [];
    let batch: T[] = [];
    let batch_instructions: TransactionInstruction[] = [];
    const overhead =
        version === 0
            ? [
                  ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNIT_LIMIT }),
                  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 })
              ]
            : [];
    const validate_capacity = (instructions: TransactionInstruction[], first: T) => {
        const fee_payer = typeof payer === 'function' ? payer(first) : payer;
        compile_tx(
            [
                ...overhead,
                ...instructions,
                ...(typeof trailing_instructions === 'function'
                    ? trailing_instructions(fee_payer)
                    : trailing_instructions)
            ],
            fee_payer,
            '11111111111111111111111111111111' as Blockhash,
            version,
            alts
        );
    };
    for (const item of items) {
        const item_instructions = instructions_for(item);
        if (batch.length >= max_items) {
            batches.push(batch);
            batch = [];
            batch_instructions = [];
        }
        const candidate = [...batch_instructions, ...item_instructions];
        try {
            validate_capacity(candidate, batch[0] ?? item);
        } catch (error) {
            if (batch.length === 0) throw error;
            validate_capacity(item_instructions, item);
            batches.push(batch);
            batch = [];
            batch_instructions = [];
        }
        batch.push(item);
        batch_instructions.push(...item_instructions);
    }
    if (batch.length) batches.push(batch);
    return batches;
}

// Transaction submission, retries and confirmation

export async function send_tx(
    instructions: TransactionInstruction[],
    signers: Keypair[],
    priority?: PriorityLevel,
    protection_tip?: number,
    mev_protect: boolean = false,
    alts?: AddressLookupTableAccount[],
    compute_unit_limit?: number,
    version: 0 | 1 = global.TRANSACTION_VERSION ?? 0,
    options: TransactionOptions = {}
): Promise<String> {
    if (mev_protect && (!protection_tip || protection_tip <= 0))
        throw new Error(`MEV protection requires a protection tip to be specified.`);

    const provider = protection_tip ? get_transaction_relay() : undefined;
    const ctx = await global.CONNECTION.getLatestBlockhashAndContext(COMMITMENT);
    const transaction = await prepare_tx(instructions, signers, ctx, {
        version,
        priority,
        alts,
        compute_unit_limit,
        provider,
        tip: protection_tip || undefined,
        tip_account: options.tip_account
    });
    return submit_tx(transaction, ctx, provider, mev_protect);
}

async function submit_tx(
    transaction: VersionedTransaction,
    context: TransactionContext,
    provider?: TransactionRelay,
    mev_protect = false
): Promise<String> {
    const bytes = transaction.serialize();
    const signature = bs58.encode(transaction.signatures[0]);
    try {
        if (provider) {
            const encoded = Buffer.from(bytes).toString('base64');
            const response =
                provider === TransactionRelay.Sender
                    ? await send_sender_tx(encoded, mev_protect)
                    : await send_jito_tx(encoded);
            if (response !== signature) throw new Error(`No matching signature returned by ${provider}.`);
        } else {
            let returned_signature: string;
            try {
                returned_signature = await global.CONNECTION.sendRawTransaction(bytes, {
                    skipPreflight: false,
                    preflightCommitment: COMMITMENT,
                    minContextSlot: context.context.slot,
                    maxRetries: BigInt(TRADE_TX_RETRIES)
                });
            } catch (error) {
                const rejected =
                    error instanceof SendTransactionError &&
                    !/already.*processed/i.test(error.transactionError.message);
                throw new TransactionSubmissionError(signature, error, rejected ? 'rejected' : 'unknown');
            }
            if (returned_signature !== signature) throw new Error('RPC returned a different transaction signature.');
        }
        await check_transaction_status(signature, context);
    } catch (error) {
        if (error instanceof TransactionSubmissionError) throw error;
        throw new TransactionSubmissionError(
            signature,
            error,
            error instanceof RelayRejectionError ? 'rejected' : 'unknown'
        );
    }
    return signature;
}

export async function send_bundle(
    instructions: TransactionInstruction[][],
    signers: Keypair[][],
    tip: number,
    priority?: PriorityLevel,
    alts?: AddressLookupTableAccount[],
    compute_unit_limit?: number,
    version: 0 | 1 = global.TRANSACTION_VERSION ?? 0,
    options: TransactionOptions = {}
): Promise<String> {
    const provider = get_transaction_relay();
    if (instructions.length > get_bundle_size() || instructions.length === 0)
        throw new Error(`Bundle size exceeded or size is 0.`);
    if (instructions.length !== signers.length) throw new Error(`Instructions and signers length mismatch.`);
    const ctx = await global.CONNECTION.getLatestBlockhashAndContext(COMMITMENT);
    const transactions: VersionedTransaction[] = [];
    for (let i = 0; i < instructions.length; i++) {
        transactions.push(
            await prepare_tx(instructions[i], signers[i], ctx, {
                version,
                priority,
                alts,
                compute_unit_limit,
                provider,
                tip: i === instructions.length - 1 ? tip : undefined,
                tip_account: options.tip_account,
                bundle: true
            })
        );
    }
    const signatures = transactions.map((transaction) => bs58.encode(transaction.signatures[0]));
    const signature = signatures[signatures.length - 1];
    const serialized_txs = transactions.map((transaction) => Buffer.from(transaction.serialize()).toString('base64'));
    try {
        if (provider === TransactionRelay.Sender) {
            await send_sender_bundle(serialized_txs);
            await check_transaction_status(signature, ctx);
            return signature;
        }
        const submission = await send_jito_bundle(serialized_txs);
        await check_transaction_status(signature, ctx, 'confirmed', submission);
        return submission.bundle_id;
    } catch (error) {
        throw new TransactionSubmissionError(
            signatures,
            error,
            error instanceof TransactionSubmissionError
                ? error.outcome
                : error instanceof RelayRejectionError
                  ? 'rejected'
                  : 'unknown'
        );
    }
}

export async function retry_send_tx(
    instructions: TransactionInstruction[],
    signers: Keypair[],
    priority?: PriorityLevel,
    protection_tip?: number,
    mev_protect: boolean = false,
    alts?: AddressLookupTableAccount[],
    compute_unit_limit?: number,
    retries: number = TRADE_RETRIES,
    options: TransactionOptions = {}
): Promise<String> {
    const version = global.TRANSACTION_VERSION ?? 0;
    while (retries > 0) {
        try {
            return await send_tx(
                instructions,
                signers,
                priority,
                protection_tip,
                mev_protect,
                alts,
                compute_unit_limit,
                version,
                options
            );
        } catch (error) {
            if (retries === 1 || (error instanceof TransactionSubmissionError && error.outcome === 'unknown'))
                throw error;
            retries--;
        }
        await common.sleep(TRADE_RETRY_INTERVAL_MS * (retries + 1));
    }
    throw new Error('Send transaction failed after multiple attempts');
}

export async function retry_send_bundle(
    bundle_instructions: TransactionInstruction[][],
    bundle_signers: Keypair[][],
    bundle_tip: number,
    priority?: PriorityLevel,
    ltas?: AddressLookupTableAccount[],
    compute_unit_limit?: number,
    retries: number = TRADE_RETRIES,
    options: TransactionOptions = {}
): Promise<String> {
    const version = global.TRANSACTION_VERSION ?? 0;
    while (retries > 0) {
        try {
            return await send_bundle(
                bundle_instructions,
                bundle_signers,
                bundle_tip,
                priority,
                ltas,
                compute_unit_limit,
                version,
                options
            );
        } catch (error) {
            if (retries === 1 || (error instanceof TransactionSubmissionError && error.outcome === 'unknown'))
                throw error;
            retries--;
        }
        await common.sleep(get_bundle_interval_ms() * (retries + 1));
    }
    throw new Error('Send bundle failed after multiple attempts');
}

async function is_blockhash_expired(last_valid_block_height: bigint): Promise<boolean> {
    let current_block_height = await global.CONNECTION.getBlockHeight(COMMITMENT);
    return last_valid_block_height - current_block_height < 0;
}

async function check_transaction_status(
    signature: string,
    context: TransactionContext,
    finality: Finality = 'confirmed',
    bundle_submission?: JitoBundleSubmission
): Promise<void> {
    const retry_interval = bundle_submission ? 2000 : 1000;
    let bundle_status: JitoBundleStatus | undefined;
    while (true) {
        const { value: status } = await CONNECTION.getSignatureStatus(signature);

        if (
            status &&
            (status.confirmationStatus === finality ||
                (finality === 'confirmed' && status.confirmationStatus === 'finalized'))
        ) {
            const tx = await CONNECTION.getTransaction(signature, {
                maxSupportedTransactionVersion: 1,
                commitment: finality
            });
            if (tx) {
                if (tx.meta?.err === null) return;
                if (tx.meta?.err !== null) {
                    const error_log =
                        tx.meta?.logMessages?.find((line) => line.includes('AnchorError')) ??
                        tx.meta?.logMessages?.find((line) => line.includes('failed:'));
                    const error_detail =
                        error_log?.replace('Program log: ', '') ?? JSON.stringify(tx.meta?.err, common.json_bigint);
                    throw new TransactionSubmissionError(signature, new Error(error_detail), 'failed');
                }
            }
        }

        if (bundle_submission) {
            bundle_status = await get_jito_bundle_status(bundle_submission);
            if (bundle_status === 'Failed')
                throw new TransactionSubmissionError(
                    signature,
                    new Error(`Jito bundle ${bundle_submission.bundle_id} failed.`),
                    'failed'
                );
        }

        const is_expired = await is_blockhash_expired(context.value.lastValidBlockHeight);
        if (is_expired) {
            if (bundle_submission)
                throw new Error(
                    `Jito bundle ${bundle_submission.bundle_id} did not land before its blockhash expired (last status: ${bundle_status?.toLowerCase() || 'unknown'}).`
                );
            throw new Error('Blockhash has expired.');
        }

        await common.sleep(retry_interval);
    }
}

// SOL and token transfers, burns and account cleanup

export async function send_lamports(
    lamports: bigint,
    sender: Keypair,
    receiver: PublicKey,
    priority?: PriorityLevel
): Promise<String> {
    let instructions = [
        SystemProgram.transfer({
            fromPubkey: sender.publicKey,
            toPubkey: receiver,
            lamports: lamports
        })
    ];
    const ctx = await global.CONNECTION.getLatestBlockhashAndContext(COMMITMENT);

    const version = global.TRANSACTION_VERSION ?? 0;
    let config: V1TransactionConfig | undefined;
    if (priority && version === 1) {
        if (lamports <= 5000) throw new Error(`Spend cap of ${lamports} lamports is insufficient to cover fees.`);
        const simulation_instructions = [
            SystemProgram.transfer({ fromPubkey: sender.publicKey, toPubkey: receiver, lamports: lamports - 5000n })
        ];
        const limits = await estimate_resource_limits_v1(simulation_instructions, sender.publicKey, ctx);
        const fee = await get_priority_fee_v1(
            simulation_instructions,
            sender.publicKey,
            limits.computeUnitLimit,
            priority
        );
        const transfer_lamports = BigInt(lamports) - 5000n - fee;
        if (transfer_lamports <= 0n)
            throw new Error(`Spend cap of ${lamports} lamports is insufficient to cover transaction fees.`);
        instructions = [
            SystemProgram.transfer({ fromPubkey: sender.publicKey, toPubkey: receiver, lamports: transfer_lamports })
        ];
        config = { ...limits, priorityFeeLamports: fee };
    } else if (priority) {
        if (lamports <= 5000) throw new Error(`Spend cap of ${lamports} lamports is insufficient to cover fees.`);
        const simulation_instructions = [
            SystemProgram.transfer({
                fromPubkey: sender.publicKey,
                toPubkey: receiver,
                lamports: lamports - 5000n
            })
        ];
        const units = await estimate_compute_unit_limit(simulation_instructions, [sender], ctx);
        const fees = await get_priority_fee(
            {
                priority_level: priority,
                transaction: {
                    instructions: instructions,
                    signers: [sender]
                }
            },
            ctx
        );
        const transfer_lamports = lamports - 5000n - BigInt(Math.ceil((fees * units) / 10 ** 6));
        if (transfer_lamports <= 0)
            throw new Error(`Spend cap of ${lamports} lamports is insufficient to cover transaction fees.`);
        instructions = [
            ComputeBudgetProgram.setComputeUnitLimit({
                units: units
            }),
            ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: fees
            }),
            SystemProgram.transfer({
                fromPubkey: sender.publicKey,
                toPubkey: receiver,
                lamports: transfer_lamports
            })
        ];
    }

    const versioned_tx = await create_signed_tx([sender], instructions, ctx, undefined, version, config);
    return submit_tx(versioned_tx, ctx);
}

export async function retry_send_lamports(
    lamports: bigint,
    sender: Keypair,
    receiver: PublicKey,
    priority?: PriorityLevel,
    retries: number = TRADE_RETRIES
): Promise<String> {
    while (retries > 0) {
        try {
            return await send_lamports(lamports, sender, receiver, priority);
        } catch (error) {
            if (retries === 1 || (error instanceof TransactionSubmissionError && error.outcome === 'unknown'))
                throw error;
            const balance = await get_balance(sender.publicKey, COMMITMENT);
            if (balance === 0n) throw new Error(`Sender has no balance.`);
            if (balance < lamports) lamports = balance;
            retries--;
        }
        await common.sleep(TRADE_RETRY_INTERVAL_MS * (retries + 1));
    }
    throw new Error('Send lamports failed after multiple attempts');
}

export async function send_tokens(
    token_amount: TokenAmount,
    mint: PublicKey,
    sender: Keypair,
    receiver: PublicKey,
    priority?: PriorityLevel,
    token_program: PublicKey = TOKEN_PROGRAM_ID
): Promise<String> {
    if (token_amount.uiAmount === null) throw new Error(`Invalid token amount.`);
    const token_amount_raw = BigInt(token_amount.amount);

    const receiver_ata = await calc_ata(receiver, mint, token_program);
    const sender_ata = await calc_ata(sender.publicKey, mint, token_program);

    const instructions = [
        createAssociatedTokenAccountIdempotentInstruction(sender, receiver_ata, receiver, mint, token_program),
        createTransferInstruction(sender_ata, receiver_ata, sender.publicKey, token_amount_raw, token_program)
    ];

    return await send_tx(instructions, [sender], priority);
}

export async function burn_token(amount: TokenAmount, owner: Keypair, mint: PublicKey): Promise<String> {
    if (amount.uiAmount === null) throw new Error(`Invalid token amount.`);
    const ata = await calc_ata(owner.publicKey, mint);
    const instructions = [createBurnInstruction(ata, mint, owner.publicKey, BigInt(amount.amount))];
    return await send_tx(instructions, [owner]);
}

export async function close_accounts(
    owner: Keypair,
    burn: boolean = false
): Promise<{
    unsold_mints: { mint: PublicKey; amount: bigint; decimals: number }[];
    closed_cnt: number;
    failed_cnt: number;
    closed: { count: number; attempts: number; signature: String }[];
    failures: { count: number; attempts: number; error: string }[];
}> {
    const token_accounts = (
        await Promise.all([
            global.CONNECTION.getTokenAccountsByOwner(owner.publicKey, {
                programId: TOKEN_PROGRAM_ID
            }).then((res) => res.value.map((acc) => ({ ...acc, programId: TOKEN_PROGRAM_ID }))),
            global.CONNECTION.getTokenAccountsByOwner(owner.publicKey, {
                programId: TOKEN_2022_PROGRAM_ID
            }).then((res) => res.value.map((acc) => ({ ...acc, programId: TOKEN_2022_PROGRAM_ID })))
        ])
    )
        .flat()
        .map((acc) => {
            return {
                pubkey: acc.pubkey,
                programId: acc.programId,
                data: decode_token_account(acc.account)
            };
        });
    const unsold_mints = await Promise.all(
        token_accounts
            .filter((acc) => acc.data.amount !== 0n && !acc.data.mint.equals(SOL_MINT) && !burn)
            .map(async (acc) => {
                const mint = acc.data.mint;
                const { decimals } = await get_token_supply(mint);
                return { mint, amount: acc.data.amount, decimals };
            })
    );
    const accounts_to_close = token_accounts.filter(
        (acc) => acc.data.amount === 0n || acc.data.mint.equals(SOL_MINT) || burn
    );

    if ((await get_balance(owner.publicKey, COMMITMENT)) === 0n) {
        if (accounts_to_close.length === 0)
            return {
                unsold_mints,
                closed_cnt: 0,
                failed_cnt: 0,
                closed: [],
                failures: []
            };
        return {
            unsold_mints,
            closed_cnt: 0,
            failed_cnt: accounts_to_close.length,
            closed: [],
            failures: [{ count: accounts_to_close.length, attempts: 0, error: 'No SOL balance' }]
        };
    }

    let closed_cnt = 0;
    let failed_cnt = 0;
    const closed: { count: number; attempts: number; signature: String }[] = [];
    const failures: { count: number; attempts: number; error: string }[] = [];
    const instructions_for = (account: (typeof accounts_to_close)[number]) => {
        const close = createCloseAccountInstruction(
            account.pubkey,
            owner.publicKey,
            owner.publicKey,
            account.programId
        );
        if (!burn || account.data.amount === 0n || account.data.mint.equals(SOL_MINT)) return [close];
        return [
            createBurnInstruction(
                account.pubkey,
                account.data.mint,
                owner.publicKey,
                account.data.amount,
                account.programId
            ),
            close
        ];
    };
    const batches = pack_tx_groups(accounts_to_close, instructions_for, owner.publicKey);
    for (let batch_index = 0; batch_index < batches.length; batch_index++) {
        const chunk = batches[batch_index];
        const instructions = chunk.flatMap(instructions_for);
        for (let attempt = 0; attempt <= TRADE_RETRIES; attempt++) {
            try {
                const signature = await send_tx(instructions, [owner], PriorityLevel.DEFAULT);
                closed_cnt += chunk.length;
                closed.push({ count: chunk.length, attempts: attempt + 1, signature });
                break;
            } catch (err) {
                const instruction_failed =
                    err instanceof TransactionSimulationError &&
                    typeof err.transaction_error === 'object' &&
                    err.transaction_error !== null &&
                    'InstructionError' in err.transaction_error;
                if (instruction_failed && chunk.length > 1) {
                    const middle = Math.ceil(chunk.length / 2);
                    batches.splice(batch_index, 1, chunk.slice(0, middle), chunk.slice(middle));
                    batch_index--;
                    break;
                }
                if (
                    attempt === TRADE_RETRIES ||
                    instruction_failed ||
                    (err instanceof TransactionSubmissionError && err.outcome === 'unknown')
                ) {
                    failed_cnt += chunk.length;
                    failures.push({ count: chunk.length, attempts: attempt + 1, error: String(err) });
                    break;
                }
                await common.sleep(TRADE_RETRY_INTERVAL_MS);
            }
        }
    }

    return {
        unsold_mints: unsold_mints,
        closed_cnt: closed_cnt,
        failed_cnt: failed_cnt,
        closed,
        failures
    };
}

// Address lookup tables

export async function create_lta(payer: Keypair): Promise<[PublicKey, String]> {
    const commitment: Commitment = 'finalized';
    let retries = TRADE_RETRIES;

    while (retries > 0) {
        try {
            const recent_slot = await global.CONNECTION.getSlot(commitment);
            const [instruction, lt_address] = await AddressLookupTableProgram.createLookupTable({
                authority: payer.publicKey,
                payer: payer.publicKey,
                recentSlot: recent_slot
            });
            const signature = await send_tx([instruction], [payer], PriorityLevel.HIGH);
            return [lt_address, signature];
        } catch (err) {
            if (retries === 1 || (err instanceof TransactionSubmissionError && err.outcome === 'unknown')) throw err;
            retries--;
        }
    }
    throw new Error(`Failed after multiple attempts`);
}

const lta_cache = new Map<string, AddressLookupTableAccount>();
export async function get_ltas(addresses: PublicKey[]): Promise<AddressLookupTableAccount[]> {
    const results: AddressLookupTableAccount[] = [];
    const uncached: PublicKey[] = [];

    for (const addr of addresses) {
        const addr_str = addr.toString();
        if (lta_cache.has(addr_str)) {
            results.push(lta_cache.get(addr_str)!);
        } else {
            uncached.push(addr);
        }
    }

    if (uncached.length > 0) {
        const new_ltas = await Promise.all(
            uncached.map(async (addr) => {
                try {
                    const account = await global.CONNECTION.getAddressLookupTable(addr, { commitment: COMMITMENT });
                    if (account && account.value) {
                        lta_cache.set(addr.toString(), account.value);
                        return account.value;
                    }
                    throw new Error(`not found`);
                } catch (error) {
                    throw new Error(`Failed to get Address Lookup Table account for ${addr}: ${error}`);
                }
            })
        );
        results.push(...new_ltas);
    }

    return results.filter((acc) => acc !== null);
}

export async function extend_lta(lta: PublicKey, payer: Keypair, addresses: PublicKey[]): Promise<String[]> {
    const max_addresses = 256;
    const lt_account = (await global.CONNECTION.getAddressLookupTable(lta, { commitment: COMMITMENT })).value;
    if (!lt_account) throw new Error('Address Lookup Table not found');

    const to_insert = addresses.filter(
        (new_addr) => !lt_account.state.addresses.some((old_addr) => old_addr.equals(new_addr))
    );
    if (to_insert.length === 0) throw new Error('No new addresses to insert');
    if (lt_account.state.addresses.length + to_insert.length > max_addresses)
        throw new Error(`Address Lookup Table is full, cannot insert more addresses`);

    const txs: Promise<String>[] = [];
    for (const chunk of common.chunks(to_insert, 20)) {
        const instruction = AddressLookupTableProgram.extendLookupTable({
            authority: payer.publicKey,
            lookupTable: lta,
            payer: payer.publicKey,
            addresses: chunk
        });
        txs.push(send_tx([instruction], [payer], PriorityLevel.HIGH));
    }
    return await Promise.all(txs);
}

export async function close_ltas(payer: Keypair, ltas: readonly AddressLookupTableAccount[]): Promise<String[]> {
    const deactivated_ltas = ltas.filter((item) => !item.isActive());

    const instructions = deactivated_ltas.map((lta) =>
        AddressLookupTableProgram.closeLookupTable({
            authority: payer.publicKey,
            recipient: payer.publicKey,
            lookupTable: lta.key
        })
    );
    const txs: Promise<String>[] = common.chunks(instructions, 10).map((chunk) => send_tx(chunk, [payer]));
    return Promise.all(txs);
}

export async function get_ltas_by_authority(
    authority: PublicKey,
    is_active?: boolean
): Promise<AddressLookupTableAccount[]> {
    try {
        const result = await get_program_accounts_v2(AddressLookupTableProgram.programId, [
            { memcmp: { offset: 22, bytes: authority.toBase58() } }
        ]);
        if (!result) throw new Error(`No Address Lookup Table accounts found for authority ${authority}`);
        const ltas = result.map(
            (account) =>
                new AddressLookupTableAccount({
                    key: account.pubkey,
                    state: AddressLookupTableAccount.deserialize(account.account.data)
                })
        );
        if (is_active !== undefined) return ltas.filter((lta) => lta.isActive() === is_active);
        return ltas;
    } catch (error) {
        throw new Error(`Failed to get Address Lookup Table accounts by authority: ${error}`);
    }
}

export async function deactivate_ltas(
    authority: Keypair,
    ltas: readonly AddressLookupTableAccount[]
): Promise<String[]> {
    const active_ltas = ltas.filter((item) => item.isActive());
    if (ltas.length === 0) throw new Error(`No active Address Lookup Table accounts`);

    const instructions = active_ltas.map((lta) =>
        AddressLookupTableProgram.deactivateLookupTable({
            authority: authority.publicKey,
            lookupTable: lta.key
        })
    );
    const txs: Promise<String>[] = common.chunks(instructions, 10).map((chunk) => send_tx(chunk, [authority]));
    return Promise.all(txs);
}

export async function generate_trade_lta(
    funder: Keypair,
    wallets: Keypair[],
    mint: PublicKey,
    token_program: PublicKey = TOKEN_PROGRAM_ID
): Promise<AddressLookupTableAccount> {
    let created_lt: PublicKey | undefined;
    try {
        [created_lt] = await create_lta(funder);
        const token_atas = await Promise.all(
            wallets.map((keypair) => calc_ata(keypair.publicKey, mint, token_program))
        );
        const wsol_atas = await Promise.all(wallets.map((keypair) => calc_ata(keypair.publicKey, SOL_MINT)));
        const keys = [
            ...wallets.map((keypair) => keypair.publicKey),
            mint,
            ...token_atas,
            ...wsol_atas,
            funder.publicKey
        ];
        await extend_lta(created_lt, funder, keys);

        const [lta] = await get_ltas([created_lt]);
        return lta;
    } catch (error) {
        if (created_lt) {
            const instruction = AddressLookupTableProgram.deactivateLookupTable({
                authority: funder.publicKey,
                lookupTable: created_lt
            });
            await send_tx([instruction], [funder], PriorityLevel.HIGH).catch((cause) =>
                common.warn(`Could not deactivate ALT ${created_lt}: ${cause}`)
            );
        }
        throw new Error(`Failed to generate trade LTA: ${error}`);
    }
}

// Quote-related utilities and functions

const quote_cache = new Map<string, { mint: PublicKey; token_program: PublicKey; decimals: number }>();

export function normalize_quote_mint(value?: string | PublicKey): PublicKey {
    const mint = value ? new PublicKey(value) : SOL_MINT;
    return mint.equals(PublicKey.default) ? SOL_MINT : mint;
}

export async function get_quote_info(mint: PublicKey) {
    const known = get_quote_by_mint(mint) ?? quote_cache.get(mint.toBase58());
    if (known) return known;
    const account = await global.CONNECTION.getAccountInfo(mint, COMMITMENT);
    if (!account || (!account.owner.equals(TOKEN_PROGRAM_ID) && !account.owner.equals(TOKEN_2022_PROGRAM_ID)))
        throw new Error(`Invalid quote mint: ${mint}`);
    const decoded = decode_mint_account(account);
    const result = { mint, token_program: account.owner, decimals: decoded.decimals };
    quote_cache.set(mint.toBase58(), result);
    return result;
}

export async function prepare_quote_account(owner: Keypair, mint: PublicKey, amount?: bigint) {
    const quote = await get_quote_info(mint);
    const ata = await getAssociatedTokenAddress(mint, owner.publicKey, quote.token_program);
    const setup: TransactionInstruction[] = [
        createAssociatedTokenAccountIdempotentInstruction(owner, ata, owner.publicKey, mint, quote.token_program)
    ];
    const cleanup: TransactionInstruction[] = [];
    if (mint.equals(SOL_MINT)) {
        if (amount !== undefined && amount > 0n)
            setup.push(
                SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: ata, lamports: amount }),
                createSyncNativeInstruction(ata)
            );
        cleanup.push(createCloseAccountInstruction(ata, owner.publicKey, owner.publicKey));
    }
    return { ...quote, ata, setup, cleanup };
}

export function quote_metrics(raw_price: number, supply: bigint, quote_decimals: number, base_decimals = 6) {
    return {
        price_quote: (raw_price * 10 ** base_decimals) / 10 ** quote_decimals,
        mcap_quote: (raw_price * Number(supply)) / 10 ** quote_decimals
    };
}

export async function quote_price(mint: PublicKey): Promise<number> {
    const asset = await get_token_meta(mint);
    return asset.price_per_token ?? 0;
}
