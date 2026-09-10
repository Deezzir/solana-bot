import { TradeOp } from '../common/trade_common';
import { METEORA_DBC_PARAMS } from '../constants';
import { BASIS_POINT_MAX, FEE_DENOMINATOR, ONE_Q64, ONE_Q128, pow_q64, DYNAMIC_FEE_SCALING_FACTOR } from './damm_math';

type DBCQuoteConfig = {
    cliff_fee_numerator: bigint;
    period_frequency: bigint;
    reduction_factor: bigint;
    number_of_periods: number;
    base_fee_mode: number;
    activation_type: number;
    collect_fee_mode: number;
    dynamic_fee_initialized: number;
    variable_fee_control: number;
    max_volatility_accumulator: number;
    bin_step: number;
    bin_step_u128: bigint;
    filter_period: number;
    decay_period: number;
    dynamic_reduction_factor: number;
    sqrt_start_price: bigint;
    migration_sqrt_price: bigint;
    migration_quote_threshold: bigint;
    curve: { sqrt_price: bigint; liquidity: bigint }[];
};

export type DBCQuoteState = {
    config: DBCQuoteConfig;
    sqrt_price: bigint;
    activation_point: bigint;
    current_point: bigint;
    timestamp: bigint;
    last_update_timestamp: bigint;
    sqrt_price_reference: bigint;
    volatility_accumulator: bigint;
    volatility_reference: bigint;
    first_swap_with_min_fee: boolean;
};

const min = (a: bigint, b: bigint) => (a < b ? a : b);
const ceil_div = (a: bigint, b: bigint) => (a + b - 1n) / b;

export function dbc_rate_limiter_active(state: DBCQuoteState): boolean {
    const config = state.config;
    return (
        config.base_fee_mode === 2 &&
        config.reduction_factor > 0n &&
        config.number_of_periods > 0 &&
        state.current_point <= state.activation_point + config.period_frequency
    );
}

export function dbc_fee_numerator(state: DBCQuoteState, amount: bigint, op: TradeOp): bigint {
    const buy = op === 'buy';
    const config = state.config;
    if (state.current_point < state.activation_point) throw new Error('DBC pool is not active yet.');
    let fee = config.cliff_fee_numerator;
    if (config.base_fee_mode === 0 || config.base_fee_mode === 1) {
        const periods = state.first_swap_with_min_fee
            ? BigInt(config.number_of_periods)
            : config.period_frequency === 0n
              ? 0n
              : min(
                    (state.current_point - state.activation_point) / config.period_frequency,
                    BigInt(config.number_of_periods)
                );
        fee =
            config.base_fee_mode === 0
                ? fee - periods * config.reduction_factor
                : (fee * pow_q64(ONE_Q64 - (config.reduction_factor * ONE_Q64) / BASIS_POINT_MAX, periods)) / ONE_Q64;
    } else if (config.base_fee_mode === 2) {
        const reference = config.reduction_factor;
        if (buy && dbc_rate_limiter_active(state) && amount > reference) {
            const increment = (BigInt(config.number_of_periods) * FEE_DENOMINATOR) / BASIS_POINT_MAX;
            const max_index = (METEORA_DBC_PARAMS.max_fee_numerator - fee) / increment;
            const a = (amount - reference) / reference;
            const b = (amount - reference) % reference;
            const index = min(a, max_index);
            const full = reference * (fee * (index + 1n) + (increment * index * (index + 1n)) / 2n);
            const rest =
                a < max_index
                    ? b * (fee + increment * (a + 1n))
                    : ((a - max_index) * reference + b) * METEORA_DBC_PARAMS.max_fee_numerator;
            fee = ceil_div(ceil_div(full + rest, FEE_DENOMINATOR) * FEE_DENOMINATOR, amount);
        }
    } else throw new Error(`Unsupported DBC base fee mode: ${config.base_fee_mode}`);
    if (config.dynamic_fee_initialized && !state.first_swap_with_min_fee) {
        const volatility = state.volatility_accumulator * BigInt(config.bin_step);
        fee += ceil_div(volatility * volatility * BigInt(config.variable_fee_control), DYNAMIC_FEE_SCALING_FACTOR);
    }
    return min(fee, METEORA_DBC_PARAMS.max_fee_numerator);
}

