import { describe, expect, test } from 'bun:test';
import type { DBCQuoteState } from '../src/meteora/dbc_math';

// Set env before the dynamic import: dbc_math loads constants that read them during module initialization.
process.env.HELIUS_API_KEY ||= 'unit-test';
process.env.PINATA_IPFS_JWT ||= 'unit-test';

const { dbc_fee_numerator, dbc_rate_limiter_active, quote_dbc_exact_in } = await import('../src/meteora/dbc_math');
const { FEE_DENOMINATOR, ONE_Q64 } = await import('../src/meteora/damm_math');

function dbc_state(
    overrides: Partial<DBCQuoteState> = {},
    config_overrides: Partial<DBCQuoteState['config']> = {}
): DBCQuoteState {
    return {
        config: {
            cliff_fee_numerator: 0n,
            period_frequency: 10n,
            reduction_factor: 0n,
            number_of_periods: 4,
            base_fee_mode: 0,
            activation_type: 0,
            collect_fee_mode: 0,
            dynamic_fee_initialized: 0,
            variable_fee_control: 0,
            max_volatility_accumulator: 0,
            bin_step: 1,
            bin_step_u128: ONE_Q64 / 100n,
            filter_period: 0,
            decay_period: 0,
            dynamic_reduction_factor: 0,
            sqrt_start_price: ONE_Q64,
            migration_sqrt_price: 2n * ONE_Q64,
            migration_quote_threshold: 0n,
            curve: [
                { sqrt_price: ONE_Q64, liquidity: 1_000n * ONE_Q64 },
                { sqrt_price: 2n * ONE_Q64, liquidity: 1_000n * ONE_Q64 }
            ],
            ...config_overrides
        },
        sqrt_price: ONE_Q64,
        activation_point: 100n,
        current_point: 100n,
        timestamp: 1_000n,
        last_update_timestamp: 1_000n,
        sqrt_price_reference: ONE_Q64,
        volatility_accumulator: 0n,
        volatility_reference: 0n,
        first_swap_with_min_fee: false,
        ...overrides
    };
}

describe('DBC base fees', () => {
    test('linear schedules decrease at period boundaries and stop after the configured periods', () => {
        const state = dbc_state(
            {},
            {
                cliff_fee_numerator: 30_000_000n,
                reduction_factor: 5_000_000n,
                number_of_periods: 4
            }
        );

        expect(dbc_fee_numerator(state, 1_000n, 'buy')).toBe(30_000_000n);
        expect(dbc_fee_numerator({ ...state, current_point: 120n }, 1_000n, 'buy')).toBe(20_000_000n);
        expect(dbc_fee_numerator({ ...state, current_point: 1_000n }, 1_000n, 'buy')).toBe(10_000_000n);
    });

    test('rate limiting matches representative included-amount reference vectors', () => {
        const state = dbc_state(
            {},
            {
                base_fee_mode: 2,
                cliff_fee_numerator: 10_000_000n,
                period_frequency: 60n,
                reduction_factor: 1_000_000_000n,
                number_of_periods: 100
            }
        );
        const amounts = [1_000_000_000n, 1_500_000_000n, 2_000_000_000n, 3_000_000_000n, 4_000_000_000n];

        // Adapted numeric vector: https://github.com/MeteoraAg/dynamic-bonding-curve-sdk/blob/aa1595c29a0457b23a80cfcf9843a04603954858/packages/dynamic-bonding-curve/src/math/poolFees/rateLimiter.ts
        // Program reference: https://github.com/MeteoraAg/dynamic-bonding-curve/blob/f552f20aa3c1c7631427c3827aeea7c58b902813/programs/dynamic-bonding-curve/src/base_fee/fee_rate_limiter.rs
        expect(amounts.map((amount) => dbc_fee_numerator(state, amount, 'buy'))).toEqual([
            10_000_000n,
            13_333_334n,
            15_000_000n,
            20_000_000n,
            25_000_000n
        ]);

        expect(dbc_rate_limiter_active(state)).toBeTrue();
        expect(dbc_fee_numerator(state, amounts.at(-1)!, 'sell')).toBe(10_000_000n);

        const expired = { ...state, current_point: state.activation_point + state.config.period_frequency + 1n };
        expect(dbc_rate_limiter_active(expired)).toBeFalse();
        expect(dbc_fee_numerator(expired, amounts.at(-1)!, 'buy')).toBe(10_000_000n);
    });

    test('exponential schedules decrease over time and stop at the configured period limit', () => {
        const state = dbc_state(
            {},
            {
                base_fee_mode: 1,
                cliff_fee_numerator: 100_000_000n,
                reduction_factor: 1_000n,
                number_of_periods: 3
            }
        );
        const points = [100n, 110n, 120n, 130n];

        // Adapted numeric vector: https://github.com/MeteoraAg/dynamic-bonding-curve-sdk/blob/aa1595c29a0457b23a80cfcf9843a04603954858/packages/dynamic-bonding-curve/src/math/poolFees/feeScheduler.ts
        // Program reference: https://github.com/MeteoraAg/dynamic-bonding-curve/blob/f552f20aa3c1c7631427c3827aeea7c58b902813/programs/dynamic-bonding-curve/src/base_fee/fee_scheduler.rs
        expect(points.map((current_point) => dbc_fee_numerator({ ...state, current_point }, 1_000n, 'buy'))).toEqual([
            100_000_000n,
            90_000_000n,
            81_000_000n,
            72_900_000n
        ]);
        expect(dbc_fee_numerator({ ...state, current_point: 1_000n }, 1_000n, 'buy')).toBe(72_900_000n);
    });

    test('dynamic fees increase with volatility, skip the minimum-fee swap, and remain capped', () => {
        const state = dbc_state(
            { volatility_accumulator: 10_000n },
            {
                cliff_fee_numerator: 10_000_000n,
                dynamic_fee_initialized: 1,
                variable_fee_control: 100_000,
                bin_step: 100
            }
        );
        const dynamic_fee = dbc_fee_numerator(state, 1n << 128n, 'buy');

        expect(dynamic_fee).toBeGreaterThan(state.config.cliff_fee_numerator);
        expect(dynamic_fee).toBeLessThanOrEqual(990_000_000n);
        expect(dbc_fee_numerator({ ...state, first_swap_with_min_fee: true }, 1n << 128n, 'buy')).toBe(
            state.config.cliff_fee_numerator
        );
    });
});

