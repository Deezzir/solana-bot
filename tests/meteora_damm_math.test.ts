import { describe, expect, test } from 'bun:test';
import {
    BASIS_POINT_MAX,
    CollectFeeMode,
    FEE_DENOMINATOR,
    ONE_Q64,
    TradeDirection,
    damm_fee_numerator,
    damm_u256_le,
    pow_q64,
    quote_exact_in
} from '../src/meteora/damm_math';

type DammPool = Parameters<typeof quote_exact_in>[0];

function time_fee_data(cliff_fee_numerator = 10_000_000n): Buffer {
    const data = Buffer.alloc(32);
    data.writeBigUInt64LE(cliff_fee_numerator, 0);
    data.writeUInt8(0, 8);
    data.writeUInt16LE(0, 14);
    data.writeBigUInt64LE(10n, 16);
    data.writeBigUInt64LE(0n, 24);
    return data;
}

function rate_limiter_data(): Buffer {
    const data = Buffer.alloc(32);
    data.writeBigUInt64LE(10_000_000n, 0);
    data.writeUInt8(2, 8);
    data.writeUInt16LE(100, 14);
    data.writeUInt32LE(60, 16);
    data.writeUInt32LE(5_000, 20);
    data.writeBigUInt64LE(1_000_000_000n, 24);
    return data;
}

function damm_pool(overrides: Partial<DammPool> = {}): DammPool {
    return {
        base_fee_data: time_fee_data(),
        protocol_fee_percent: 20,
        referral_fee_percent: 25,
        compounding_fee_bps: 2_500,
        dynamic_fee_initialized: 0,
        dynamic_fee_variable_fee_control: 0,
        dynamic_fee_bin_step: 0,
        dynamic_fee_volatility_accumulator: 0n,
        init_sqrt_price: ONE_Q64,
        fee_version: 0,
        collect_fee_mode: CollectFeeMode.Compounding,
        activation_point: 100n,
        sqrt_price: ONE_Q64,
        token_a_amount: 1_000_000n,
        token_b_amount: 2_000_000n,
        liquidity: 1_000_000n * ONE_Q64,
        sqrt_min_price: ONE_Q64 / 2n,
        sqrt_max_price: 2n * ONE_Q64,
        ...overrides
    };
}

function total_fees(quote: ReturnType<typeof quote_exact_in>): bigint {
    return fee_parts(quote).reduce((total, fee) => total + fee, 0n);
}

function fee_parts(quote: ReturnType<typeof quote_exact_in>): bigint[] {
    return [quote.claiming_fee, quote.compounding_fee, quote.protocol_fee, quote.referral_fee];
}

describe('DAMM fixed-point helpers', () => {
    test('fixed-point powers preserve identity and exact binary fractions', () => {
        expect(pow_q64(ONE_Q64 / 2n, 0n)).toBe(ONE_Q64);
        expect(pow_q64(ONE_Q64 / 2n, 2n)).toBe(ONE_Q64 / 4n);
    });

    test('little-endian u256 decoding preserves low and high boundary bytes', () => {
        const data = Buffer.alloc(32);
        data[0] = 0x34;
        data[1] = 0x12;
        data[31] = 0x80;

        expect(damm_u256_le(data)).toBe((0x80n << 248n) + 0x1234n);
    });
});

