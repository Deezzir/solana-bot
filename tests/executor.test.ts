import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import {
    Keypair,
    PublicKey,
    TransactionInstruction,
    type AddressLookupTableAccount,
    type Connection,
    type TokenAmount
} from '@solana/web3.js';
import type { ClaimableAsset, IMintMeta, IProgramProvider, SerializedMintMeta } from '../src/common/trade_common';

const original_env = {
    HELIUS_API_KEY: process.env.HELIUS_API_KEY,
    PINATA_IPFS_JWT: process.env.PINATA_IPFS_JWT,
    JUPITER_API_KEY: process.env.JUPITER_API_KEY
};
process.env.HELIUS_API_KEY ||= 'unit-test';
process.env.PINATA_IPFS_JWT ||= 'unit-test';
process.env.JUPITER_API_KEY ||= 'unit-test';

const { Executor } = await import('../src/common/executor');
const { PriorityLevel, SOL_MINT, MAX_COMPUTE_UNIT_LIMIT, EXECUTOR_JUPITER_COMPUTE_UNIT_ALLOWANCE } =
    await import('../src/constants');
const trade = await import('../src/common/trade_common');
const common = await import('../src/common/common');
const jupiter = await import('../src/jupiter/swap_jupiter');
const { TOKEN_2022_PROGRAM_ID } = await import('../src/common/token');

type BuyCall = Parameters<IProgramProvider['buy_token_instructions']>;
type SellCall = Parameters<IProgramProvider['sell_token_instructions']>;

const buyer = await Keypair.fromSeed(new Uint8Array(32).fill(7));
const create_mint = await Keypair.fromSeed(new Uint8Array(32).fill(42));
const token_mint = new PublicKey(new Uint8Array(32).fill(8));
const usdc_mint = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const token_program = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const original_fetch = global.fetch;
const original_connection = global.CONNECTION;
const original_version = global.TRANSACTION_VERSION;

function mint_meta(quote_mint_pubkey: PublicKey): IMintMeta {
    return {
        token_name: 'Unit Test Token',
        token_symbol: 'TEST',
        token_mint: token_mint.toBase58(),
        token_quote_mc: 1,
        migrated: false,
        platform_fee: 0,
        mint_pubkey: token_mint,
        quote_mint_pubkey,
        token_program,
        serialize: () => ({}) as SerializedMintMeta
    };
}

function instruction(seed: number): TransactionInstruction {
    return new TransactionInstruction({ programId: token_program, keys: [], data: Buffer.from([seed]) });
}

const buy_ix = instruction(1);
const sell_ix = instruction(2);
const funding_ix = instruction(3);
const conversion_ix = instruction(4);
const lta = { key: token_mint } as AddressLookupTableAccount;
const minimum = { amount: '4321000', decimals: 6, uiAmount: null };

function fake_program_trader(overrides: Partial<IProgramProvider> = {}) {
    const buy_calls: BuyCall[] = [];
    const sell_calls: SellCall[] = [];
    const methods: Partial<IProgramProvider> = {
        get_compute_unit_limit: () => 300_000,
        buy_token_instructions: async (...args: BuyCall) => {
            buy_calls.push(args);
            return [[buy_ix], [lta]];
        },
        sell_token_instructions: async (...args: SellCall) => {
            sell_calls.push(args);
            return { instructions: [sell_ix], ltas: [lta], minimum_quote_output: minimum };
        },
        buy_sell_instructions: async () => ({
            buy: [buy_ix],
            sell: [sell_ix],
            ltas: [lta],
            minimum_quote_output: minimum
        }),
        ...overrides
    };
    const trader = new Proxy(methods as IProgramProvider, {
        get(target, property, receiver) {
            if (property in target) return Reflect.get(target, property, receiver);
            return () => {
                throw new Error(`Unexpected trader call: ${String(property)}`);
            };
        }
    });
    return { trader, buy_calls, sell_calls };
}