describe('DBC exact-in quotes', () => {
    test('buy output and ending price increase monotonically with input', () => {
        const state = dbc_state();
        const quotes = [10n, 50n, 100n].map((amount) => quote_dbc_exact_in(state, amount, 'buy'));

        expect(quotes[0].output_amount).toBeLessThan(quotes[1].output_amount);
        expect(quotes[1].output_amount).toBeLessThan(quotes[2].output_amount);
        expect(quotes[0].next.sqrt_price).toBeLessThan(quotes[1].next.sqrt_price);
        expect(quotes[1].next.sqrt_price).toBeLessThan(quotes[2].next.sqrt_price);
        for (const [index, quote] of quotes.entries()) {
            expect(quote.output_amount).toBeGreaterThanOrEqual(0n);
            expect(quote.base_amount).toBe(quote.output_amount);
            expect(quote.quote_amount).toBe([10n, 50n, 100n][index]);
            expect(quote.next.first_swap_with_min_fee).toBeFalse();
        }
    });

    test('sell output increases monotonically while the ending price decreases', () => {
        const state = dbc_state({ sqrt_price: 2n * ONE_Q64 });
        const quotes = [10n, 50n, 100n].map((amount) => quote_dbc_exact_in(state, amount, 'sell'));

        expect(quotes[0].output_amount).toBeLessThan(quotes[1].output_amount);
        expect(quotes[1].output_amount).toBeLessThan(quotes[2].output_amount);
        expect(quotes[0].next.sqrt_price).toBeGreaterThan(quotes[1].next.sqrt_price);
        expect(quotes[1].next.sqrt_price).toBeGreaterThan(quotes[2].next.sqrt_price);
        for (const [index, quote] of quotes.entries()) {
            expect(quote.output_amount).toBeGreaterThanOrEqual(0n);
            expect(quote.base_amount).toBe([10n, 50n, 100n][index]);
            expect(quote.quote_amount).toBe(quote.output_amount);
        }
    });

    test('input and output fee modes conserve the reported gross amounts with ceiling-safe fees', () => {
        const input_fee = quote_dbc_exact_in(
            dbc_state({}, { cliff_fee_numerator: FEE_DENOMINATOR / 10n, collect_fee_mode: 0 }),
            100n,
            'buy'
        );
        const output_fee = quote_dbc_exact_in(
            dbc_state({}, { cliff_fee_numerator: FEE_DENOMINATOR / 10n, collect_fee_mode: 1 }),
            100n,
            'buy'
        );

        expect(input_fee.quote_amount).toBe(90n);
        expect(input_fee.base_amount).toBe(input_fee.output_amount);
        expect(output_fee.quote_amount).toBe(100n);
        expect(output_fee.base_amount - output_fee.output_amount).toBe(9n);
        expect(input_fee.output_amount).toBeGreaterThanOrEqual(0n);
        expect(output_fee.output_amount).toBeGreaterThanOrEqual(0n);
    });

    test('rejects nonpositive amounts before changing state', () => {
        const state = dbc_state();

        expect(() => quote_dbc_exact_in(state, 0n, 'buy')).toThrow('must be positive');
        expect(() => quote_dbc_exact_in(state, -1n, 'sell')).toThrow('must be positive');
        expect(state.sqrt_price).toBe(ONE_Q64);
    });

    test('rejects inactive pools and inputs beyond the available integer liquidity', () => {
        expect(() => dbc_fee_numerator(dbc_state({ current_point: 99n }), 1n, 'buy')).toThrow('not active');
        expect(() => quote_dbc_exact_in(dbc_state(), 1n << 128n, 'buy')).toThrow('remaining curve liquidity');
    });
});