describe('DAMM fees', () => {
    test('rate-limited B-to-A fees match representative included-amount reference vectors', () => {
        const pool = damm_pool({ base_fee_data: rate_limiter_data() });
        const amounts = [1_000_000_000n, 1_500_000_000n, 2_000_000_000n, 3_000_000_000n, 4_000_000_000n];
        const fees = amounts.map((amount) => damm_fee_numerator(pool, amount, TradeDirection.BtoA, 100n));

        // Adapted numeric vector: https://github.com/MeteoraAg/damm-v2-sdk/blob/8ed7fcef1a70c972eb0fae5b82d876ae2427a6a3/src/math/poolFees/baseFee/rateLimiter.ts
        // Program reference: https://github.com/MeteoraAg/damm-v2/blob/a85c926607433f23f0ea60f4ca7b1ae92f4156cb/programs/cp-amm/src/tests/test_rate_limiter.rs
        expect(fees).toEqual([10_000_000n, 13_333_334n, 15_000_000n, 20_000_000n, 25_000_000n]);
        expect(fees.at(-1)).toBeLessThanOrEqual((5_000n * FEE_DENOMINATOR) / BASIS_POINT_MAX);
        expect(damm_fee_numerator(pool, amounts.at(-1)!, TradeDirection.AtoB, 100n)).toBe(10_000_000n);
        expect(damm_fee_numerator(pool, amounts.at(-1)!, TradeDirection.BtoA, 161n)).toBe(10_000_000n);
    });

    test('dynamic fees round upward and obey the pool-version maximum', () => {
        const dynamic = damm_pool({
            base_fee_data: time_fee_data(0n),
            dynamic_fee_initialized: 1,
            dynamic_fee_variable_fee_control: 1,
            dynamic_fee_bin_step: 1,
            dynamic_fee_volatility_accumulator: 1n
        });
        const capped = damm_pool({
            dynamic_fee_initialized: 1,
            dynamic_fee_variable_fee_control: 1_000_000_000,
            dynamic_fee_bin_step: 1_000_000,
            dynamic_fee_volatility_accumulator: 1_000_000n
        });

        expect(damm_fee_numerator(dynamic, 1n, TradeDirection.AtoB, 100n)).toBe(1n);
        expect(damm_fee_numerator(capped, 1n, TradeDirection.AtoB, 100n)).toBe(500_000_000n);
        expect(damm_fee_numerator({ ...capped, fee_version: 1 }, 1n, TradeDirection.AtoB, 100n)).toBe(990_000_000n);
    });
});

