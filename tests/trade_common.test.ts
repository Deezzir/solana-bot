import { describe, expect, test } from 'bun:test';
import { PublicKey, SystemProgram, type ParsedTransactionWithMeta, type TokenAmount } from '@solana/web3.js';
import type { RawParsedTransaction } from '../src/common/trade_common';

process.env.HELIUS_API_KEY ||= 'unit-test';
process.env.PINATA_IPFS_JWT ||= 'unit-test';

const {
    apply_slippage_down,
    apply_slippage_up,
    calc_token_balance_changes,
    deserialize_parsed_transaction,
    get_sol_token_amount,
    get_token_amount,
    get_token_amount_by_percent,
    lamports_to_sol,
    normalize_quote_mint,
    quote_metrics,
    sol_to_lamports,
    validate_trade_parameters
} = await import('../src/common/trade_common');

const account = new PublicKey(new Uint8Array(32).fill(1));
const mint = new PublicKey(new Uint8Array(32).fill(2));

function raw_parsed_transaction(): RawParsedTransaction {
    return {
        slot: 42,
        blockTime: 1_700_000_000,
        version: 1,
        transaction: {
            signatures: ['signature'],
            message: {
                accountKeys: [{ pubkey: account.toBase58(), signer: true, writable: true }],
                instructions: [
                    {
                        accounts: [account.toBase58()],
                        data: '3Bxs4NN8M2Yn4TLb',
                        programId: SystemProgram.programId.toBase58()
                    }
                ],
                recentBlockhash: PublicKey.default.toBase58(),
                addressTableLookups: [
                    {
                        accountKey: mint.toBase58(),
                        writableIndexes: [0],
                        readonlyIndexes: [1]
                    }
                ],
                transactionConfig: {
                    computeUnitLimit: 200_000,
                    priorityFeeLamports: 2_000_000
                }
            }
        },
        meta: {
            err: null,
            fee: 5_000,
            preBalances: [5_000_000_000],
            postBalances: [4_500_000_000],
            preTokenBalances: [],
            postTokenBalances: [],
            innerInstructions: null,
            logMessages: [],
            loadedAddresses: {
                writable: [account.toBase58()],
                readonly: [mint.toBase58()]
            },
            rewards: null,
            computeUnitsConsumed: 150_000
        }
    } as RawParsedTransaction;
}

describe('trade parameter validation', () => {
    test('accepts positive SOL and unsigned token amounts below the slippage limit', () => {
        expect(() => validate_trade_parameters(0.25, 0.01)).not.toThrow();
        expect(() =>
            validate_trade_parameters({ amount: '18446744073709551615', decimals: 255, uiAmount: null }, 4.999)
        ).not.toThrow();
    });

    test('rejects zero, negative, sub-lamport, malformed, and overflowing amounts', () => {
        expect(() => validate_trade_parameters(0, 0.01)).toThrow(RangeError);
        expect(() => validate_trade_parameters(-1, 0.01)).toThrow(RangeError);
        expect(() => validate_trade_parameters(0.000_000_000_1, 0.01)).toThrow(RangeError);
        expect(() => validate_trade_parameters({ amount: '1.5', decimals: 6, uiAmount: 1.5 }, 0.01)).toThrow(
            RangeError
        );
        expect(() =>
            validate_trade_parameters({ amount: '18446744073709551616', decimals: 6, uiAmount: null }, 0.01)
        ).toThrow(RangeError);
        expect(() => validate_trade_parameters({ amount: '1', decimals: 256, uiAmount: null }, 0.01)).toThrow(
            RangeError
        );
    });

    test('rejects non-finite slippage and both exclusive boundaries', () => {
        for (const slippage of [Number.NaN, Number.POSITIVE_INFINITY, 0, -0.01, 5]) {
            expect(() => validate_trade_parameters(1, slippage)).toThrow(RangeError);
        }
    });
});