function delta_bins(a: bigint, b: bigint, step: bigint): bigint {
    const upper = a > b ? a : b;
    const lower = a > b ? b : a;
    return (((upper * ONE_Q64) / lower - ONE_Q64) / step) * 2n;
}

export function quote_dbc_exact_in(state: DBCQuoteState, amount: bigint, op: TradeOp) {
    if (amount <= 0n) throw new Error('DBC swap amount must be positive.');
    const config = state.config;
    const next = { ...state };
    if (config.dynamic_fee_initialized) {
        const elapsed =
            state.timestamp > state.last_update_timestamp ? state.timestamp - state.last_update_timestamp : 0n;
        if (elapsed >= BigInt(config.filter_period)) {
            next.sqrt_price_reference = state.sqrt_price;
            next.volatility_reference =
                elapsed < BigInt(config.decay_period)
                    ? (state.volatility_accumulator * BigInt(config.dynamic_reduction_factor)) / BASIS_POINT_MAX
                    : 0n;
        }
    }
    const buy = op === 'buy';
    const fee_numerator = dbc_fee_numerator(state, amount, op);
    const fee_on_input = buy && config.collect_fee_mode === 0;
    const fee = (value: bigint) => ceil_div(value * fee_numerator, FEE_DENOMINATOR);
    const input_amount = fee_on_input ? amount - fee(amount) : amount;
    let remaining = input_amount;
    let output = 0n;
    let price = state.sqrt_price;
    if (buy) {
        for (const point of config.curve) {
            const target = min(point.sqrt_price, config.migration_sqrt_price);
            if (target <= price) continue;
            const max_input = ceil_div(point.liquidity * (target - price), ONE_Q128);
            const input = min(remaining, max_input);
            const next_price = remaining < max_input ? price + (input * ONE_Q128) / point.liquidity : target;
            output += (point.liquidity * (next_price - price)) / (price * next_price);
            price = next_price;
            remaining -= input;
            if (remaining === 0n || price === config.migration_sqrt_price) break;
        }
    } else {
        for (let i = config.curve.length - 1; i >= 0 && remaining > 0n; i--) {
            const target = i === 0 ? config.sqrt_start_price : config.curve[i - 1].sqrt_price;
            if (target >= price) continue;
            const liquidity = config.curve[i].liquidity;
            const max_input = ceil_div(liquidity * (price - target), price * target);
            const input = min(remaining, max_input);
            const next_price = remaining < max_input ? ceil_div(price * liquidity, liquidity + input * price) : target;
            output += (liquidity * (price - next_price)) / ONE_Q128;
            price = next_price;
            remaining -= input;
        }
    }

    if (remaining > 0n) throw new Error('DBC swap exceeds the remaining curve liquidity.');
    const output_amount = fee_on_input ? output : output - fee(output);
    if (output_amount <= 0n) throw new Error('DBC swap produces no output.');
    if (config.dynamic_fee_initialized) {
        next.volatility_accumulator = min(
            BigInt(config.max_volatility_accumulator),
            next.volatility_reference +
                delta_bins(price, next.sqrt_price_reference, config.bin_step_u128) * BASIS_POINT_MAX
        );
        if (delta_bins(price, state.sqrt_price, config.bin_step_u128) > 0n)
            next.last_update_timestamp = state.timestamp;
    }
    next.sqrt_price = price;
    next.first_swap_with_min_fee = false;
    return {
        output_amount,
        base_amount: buy ? output : input_amount,
        quote_amount: buy ? input_amount : output,
        next
    };
}