describe('DAMM exact-in quotes', () => {
    test('A-to-B compounding quotes are monotonic and conserve output-side fees', () => {
        const pool = damm_pool();
        const quotes = [1_000n, 5_000n, 10_000n].map((amount) =>
            quote_exact_in(pool, amount, TradeDirection.AtoB, 100n)
        );

        expect(quotes[0].output_amount).toBeLessThan(quotes[1].output_amount);
        expect(quotes[1].output_amount).toBeLessThan(quotes[2].output_amount);
        expect(quotes[0].next_sqrt_price).toBeGreaterThan(quotes[1].next_sqrt_price);
        expect(quotes[1].next_sqrt_price).toBeGreaterThan(quotes[2].next_sqrt_price);
        for (const [index, quote] of quotes.entries()) {
            expect(quote.output_amount).toBeGreaterThanOrEqual(0n);
            for (const fee of fee_parts(quote)) expect(fee).toBeGreaterThanOrEqual(0n);
            expect(quote.included_fee_input_amount).toBe([1_000n, 5_000n, 10_000n][index]);
            expect(quote.excluded_fee_input_amount).toBe(quote.included_fee_input_amount);
            expect(quote.amount_left).toBe(0n);
            expect(quote.next_sqrt_price).toBeGreaterThan(0n);
        }
        expect(quotes[2]).toMatchObject({
            claiming_fee: 120n,
            compounding_fee: 40n,
            protocol_fee: 39n,
            referral_fee: 0n
        });
        expect(quotes[2].output_amount + total_fees(quotes[2])).toBe(19_801n);
    });

    test('B-to-A compounding quotes are monotonic and conserve input-side fees', () => {
        const pool = damm_pool();
        const quotes = [1_000n, 5_000n, 10_000n].map((amount) =>
            quote_exact_in(pool, amount, TradeDirection.BtoA, 100n)
        );

        expect(quotes[0].output_amount).toBeLessThan(quotes[1].output_amount);
        expect(quotes[1].output_amount).toBeLessThan(quotes[2].output_amount);
        expect(quotes[0].next_sqrt_price).toBeLessThan(quotes[1].next_sqrt_price);
        expect(quotes[1].next_sqrt_price).toBeLessThan(quotes[2].next_sqrt_price);
        for (const quote of quotes) {
            expect(quote.output_amount).toBeGreaterThanOrEqual(0n);
            for (const fee of fee_parts(quote)) expect(fee).toBeGreaterThanOrEqual(0n);
            expect(quote.excluded_fee_input_amount + total_fees(quote)).toBe(quote.included_fee_input_amount);
            expect(quote.amount_left).toBe(0n);
            expect(quote.next_sqrt_price).toBeGreaterThan(0n);
        }
        expect(quotes[2]).toMatchObject({
            claiming_fee: 60n,
            compounding_fee: 20n,
            protocol_fee: 20n,
            referral_fee: 0n,
            excluded_fee_input_amount: 9_900n
        });
    });

    test('non-compounding collect modes place fees on the configured side', () => {
        const both_token = damm_pool({ collect_fee_mode: CollectFeeMode.BothToken });
        const only_b = damm_pool({ collect_fee_mode: CollectFeeMode.OnlyB });

        for (const pool of [both_token, only_b]) {
            const a_to_b = quote_exact_in(pool, 10_000n, TradeDirection.AtoB, 100n);
            expect(a_to_b.excluded_fee_input_amount).toBe(a_to_b.included_fee_input_amount);
            expect(a_to_b.output_amount).toBeGreaterThan(0n);
            expect(a_to_b.next_sqrt_price).toBeLessThan(pool.sqrt_price);
        }

        const both_b_to_a = quote_exact_in(both_token, 10_000n, TradeDirection.BtoA, 100n);
        expect(both_b_to_a.excluded_fee_input_amount).toBe(both_b_to_a.included_fee_input_amount);
        expect(both_b_to_a.next_sqrt_price).toBeGreaterThan(both_token.sqrt_price);

        const only_b_to_a = quote_exact_in(only_b, 10_000n, TradeDirection.BtoA, 100n);
        expect(only_b_to_a.excluded_fee_input_amount + total_fees(only_b_to_a)).toBe(
            only_b_to_a.included_fee_input_amount
        );
        expect(only_b_to_a.next_sqrt_price).toBeGreaterThan(only_b.sqrt_price);
    });

    test('dynamic fees flow through quotes and reduce output', () => {
        const pool = damm_pool();
        const dynamic_pool = damm_pool({
            dynamic_fee_initialized: 1,
            dynamic_fee_variable_fee_control: 10_000,
            dynamic_fee_bin_step: 100,
            dynamic_fee_volatility_accumulator: 10_000n
        });
        const base_quote = quote_exact_in(pool, 10_000n, TradeDirection.AtoB, 100n);
        const dynamic_quote = quote_exact_in(dynamic_pool, 10_000n, TradeDirection.AtoB, 100n);

        expect(total_fees(dynamic_quote)).toBeGreaterThan(total_fees(base_quote));
        expect(dynamic_quote.output_amount).toBeLessThan(base_quote.output_amount);
        expect(dynamic_quote.next_sqrt_price).toBeGreaterThan(0n);
    });

    test('compounding next price matches the post-swap reserve ratio within integer sqrt rounding', () => {
        const pool = damm_pool();
        const quote = quote_exact_in(pool, 10_000n, TradeDirection.AtoB, 100n);
        const gross_output = quote.output_amount + total_fees(quote);
        const next_a = pool.token_a_amount + quote.excluded_fee_input_amount;
        const next_b = pool.token_b_amount - gross_output + quote.compounding_fee;
        const ratio_q128 = (next_b << 128n) / next_a;

        expect(quote.next_sqrt_price * quote.next_sqrt_price).toBeLessThanOrEqual(ratio_q128);
        expect((quote.next_sqrt_price + 1n) ** 2n).toBeGreaterThan(ratio_q128);
    });

    test('rejects nonpositive amounts', () => {
        const pool = damm_pool();

        expect(() => quote_exact_in(pool, 0n, TradeDirection.AtoB, 100n)).toThrow(RangeError);
        expect(() => quote_exact_in(pool, -1n, TradeDirection.BtoA, 100n)).toThrow(RangeError);
    });
});
