import { afterAll, afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { Keypair, PublicKey, TransactionInstruction, type AddressLookupTableAccount } from '@solana/web3.js';

const original_env = {
    HELIUS_API_KEY: process.env.HELIUS_API_KEY,
    PINATA_IPFS_JWT: process.env.PINATA_IPFS_JWT,
    JUPITER_API_KEY: process.env.JUPITER_API_KEY
};
for (const name of Object.keys(original_env)) process.env[name] ||= 'unit-test';
const { Provider } = await import('../src/jupiter/trade_jupiter');
const jupiter = await import('../src/jupiter/swap_jupiter');
const trade = await import('../src/common/trade_common');
const common = await import('../src/common/common');
const original_fetch = global.fetch;
const test_api_key = process.env.JUPITER_API_KEY;
const { SOL_MINT } = await import('../src/constants');
const { TOKEN_PROGRAM_ID } = await import('../src/common/token');
const wallet = await Keypair.fromSeed(new Uint8Array(32).fill(80));
const provider = new Provider();
const meta = provider.deserialize_mint_meta({
    mint: wallet.publicKey.toBase58(),
    total_supply: '1000000000',
    token_quote_mc: 1,
    mint_pubkey: wallet.publicKey.toBase58(),
    token_program: TOKEN_PROGRAM_ID.toBase58(),
    migrated: false,
    platform_fee: 0,
    token_name: 'Token',
    token_symbol: 'TOK',
    token_mint: wallet.publicKey.toBase58()
});
const amount = { amount: '1000000000', decimals: 9, uiAmount: 1 };
const ix = new TransactionInstruction({ programId: PublicKey.default, keys: [], data: Buffer.from([1]) });

function quote(
    overrides: Partial<Awaited<ReturnType<typeof jupiter.quote_jupiter>>> = {}
): Awaited<ReturnType<typeof jupiter.quote_jupiter>> {
    return {
        inputMint: SOL_MINT.toBase58(),
        outputMint: wallet.publicKey.toBase58(),
        inAmount: amount.amount,
        outAmount: '12345',
        otherAmountThreshold: '12000',
        swapMode: 'ExactIn',
        slippageBps: 100,
        platformFee: { amount: '0', feeBps: 0 },
        priceImpactPct: '0',
        routePlan: [],
        contextSlot: 1,
        timeTaken: 0,
        ...overrides
    };
}

afterEach(() => {
    mock.restore();
    global.fetch = original_fetch;
    process.env.JUPITER_API_KEY = test_api_key;
});
afterAll(() => {
    for (const [name, value] of Object.entries(original_env)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
});

describe('Jupiter swap response decoding', () => {
    function wire_instruction(seed: number) {
        return {
            programId: SOL_MINT.toBase58(),
            accounts: [
                { pubkey: wallet.publicKey.toBase58(), isSigner: true, isWritable: true },
                { pubkey: PublicKey.default.toBase58(), isSigner: false, isWritable: false }
            ],
            data: Buffer.from([seed, 0, 255]).toString('base64')
        };
    }

    test('preserves ledger/setup/other/swap/cleanup order, bytes, permissions and lookup tables', async () => {
        const response = {
            tokenLedgerInstruction: wire_instruction(1),
            setupInstructions: [wire_instruction(2), wire_instruction(3)],
            otherInstructions: [wire_instruction(4)],
            swapInstruction: wire_instruction(5),
            cleanupInstruction: wire_instruction(6),
            addressLookupTableAddresses: [wallet.publicKey.toBase58()]
        };
        const fetch = mock(async (_url: unknown, _init?: RequestInit) => Response.json(response));
        global.fetch = fetch as unknown as typeof global.fetch;
        const tables = [{ key: wallet.publicKey } as AddressLookupTableAccount];
        const load = spyOn(trade, 'get_ltas').mockResolvedValue(tables);
        const submitted_quote = quote();
        const [instructions, ltas] = await jupiter.swap_jupiter_instructions(wallet, submitted_quote);
        expect(instructions.map((instruction) => [...instruction.data])).toEqual(
            [1, 2, 3, 4, 5, 6].map((seed) => [seed, 0, 255])
        );
        for (const instruction of instructions) {
            expect(instruction.programId).toEqual(SOL_MINT);
            expect(instruction.keys).toEqual([
                { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
                { pubkey: PublicKey.default, isSigner: false, isWritable: false }
            ]);
        }
        expect(load).toHaveBeenCalledWith([wallet.publicKey]);
        expect(ltas).toBe(tables);
        const [url, init] = fetch.mock.calls[0]!;
        expect(String(url)).toEndWith('/swap-instructions');
        expect(init?.method).toBe('POST');
        expect(new Headers(init?.headers).get('x-api-key')).toBe(test_api_key!);
        expect(JSON.parse(init?.body as string)).toEqual({
            quoteResponse: submitted_quote,
            userPublicKey: wallet.publicKey.toBase58(),
            wrapAndUnwrapSol: true
        });
    });

    test('accepts a swap-only response with optional fields absent', async () => {
        global.fetch = mock(async () =>
            Response.json({ swapInstruction: wire_instruction(5) })
        ) as unknown as typeof fetch;
        spyOn(trade, 'get_ltas').mockResolvedValue([]);
        const [instructions, ltas] = await jupiter.swap_jupiter_instructions(wallet, quote());
        expect(instructions).toHaveLength(1);
        expect([...instructions[0]!.data]).toEqual([5, 0, 255]);
        expect(ltas).toEqual([]);
        expect(trade.get_ltas).toHaveBeenCalledWith([]);
    });

    test('rejects a missing swap before loading lookup tables', async () => {
        global.fetch = mock(async () => Response.json({ swapInstruction: null })) as unknown as typeof fetch;
        const load = spyOn(trade, 'get_ltas').mockResolvedValue([]);
        await expect(jupiter.swap_jupiter_instructions(wallet, quote())).rejects.toThrow(
            'did not include a swap instruction'
        );
        expect(load).not.toHaveBeenCalled();
    });

    test.each([
        [429, { error: 'rate limited' }, 'rate limited'],
        [200, { errorCode: 'NO_ROUTE' }, 'HTTP 200'],
        [503, {}, 'HTTP 503']
    ] as const)('rejects HTTP/API errors before decoding instructions %#', async (status, body, message) => {
        global.fetch = mock(async () => Response.json(body, { status })) as unknown as typeof fetch;
        await expect(jupiter.swap_jupiter_instructions(wallet, quote())).rejects.toThrow(message);
    });

    test('requires an API key before making a network request', async () => {
        delete process.env.JUPITER_API_KEY;
        const fetch = mock(async () => Response.json({}));
        global.fetch = fetch as unknown as typeof global.fetch;
        await expect(jupiter.swap_jupiter_instructions(wallet, quote())).rejects.toThrow('JUPITER_API_KEY is required');
        expect(fetch).not.toHaveBeenCalled();
    });
});

describe('Jupiter provider output contracts', () => {
    test('builds a standalone buy from the requested SOL budget and forwards its exact quote', async () => {
        const buy_quote = quote();
        const request = spyOn(jupiter, 'quote_jupiter').mockResolvedValue(buy_quote);
        const swap = spyOn(jupiter, 'swap_jupiter_instructions').mockResolvedValue([[ix], []]);
        expect(await provider.buy_token_instructions(amount, wallet, meta, 0.02)).toEqual([[ix], []]);
        expect(request).toHaveBeenCalledWith(amount, SOL_MINT, wallet.publicKey, 0.02);
        expect(swap).toHaveBeenCalledWith(wallet, buy_quote);
    });

    test('round-trips fetched metadata and refreshes SOL-denominated market cap', async () => {
        spyOn(common, 'fetch_sol_price').mockResolvedValue(100);
        const asset = {
            mint: wallet.publicKey,
            token_name: 'Token',
            token_symbol: 'TOK',
            token_supply: 1_000_000_000,
            token_decimal: 6,
            price_per_token: 2,
            token_program: new PublicKey(meta.serialize().token_program)
        };
        const fetch_meta = spyOn(trade, 'get_token_meta').mockResolvedValue(asset);
        const initial = (await provider.get_mint_meta(wallet.publicKey))!;
        expect(initial.token_quote_mc).toBe(20);
        expect(initial.token_name).toBe('Token');
        expect(initial.token_symbol).toBe('TOK');
        const restored = provider.deserialize_mint_meta(initial.serialize());
        expect(restored.serialize()).toEqual(initial.serialize());
        fetch_meta.mockResolvedValue({ ...asset, price_per_token: 3 });
        expect((await provider.update_mint_meta(restored)).token_quote_mc).toBe(30);
        expect(initial.token_quote_mc).toBe(20);
    });

    test('keeps unknown metadata usable with zero market cap when the asset API fails', async () => {
        spyOn(common, 'fetch_sol_price').mockResolvedValue(0);
        spyOn(trade, 'get_token_meta').mockRejectedValue(new Error('asset unavailable'));
        const fallback = await provider.default_mint_meta(wallet.publicKey);
        expect(fallback.token_quote_mc).toBe(0);
        expect(fallback.token_name).toBe('Unknown');
        expect(fallback.quote_mint_pubkey).toEqual(SOL_MINT);
        expect(fallback.token_mint).toBe(wallet.publicKey.toBase58());
    });

    test('preserves base and quote decimals when estimating buys and sells', async () => {
        spyOn(jupiter, 'quote_jupiter').mockResolvedValue(quote({ outAmount: '123456789' }));
        spyOn(trade, 'get_quote_info').mockResolvedValue({
            mint: wallet.publicKey,
            token_program: new PublicKey(meta.serialize().token_program),
            decimals: 8
        });
        const buy = await provider.estimate_buy_output(meta, amount, 0.1);
        const sell = await provider.estimate_sell_output(meta, amount, 0.1);
        expect(buy.expected).toEqual({ amount: '123456789', decimals: 8, uiAmount: 1.23456789 });
        expect(sell.expected).toEqual({ amount: '123456789', decimals: 9, uiAmount: 0.123456789 });
        expect(buy.minimum.amount).toBe('111111111');
        expect(sell.minimum.amount).toBe('111111111');
    });

    test('returns the minimum from the exact sell quote submitted for instructions', async () => {
        const sell_quote = quote({ otherAmountThreshold: '987654321', outAmount: '999999999' });
        const quotes = spyOn(jupiter, 'quote_jupiter').mockResolvedValue(sell_quote);
        const swap = spyOn(jupiter, 'swap_jupiter_instructions').mockResolvedValue([[ix], []]);
        const output = await provider.sell_token_instructions(amount, wallet, meta, 0.01);
        expect(quotes).toHaveBeenCalledTimes(1);
        expect(swap).toHaveBeenCalledWith(wallet, sell_quote);
        expect(output).toEqual({
            instructions: [ix],
            ltas: [],
            minimum_quote_output: { amount: '987654321', decimals: 9, uiAmount: null }
        });
    });

    test('uses an exact-output buy and propagates the paired sell threshold', async () => {
        const exact = quote({ swapMode: 'ExactOut', otherAmountThreshold: '1010000000' });
        const sell = quote({ outAmount: '950000000', otherAmountThreshold: '940500000' });
        const quotes = spyOn(jupiter, 'quote_jupiter')
            .mockResolvedValueOnce(quote())
            .mockResolvedValueOnce(exact)
            .mockResolvedValueOnce(sell);
        const swap = spyOn(jupiter, 'swap_jupiter_instructions').mockResolvedValue([[ix], []]);
        const output = await provider.buy_sell_instructions(amount, wallet, meta, 0.01);
        expect(quotes.mock.calls[1]?.[4]).toBe('ExactOut');
        expect(quotes.mock.calls[2]?.[0].amount).toBe('12345');
        expect(swap.mock.calls.map(([, quote]) => quote)).toEqual([exact, sell]);
        expect(output.minimum_quote_output).toEqual({ amount: '940500000', decimals: 9, uiAmount: null });
        expect(output.buy).toEqual([ix]);
        expect(output.sell).toEqual([ix]);
    });

    test.each([
        { swapMode: 'ExactIn' as const, otherAmountThreshold: '1000000000' },
        { swapMode: 'ExactOut' as const, otherAmountThreshold: '1010000001' },
        { swapMode: 'ExactOut' as const, otherAmountThreshold: '1000000000', outAmount: '12346' }
    ])('rejects an invalid or over-budget exact-output quote %# before building swaps', async (invalid) => {
        spyOn(jupiter, 'quote_jupiter').mockResolvedValueOnce(quote()).mockResolvedValueOnce(quote(invalid));
        const swap = spyOn(jupiter, 'swap_jupiter_instructions').mockResolvedValue([[ix], []]);
        await expect(provider.buy_sell_instructions(amount, wallet, meta, 0.01)).rejects.toThrow('Jupiter');
        expect(swap).not.toHaveBeenCalled();
    });
});
