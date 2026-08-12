const FEE_DENOMINATOR = 1_000_000_000n;
const BASIS_POINT_MAX = 10_000n;
const SCALE_OFFSET = 64n;
const MAX_FEE_NUMERATOR_V0 = 500_000_000n; // 50%
const MAX_FEE_NUMERATOR_V1 = 990_000_000n; // 99%
const DYNAMIC_FEE_ROUNDING_OFFSET = 99_999_999_999n;
const DYNAMIC_FEE_SCALING_FACTOR = 100_000_000_000n;

export enum TradeDirection {
    AtoB,
    BtoA
}

type DAMMV2Quote = {
    claiming_fee: bigint;
    compounding_fee: bigint;
    protocol_fee: bigint;
    referral_fee: bigint;
    amount_left: bigint;
    included_fee_input_amount: bigint;
    excluded_fee_input_amount: bigint;
    output_amount: bigint;
    next_sqrt_price: bigint;
};

enum CollectFeeMode {
    BothToken,
    OnlyB,
    Compounding
}

type FeeMode = {
    fees_on_input: boolean;
    fees_on_token_a: boolean;
    has_referral: boolean;
};

enum BaseFeeMode {
    FeeTimeSchedulerLinear,
    FeeTimeSchedulerExponential,
    RateLimiter,
    FeeMarketCapSchedulerLinear,
    FeeMarketCapSchedulerExponential
}

interface SwapAmountFromInput {
    output_amount: bigint;
    next_sqrt_price: bigint;
    amount_left: bigint;
}

interface DAMMV2QuotePool {
    base_fee_data: Buffer;
    protocol_fee_percent: number;
    referral_fee_percent: number;
    compounding_fee_bps: number;
    dynamic_fee_initialized: number;
    dynamic_fee_variable_fee_control: number;
    dynamic_fee_bin_step: number;
    dynamic_fee_volatility_accumulator: bigint;
    init_sqrt_price: bigint;
    fee_version: number;
    collect_fee_mode: number;
    activation_point: bigint;
    sqrt_price: bigint;
    token_a_amount: bigint;
    token_b_amount: bigint;
    liquidity: bigint;
    sqrt_min_price: bigint;
    sqrt_max_price: bigint;
}

interface LiquidityHandler {
    calculate_a_to_b_from_amount_in(amount_in: bigint): SwapAmountFromInput;
    calculate_b_to_a_from_amount_in(amount_in: bigint): SwapAmountFromInput;
}

class CompoundingLiquidityHandler implements LiquidityHandler {
    public token_a_amount: bigint;
    public token_b_amount: bigint;
    public liquidity: bigint;

    constructor(token_a_amount: bigint, token_b_amount: bigint, liquidity: bigint) {
        this.token_a_amount = token_a_amount;
        this.token_b_amount = token_b_amount;
        this.liquidity = liquidity;
    }

    calculate_a_to_b_from_amount_in(amount_in: bigint): SwapAmountFromInput {
        const denominator = this.token_a_amount + amount_in;
        const output_amount = (this.token_b_amount * amount_in) / denominator;

        return {
            amount_left: 0n,
            output_amount,
            next_sqrt_price: 0n
        };
    }
    calculate_b_to_a_from_amount_in(amount_in: bigint): SwapAmountFromInput {
        const denominator = this.token_b_amount + amount_in;
        const output_amount = (this.token_a_amount * amount_in) / denominator;

        return {
            amount_left: 0n,
            output_amount,
            next_sqrt_price: 0n
        };
    }
}

class ConcentratedLiquidityHandler implements LiquidityHandler {
    private sqrt_max_price: bigint;
    private sqrt_min_price: bigint;
    private sqrt_price: bigint;
    private liquidity: bigint;

    constructor(sqrt_max_price: bigint, sqrt_min_price: bigint, sqrt_price: bigint, liquidity: bigint) {
        this.sqrt_max_price = sqrt_max_price;
        this.sqrt_min_price = sqrt_min_price;
        this.sqrt_price = sqrt_price;
        this.liquidity = liquidity;
    }

    private get_next_sqrt_price_from_amount_in(sqrt_price: bigint, liquidity: bigint, amount: bigint): bigint {
        if (amount === 0n) return sqrt_price;

        const product = amount * sqrt_price;
        const denominator = liquidity + product;
        const result = (liquidity * sqrt_price + denominator - 1n) / denominator;
        return result;
    }

