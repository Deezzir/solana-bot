import { describe, expect, test } from 'bun:test';
import type { Wallet } from '../src/common/common';

process.env.HELIUS_API_KEY ||= 'unit-test';
process.env.PINATA_IPFS_JWT ||= 'unit-test';

const { chunks, filter_wallets, json_bigint, rpc_bigint, safe_number, zip } = await import('../src/common/common');

function wallet(id: number): Wallet {
    return {
        id,
        name: `wallet-${id}`,
        is_reserve: false,
        keypair: {} as Wallet['keypair']
    };
}

describe('safe numeric conversion', () => {
    test('converts safe integer numbers and bigints without changing their value', () => {
        expect(safe_number(42)).toBe(42);
        expect(safe_number(9_007_199_254_740_991n)).toBe(Number.MAX_SAFE_INTEGER);
    });

    test('rejects values that cannot be represented as safe integers', () => {
        expect(() => safe_number(1.5)).toThrow(RangeError);
        expect(() => safe_number(9_007_199_254_740_992n)).toThrow(RangeError);
        expect(() => safe_number(Number.NaN)).toThrow(RangeError);
    });
});

describe('RPC bigint normalization', () => {
    test('normalizes safe RPC integers and preserves bigint inputs', () => {
        const existing = 123n;

        expect(rpc_bigint(456)).toBe(456n);
        expect(rpc_bigint(existing)).toBe(existing);
    });

    test('rejects unsafe or fractional RPC numbers', () => {
        expect(() => rpc_bigint(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
        expect(() => rpc_bigint(0.25)).toThrow(RangeError);
    });
});

test('JSON bigint serialization converts bigints at any nesting level and leaves other values unchanged', () => {
    const value = {
        count: 12n,
        nested: [0n, { label: 'unchanged', enabled: true }]
    };

    expect(JSON.stringify(value, json_bigint)).toBe(
        '{"count":"12","nested":["0",{"label":"unchanged","enabled":true}]}'
    );
});

describe('collection helpers', () => {
    test('chunks preserve order, include a short final chunk, and do not mutate the input', () => {
        const input = [1, 2, 3, 4, 5];

        expect(chunks(input, 2)).toEqual([[1, 2], [3, 4], [5]]);
        expect(input).toEqual([1, 2, 3, 4, 5]);
        expect(chunks([], 3)).toEqual([]);
    });

    test('filters wallets by an explicit id list regardless of source order', () => {
        const wallets = [wallet(1), wallet(2), wallet(3), wallet(4)];

        expect(filter_wallets(wallets, 0, 1, [4, 2]).map(({ id }) => id)).toEqual([2, 4]);
    });

    test('slices wallets when no id list is supplied', () => {
        const wallets = [wallet(1), wallet(2), wallet(3), wallet(4)];

        expect(filter_wallets(wallets, 1, 3).map(({ id }) => id)).toEqual([2, 3]);
    });

    test('zips equal-length collections and rejects mismatched lengths', () => {
        expect(zip(['a', 'b'], [1, 2])).toEqual([
            ['a', 1],
            ['b', 2]
        ]);
        expect(() => zip([1], ['a', 'b'])).toThrow('Array lengths do not match');
    });
});
