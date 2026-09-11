import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { PublicKey, type Connection, type ParsedTransactionWithMeta } from '@solana/web3.js';

const original_env = {
    HELIUS_API_KEY: process.env.HELIUS_API_KEY,
    PINATA_IPFS_JWT: process.env.PINATA_IPFS_JWT
};
process.env.HELIUS_API_KEY = 'unit-test';
process.env.PINATA_IPFS_JWT ||= 'unit-test';

const { get_wallet_pnl } = await import('../src/subcommands/pnl');
const { SOL_MINT } = await import('../src/constants');

const wallet = new PublicKey(new Uint8Array(32).fill(1));
const mint_a = new PublicKey(new Uint8Array(32).fill(2));
const mint_b = new PublicKey(new Uint8Array(32).fill(3));
const token_program = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const original_connection = global.CONNECTION;
const original_fetch = global.fetch;
const original_set_timeout = globalThis.setTimeout;

type TokenChange = {
    mint: PublicKey;
    pre: number;
    post: number;
};

function transaction(
    signature: string,
    timestamp: number,
    pre_sol: number,
    post_sol: number,
    token_changes: TokenChange[],
    priority_fee_sol = 0,
    failed = false
): ParsedTransactionWithMeta {
    const token_balance = (change: TokenChange, amount: number) => ({
        accountIndex: 1,
        mint: change.mint.toBase58(),
        owner: wallet.toBase58(),
        programId: token_program.toBase58(),
        uiTokenAmount: {
            amount: String(amount * 1_000_000),
            decimals: 6,
            uiAmount: amount,
            uiAmountString: String(amount)
        }
    });

    return {
        blockTime: BigInt(timestamp),
        meta: {
            err: failed ? { InstructionError: [0, 'Custom'] } : null,
            fee: 5_000n,
            innerInstructions: null,
            loadedAddresses: { readonly: [], writable: [] },
            logMessages: null,
            postBalances: [BigInt(Math.round(post_sol * 1_000_000_000))],
            postTokenBalances: token_changes.map((change) => token_balance(change, change.post)),
            preBalances: [BigInt(Math.round(pre_sol * 1_000_000_000))],
            preTokenBalances: token_changes.map((change) => token_balance(change, change.pre)),
            rewards: null
        },
        slot: 1n,
        transaction: {
            message: {
                accountKeys: [{ pubkey: wallet, signer: true, source: 'transaction', writable: true }],
                addressTableLookups: [],
                instructions: [],
                recentBlockhash: '11111111111111111111111111111111',
                transactionConfig: { priorityFeeLamports: BigInt(Math.round(priority_fee_sol * 1_000_000_000)) }
            },
            signatures: [signature]
        },
        version: 1
    } as unknown as ParsedTransactionWithMeta;
}

function install_boundaries(with_priority_fees = false): {
    signature_requests: { limit?: number; before?: string }[];
    transaction_requests: string[][];
    metadata_requests: string[];
} {
    const first_page = Array.from({ length: 50 }, (_, index) => ({
        blockTime: 200 - index,
        confirmationStatus: 'confirmed' as const,
        err: null,
        memo: null,
        signature: `page-1-${index}`,
        slot: 100 - index
    }));
    const second_page = [
        {
            blockTime: 100,
            confirmationStatus: 'confirmed' as const,
            err: null,
            memo: null,
            signature: 'page-2-buy',
            slot: 1
        }
    ];
    const transactions = new Map<string, ParsedTransactionWithMeta | null>([
        [
            'page-1-0',
            transaction(
                'sell-a',
                300,
                50,
                with_priority_fees ? 51.195 : 51.2,
                [{ mint: mint_a, pre: 10, post: 6 }],
                with_priority_fees ? 0.005 : 0
            )
        ],
        ['page-1-1', transaction('failed-a', 250, 40, 39, [{ mint: mint_a, pre: 6, post: 11 }], 0, true)],
        ['page-1-3', transaction('non-token', 225, 30, 29.9, [])],
        ['page-1-4', transaction('receive-b', 200, 20, 20, [{ mint: mint_b, pre: 0, post: 5 }])],
        [
            'page-2-buy',
            transaction(
                'buy-a',
                100,
                100,
                with_priority_fees ? 97.99 : 98,
                [
                    { mint: mint_a, pre: 0, post: 10 },
                    { mint: SOL_MINT, pre: 1, post: 1 }
                ],
                with_priority_fees ? 0.01 : 0
            )
        ]
    ]);
    const signature_requests: { limit?: number; before?: string }[] = [];
    const transaction_requests: string[][] = [];
    const metadata_requests: string[] = [];
    const methods = {
        getAccountInfo: async (mint: PublicKey) => {
            if (!mint.equals(mint_a) && !mint.equals(mint_b)) throw new Error(`Unexpected mint account: ${mint}`);
            return { owner: token_program };
        },
        getParsedTransactions: async (signatures: string[], options: { maxSupportedTransactionVersion?: number }) => {
            expect(options).toEqual({ maxSupportedTransactionVersion: 1 });
            transaction_requests.push([...signatures]);
            return signatures.map((signature) => transactions.get(signature) ?? null);
        },
        getSignaturesForAddress: async (address: PublicKey, options: { limit?: number; before?: string }) => {
            expect(address.equals(wallet)).toBeTrue();
            signature_requests.push({ ...options });
            if (signature_requests.length === 1) return first_page;
            if (signature_requests.length === 2 && options.before === 'page-1-49') return second_page;
            throw new Error(`Unexpected signature request: ${JSON.stringify(options)}`);
        }
    };
    global.CONNECTION = new Proxy(methods, {
        get(target, property, receiver) {
            if (property in target) return Reflect.get(target, property, receiver);
            throw new Error(`Unexpected RPC call: ${String(property)}`);
        }
    }) as unknown as Connection;
    global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
        if (url.origin !== 'https://mainnet.helius-rpc.com' || !url.searchParams.has('api-key'))
            throw new Error(`Unexpected fetch URL: ${url}`);
        if (init?.method !== 'POST' || typeof init.body !== 'string') throw new Error('Unexpected fetch options');
        const body = JSON.parse(init.body) as { method?: string; params?: unknown[] };
        const mint = body.params?.[0];
        if (
            body.method !== 'getAsset' ||
            typeof mint !== 'string' ||
            (mint !== mint_a.toBase58() && mint !== mint_b.toBase58())
        )
            throw new Error(`Unexpected fetch body: ${init.body}`);
        metadata_requests.push(mint);
        const is_a = mint === mint_a.toBase58();
        return Response.json({
            jsonrpc: '2.0',
            id: 1,
            result: {
                content: { metadata: { name: is_a ? 'Token A' : 'Token B', symbol: is_a ? 'A' : 'B' } },
                creators: [],
                token_info: {
                    decimals: 6,
                    supply: 1_000_000,
                    price_info: { price_per_token: is_a ? 4 : 2 }
                }
            }
        });
    }) as typeof fetch;

    return { signature_requests, transaction_requests, metadata_requests };
}