    private get_next_sqrt_price_from_amount_in_b(sqrt_price: bigint, liquidity: bigint, amount: bigint): bigint {
        const quotient = (amount << (SCALE_OFFSET * 2n)) / liquidity;
        const result = sqrt_price + quotient;
        return result;
    }

    private get_next_sqrt_price_from_input(
        sqrt_price: bigint,
        liquidity: bigint,
        amount_int: bigint,
        a_to_b: boolean
    ): bigint {
        if (sqrt_price <= 0n) throw new Error('sqrt_price must be greater than 0');
        if (liquidity <= 0n) throw new Error('liquidity must be greater than 0');

        if (a_to_b) {
            return this.get_next_sqrt_price_from_amount_in(sqrt_price, liquidity, amount_int);
        } else {
            return this.get_next_sqrt_price_from_amount_in_b(sqrt_price, liquidity, amount_int);
        }
    }

    private get_amount_b_from_liquidity_delta(
        lower_sqrt_price: bigint,
        upper_sqrt_price: bigint,
        liquidity: bigint
    ): bigint {
        const delta_sqrt_price = upper_sqrt_price - lower_sqrt_price;
        const prod = liquidity * delta_sqrt_price;
        const result = prod >> (SCALE_OFFSET * 2n);
        return result;
    }

    private get_amount_a_from_liquidity_delta(
        lower_sqrt_price: bigint,
        upper_sqrt_price: bigint,
        liquidity: bigint
    ): bigint {
        const numerator_1 = liquidity;
        const numerator_2 = upper_sqrt_price - lower_sqrt_price;
        const denominator = lower_sqrt_price * upper_sqrt_price;

        if (denominator <= 0n) throw new Error('denominator must be greater than zero');

        const result = (numerator_1 * numerator_2) / denominator;
        return result;
    }

    calculate_a_to_b_from_amount_in(amount_in: bigint): SwapAmountFromInput {
        const next_sqrt_price = this.get_next_sqrt_price_from_input(this.sqrt_price, this.liquidity, amount_in, true);
        if (next_sqrt_price < this.sqrt_min_price) throw new Error('Price below minimum range');

        const output_amount = this.get_amount_b_from_liquidity_delta(next_sqrt_price, this.sqrt_price, this.liquidity);

        return {
            output_amount,
            next_sqrt_price,
            amount_left: 0n
        };
    }

    calculate_b_to_a_from_amount_in(amount_in: bigint): SwapAmountFromInput {
        const next_sqrt_price = this.get_next_sqrt_price_from_input(this.sqrt_price, this.liquidity, amount_in, false);

        if (next_sqrt_price > this.sqrt_max_price) throw new Error('Price above maximum range');

        const output_amount = this.get_amount_a_from_liquidity_delta(this.sqrt_price, next_sqrt_price, this.liquidity);

        return {
            output_amount,
            next_sqrt_price,
            amount_left: 0n
        };
    }
}

interface BaseFeeHandler {
    get_base_fee_numerator_from_included_fee_amount(
        current_point: bigint,
        activation_point: bigint,
        trade_direction: TradeDirection,
        included_fee_amount: bigint,
        init_sqrt_price: bigint,
        current_sqrt_price: bigint
    ): bigint;
    get_base_fee_numerator_from_excluded_fee_amount(
        currentPoint: bigint,
        activationPoint: bigint,
        tradeDirection: TradeDirection,
        excludedFeeAmount: bigint,
        initSqrtPrice: bigint,
        currentSqrtPrice: bigint
    ): bigint;
}

class FeeTimeScheduler implements BaseFeeHandler {
    public cliff_fee_numerator: bigint;
    public number_of_period: bigint;
    public period_frequency: bigint;
    public reduction_factor: bigint;
    public fee_time_schedule_mode: BaseFeeMode;

    constructor(
        cliff_fee_numerator: bigint,
        number_of_period: bigint,
        period_frequency: bigint,
        reduction_factor: bigint,
        fee_time_scheduler_mode: BaseFeeMode
    ) {
        this.cliff_fee_numerator = cliff_fee_numerator;
        this.number_of_period = number_of_period;
        this.period_frequency = period_frequency;
        this.reduction_factor = reduction_factor;
        this.fee_time_schedule_mode = fee_time_scheduler_mode;
    }

