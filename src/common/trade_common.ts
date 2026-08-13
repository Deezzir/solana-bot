import {
    Keypair,
    LAMPORTS_PER_SOL,
    PublicKey,
    Signer,
    SystemProgram,
    TokenAmount,
    TransactionInstruction,
    VersionedTransaction,
    TransactionMessage,
    RpcResponseAndContext,
    ComputeBudgetProgram,
    Commitment,
    Finality,
    AddressLookupTableAccount,
    Transaction,
    AddressLookupTableProgram,
    ParsedTransactionWithMeta,
    ParsedInstruction,
    PartiallyDecodedInstruction
} from '@solana/web3.js';
import {
    AccountLayout,
    TOKEN_2022_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    createAssociatedTokenAccountIdempotentInstruction,
    createBurnInstruction,
    createCloseAccountInstruction,
    createTransferInstruction,
    getAssociatedTokenAddressSync,
    getMint
} from '@solana/spl-token';
import {
    COMMITMENT,
    JITO_ENDPOINTS,
    PriorityLevel,
    TRADE_DEFAULT_TOKEN_DECIMALS,
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
    HELIUS_RPC
} from '../constants';
import * as common from './common';
import bs58 from 'bs58';
import { rate_limit_request } from './rate_limit';

export type SerializedMintMeta = {
    token_usd_mc: number;
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

export type ProgramAccount = { pubkey: PublicKey; account: { data: Buffer } };
type HeliusProgramAccountsPage = {
    accounts: { pubkey: string; account: { data: [string, string] } }[];
    paginationKey: string | null;
};

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
    data_slice?: { offset: number; length: number }
): Promise<ProgramAccount[]> {
    const accounts: ProgramAccount[] = [];
    let pagination_key: string | null = null;
    do {
        const options = { encoding: 'base64', commitment: COMMITMENT, limit: 1000, filters, dataSlice: data_slice };
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
    } while (pagination_key);
    return accounts;
}

export interface IMintMeta {
    readonly token_name: string;
    readonly token_symbol: string;
    readonly token_mint: string;
    readonly token_usd_mc: number;
    readonly migrated: boolean;
    readonly platform_fee: number;
    readonly mint_pubkey: PublicKey;
    readonly token_program: PublicKey;

    serialize(): SerializedMintMeta;
}

export interface ClaimableAsset {
    mint: PublicKey;
    raw_amount: bigint;
    decimals: number;
    source: 'creator_reward' | 'position_reward' | 'cashback_reward' | 'token_incentive_reward';
}
export interface IProgramTrader {
    get_name(): string;
    get_lta_addresses(): PublicKey[];
    deserialize_mint_meta(data: SerializedMintMeta): IMintMeta;
    buy_token(
        sol_amount: number,
        buyer: Signer,
        mint_meta: IMintMeta,
        slippage: number,
        priority?: PriorityLevel,
        protection_tip?: number
    ): Promise<String>;
    sell_token(
        token_amount: TokenAmount,
        seller: Signer,
        mint_meta: Partial<IMintMeta>,
        slippage: number,
        priority?: PriorityLevel,
        protection_tip?: number
    ): Promise<String>;
    buy_token_instructions(
        sol_amount: number,
        buyer: Signer,
        mint_meta: IMintMeta,
        slippage: number
    ): Promise<[TransactionInstruction[], AddressLookupTableAccount[]?]>;
    sell_token_instructions(
        token_amount: TokenAmount,
        seller: Signer,
        mint_meta: IMintMeta,
        slippage: number
    ): Promise<[TransactionInstruction[], AddressLookupTableAccount[]?]>;
    buy_sell_instructions(
        sol_amount: number,
        trader: Signer,
        mint_meta: IMintMeta,
        slippage: number
    ): Promise<[TransactionInstruction[], TransactionInstruction[], AddressLookupTableAccount[]?]>;
    buy_sell_bundle(
        sol_amount: number,
        trader: Signer,
        mint_meta: IMintMeta,
        tip: number,
        slippage: number,
        priority?: PriorityLevel
    ): Promise<String>;
    buy_sell(
        sol_amount: number,
        trader: Signer,
        mint_meta: IMintMeta,
        slippage: number,
        interval_ms?: number,
        priority?: PriorityLevel,
        protection_tip?: number
    ): Promise<[String, String]>;
    create_token(
        mint: Keypair,
        creator: Signer,
        token_name: string,
        token_symbol: string,
        meta_cid: string,
        sol_amount?: number,
        traders?: [Signer, number][],
        bundle_tip?: number,
        priority?: PriorityLevel,
        config?: object
    ): Promise<String>;
    create_token_metadata(meta: common.IPFSMetadata, image_path: string): Promise<string>;
    get_random_mints(count: number): Promise<IMintMeta[]>;
    get_mint_meta(mint: PublicKey, sol_price?: number): Promise<IMintMeta | undefined>;
    update_mint_meta(mint_meta: IMintMeta, sol_price?: number): Promise<IMintMeta>;
    subscribe_mint_meta(mint_meta: IMintMeta, callback: (mint_meta: IMintMeta) => void): Promise<() => void>;
    update_mint_meta_reserves(mint_meta: IMintMeta, amount: number | TokenAmount): IMintMeta;
    default_mint_meta(mint: PublicKey, sol_price?: number, data?: object): Promise<IMintMeta>;
    get_trader_fees(trader: Signer): Promise<ClaimableAsset[]>;
    claim_trader_fees(trader: Signer, assets: ClaimableAsset[], priority?: PriorityLevel): Promise<String>;
}