describe('amount conversion', () => {
    test('converts representative SOL values in both directions', () => {
        expect(sol_to_lamports(1.25)).toBe(1_250_000_000n);
        expect(lamports_to_sol(1_250_000_000n)).toBe(1.25);
        expect(sol_to_lamports(0)).toBe(0n);
    });

    test('rejects SOL values that are negative, too small, or outside the safe integer range', () => {
        expect(() => sol_to_lamports(-0.1)).toThrow(RangeError);
        expect(() => sol_to_lamports(0.000_000_000_1)).toThrow(RangeError);
        expect(() => sol_to_lamports(Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
    });

    test('creates token amounts with the requested precision and floors excess fractional units', () => {
        expect(get_token_amount(1.234_567, 4)).toEqual({ amount: '12345', decimals: 4, uiAmount: 1.2345 });
        expect(get_sol_token_amount(0.5)).toEqual({ amount: '500000000', decimals: 9, uiAmount: 0.5 });
    });

    test('rejects invalid decimal precision and positive amounts smaller than one base unit', () => {
        expect(() => get_token_amount(1, -1)).toThrow('Invalid decimals');
        expect(() => get_token_amount(1, 19)).toThrow('Invalid decimals');
        expect(() => get_token_amount(0.0001, 3)).toThrow(RangeError);
    });
});

describe('percentage and slippage calculations', () => {
    const amount: TokenAmount = { amount: '10001', decimals: 2, uiAmount: 100.01 };

    test('returns zero, a representative fraction, and the original full amount', () => {
        expect(get_token_amount_by_percent(amount, 0)).toEqual({ amount: '0', decimals: 2, uiAmount: 0 });
        expect(get_token_amount_by_percent(amount, 0.25)).toEqual({ amount: '2500', decimals: 2, uiAmount: 25 });
        expect(get_token_amount_by_percent(amount, 1)).toBe(amount);
    });

    test('rejects percentages outside the inclusive unit interval', () => {
        for (const percent of [-0.01, 1.01, Number.NaN]) {
            expect(() => get_token_amount_by_percent(amount, percent)).toThrow('Invalid percent');
        }
    });

    test('moves an amount up and down by the requested slippage without crossing the original amount', () => {
        expect(apply_slippage_up(10_000n, 0.025)).toBe(10_250n);
        expect(apply_slippage_down(10_000n, 0.025)).toBe(9_750n);
        expect(apply_slippage_up(7n, 0.001)).toBeGreaterThanOrEqual(7n);
        expect(apply_slippage_down(7n, 0.001)).toBeLessThanOrEqual(7n);
    });
});

describe('quote normalization and metrics', () => {
    test('normalizes omitted and default addresses to wrapped SOL while preserving custom quote mints', () => {
        const wrapped_sol = normalize_quote_mint();

        expect(String(wrapped_sol)).toBe('So11111111111111111111111111111111111111112');
        expect(normalize_quote_mint(PublicKey.default).equals(wrapped_sol)).toBeTrue();
        expect(normalize_quote_mint(mint).equals(mint)).toBeTrue();
        expect(normalize_quote_mint(mint.toBase58()).equals(mint)).toBeTrue();
    });

    test('scales raw quote prices and market cap across differing decimal precision', () => {
        expect(quote_metrics(2.5, 1_000_000_000n, 9)).toEqual({ price_quote: 0.0025, mcap_quote: 2.5 });
        expect(quote_metrics(7, 0n, 6)).toEqual({ price_quote: 7, mcap_quote: 0 });
    });
});

describe('parsed transaction handling', () => {
    test('deserializes RPC numeric and address fields into bigint and PublicKey values', () => {
        const parsed = deserialize_parsed_transaction(raw_parsed_transaction());
        const instruction = parsed.transaction.message.instructions[0];

        expect(parsed.slot).toBe(42n);
        expect(parsed.blockTime).toBe(1_700_000_000n);
        expect(parsed.meta?.fee).toBe(5_000n);
        expect(parsed.meta?.preBalances).toEqual([5_000_000_000n]);
        expect(parsed.transaction.message.accountKeys[0].pubkey.equals(account)).toBeTrue();
        expect(instruction.programId.equals(SystemProgram.programId)).toBeTrue();
        expect('accounts' in instruction && instruction.accounts[0].equals(account)).toBeTrue();
        expect(parsed.transaction.message.addressTableLookups?.[0].accountKey.equals(mint)).toBeTrue();
        expect(parsed.meta?.loadedAddresses?.readonly[0].equals(mint)).toBeTrue();
        expect(parsed.transaction.message.transactionConfig?.priorityFeeLamports).toBe(2_000_000n);
    });

    test('rejects a priority fee that is neither a number nor a bigint', () => {
        const raw = raw_parsed_transaction();
        const config = raw.transaction.message.transactionConfig;
        if (!config) throw new Error('Fixture is missing transaction config');
        config.priorityFeeLamports = '2000000' as unknown as bigint;

        expect(() => deserialize_parsed_transaction(raw)).toThrow('Invalid transaction priority fee');
    });

    test('calculates owner SOL and token changes plus v1 priority and trailing transfer fees', () => {
        const transaction = deserialize_parsed_transaction(raw_parsed_transaction());
        if (!transaction.meta) throw new Error('Fixture is missing transaction metadata');
        transaction.meta.preTokenBalances = [
            {
                accountIndex: 0,
                mint: mint.toBase58(),
                owner: account.toBase58(),
                programId: PublicKey.default.toBase58(),
                uiTokenAmount: { amount: '1000', decimals: 2, uiAmount: 10, uiAmountString: '10' }
            }
        ];
        transaction.meta.postTokenBalances = [
            {
                accountIndex: 0,
                mint: mint.toBase58(),
                owner: account.toBase58(),
                programId: PublicKey.default.toBase58(),
                uiTokenAmount: { amount: '2500', decimals: 2, uiAmount: 25, uiAmountString: '25' }
            }
        ];
        transaction.transaction.message.instructions = [
            {
                program: 'system',
                programId: SystemProgram.programId,
                parsed: { type: 'transfer', info: { lamports: 1_000_000 } }
            }
        ];

        expect(calc_token_balance_changes(transaction, account, mint.toBase58())).toEqual({
            pre_sol_balance: 5,
            post_sol_balance: 4.5,
            pre_token_balance: 10,
            post_token_balance: 25,
            change_sol: -0.5,
            change_tokens: 15,
            fees: 0.003
        });
    });

    test('returns null when metadata is absent, failed, or does not contain the account', () => {
        const transaction = deserialize_parsed_transaction(raw_parsed_transaction());
        expect(calc_token_balance_changes({ ...transaction, meta: null }, account)).toBeNull();

        const failed = {
            ...transaction,
            meta: transaction.meta ? { ...transaction.meta, err: { InstructionError: [0, 'failed'] } } : null
        } as ParsedTransactionWithMeta;
        expect(calc_token_balance_changes(failed, account)).toBeNull();
        expect(calc_token_balance_changes(transaction, new PublicKey(new Uint8Array(32).fill(3)))).toBeNull();
    });
});