    private get_fee_time_base_fee_numerator(
        cliff_fee_numerator: bigint,
        number_of_period: bigint,
        period_frequency: bigint,
        reduction_factor: bigint,
        fee_time_scheduler_mode: BaseFeeMode,
        current_point: bigint,
        activation_point: bigint
    ): bigint {
        if (period_frequency === 0n) return cliff_fee_numerator;
        const period =
            current_point < activation_point ? number_of_period : (current_point - activation_point) / period_frequency;
        const capped_period = period < number_of_period ? period : number_of_period;
        if (capped_period > 65_535n) throw new Error('Fee scheduler period exceeds u16.');

        switch (fee_time_scheduler_mode) {
            case BaseFeeMode.FeeTimeSchedulerLinear:
                return cliff_fee_numerator - capped_period * reduction_factor;
            case BaseFeeMode.FeeTimeSchedulerExponential:
                return (
                    (cliff_fee_numerator *
                        pow_q64(ONE_Q64 - (reduction_factor << SCALE_OFFSET) / BASIS_POINT_MAX, capped_period)) >>
                    SCALE_OFFSET
                );
            default:
                throw new Error('Invalid fee time scheduler mode.');
        }
    }

    get_base_fee_numerator_from_included_fee_amount(
        current_point: bigint,
        activation_point: bigint,
        _dir: TradeDirection,
        _included_fee_amount: bigint,
        _init_sqrt_price: bigint,
        _current_sqrt_price: bigint
    ): bigint {
        return this.get_base_fee_numerator_from_excluded_fee_amount(
            current_point,
            activation_point,
            _dir,
            _included_fee_amount,
            _init_sqrt_price,
            _current_sqrt_price
        );
    }

    get_base_fee_numerator_from_excluded_fee_amount(
        current_point: bigint,
        activation_point: bigint,
        _dir: TradeDirection,
        _excluded_fee_amount: bigint,
        _init_sqrt_price: bigint,
        _current_sqrt_price: bigint
    ): bigint {
        return this.get_fee_time_base_fee_numerator(
            this.cliff_fee_numerator,
            this.number_of_period,
            this.period_frequency,
            this.reduction_factor,
            this.fee_time_schedule_mode,
            current_point,
            activation_point
        );
    }
}

class FeeRateLimiter implements BaseFeeHandler {
    public cliff_fee_numerator: bigint;
    public fee_increment_bps: bigint;
    public max_fee_bps: bigint;
    public max_limiter_duration: bigint;
    public reference_amount: bigint;

    constructor(
        cliff_fee_numerator: bigint,
        fee_increment_bps: bigint,
        max_fee_bps: bigint,
        max_limiter_duration: bigint,
        reference_amount: bigint
    ) {
        this.cliff_fee_numerator = cliff_fee_numerator;
        this.fee_increment_bps = fee_increment_bps;
        this.max_fee_bps = max_fee_bps;
        this.max_limiter_duration = max_limiter_duration;
        this.reference_amount = reference_amount;
    }

    get_base_fee_numerator_from_excluded_fee_amount(
        current_point: bigint,
        activation_point: bigint,
        dir: TradeDirection,
        excluded_fee_amount: bigint,
        _init_sqrt_price: bigint,
        _current_sqrt_price: bigint
    ): bigint {
        if (
            is_rate_limiter_applied(
                this.reference_amount,
                this.max_limiter_duration,
                this.max_fee_bps,
                this.fee_increment_bps,
                current_point,
                activation_point,
                dir
            )
        ) {
            return get_fee_numerator_from_included_fee_amount(
                excluded_fee_amount,
                this.reference_amount,
                this.cliff_fee_numerator,
                this.max_fee_bps,
                this.fee_increment_bps
            );
        } else {
            return this.cliff_fee_numerator;
        }
    }

    get_base_fee_numerator_from_included_fee_amount(
        current_point: bigint,
        activation_point: bigint,
        dir: TradeDirection,
        included_fee_amount: bigint,
        _init_sqrt_price: bigint,
        _current_sqrt_price: bigint
    ): bigint {
        return is_rate_limiter_applied(
            this.reference_amount,
            this.max_limiter_duration,
            this.max_fee_bps,
            this.fee_increment_bps,
            current_point,
            activation_point,
            dir
        )
            ? get_fee_numerator_from_included_fee_amount(
                  included_fee_amount,
                  this.reference_amount,
                  this.cliff_fee_numerator,
                  this.max_fee_bps,
                  this.fee_increment_bps
              )
            : this.cliff_fee_numerator;
    }
}