beforeEach(() => {
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, _delay?: number, ...args: unknown[]) => {
        callback(...args);
        return 0;
    }) as unknown as typeof setTimeout;
});

afterEach(() => {
    global.fetch = original_fetch;
    globalThis.setTimeout = original_set_timeout;
    if (original_connection === undefined) delete (global as { CONNECTION?: Connection }).CONNECTION;
    else global.CONNECTION = original_connection;
});

afterAll(() => {
    for (const [name, value] of Object.entries(original_env)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
});

describe('get_wallet_pnl public boundary', () => {
    test('discovers, filters, and batches transactions while calculating ordered multi-mint PnL totals', async () => {
        const calls = install_boundaries();

        const result = await get_wallet_pnl(wallet, 20);

        expect(calls.signature_requests).toEqual([{ limit: 50 }, { limit: 50, before: 'page-1-49' }]);
        expect(calls.transaction_requests.map((signatures) => signatures.length)).toEqual([50, 1]);
        expect(calls.metadata_requests.sort()).toEqual([mint_a.toBase58(), mint_b.toBase58()].sort());
        expect(result.address).toEqual(wallet);
        expect(result.profit_loss).toHaveLength(2);
        const [token_a, token_b] = result.profit_loss;
        expect(token_a).toMatchObject({
            mint: mint_a.toBase58(),
            name: 'Token A',
            symbol: 'A',
            token_balance: 6
        });
        expect(
            token_a?.transactions.map(({ signature, change_tokens, timestamp }) => ({
                signature,
                change_tokens,
                timestamp
            }))
        ).toEqual([
            { signature: 'sell-a', change_tokens: -4, timestamp: 300 },
            { signature: 'buy-a', change_tokens: 10, timestamp: 100 }
        ]);
        expect(token_a?.transactions[0]?.change_sol).toBeCloseTo(1.2);
        expect(token_a?.transactions[1]?.change_sol).toBeCloseTo(-2);
        expect(token_a?.realized_pnl).toBeCloseTo(-0.8);
        expect(token_a?.unrealized_pnl).toBeCloseTo(1.2);
        expect(token_b).toMatchObject({
            mint: mint_b.toBase58(),
            name: 'Token B',
            symbol: 'B',
            realized_pnl: 0,
            unrealized_pnl: 0.5,
            token_balance: 5,
            transactions: [{ signature: 'receive-b', change_sol: 0, change_tokens: 5, timestamp: 200 }]
        });
        expect(result.total_realized_pnl).toBeCloseTo(-0.8);
        expect(result.total_unrealized_pnl).toBeCloseTo(1.7);
    });

    test('removes separately identified priority fees from both buy costs and sell proceeds', async () => {
        install_boundaries(true);

        const result = await get_wallet_pnl(wallet, 20);
        const token_a = result.profit_loss[0];

        expect(result.total_unrealized_pnl).toBeCloseTo(1.7);
        expect(token_a?.transactions[1]?.change_sol).toBeCloseTo(-2);
        expect(token_a?.transactions[0]?.change_sol).toBeCloseTo(1.2);
        expect(token_a?.realized_pnl).toBeCloseTo(-0.8);
        expect(result.total_realized_pnl).toBeCloseTo(-0.8);
    });
});