type QuoteOverrides = Partial<Record<'inAmount' | 'outAmount' | 'otherAmountThreshold', string>>;

function install_jupiter_quotes(...responses: QuoteOverrides[]) {
    const requests: URL[] = [];
    global.fetch = (async (input: string | URL | Request) => {
        requests.push(new URL(typeof input === 'string' || input instanceof URL ? input : input.url));
        const overrides = responses[requests.length - 1] ?? responses.at(-1) ?? {};
        return Response.json({
            inputMint: SOL_MINT.toBase58(),
            inAmount: '1000000000',
            outputMint: usdc_mint.toBase58(),
            outAmount: '6000000',
            otherAmountThreshold: '5900000',
            swapMode: 'ExactIn',
            slippageBps: 100,
            platformFee: { amount: '0', feeBps: 0 },
            priceImpactPct: '0',
            routePlan: [],
            contextSlot: 1,
            timeTaken: 0,
            ...overrides
        });
    }) as typeof fetch;
    return requests;
}

function install_balances(sol_balance_raw: bigint, quote_balance_raw = '0'): void {
    global.CONNECTION = {
        getBalance: async () => sol_balance_raw,
        getTokenAccountBalance: async () => ({
            context: { slot: 1 },
            value: {
                amount: quote_balance_raw,
                decimals: 6,
                uiAmount: null,
                uiAmountString: quote_balance_raw
            }
        })
    } as unknown as Connection;
}