class FeeMarketCapScheduler implements BaseFeeHandler {
    public cliff_fee_numerator: bigint;
    public number_of_period: number;
    public sqrt_price_step_bps: number;
    public schedule_expiration_duration: number;
    public reduction_factor: bigint;
    public fee_market_cap_scheduler_mode: BaseFeeMode;

    constructor(
        cliff_fee_numerator: bigint,
        number_of_period: number,
        sqrt_price_step_bps: number,
        schedule_expiration_duration: number,
        reduction_factor: bigint,
        fee_market_cap_scheduler_mode: BaseFeeMode
    ) {
        this.cliff_fee_numerator = cliff_fee_numerator;
        this.number_of_period = number_of_period;
        this.sqrt_price_step_bps = sqrt_price_step_bps;
        this.schedule_expiration_duration = schedule_expiration_duration;
        this.reduction_factor = reduction_factor;
        this.fee_market_cap_scheduler_mode = fee_market_cap_scheduler_mode;
    }

    get_base_fee_numerator_from_excluded_fee_amount(
        current_point: bigint,
        activation_point: bigint,
        _dir: TradeDirection,
        _excludedFeeAmount: bigint,
        init_sqrt_price: bigint,
        current_sqrt_price: bigint
    ): bigint {
        return get_fee_market_cap_base_fee_numerator(
            this.cliff_fee_numerator,
            this.number_of_period,
            this.sqrt_price_step_bps,
            this.schedule_expiration_duration,
            this.reduction_factor,
            this.fee_market_cap_scheduler_mode,
            current_point,
            activation_point,
            init_sqrt_price,
            current_sqrt_price
        );
    }

    get_base_fee_numerator_from_included_fee_amount(
        current_point: bigint,
        activation_point: bigint,
        _dir: TradeDirection,
        _included_fee_amount: bigint,
        init_sqrt_price: bigint,
        current_sqrt_price: bigint
    ): bigint {
        return this.get_base_fee_numerator_from_excluded_fee_amount(
            current_point,
            activation_point,
            _dir,
            _included_fee_amount,
            init_sqrt_price,
            current_sqrt_price
        );
    }
}

const ONE_Q64 = 1n << SCALE_OFFSET;

function pow_q64(base: bigint, exponent: bigint): bigint {
    let result = ONE_Q64;
    let factor = base;
    let remaining = exponent;
    while (remaining > 0n) {
        if (remaining & 1n) result = (result * factor) >> SCALE_OFFSET;
        factor = (factor * factor) >> SCALE_OFFSET;
        remaining >>= 1n;
    }
    return result;
}

function get_fee_market_cap_base_fee_numerator(
    cliff_fee_numerator: bigint,
    number_of_period: number,
    sqrt_price_step_bps: number,
    scheduler_expiration_duration: number,
    reduction_factor: bigint,
    mode: BaseFeeMode,
    current_point: bigint,
    activation_point: bigint,
    init_sqrt_price: bigint,
    current_sqrt_price: bigint
): bigint {
    const expiration = activation_point + BigInt(scheduler_expiration_duration);
    let period: bigint;
    if (current_point > expiration || current_point < activation_point) period = BigInt(number_of_period);
    else if (current_sqrt_price <= init_sqrt_price) period = 0n;
    else {
        if (sqrt_price_step_bps === 0) throw new Error('Market-cap fee sqrt price step must be positive.');
        period =
            ((current_sqrt_price - init_sqrt_price) * BASIS_POINT_MAX) / init_sqrt_price / BigInt(sqrt_price_step_bps);
    }
    period = period < BigInt(number_of_period) ? period : BigInt(number_of_period);
    switch (mode) {
        case BaseFeeMode.FeeMarketCapSchedulerLinear:
            return cliff_fee_numerator - period * reduction_factor;
        case BaseFeeMode.FeeMarketCapSchedulerExponential:
            return (
                (cliff_fee_numerator *
                    pow_q64(ONE_Q64 - (reduction_factor << SCALE_OFFSET) / BASIS_POINT_MAX, period)) >>
                SCALE_OFFSET
            );
        default:
            throw new Error('Invalid market-cap fee scheduler mode.');
    }
}

