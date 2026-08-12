import { ConnectionConfig } from '@solana/web3.js';
import { RPC_REQUESTS_PER_SECOND } from '../constants';

export function create_rate_limiter(
    requests_per_second: number,
    state = new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT)
) {
    if (!Number.isFinite(requests_per_second) || requests_per_second <= 0)
        throw new Error('Requests per second must be greater than zero.');

    const next_start_us = new BigInt64Array(state);
    const interval_us = BigInt(Math.ceil(1_000_000 / requests_per_second));

    return async <T>(request: () => Promise<T>): Promise<T> => {
        let start_at: bigint;
        let now: bigint;
        let next: bigint;
        do {
            now = process.hrtime.bigint() / 1000n;
            next = Atomics.load(next_start_us, 0);
            start_at = next > now ? next : now;
        } while (Atomics.compareExchange(next_start_us, 0, next, start_at + interval_us) !== next);

        const delay_us = start_at - now;
        if (delay_us > 0n) await new Promise((resolve) => setTimeout(resolve, Number(delay_us / 1000n)));
        return request();
    };
}

export function create_rpc_rate_limit_state(): SharedArrayBuffer {
    return new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT);
}

export let rate_limit_request = create_rate_limiter(RPC_REQUESTS_PER_SECOND);

export function configure_rpc_rate_limiter(state: SharedArrayBuffer): void {
    rate_limit_request = create_rate_limiter(RPC_REQUESTS_PER_SECOND, state);
}

export function rpc_connection_config(config: ConnectionConfig): ConnectionConfig {
    return {
        ...config,
        fetchMiddleware: (info, init, fetch) => {
            void rate_limit_request(async () => fetch(info, init));
        }
    };
}