type PriorityOptions = {
    accounts?: string[];
    transaction?: {
        instructions: TransactionInstruction[];
        signers: Signer[];
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
    price_sol: number;
    mcap_sol: number;
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

export async function retry_get_tx(
    signature: string,
    retries: number = TRADE_RETRIES
): Promise<ParsedTransactionWithMeta | null> {
    while (retries > 0) {
        try {
            const transaction = await global.CONNECTION.getParsedTransaction(signature, {
                maxSupportedTransactionVersion: 0,
                commitment: COMMITMENT
            });
            if (transaction) return transaction;
        } catch (error) {}
        retries--;
        await common.sleep(TRADE_RETRY_INTERVAL_MS * (retries + 1));
    }
    return null;
}

export async function retry_send_lamports(
    amount: number,
    sender: Keypair,
    receiver: PublicKey,
    priority?: PriorityLevel,
    retries: number = TRADE_RETRIES
): Promise<String> {
    while (retries > 0) {
        try {
            return await send_lamports(amount, sender, receiver, priority);
        } catch (error) {
            const balance = await get_balance(sender.publicKey, COMMITMENT);
            if (balance === 0) throw new Error(`Sender has no balance.`);
            if (balance < amount) amount = balance;
            retries--;
        }
        await common.sleep(TRADE_RETRY_INTERVAL_MS * (retries + 1));
    }
    throw new Error('Send lamports failed after multiple attempts');
}

export async function retry_send_bundle(
    bundle_instructions: TransactionInstruction[][],
    bundle_signers: Signer[][],
    bundle_tip: number,
    priority?: PriorityLevel,
    ltas?: AddressLookupTableAccount[],
    retries: number = TRADE_RETRIES
): Promise<String> {
    while (retries > 0) {
        try {
            return await send_bundle(bundle_instructions, bundle_signers, bundle_tip, priority, ltas);
        } catch (error) {
            common.log(common.red(`Failed to send bundle: ${error}`));
            retries--;
        }
        await common.sleep(JITO_BUNDLE_INTERVAL_MS * (retries + 1));
    }
    throw new Error('Send bundle failed after multiple attempts');
}

export async function retry_send_tx(
    instructions: TransactionInstruction[],
    signers: Signer[],
    priority?: PriorityLevel,
    protection_tip?: number,
    alts?: AddressLookupTableAccount[],
    retries: number = TRADE_RETRIES
): Promise<String> {
    while (retries > 0) {
        try {
            return await send_tx(instructions, signers, priority, protection_tip, alts);
        } catch (error) {
            common.log(common.red(`Failed to send transaction: ${error}`));
            retries--;
        }
        await common.sleep(TRADE_RETRY_INTERVAL_MS * (retries + 1));
    }
    throw new Error('Send transaction failed after multiple attempts');
}

export function calc_ata(owner: PublicKey, mint: PublicKey, token_program: PublicKey = TOKEN_PROGRAM_ID): PublicKey {
    return getAssociatedTokenAddressSync(mint, owner, true, token_program);
}

export function calc_token_balance_changes(
    tx: ParsedTransactionWithMeta,
    account: PublicKey,
    mint?: string
): TxBalanceChanges | null {
    if (!tx.meta || tx.meta.err || !tx.meta.postTokenBalances || !tx.meta.preTokenBalances) return null;

    const change_sol_index = tx.transaction.message.accountKeys.findIndex((acc) => acc.pubkey.equals(account));
    const pre_token_balance_index = tx.meta.preTokenBalances.findIndex(
        (change) => change.owner === account.toString() && (!mint || change.mint === mint)
    );
    const post_token_balance_index = tx.meta.postTokenBalances.findIndex(
        (change) => change.owner === account.toString() && (!mint || change.mint === mint)
    );

    const pre_sol_balance = tx.meta.preBalances[change_sol_index] / LAMPORTS_PER_SOL;
    const post_sol_balance = tx.meta.postBalances[change_sol_index] / LAMPORTS_PER_SOL;

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
        if ('parsed' in instr && instr.programId.equals(SYSTEM_PROGRAM_ID) && instr.parsed.type === 'transfer') {
            tips_instructions.push(instr);
        }
        break;
    }
    const tips =
        tips_instructions.reduce((sum: number, cur: ParsedInstruction) => sum + cur.parsed.info.lamports, 0) /
        LAMPORTS_PER_SOL;

    let tx_fees = 0;
    const compute_budget_data = tx.transaction.message.instructions
        .filter(
            (instr): instr is PartiallyDecodedInstruction =>
                'data' in instr && instr.programId.equals(COMPUTE_BUDGET_PROGRAM_ID)
        )
        .map((instr) => {
            const buff = Buffer.from(bs58.decode(instr.data));
            if (buff.length === 5) return common.read_biguint_le(buff, 1, 4);
            if (buff.length === 9) return common.read_biguint_le(buff, 1, 8);
            throw new Error(`Invalid compute budget instruction data length: ${buff.length}`);
        });
    if (compute_budget_data.length === 2) {
        tx_fees = Number(compute_budget_data[0] * compute_budget_data[1]) / (LAMPORTS_PER_SOL * 10 ** 6);
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
    commitment: Finality = 'finalized',
    token_program: PublicKey = TOKEN_PROGRAM_ID
): Promise<CostBasis | null> {
    const token_ata = calc_ata(account, mint, token_program);

    const signatures = (await global.CONNECTION.getSignaturesForAddress(token_ata, {}, commitment)).map(
        (info) => info.signature
    );
    if (signatures.length === 0) return null;

    const txs = await global.CONNECTION.getParsedTransactions(signatures, {
        maxSupportedTransactionVersion: 0,
        commitment: commitment
    });
    if (txs.length === 0) return null;

    const changes = txs
        .filter((tx) => tx !== null)
        .map((tx) => calc_token_balance_changes(tx, account))
        .filter((change) => change !== null);
    // .filter((change) => change.change_tokens > 0);

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

export async function get_balance(pubkey: PublicKey, commitment: Commitment = 'finalized'): Promise<number> {
    return await global.CONNECTION.getBalance(pubkey, { commitment });
}

export async function get_token_balance(
    owner: PublicKey,
    mint: PublicKey,
    commitment: Commitment = 'finalized',
    program_id: PublicKey = TOKEN_PROGRAM_ID
): Promise<TokenAmount> {
    try {
        const assoc_address = calc_ata(owner, mint, program_id);
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

function get_random_jito_tip_account(): PublicKey {
    const random_tip_account = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
    return new PublicKey(random_tip_account);
}

function get_random_sender_tip_account(): PublicKey {
    const random_tip_account = SENDER_TIP_ACCOUNTS[Math.floor(Math.random() * SENDER_TIP_ACCOUNTS.length)];
    return new PublicKey(random_tip_account);
}

function create_versioned_tx(
    signers: Signer[],
    instructions: TransactionInstruction[],
    ctx: RpcResponseAndContext<Readonly<{ blockhash: string; lastValidBlockHeight: number }>>,
    alts?: AddressLookupTableAccount[]
): VersionedTransaction {
    if (instructions.length === 0) throw new Error(`No instructions provided.`);
    if (signers.length === 0) throw new Error(`No signers provided.`);

    const versioned_tx = new VersionedTransaction(
        new TransactionMessage({
            payerKey: signers[0].publicKey,
            recentBlockhash: ctx.value.blockhash,
            instructions: instructions
        }).compileToV0Message(alts)
    );
    versioned_tx.sign(signers);
    return versioned_tx;
}

function cleanup_ttl_cache<T>(cache: Map<string, { value: T; expires_at: number }>, now: number): void {
    if (cache.size <= CACHE_SIZE_MAX) return;
    for (const [key, item] of cache.entries()) {
        if (item.expires_at <= now) cache.delete(key);
    }
}

async function send_jito_bundle(serialized_txs: string[]): Promise<string[]> {
    const requests = JITO_ENDPOINTS.map((endpoint) =>
        fetch(`${endpoint}/bundles`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'sendBundle',
                params: [
                    serialized_txs,
                    {
                        encoding: 'base64'
                    }
                ]
            })
        })
    );
    const responses = await Promise.all(
        requests.map((resp) =>
            resp
                .then((resp) => resp.json())
                .then((data) => {
                    if (data.error || !data.result) throw new Error(data.error?.message || 'Jito bundle rejected.');
                    return data.result as string;
                })
                .catch((err) => err)
        )
    );
    return responses.filter((resp) => !(resp instanceof Error) && resp !== undefined);
}

async function send_jito_tx(serialized_tx: string): Promise<string[]> {
    const requests = JITO_ENDPOINTS.map((endpoint) =>
        fetch(`${endpoint}/transactions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'sendTransaction',
                params: [
                    serialized_tx,
                    {
                        encoding: 'base64'
                    }
                ]
            })
        })
    );
    const responses = await Promise.all(
        requests.map((resp) =>
            resp
                .then((resp) => resp.json())
                .then((data) => {
                    if (data.error || !data.result)
                        throw new Error(data.error?.message || 'Jito transaction rejected.');
                    return data.result as string;
                })
                .catch((err) => err)
        )
    );
    return responses.filter((resp) => !(resp instanceof Error) && resp !== undefined);
}

async function send_sender_tx(serialized_tx: string): Promise<string[]> {
    const requests = SENDER_ENDPOINTS.map((endpoint) =>
        rate_limit_request(() =>
            fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: Date.now().toString(),
                    method: 'sendTransaction',
                    params: [
                        serialized_tx,
                        {
                            encoding: 'base64',
                            skipPreflight: true, // Required for Sender
                            maxRetries: 0
                        }
                    ]
                })
            })
        )
    );
    const responses = await Promise.all(
        requests.map((resp) =>
            resp
                .then((resp) => resp.json())
                .then((data) => {
                    if (data.error || !data.result)
                        throw new Error(data.error?.message || 'Sender transaction rejected.');
                    return data.result as string;
                })
                .catch((err) => err)
        )
    );
    return responses.filter((resp) => !(resp instanceof Error) && resp !== undefined);
}

async function send_protected_tx(
    instructions: TransactionInstruction[],
    signers: Signer[],
    tip: number,
    alts?: AddressLookupTableAccount[],
    provider: 'sender' | 'jito' = 'sender'
): Promise<String> {
    if (tip < JITO_MIN_TIP) throw new Error(`Tip is too low, minimum is ${JITO_MIN_TIP} `);
    instructions = instructions.filter(Boolean);
    if (instructions.length === 0) throw new Error(`No instructions provided.`);
    if (signers.length === 0) throw new Error(`No signers provided.`);

    const tip_account = provider === 'sender' ? get_random_sender_tip_account() : get_random_jito_tip_account();

    instructions.push(
        SystemProgram.transfer({
            fromPubkey: signers[0].publicKey,
            toPubkey: tip_account,
            lamports: tip * LAMPORTS_PER_SOL
        })
    );

    const ctx = await global.CONNECTION.getLatestBlockhashAndContext(COMMITMENT);
    const versioned_tx = create_versioned_tx(signers, instructions, ctx, alts);
    const jito_tx_signature = bs58.encode(versioned_tx.signatures[0]);
    const serialized_tx = Buffer.from(versioned_tx.serialize()).toString('base64');

    const responses = provider === 'sender' ? await send_sender_tx(serialized_tx) : await send_jito_tx(serialized_tx);
    if (responses.length > 0) {
        await check_transaction_status(jito_tx_signature, ctx);
        return responses[0];
    } else {
        throw new Error(`Failed to send the protected transaction, no successful response from the JITO endpoints`);
    }
}

export async function send_bundle(
    instructions: TransactionInstruction[][],
    signers: Signer[][],
    tip: number,
    priority?: PriorityLevel,
    alts?: AddressLookupTableAccount[]
): Promise<String> {
    if (tip < JITO_MIN_TIP) throw new Error(`Tip is too low, minimum is ${JITO_MIN_TIP} `);
    instructions = instructions.filter(Boolean);
    if (instructions.length > JITO_BUNDLE_SIZE || instructions.length === 0)
        throw new Error(`Bundle size exceeded or size is 0.`);
    if (instructions.length !== signers.length) throw new Error(`Instructions and signers length mismatch.`);
    for (let i = 0; i < instructions.length; i++) {
        if (instructions[i].length === 0) throw new Error(`No instructions provided for tx ${i}.`);
        if (signers[i].length === 0) throw new Error(`No signers provided for tx ${i}.`);
        instructions[i] = instructions[i].filter(Boolean);
    }

    let priority_fee: number | undefined;
    if (priority && !priority_fee) {
        priority_fee = await get_priority_fee({
            priority_level: priority,
            transaction: {
                instructions: instructions[0],
                signers: signers[0]
            }
        });
    }

    const jito_tip_account = get_random_jito_tip_account();
    const ctx = await global.CONNECTION.getLatestBlockhashAndContext(COMMITMENT);
    let signature: string;

    let serialized_txs = [];
    for (let i = 0; i < instructions.length; i++) {
        if (priority_fee)
            instructions[i].unshift(
                ComputeBudgetProgram.setComputeUnitPrice({
                    microLamports: priority_fee!
                })
            );
        if (i === instructions.length - 1) {
            instructions[i].push(
                SystemProgram.transfer({
                    fromPubkey: signers[i][0].publicKey,
                    toPubkey: jito_tip_account,
                    lamports: tip * LAMPORTS_PER_SOL
                })
            );
        }
        const versioned_tx = create_versioned_tx(signers[i], instructions[i], ctx, alts);

        if (i === instructions.length - 1) signature = bs58.encode(versioned_tx.signatures[0]);
        serialized_txs.push(Buffer.from(versioned_tx.serialize()).toString('base64'));
    }

    const responses = await send_jito_bundle(serialized_txs);
    if (responses.length > 0) {
        await check_transaction_status(signature!, ctx);
        return responses[0];
    } else {
        throw new Error(`Failed to send the bundle, no successful response from the JITO endpoints`);
    }
}

async function is_blockhash_expired(last_valid_block_height: number): Promise<boolean> {
    let current_block_height = await global.CONNECTION.getBlockHeight(COMMITMENT);
    return last_valid_block_height - current_block_height < 0;
}

async function check_transaction_status(
    signature: string,
    context: RpcResponseAndContext<Readonly<{ blockhash: string; lastValidBlockHeight: number }>>,
    finality: Finality = 'confirmed'
): Promise<void> {
    const retry_interval = 1000;
    while (true) {
        const { value: status } = await CONNECTION.getSignatureStatus(signature);

        if (
            status &&
            (status.confirmationStatus === finality ||
                (finality === 'confirmed' && status.confirmationStatus === 'finalized'))
        ) {
            const tx = await CONNECTION.getTransaction(signature, {
                maxSupportedTransactionVersion: 0,
                commitment: finality
            });
            if (tx) {
                if (tx.meta?.err === null) return;
                if (tx.meta?.err !== null)
                    throw new Error(`Transaction failed with an error | Signature: ${signature} `);
            }
        }

        const is_expired = await is_blockhash_expired(context.value.lastValidBlockHeight);
        if (is_expired) throw new Error('Blockhash has expired.');

        await common.sleep(retry_interval);
    }
}

const priority_cache = new Map<string, { value: number; expires_at: number }>();
const priority_cache_inflight = new Map<string, Promise<number>>();
async function get_priority_fee(priority_opts: PriorityOptions): Promise<number> {
    const get_priority_cache_key = (priority_opts: PriorityOptions): string => {
        const priority = (priority_opts.priority_level || 'recommended').toLowerCase();
        const tx_shape = priority_opts.transaction
            ? priority_opts.transaction.instructions.map((ix) => `${ix.programId.toBase58()}`).join('|')
            : 'none';
        return `${priority}::${tx_shape}`;
    };

    if (!priority_opts.transaction)
        throw new Error(`Transaction instructions and signers are required to get priority fee estimate.`);

    const now = Date.now();
    cleanup_ttl_cache(priority_cache, now);

    const cache_key = get_priority_cache_key(priority_opts);
    const cached = priority_cache.get(cache_key);
    if (cached && cached.expires_at > now) return cached.value;
    if (cached) priority_cache.delete(cache_key);

    const in_flight = priority_cache_inflight.get(cache_key);
    if (in_flight) return in_flight;

    const fetch_priority_fee = (async () => {
        let encoded_tx: string | undefined;
        if (priority_opts.transaction) {
            const { blockhash, lastValidBlockHeight } = await global.CONNECTION.getLatestBlockhash(COMMITMENT);
            const { instructions, signers, alts } = priority_opts.transaction;
            if (alts?.length) {
                const tx = new VersionedTransaction(
                    new TransactionMessage({
                        payerKey: signers[0].publicKey,
                        recentBlockhash: blockhash,
                        instructions
                    }).compileToV0Message(alts)
                );
                tx.sign(signers);
                encoded_tx = bs58.encode(tx.serialize());
            } else {
                const tx = new Transaction({
                    blockhash: blockhash,
                    lastValidBlockHeight: lastValidBlockHeight,
                    feePayer: signers[0].publicKey
                }).add(...instructions);
                encoded_tx = bs58.encode(tx.serialize({ verifySignatures: false, requireAllSignatures: false }));
            }
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

        const fee = Math.floor(response.priorityFeeEstimate || 0);
        priority_cache.set(cache_key, { value: fee, expires_at: Date.now() + PRIORITY_FEE_TTL_MS });
        return fee;
    })().finally(() => {
        priority_cache_inflight.delete(cache_key);
    });

    priority_cache_inflight.set(cache_key, fetch_priority_fee);
    return fetch_priority_fee;
}

async function send_smart_tx(
    instructions: TransactionInstruction[],
    signers: Signer[],
    protection_tip?: number,
    alts?: AddressLookupTableAccount[]
): Promise<String> {
    instructions = instructions.filter(Boolean);
    if (instructions.length === 0) throw new Error(`No instructions provided.`);
    if (signers.length === 0) throw new Error(`No signers provided.`);

    if (instructions.some((instruction) => instruction.programId.equals(ComputeBudgetProgram.programId)))
        throw new Error('Smart transactions cannot include compute budget instructions.');

    const ctx = await global.CONNECTION.getLatestBlockhashAndContext(COMMITMENT);
    const priority_fee = await get_priority_fee({
        transaction: { instructions, signers, alts }
    });
    const simulation_instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...instructions];
    const simulation_tx = create_versioned_tx(signers, simulation_instructions, ctx, alts);
    const simulation = await global.CONNECTION.simulateTransaction(simulation_tx, {
        sigVerify: true,
        commitment: COMMITMENT
    });
    if (simulation.value.err || !simulation.value.unitsConsumed)
        throw new Error(`Smart transaction simulation failed: ${JSON.stringify(simulation.value.err)}`);

    const final_instructions = [
        ComputeBudgetProgram.setComputeUnitLimit({
            units: Math.max(1_000, Math.ceil(simulation.value.unitsConsumed * 1.1))
        }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priority_fee }),
        ...instructions
    ];
    if (protection_tip) {
        final_instructions.push(
            SystemProgram.transfer({
                fromPubkey: signers[0].publicKey,
                toPubkey: get_random_sender_tip_account(),
                lamports: protection_tip * LAMPORTS_PER_SOL
            })
        );
    }
    const transaction = create_versioned_tx(signers, final_instructions, ctx, alts);
    const signature = bs58.encode(transaction.signatures[0]);
    if (protection_tip) {
        const responses = await send_sender_tx(Buffer.from(transaction.serialize()).toString('base64'));
        if (responses.length === 0) throw new Error('Sender did not accept the smart transaction.');
    } else {
        await global.CONNECTION.sendTransaction(transaction, {
            skipPreflight: true,
            preflightCommitment: COMMITMENT,
            maxRetries: TRADE_TX_RETRIES
        });
    }
    await check_transaction_status(signature, ctx);
    return signature;
}

export async function send_tx(
    instructions: TransactionInstruction[],
    signers: Signer[],
    priority?: PriorityLevel,
    protection_tip?: number,
    alts?: AddressLookupTableAccount[]
): Promise<String> {
    const tx_instructions = instructions.filter(Boolean);
    if (instructions.length === 0) throw new Error(`No instructions provided.`);
    if (signers.length === 0) throw new Error(`No signers provided.`);

    if (!priority) return send_smart_tx(tx_instructions, signers, protection_tip, alts);

    const fee = await get_priority_fee({
        priority_level: priority,
        transaction: { instructions: tx_instructions, signers }
    });
    tx_instructions.unshift(
        ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: fee
        }),
        ComputeBudgetProgram.setComputeUnitLimit({
            units: 1_600_000
        })
    );

    if (protection_tip) return send_protected_tx(tx_instructions, signers, protection_tip, alts);

    const ctx = await global.CONNECTION.getLatestBlockhashAndContext(COMMITMENT);
    const versioned_tx = create_versioned_tx(signers, tx_instructions, ctx, alts);
    const signature = await global.CONNECTION.sendTransaction(versioned_tx, {
        skipPreflight: false,
        preflightCommitment: COMMITMENT,
        maxRetries: TRADE_TX_RETRIES
    });
    await check_transaction_status(signature, ctx);
    return signature;
}

export async function get_balance_change(signature: string, address: PublicKey): Promise<number> {
    try {
        const tx_details = await global.CONNECTION.getTransaction(signature, {
            commitment: COMMITMENT,
            maxSupportedTransactionVersion: 0
        });
        if (!tx_details) throw new Error(`Transaction not found: ${signature} `);
        const balance_index = tx_details?.transaction.message
            .getAccountKeys()
            .staticAccountKeys.findIndex((i) => i.equals(address));
        if (balance_index !== undefined && balance_index !== -1) {
            const pre_balance = tx_details?.meta?.preBalances[balance_index] || 0;
            const post_balance = tx_details?.meta?.postBalances[balance_index] || 0;
            return (pre_balance - post_balance) / LAMPORTS_PER_SOL;
        }
        return 0;
    } catch (err) {
        throw new Error(`Failed to get the balance change: ${err} `);
    }
}

export async function send_lamports(
    lamports: number,
    sender: Signer,
    receiver: PublicKey,
    priority?: PriorityLevel
): Promise<String> {
    lamports = Math.floor(lamports);
    let instructions = [
        SystemProgram.transfer({
            fromPubkey: sender.publicKey,
            toPubkey: receiver,
            lamports: lamports
        })
    ];

    if (priority) {
        const units = 500;
        const fees = await get_priority_fee({
            priority_level: priority,
            transaction: {
                instructions: instructions,
                signers: [sender]
            }
        });
        const transfer_lamports = lamports - 5000 - Math.ceil((fees * units) / 10 ** 6);
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

    const ctx = await global.CONNECTION.getLatestBlockhashAndContext(COMMITMENT);
    const versioned_tx = create_versioned_tx([sender], instructions, ctx);
    const signature = await global.CONNECTION.sendTransaction(versioned_tx, {
        skipPreflight: false,
        preflightCommitment: COMMITMENT,
        maxRetries: TRADE_TX_RETRIES
    });
    await check_transaction_status(signature, ctx);
    return signature;
}

export async function send_tokens(
    token_amount: TokenAmount,
    mint: PublicKey,
    sender: Signer,
    receiver: PublicKey,
    priority?: PriorityLevel,
    token_program: PublicKey = TOKEN_PROGRAM_ID
): Promise<String> {
    if (token_amount.uiAmount === null) throw new Error(`Invalid token amount.`);
    const token_amount_raw = BigInt(token_amount.amount);

    const receiver_ata = calc_ata(receiver, mint, token_program);
    const sender_ata = calc_ata(sender.publicKey, mint, token_program);

    const instructions = [
        createAssociatedTokenAccountIdempotentInstruction(
            sender.publicKey,
            receiver_ata,
            receiver,
            mint,
            token_program
        ),
        createTransferInstruction(sender_ata, receiver_ata, sender.publicKey, token_amount_raw, [], token_program)
    ];

    return await send_tx(instructions, [sender], priority);
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
                data: AccountLayout.decode(acc.account.data)
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

    if ((await get_balance(owner.publicKey, COMMITMENT)) === 0) {
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
    for (const chunk of common.chunks(accounts_to_close, burn ? 7 : 15)) {
        const instructions = chunk.flatMap((account) => {
            const close = createCloseAccountInstruction(
                account.pubkey,
                owner.publicKey,
                owner.publicKey,
                undefined,
                account.programId
            );
            if (!burn || account.data.amount === 0n || account.data.mint.equals(SOL_MINT)) return [close];
            return [
                createBurnInstruction(
                    account.pubkey,
                    account.data.mint,
                    owner.publicKey,
                    account.data.amount,
                    [],
                    account.programId
                ),
                close
            ];
        });
        for (let attempt = 0; attempt <= TRADE_RETRIES; attempt++) {
            try {
                const signature = await send_tx(instructions, [owner], PriorityLevel.DEFAULT);
                closed_cnt += chunk.length;
                closed.push({ count: chunk.length, attempts: attempt + 1, signature });
                break;
            } catch (err) {
                if (attempt === TRADE_RETRIES) {
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

export function get_sol_token_amount(amount: number): TokenAmount {
    return {
        uiAmount: amount,
        amount: Math.floor(amount * LAMPORTS_PER_SOL).toString(),
        decimals: Math.log10(LAMPORTS_PER_SOL)
    } as TokenAmount;
}

export function get_token_amount(amount: number, decimals: number): TokenAmount {
    if (decimals < 0 || decimals > 18) throw new Error(`Invalid decimals: ${decimals} `);
    return {
        uiAmount: amount,
        amount: (amount * 10 ** decimals).toString(),
        decimals: decimals
    } as TokenAmount;
}

export function get_token_amount_by_percent(token_amount: TokenAmount, percent: number): TokenAmount {
    if (percent < 0.0 || percent > 1.0) throw new Error(`Invalid percent: ${percent} `);
    if (token_amount.uiAmount === null) throw new Error(`Invalid token amount.`);
    if (percent === 1.0) return token_amount;
    return {
        uiAmount: Math.floor(token_amount.uiAmount * percent),
        amount: ((BigInt(token_amount.amount) * BigInt(Math.floor(percent * 10000))) / BigInt(10000)).toString(),
        decimals: token_amount.decimals
    } as TokenAmount;
}

export async function create_lta(payer: Signer): Promise<[PublicKey, String]> {
    const commitment: Commitment = 'finalized';
    let retries = TRADE_RETRIES;

    while (retries > 0) {
        try {
            const recent_slot = await global.CONNECTION.getSlot(commitment);
            const [instruction, lt_address] = AddressLookupTableProgram.createLookupTable({
                authority: payer.publicKey,
                payer: payer.publicKey,
                recentSlot: recent_slot
            });
            const signature = await send_tx([instruction], [payer], PriorityLevel.HIGH);
            return [lt_address, signature];
        } catch (err) {
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

export async function extend_lta(lta: PublicKey, payer: Signer, addresses: PublicKey[]): Promise<String[]> {
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

export async function close_ltas(payer: Signer, ltas: readonly AddressLookupTableAccount[]): Promise<String[]> {
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
    authority: Signer,
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
    funder: Signer,
    wallets: Keypair[],
    mint: PublicKey
): Promise<AddressLookupTableAccount> {
    try {
        const [created_lt] = await create_lta(funder);
        const token_atas = wallets.map((keypair) => calc_ata(keypair.publicKey, mint));
        const wsol_atas = wallets.map((keypair) => calc_ata(keypair.publicKey, SOL_MINT));
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
        throw new Error(`Failed to generate trade LTA: ${error}`);
    }
}

export async function burn_token(amount: TokenAmount, owner: Signer, mint: PublicKey): Promise<String> {
    if (amount.uiAmount === null) throw new Error(`Invalid token amount.`);
    const ata = calc_ata(owner.publicKey, mint);
    const instructions = [createBurnInstruction(ata, mint, owner.publicKey, BigInt(amount.amount))];
    return await send_tx(instructions, [owner]);
}