function to_numerator(bps: bigint): bigint {
    return (bps * FEE_DENOMINATOR) / BASIS_POINT_MAX;
}

function is_rate_limiter_applied(
    reference_amount: bigint,
    max_limiter_duration: bigint,
    max_fee_bps: bigint,
    fee_increment_bps: bigint,
    current_point: bigint,
    activation_point: bigint,
    dir: TradeDirection
): boolean {
    if (reference_amount === 0n && max_limiter_duration === 0n && max_fee_bps === 0n && fee_increment_bps === 0n)
        return false;
    return (
        dir === TradeDirection.BtoA &&
        current_point >= activation_point &&
        current_point <= activation_point + max_limiter_duration
    );
}

function get_fee_numerator_from_included_fee_amount(
    input_amount: bigint,
    reference_amount: bigint,
    cliff_fee_numerator: bigint,
    max_fee_bps: bigint,
    fee_increment_bps: bigint
): bigint {
    if (input_amount <= reference_amount) return cliff_fee_numerator;
    if (reference_amount === 0n || fee_increment_bps === 0n) throw new Error('Invalid rate limiter parameters.');
    const max_fee_numerator = to_numerator(max_fee_bps);
    if (cliff_fee_numerator > max_fee_numerator) throw new Error('Rate limiter cliff fee exceeds maximum fee.');
    const increment = to_numerator(fee_increment_bps);
    const max_index = (max_fee_numerator - cliff_fee_numerator) / increment;
    const delta = input_amount - reference_amount;
    const a = delta / reference_amount;
    const b = delta % reference_amount;
    let fee_numerator: bigint;
    if (a < max_index) {
        fee_numerator =
            reference_amount * (cliff_fee_numerator + cliff_fee_numerator * a + (increment * a * (a + 1n)) / 2n) +
            b * (cliff_fee_numerator + increment * (a + 1n));
    } else {
        fee_numerator =
            reference_amount *
                (cliff_fee_numerator +
                    cliff_fee_numerator * max_index +
                    (increment * max_index * (max_index + 1n)) / 2n) +
            (a - max_index) * reference_amount * max_fee_numerator +
            b * max_fee_numerator;
    }
    const trading_fee = (fee_numerator + FEE_DENOMINATOR - 1n) / FEE_DENOMINATOR;
    return (trading_fee * FEE_DENOMINATOR + input_amount - 1n) / input_amount;
}

function sqrt(value: bigint): bigint {
    if (value < 2n) return value;
    if (value < 16n) return BigInt(Math.sqrt(Number(value)) | 0);

    let x0, x1: bigint;
    if (value < 4503599627370496n) {
        //1n<<52n
        x1 = BigInt(Math.sqrt(Number(value)) | 0) - 3n;
    } else {
        let vlen = value.toString().length;
        if (!(vlen & 1)) {
            x1 = 10n ** BigInt(vlen / 2);
        } else {
            x1 = 4n * 10n ** BigInt((vlen / 2) | 0);
        }
    }

    do {
        x0 = x1;
        x1 = (value / x0 + x0) >> 1n;
    } while (x0 !== x1 && x0 !== x1 - 1n);
    return x0;
}

function split_fees(
    pool: DAMMV2QuotePool,
    fee_amount: bigint,
    has_referral: boolean
): {
    claiming_fee: bigint;
    compounding_fee: bigint;
    protocol_fee: bigint;
    referral_fee: bigint;
} {
    const compounding_fee_bps = BigInt(pool.compounding_fee_bps);
    let protocol_fee = (fee_amount * BigInt(pool.protocol_fee_percent)) / 100n;
    let trading_fee = fee_amount - protocol_fee;
    let referral_fee: bigint = 0n;
    let compounding_fee: bigint = 0n;
    let claiming_fee: bigint = trading_fee;

    if (compounding_fee_bps > 0n) {
        compounding_fee = (trading_fee * compounding_fee_bps) / BASIS_POINT_MAX;
        claiming_fee = trading_fee - compounding_fee;
    }

    if (has_referral) referral_fee = (protocol_fee * BigInt(pool.referral_fee_percent)) / 100n;

    protocol_fee = protocol_fee - referral_fee;

    return {
        claiming_fee,
        compounding_fee,
        protocol_fee,
        referral_fee
    };
}