afterAll(() => {
    for (const [name, value] of Object.entries(original_env)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
});

afterEach(() => {
    mock.restore();
    global.TRANSACTION_VERSION = original_version;
    global.fetch = original_fetch;
    if (original_connection === undefined) delete (global as { CONNECTION?: Connection }).CONNECTION;
    else global.CONNECTION = original_connection;
});

describe('Executor creation and rewards', () => {
    const create_ix = instruction(5);
    const mint = create_mint;

    function setup_create(meta = mint_meta(SOL_MINT)) {
        spyOn(trade, 'retry_send_tx').mockResolvedValue('create-signature');
        spyOn(trade, 'retry_send_bundle').mockResolvedValue('create-bundle-signature');
        spyOn(trade, 'get_bundle_size').mockReturnValue(5);
        global.TRANSACTION_VERSION = 1;
        const create = mock<IProgramProvider['create_token_instructions']>(async () => ({
            instructions: [create_ix],
            mint_meta: meta,
            ltas: []
        }));
        const fake = fake_program_trader({
            create_token_instructions: create,
            update_mint_meta_reserves: (meta, amount) => ({
                ...meta,
                token_quote_mc: meta.token_quote_mc + Number(amount.amount)
            })
        });
        return { fake, create, executor: new Executor(fake.trader, true) };
    }

    test('creates without a buy and forwards the provider config', async () => {
        const { executor, create, fake } = setup_create();
        const config = { quote_mint: SOL_MINT.toBase58() };
        expect(
            await executor.create_token(
                mint,
                buyer,
                'Token',
                'TOK',
                'cid',
                0,
                undefined,
                undefined,
                PriorityLevel.HIGH,
                config
            )
        ).toBe('create-signature');
        expect(create).toHaveBeenCalledWith(mint, buyer, 'Token', 'TOK', 'cid', config, false);
        expect(fake.buy_calls).toHaveLength(0);
        expect(trade.retry_send_tx).toHaveBeenCalledWith(
            [create_ix],
            [buyer, mint],
            PriorityLevel.HIGH,
            undefined,
            false,
            [],
            300_000
        );
    });

    test('puts creator funding before creation and its initial buy', async () => {
        const { executor, create } = setup_create(mint_meta(usdc_mint));
        install_jupiter_quotes();
        install_balances(1_000_000_000n);
        spyOn(jupiter, 'swap_jupiter_instructions').mockResolvedValue([[funding_ix], []]);
        await executor.create_token(mint, buyer, 'Token', 'TOK', 'cid', 1);
        expect(create.mock.calls[0]?.[6]).toBeTrue();
        expect(trade.retry_send_tx).toHaveBeenCalledWith(
            [funding_ix, create_ix, buy_ix],
            [buyer, mint],
            undefined,
            undefined,
            false,
            [lta],
            MAX_COMPUTE_UNIT_LIMIT
        );
    });

    test('prepares creator and initial buyers sequentially using updated reserves', async () => {
        const { executor, fake } = setup_create();
        const initial_buyer = await Keypair.fromSeed(new Uint8Array(32).fill(44));
        await executor.create_token(mint, buyer, 'Token', 'TOK', 'cid', 1, [[initial_buyer, 2]], 0.001);
        expect(fake.buy_calls.map(([amount, wallet, meta]) => [amount.amount, wallet, meta.token_quote_mc])).toEqual([
            ['1000000000', buyer, 1],
            ['2000000000', initial_buyer, 1_000_000_001]
        ]);
        expect(trade.retry_send_bundle).toHaveBeenCalledTimes(1);
        expect(trade.retry_send_bundle).toHaveBeenCalledWith(
            [[create_ix, buy_ix], [buy_ix]],
            [[buyer, mint], [initial_buyer]],
            0.001,
            undefined,
            [lta],
            MAX_COMPUTE_UNIT_LIMIT,
            undefined,
            { tip_account: expect.any(PublicKey) }
        );
    });

    test.each([false, true])('deactivates a generated creation ALT after bundle failure=%s', async (fails) => {
        const { executor } = setup_create();
        global.TRANSACTION_VERSION = 0;
        const table = { key: usdc_mint, state: { addresses: [] } } as unknown as AddressLookupTableAccount;
        spyOn(trade, 'generate_trade_lta').mockResolvedValue(table);
        const deactivate = spyOn(trade, 'deactivate_ltas').mockResolvedValue([]);
        spyOn(common, 'log').mockImplementation(() => undefined);
        // Packing is covered separately; this exercises creation resource ownership around submission.
        spyOn(trade, 'pack_tx_groups').mockImplementation((items) => (items.length ? [items] : []));
        if (fails) spyOn(trade, 'retry_send_bundle').mockRejectedValue(new Error('bundle rejected'));
        const pending = executor.create_token(mint, buyer, 'Token', 'TOK', 'cid', 0, [[buyer, 1]], 0.001);
        if (fails) await expect(pending).rejects.toThrow('bundle rejected');
        else expect(await pending).toBe('create-bundle-signature');
        expect(deactivate).toHaveBeenCalledWith(buyer, [table]);
    });

    test('rejects a funded creation bundle that exceeds transaction capacity before submission', async () => {
        const { executor } = setup_create(mint_meta(usdc_mint));
        install_jupiter_quotes();
        install_balances(1_000_000_000n);
        spyOn(jupiter, 'swap_jupiter_instructions').mockResolvedValue([[funding_ix], []]);
        spyOn(trade, 'get_bundle_size').mockReturnValue(2);
        await expect(executor.create_token(mint, buyer, 'Token', 'TOK', 'cid', 1, [[buyer, 1]], 0.001)).rejects.toThrow(
            'Initial buys do not fit'
        );
        expect(trade.retry_send_bundle).not.toHaveBeenCalled();
    });

    test('validates creation parameters before calling the provider', async () => {
        const { executor, create } = setup_create();
        await expect(executor.create_token(mint, buyer, 'Token', 'TOK', 'cid', 0, [[buyer, 1]])).rejects.toThrow(
            'Traders and bundle tip'
        );
        expect(create).not.toHaveBeenCalled();
    });

    test('forwards reward assets unchanged and submits the claim with provider compute limits', async () => {
        const assets: ClaimableAsset[] = [{ mint: usdc_mint, raw_amount: 99n, decimals: 6, source: 'cashback_reward' }];
        const get_rewards = mock(async () => assets);
        const claim = mock(async () => [conversion_ix]);
        const executor = new Executor(fake_program_trader({ get_rewards, claim_rewards_instructions: claim }).trader);
        expect(await executor.get_rewards(buyer)).toBe(assets);
        expect(get_rewards).toHaveBeenCalledWith(buyer);
        expect(await executor.claim_rewards(buyer, assets, PriorityLevel.HIGH)).toBe('tx-signature');
        expect(claim).toHaveBeenCalledWith(buyer, assets);
        expect(trade.send_tx).toHaveBeenCalledWith(
            [conversion_ix],
            [buyer],
            PriorityLevel.HIGH,
            undefined,
            false,
            undefined,
            300_000
        );
    });

    test('forwards metadata and discovery without altering provider results', async () => {
        const meta = mint_meta(SOL_MINT);
        const serialized = meta.serialize();
        const methods = {
            get_lta_addresses: mock(() => [token_mint]),
            deserialize_mint_meta: mock(() => meta),
            get_mint_meta: mock(async () => meta),
            update_mint_meta: mock(async () => meta),
            update_mint_meta_reserves: mock(() => meta),
            get_random_mints: mock(async () => [meta]),
            create_token_metadata: mock(async () => 'cid')
        };
        const executor = new Executor(fake_program_trader(methods).trader);
        expect(executor.get_lta_addresses()).toEqual([token_mint]);
        expect(executor.deserialize_mint_meta(serialized)).toBe(meta);
        expect(await executor.get_mint_meta(token_mint)).toBe(meta);
        expect(await executor.update_mint_meta(meta)).toBe(meta);
        expect(executor.update_mint_meta_reserves(meta, minimum, 'sell')).toBe(meta);
        expect(await executor.get_random_mints(3)).toEqual([meta]);
        const metadata = {
            name: 'Token',
            symbol: 'TOK',
            description: 'test',
            image: undefined,
            showName: undefined,
            createdOn: undefined,
            twitter: undefined,
            telegram: undefined,
            website: undefined
        };
        expect(await executor.create_token_metadata(metadata, 'image.png')).toBe('cid');
        expect(methods.deserialize_mint_meta).toHaveBeenCalledWith(serialized);
        expect(methods.get_mint_meta).toHaveBeenCalledWith(token_mint);
        expect(methods.update_mint_meta).toHaveBeenCalledWith(meta);
        expect(methods.update_mint_meta_reserves).toHaveBeenCalledWith(meta, minimum, 'sell');
        expect(methods.get_random_mints).toHaveBeenCalledWith(3);
        expect(methods.create_token_metadata).toHaveBeenCalledWith(metadata, 'image.png');
    });
});

beforeEach(() => {
    spyOn(trade, 'send_tx').mockResolvedValue('tx-signature');
    spyOn(trade, 'send_bundle').mockResolvedValue('bundle-signature');
});

describe('Executor delegation', () => {
    test('denominates a SOL buy in lamports and preserves all delegation options', async () => {
        const fake = fake_program_trader();
        const executor = new Executor(fake.trader);
        const meta = mint_meta(SOL_MINT);

        const result = await executor.buy_token(1.25, buyer, meta, 0.03, PriorityLevel.HIGH, 0.001, true);

        expect(result).toBe('tx-signature');
        expect(fake.buy_calls).toEqual([[{ amount: '1250000000', decimals: 9, uiAmount: 1.25 }, buyer, meta, 0.03]]);
        expect(trade.send_tx).toHaveBeenCalledWith([buy_ix], [buyer], PriorityLevel.HIGH, 0.001, true, [lta], 300_000);
    });

    test('delegates a SOL sell with the original token amount and options', async () => {
        const fake = fake_program_trader();
        const executor = new Executor(fake.trader);
        const meta = mint_meta(SOL_MINT);
        const amount: TokenAmount = { amount: '42000000', decimals: 6, uiAmount: 42 };

        const result = await executor.sell_token(amount, buyer, meta, 0.02, PriorityLevel.LOW, undefined, true);

        expect(result).toBe('tx-signature');
        expect(fake.sell_calls).toEqual([[amount, buyer, meta, 0.02]]);
        expect(trade.send_tx).toHaveBeenCalledWith(
            [sell_ix],
            [buyer],
            PriorityLevel.LOW,
            undefined,
            true,
            [lta],
            300_000
        );
    });

    test('denominates a funding-disabled non-SOL buy in quote-token units', async () => {
        const requests = install_jupiter_quotes();
        const fake = fake_program_trader();
        const executor = new Executor(fake.trader, false);
        const meta = mint_meta(usdc_mint);

        await executor.buy_token(1, buyer, meta, 0.01);

        expect(fake.buy_calls[0]?.[0]).toEqual({ amount: '6000000', decimals: 6, uiAmount: null });
        expect(requests).toHaveLength(1);
        expect(requests[0]?.searchParams.get('amount')).toBe('1000000000');
        expect(requests[0]?.searchParams.get('inputMint')).toBe(SOL_MINT.toBase58());
        expect(requests[0]?.searchParams.get('outputMint')).toBe(usdc_mint.toBase58());
        expect(requests[0]?.searchParams.get('swapMode')).toBe('ExactIn');
    });
});

describe('Executor funding contracts', () => {
    test('uses the minimum quoted output when an existing quote balance fully funds a buy', async () => {
        const requests = install_jupiter_quotes();
        install_balances(0n, '5900000');
        const fake = fake_program_trader();
        const executor = new Executor(fake.trader, true);

        await executor.buy_token(1, buyer, mint_meta(usdc_mint), 0.01);

        expect(fake.buy_calls[0]?.[0]).toEqual({ amount: '5900000', decimals: 6, uiAmount: null });
        expect(requests).toHaveLength(1);
        expect(requests[0]?.pathname.endsWith('/quote')).toBeTrue();
        expect(requests.some(({ pathname }) => pathname.endsWith('/swap-instructions'))).toBeFalse();
    });

    test('rejects a funding quote whose input exceeds the requested SOL budget', async () => {
        install_jupiter_quotes({ inAmount: '1000000001' });
        install_balances(0n);
        const fake = fake_program_trader();
        const executor = new Executor(fake.trader, true);

        await expect(executor.buy_token(1, buyer, mint_meta(usdc_mint), 0.01)).rejects.toThrow(
            'Funding quote exceeds the SOL budget'
        );
        expect(fake.buy_calls).toHaveLength(0);
    });

    test('rejects partial funding when the follow-up quote minimum cannot cover the shortfall', async () => {
        const requests = install_jupiter_quotes({}, { inAmount: '500000000', otherAmountThreshold: '2949999' });
        install_balances(0n, '2950000');
        const fake = fake_program_trader();
        const executor = new Executor(fake.trader, true);

        await expect(executor.buy_token(1, buyer, mint_meta(usdc_mint), 0.01)).rejects.toThrow(
            'Funding quote minimum output does not cover the quote-token shortfall'
        );
        expect(requests).toHaveLength(2);
        expect(requests[1]?.searchParams.get('amount')).toBe('500000000');
        expect(requests.every(({ pathname }) => pathname.endsWith('/quote'))).toBeTrue();
        expect(fake.buy_calls).toHaveLength(0);
    });
});

describe('Executor balance checks', () => {
    test('does not classify a quote shortfall as fundable when funding is disabled', async () => {
        install_jupiter_quotes();
        install_balances(10_000_000_000n, '5900000');
        const executor = new Executor(fake_program_trader().trader, false);
        const result = await executor.has_enough_balances(1, buyer.publicKey, mint_meta(usdc_mint));
        expect(result.status).toBe('insufficient');
        expect(result.quote_amount.amount).toBe('6000000');
    });

    test('reads the Token-2022 quote ATA in both preflight and funding preparation', async () => {
        install_jupiter_quotes();
        install_balances(0n, '5900000');
        spyOn(trade, 'get_quote_info').mockResolvedValue({
            mint: usdc_mint,
            decimals: 6,
            token_program: TOKEN_2022_PROGRAM_ID
        });
        const read_balance = spyOn(global.CONNECTION, 'getTokenAccountBalance');
        const executor = new Executor(fake_program_trader().trader, true);
        expect((await executor.has_enough_balances(1, buyer.publicKey, mint_meta(usdc_mint))).status).toBe('ready');
        await executor.buy_token_instructions(1, buyer, mint_meta(usdc_mint), 0.01);
        const ata = await trade.calc_ata(buyer.publicKey, usdc_mint, TOKEN_2022_PROGRAM_ID);
        expect(read_balance.mock.calls.map(([account]) => account)).toEqual([ata, ata]);
    });

    test('classifies SOL balances and returns a lamport-denominated requirement', async () => {
        const executor = new Executor(fake_program_trader().trader, true);
        const meta = mint_meta(SOL_MINT);

        for (const [sol_balance_raw, status] of [
            [1_000_000_000n, 'ready'],
            [999_999_999n, 'insufficient']
        ] as const) {
            install_balances(sol_balance_raw);

            expect(await executor.has_enough_balances(1, buyer.publicKey, meta)).toEqual({
                status,
                quote_amount: { amount: '1000000000', decimals: 9, uiAmount: 1 },
                sol_balance_raw,
                quote_balance_raw: 0n
            });
        }
    });

    test('classifies fully funded, partially fundable, and insufficient quote-token balances', async () => {
        const executor = new Executor(fake_program_trader().trader, true);
        const meta = mint_meta(usdc_mint);
        const cases = [
            { sol: 0n, quote: '5900000', status: 'ready' },
            { sol: 500_000_000n, quote: '2950000', status: 'needs_funding' },
            { sol: 499_999_999n, quote: '2950000', status: 'insufficient' }
        ] as const;

        for (const expected of cases) {
            install_jupiter_quotes();
            install_balances(expected.sol, expected.quote);

            expect(await executor.has_enough_balances(1, buyer.publicKey, meta)).toEqual({
                status: expected.status,
                quote_amount: { amount: '5900000', decimals: 6, uiAmount: null },
                sol_balance_raw: expected.sol,
                quote_balance_raw: BigInt(expected.quote)
            });
        }
    });
});

describe('Executor funded execution', () => {
    function setup(quote_balance = '0') {
        const requests = install_jupiter_quotes({}, { inAmount: '500000000', otherAmountThreshold: '2950000' });
        install_balances(1_000_000_000n, quote_balance);
        const swap = spyOn(jupiter, 'swap_jupiter_instructions').mockResolvedValue([[funding_ix], []]);
        const fake = fake_program_trader();
        return { executor: new Executor(fake.trader, true), fake, swap, requests };
    }

    test('funds only the shortfall and preserves funding-before-buy order', async () => {
        const { executor, fake, swap, requests } = setup('2950000');
        expect(await executor.buy_token_instructions(1, buyer, mint_meta(usdc_mint), 0.01)).toEqual([
            [[funding_ix], [buy_ix]],
            [lta]
        ]);
        expect(requests[1]?.searchParams.get('amount')).toBe('500000000');
        expect(swap.mock.calls[0]?.[1].otherAmountThreshold).toBe('2950000');
        expect(fake.buy_calls[0]?.[0].amount).toBe('5900000');
    });

    test.each([undefined, 0.001])('submits a funded buy atomically with tip %s', async (tip) => {
        const { executor, requests } = setup();
        await executor.buy_token(1, buyer, mint_meta(usdc_mint), 0.01, PriorityLevel.HIGH, tip, true);
        expect(requests).toHaveLength(1);
        const limit = 300_000 + EXECUTOR_JUPITER_COMPUTE_UNIT_ALLOWANCE;
        if (tip) {
            expect(trade.send_bundle).toHaveBeenCalledWith(
                [[funding_ix], [buy_ix]],
                [[buyer], [buyer]],
                tip,
                PriorityLevel.HIGH,
                [lta],
                limit
            );
            expect(trade.send_tx).not.toHaveBeenCalled();
        } else {
            expect(trade.send_tx).toHaveBeenCalledWith(
                [funding_ix, buy_ix],
                [buyer],
                PriorityLevel.HIGH,
                tip,
                true,
                [lta],
                limit
            );
            expect(trade.send_bundle).not.toHaveBeenCalled();
        }
    });

    test.each([undefined, 0.001])('converts exactly the provider sell minimum with tip %s', async (tip) => {
        const { executor } = setup();
        const requests = install_jupiter_quotes();
        spyOn(jupiter, 'swap_jupiter_instructions').mockResolvedValue([[conversion_ix], []]);
        await executor.sell_token(
            { amount: '123', decimals: 8, uiAmount: null },
            buyer,
            mint_meta(usdc_mint),
            0.02,
            PriorityLevel.LOW,
            tip,
            true
        );
        expect(requests[0]?.searchParams.get('amount')).toBe(minimum.amount);
        expect(requests[0]?.searchParams.get('inputMint')).toBe(usdc_mint.toBase58());
        expect(requests[0]?.searchParams.get('outputMint')).toBe(SOL_MINT.toBase58());
        if (tip) {
            expect(trade.send_bundle).toHaveBeenCalledWith(
                [[sell_ix], [conversion_ix]],
                [[buyer], [buyer]],
                tip,
                PriorityLevel.LOW,
                [lta],
                executor.get_compute_unit_limit(true)
            );
        } else {
            expect(trade.send_tx).toHaveBeenCalledWith(
                [sell_ix, conversion_ix],
                [buyer],
                PriorityLevel.LOW,
                tip,
                true,
                [lta],
                executor.get_compute_unit_limit(true)
            );
        }
    });

    test.each(['buy', 'sell', 'paired'] as const)(
        'reports atomic size failure for %s without submitting legs separately',
        async (op) => {
            const { executor } = setup();
            const error = new trade.CompileTransactionError('too large');
            spyOn(trade, 'send_tx').mockRejectedValue(error);
            const pending =
                op === 'buy'
                    ? executor.buy_token(1, buyer, mint_meta(usdc_mint), 0.01)
                    : op === 'sell'
                      ? executor.sell_token(minimum, buyer, mint_meta(usdc_mint), 0.01)
                      : executor.buy_sell(1, buyer, mint_meta(usdc_mint), 0.01);
            await expect(pending).rejects.toThrow('cannot fit in one transaction');
            expect(trade.send_tx).toHaveBeenCalledTimes(1);
            expect(trade.send_bundle).not.toHaveBeenCalled();
        }
    );

    test('propagates submission errors without disguising them as size failures', async () => {
        const { executor } = setup();
        const error = new Error('relay rejected');
        spyOn(trade, 'send_tx').mockRejectedValue(error);
        await expect(executor.buy_token(1, buyer, mint_meta(usdc_mint), 0.01)).rejects.toBe(error);
    });

    test('keeps all four paired legs and lookup tables in execution order', async () => {
        const { executor, swap, requests } = setup();
        const funding_lta = { key: usdc_mint } as AddressLookupTableAccount;
        const conversion_lta = { key: buyer.publicKey } as AddressLookupTableAccount;
        swap.mockResolvedValueOnce([[funding_ix], [funding_lta]]).mockResolvedValueOnce([
            [conversion_ix],
            [conversion_lta]
        ]);
        await executor.buy_sell_bundle(1, buyer, mint_meta(usdc_mint), 0.002, 0.01, PriorityLevel.HIGH);
        expect(requests[1]?.searchParams.get('inputMint')).toBe(usdc_mint.toBase58());
        expect(requests[1]?.searchParams.get('amount')).toBe(minimum.amount);
        expect(trade.send_bundle).toHaveBeenCalledWith(
            [[funding_ix], [buy_ix], [sell_ix], [conversion_ix]],
            [[buyer], [buyer], [buyer], [buyer]],
            0.002,
            PriorityLevel.HIGH,
            [funding_lta, lta, conversion_lta],
            executor.get_compute_unit_limit(true)
        );
    });

    test('returns the same signature for an immediate atomic pair', async () => {
        const executor = new Executor(fake_program_trader().trader);
        expect(
            await executor.buy_sell(1, buyer, mint_meta(SOL_MINT), 0.01, 0, PriorityLevel.HIGH, 0.001, true)
        ).toEqual(['tx-signature', 'tx-signature']);
        expect(trade.send_tx).toHaveBeenCalledWith(
            [buy_ix, sell_ix],
            [buyer],
            PriorityLevel.HIGH,
            0.001,
            true,
            [lta],
            MAX_COMPUTE_UNIT_LIMIT
        );
    });

    test.each([300_000, 1_200_000, undefined])('bounds the funded compute allowance for provider limit %s', (limit) => {
        const executor = new Executor(fake_program_trader({ get_compute_unit_limit: () => limit }).trader);
        expect(executor.get_compute_unit_limit()).toBe(limit);
        expect(executor.get_compute_unit_limit(true)).toBe(
            Math.min(
                MAX_COMPUTE_UNIT_LIMIT,
                (limit ?? MAX_COMPUTE_UNIT_LIMIT) + EXECUTOR_JUPITER_COMPUTE_UNIT_ALLOWANCE
            )
        );
    });
});

describe('Executor delayed paired execution', () => {
    test.each([0n, 500n])('sells only the balance increase with pre-existing balance %s', async (before) => {
        const data = Buffer.alloc(165);
        Buffer.from(token_mint.toBytes()).copy(data, 0);
        Buffer.from(buyer.publicKey.toBytes()).copy(data, 32);
        data.writeBigUInt64LE(before, 64);
        data[108] = 1;
        install_balances(0n, (before + 123n).toString());
        global.CONNECTION.getAccountInfo = mock(async () =>
            before ? { data, owner: token_program, executable: false, lamports: 1n, rentEpoch: 0n, space: 165n } : null
        );
        const meta = mint_meta(SOL_MINT);
        const refreshed = { ...meta, token_quote_mc: 2 };
        const update = mock(async () => refreshed);
        const fake = fake_program_trader({ update_mint_meta: update });
        const sleep = spyOn(common, 'sleep').mockResolvedValue(undefined);
        const executor = new Executor(fake.trader);
        expect(await executor.buy_sell(1, buyer, meta, 0.02, 100, PriorityLevel.HIGH, 0.001, true)).toEqual([
            'tx-signature',
            'tx-signature'
        ]);
        expect(sleep).toHaveBeenCalledWith(100);
        expect(update).toHaveBeenCalledWith(meta);
        expect(fake.sell_calls).toEqual([[{ amount: '123', decimals: 6, uiAmount: null }, buyer, refreshed, 0.02]]);
    });

    test('does not sell when a buy receives no tokens', async () => {
        install_balances(0n, '0');
        global.CONNECTION.getAccountInfo = mock(async () => null);
        const fake = fake_program_trader();
        await expect(new Executor(fake.trader).buy_sell(1, buyer, mint_meta(SOL_MINT), 0.01, 1)).rejects.toThrow(
            'No tokens received'
        );
        expect(fake.sell_calls).toHaveLength(0);
        expect(trade.send_tx).toHaveBeenCalledTimes(1);
    });
});