type PodAlignedFeeTimeScheduler = {
    cliff_fee_numerator: bigint;
    number_of_period: bigint;
    period_frequency: bigint;
    reduction_factor: bigint;
    base_fee_mode: BaseFeeMode;
};

type PodAlignedFeeRateLimiter = {
    cliff_fee_numerator: bigint;
    fee_increment_bps: bigint;
    max_limiter_duration: bigint;
    max_fee_bps: bigint;
    reference_amount: bigint;
};

type PodAlignedFeeMarketCapScheduler = {
    cliff_fee_numerator: bigint;
    number_of_period: number;
    sqrt_price_step_bps: number;
    scheduler_expiration_duration: number;
    reduction_factor: bigint;
    base_fee_mode: BaseFeeMode;
};

function decode_pod_aligned_fee_time_scheduler(data: Buffer): PodAlignedFeeTimeScheduler {
    if (data.byteLength < 32) throw new Error('Invalid DAMM v2 time fee data.');
    return {
        cliff_fee_numerator: data.readBigUInt64LE(0),
        base_fee_mode: data.readUInt8(8) as BaseFeeMode,
        number_of_period: BigInt(data.readUInt16LE(14)),
        period_frequency: data.readBigUInt64LE(16),
        reduction_factor: data.readBigUInt64LE(24)
    };
}

function decode_pod_aligned_fee_rate_limiter(data: Buffer): PodAlignedFeeRateLimiter {
    if (data.byteLength < 32) throw new Error('Invalid DAMM v2 rate-limiter fee data.');
    return {
        cliff_fee_numerator: data.readBigUInt64LE(0),
        fee_increment_bps: BigInt(data.readUInt16LE(14)),
        max_limiter_duration: BigInt(data.readUInt32LE(16)),
        max_fee_bps: BigInt(data.readUInt32LE(20)),
        reference_amount: data.readBigUInt64LE(24)
    };
}

function decode_pod_aligned_fee_market_cap_scheduler(data: Buffer): PodAlignedFeeMarketCapScheduler {
    if (data.byteLength < 32) throw new Error('Invalid DAMM v2 market-cap fee data.');
    return {
        cliff_fee_numerator: data.readBigUInt64LE(0),
        base_fee_mode: data.readUInt8(8) as BaseFeeMode,
        number_of_period: data.readUInt16LE(14),
        sqrt_price_step_bps: data.readUInt32LE(16),
        scheduler_expiration_duration: data.readUInt32LE(20),
        reduction_factor: data.readBigUInt64LE(24)
    };
}

function get_base_fee_handler(raw: number[]): BaseFeeHandler {
    const data = Buffer.from(raw);
    const mode_id = data.readUInt8(8);
    const base_fee_mode = mode_id as BaseFeeMode;

    switch (base_fee_mode) {
        case BaseFeeMode.FeeTimeSchedulerLinear:
        case BaseFeeMode.FeeTimeSchedulerExponential: {
            const pool_fees = decode_pod_aligned_fee_time_scheduler(data);
            return new FeeTimeScheduler(
                pool_fees.cliff_fee_numerator,
                pool_fees.number_of_period,
                pool_fees.period_frequency,
                pool_fees.reduction_factor,
                pool_fees.base_fee_mode
            );
        }
        case BaseFeeMode.RateLimiter: {
            const pool_fees = decode_pod_aligned_fee_rate_limiter(data);
            return new FeeRateLimiter(
                pool_fees.cliff_fee_numerator,
                pool_fees.fee_increment_bps,
                pool_fees.max_fee_bps,
                pool_fees.max_limiter_duration,
                pool_fees.reference_amount
            );
        }
        case BaseFeeMode.FeeMarketCapSchedulerLinear:
        case BaseFeeMode.FeeMarketCapSchedulerExponential: {
            const pool_fees = decode_pod_aligned_fee_market_cap_scheduler(data);
            return new FeeMarketCapScheduler(
                pool_fees.cliff_fee_numerator,
                pool_fees.number_of_period,
                pool_fees.sqrt_price_step_bps,
                pool_fees.scheduler_expiration_duration,
                pool_fees.reduction_factor,
                pool_fees.base_fee_mode
            );
        }
        default:
            throw new Error('Invalid base fee mode');
    }
}

function apply_swap_result(pool: DAMMV2QuotePool, quote: DAMMV2Quote, fee_mode: FeeMode, dir: TradeDirection): bigint {
    const collect_fee_mode = Number(pool.collect_fee_mode) as CollectFeeMode;
    if (collect_fee_mode !== CollectFeeMode.Compounding) return quote.next_sqrt_price;

    const trading_fee = quote.claiming_fee + quote.compounding_fee;

    const included_fee_output_amount = fee_mode.fees_on_input
        ? quote.output_amount
        : quote.output_amount + trading_fee + quote.protocol_fee + quote.referral_fee;

    let new_token_a_amount: bigint;
    let new_token_b_amount: bigint;

    if (dir === TradeDirection.AtoB) {
        new_token_a_amount = pool.token_a_amount + quote.excluded_fee_input_amount;
        new_token_b_amount = pool.token_b_amount - included_fee_output_amount;
    } else {
        new_token_b_amount = pool.token_b_amount + quote.excluded_fee_input_amount;
        new_token_a_amount = pool.token_a_amount - included_fee_output_amount;
    }

    new_token_b_amount = new_token_b_amount + quote.compounding_fee;

    const price = (new_token_b_amount << 128n) / new_token_a_amount;
    const sqrt_price = sqrt(price);
    return sqrt_price;
}

function get_fee_on_amount(
    pool: DAMMV2QuotePool,
    amount: bigint,
    trade_fee_numerator: bigint,
    has_referral: boolean
): {
    amount: bigint;
    claiming_fee: bigint;
    compounding_fee: bigint;
    protocol_fee: bigint;
    referral_fee: bigint;
} {
    const trading_fee = (amount * trade_fee_numerator + FEE_DENOMINATOR - 1n) / FEE_DENOMINATOR;
    const excluded_fee_amount = amount - trading_fee;
    const split_fees_result = split_fees(pool, trading_fee, has_referral);

    return {
        amount: excluded_fee_amount,
        claiming_fee: split_fees_result.claiming_fee,
        compounding_fee: split_fees_result.compounding_fee,
        protocol_fee: split_fees_result.protocol_fee,
        referral_fee: split_fees_result.referral_fee
    };
}

function get_liquidity_handler(pool: DAMMV2QuotePool): LiquidityHandler {
    const collect_fee_mode = Number(pool.collect_fee_mode) as CollectFeeMode;

    if (collect_fee_mode === CollectFeeMode.Compounding) {
        return new CompoundingLiquidityHandler(pool.token_a_amount, pool.token_b_amount, pool.liquidity);
    } else {
        return new ConcentratedLiquidityHandler(
            pool.sqrt_max_price,
            pool.sqrt_min_price,
            pool.sqrt_price,
            pool.liquidity
        );
    }
}

function get_max_fee_numerator(fee_version: bigint): bigint {
    switch (fee_version) {
        case 0n:
            return MAX_FEE_NUMERATOR_V0;
        case 1n:
            return MAX_FEE_NUMERATOR_V1;
        default:
            throw new Error('Invalid pool version');
    }
}

function get_fee_mode(pool: DAMMV2QuotePool, dir: TradeDirection, has_referral: boolean): FeeMode {
    let fees_on_input: boolean;
    let fees_on_token_a: boolean;
    const collect_fee_mode = Number(pool.collect_fee_mode) as CollectFeeMode;

    switch (collect_fee_mode) {
        case CollectFeeMode.BothToken:
            switch (dir) {
                case TradeDirection.AtoB:
                    fees_on_input = false;
                    fees_on_token_a = false;
                    break;
                case TradeDirection.BtoA:
                    fees_on_input = false;
                    fees_on_token_a = true;
                    break;
            }
            break;
        case CollectFeeMode.OnlyB:
            switch (dir) {
                case TradeDirection.AtoB:
                    fees_on_input = false;
                    fees_on_token_a = false;
                    break;
                case TradeDirection.BtoA:
                    fees_on_input = true;
                    fees_on_token_a = false;
                    break;
            }
            break;
        case CollectFeeMode.Compounding:
            switch (dir) {
                case TradeDirection.AtoB:
                    fees_on_input = false;
                    fees_on_token_a = false;
                    break;
                case TradeDirection.BtoA:
                    fees_on_input = true;
                    fees_on_token_a = false;
                    break;
            }
            break;
        default:
            throw new Error('Invalid collect fee mode');
    }

    return {
        fees_on_input,
        fees_on_token_a,
        has_referral
    };
}

function get_total_trading_fee_from_included_fee_amount(
    pool: DAMMV2QuotePool,
    current_point: bigint,
    activation_point: bigint,
    excluded_fee_amount: bigint,
    dir: TradeDirection,
    max_fee_numerator: bigint,
    init_sqrt_price: bigint,
    current_sqrt_price: bigint
): bigint {
    const base_fee_handler = get_base_fee_handler([...pool.base_fee_data]);
    const base_fee_numerator = base_fee_handler.get_base_fee_numerator_from_included_fee_amount(
        current_point,
        activation_point,
        dir,
        excluded_fee_amount,
        init_sqrt_price,
        current_sqrt_price
    );

    let dynamic_fee_numerator = 0n;
    if (pool.dynamic_fee_initialized !== 0) {
        const square_vfa_bin = (pool.dynamic_fee_volatility_accumulator * BigInt(pool.dynamic_fee_bin_step)) ** 2n;
        const v_fee = BigInt(pool.dynamic_fee_variable_fee_control) * square_vfa_bin;
        dynamic_fee_numerator = (v_fee + DYNAMIC_FEE_ROUNDING_OFFSET) / DYNAMIC_FEE_SCALING_FACTOR;
    }

    const total_fee_numerator = dynamic_fee_numerator + base_fee_numerator;
    return total_fee_numerator < max_fee_numerator ? total_fee_numerator : max_fee_numerator;
}

export function quote_exact_in(
    pool: DAMMV2QuotePool,
    amount_in: bigint,
    dir: TradeDirection,
    current_point: bigint
): DAMMV2Quote {
    if (amount_in <= 0n) throw new RangeError('DAMM v2 swap amount must be positive.');
    let actual_protocol_fee = 0n;
    let actual_claiming_fee = 0n;
    let actual_compounding_fee = 0n;
    let actual_referral_fee = 0n;

    const handler = get_liquidity_handler(pool);
    const max_fee_numerator = get_max_fee_numerator(BigInt(pool.fee_version));
    const fee_mode = get_fee_mode(pool, dir, false);
    const trade_fee_numerator = get_total_trading_fee_from_included_fee_amount(
        pool,
        current_point,
        pool.activation_point,
        amount_in,
        dir,
        max_fee_numerator,
        pool.init_sqrt_price,
        pool.sqrt_price
    );

    let actual_amount_in: bigint;
    if (fee_mode.fees_on_input) {
        const { amount, claiming_fee, compounding_fee, protocol_fee, referral_fee } = get_fee_on_amount(
            pool,
            amount_in,
            trade_fee_numerator,
            fee_mode.has_referral
        );

        actual_claiming_fee = claiming_fee;
        actual_compounding_fee = compounding_fee;
        actual_protocol_fee = protocol_fee;
        actual_referral_fee = referral_fee;

        actual_amount_in = amount;
    } else {
        actual_amount_in = amount_in;
    }

    let swap_amount_from_input;
    if (dir === TradeDirection.AtoB) {
        swap_amount_from_input = handler.calculate_a_to_b_from_amount_in(actual_amount_in);
    } else {
        swap_amount_from_input = handler.calculate_b_to_a_from_amount_in(actual_amount_in);
    }
    const { output_amount, next_sqrt_price, amount_left } = swap_amount_from_input;

    let actual_amount_out: bigint;
    if (fee_mode.fees_on_input) {
        actual_amount_out = output_amount;
    } else {
        const { amount, claiming_fee, compounding_fee, protocol_fee, referral_fee } = get_fee_on_amount(
            pool,
            output_amount,
            trade_fee_numerator,
            fee_mode.has_referral
        );

        actual_claiming_fee = claiming_fee;
        actual_compounding_fee = compounding_fee;
        actual_protocol_fee = protocol_fee;
        actual_referral_fee = referral_fee;

        actual_amount_out = amount;
    }

    const result: DAMMV2Quote = {
        amount_left,
        included_fee_input_amount: amount_in,
        excluded_fee_input_amount: actual_amount_in,
        output_amount: actual_amount_out,
        next_sqrt_price,
        claiming_fee: actual_claiming_fee,
        compounding_fee: actual_compounding_fee,
        protocol_fee: actual_protocol_fee,
        referral_fee: actual_referral_fee
    };

    result.next_sqrt_price = apply_swap_result(pool, result, fee_mode, dir);

    return result;
}
