import { afterAll, afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { getMintEncoder } from '@solana-program/token-2022';
import type { Address } from '@solana/kit';
import { Keypair, PublicKey, type AccountInfo, type Connection, type TokenAmount } from '@solana/web3.js';
import type { SerializedMintMeta } from '../src/common/trade_common';
import type { DBCQuoteState } from '../src/meteora/dbc_math';

const original_helius_key = process.env.HELIUS_API_KEY;
const original_pinata_jwt = process.env.PINATA_IPFS_JWT;
process.env.HELIUS_API_KEY ||= 'unit-test';
process.env.PINATA_IPFS_JWT ||= 'unit-test';

const [
    { Provider },
    { METEORA_DAMM_V2_PROGRAM_ID, METEORA_DAMM_V2_STATE_HEADER, SOL_MINT },
    { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID },
    { quote_dbc_exact_in },
    { CollectFeeMode, ONE_Q64 }
] = await Promise.all([
    import('../src/meteora/trade_meteora'),
    import('../src/constants'),
    import('../src/common/token'),
    import('../src/meteora/dbc_math'),
    import('../src/meteora/damm_math')
]);

type DammPool = Parameters<(typeof import('../src/meteora/damm_math'))['quote_exact_in']>[0];

const original_connection = global.CONNECTION;
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const trade = await import('../src/common/trade_common');
const { METEORA_DBC_PROGRAM_ID } = await import('../src/constants');
const constants = await import('../src/constants');
const original_version = global.TRANSACTION_VERSION;
const wallet = await Keypair.fromSeed(new Uint8Array(32).fill(26));
const create_mint = await Keypair.fromSeed(new Uint8Array(32).fill(57));

function address(seed: number): PublicKey {
    return new PublicKey(new Uint8Array(32).fill(seed));
}

function amount(raw: bigint, decimals: number): TokenAmount {
    return {
        amount: raw.toString(),
        decimals,
        uiAmount: Number(raw) / 10 ** decimals
    };
}

function time_fee_data(cliff_fee_numerator: bigint): Buffer {
    const data = Buffer.alloc(32);
    data.writeBigUInt64LE(cliff_fee_numerator, 0);
    data.writeUInt8(0, 8);
    data.writeBigUInt64LE(10n, 16);
    return data;
}

function dbc_quote_state(): DBCQuoteState {
    return {
        config: {
            cliff_fee_numerator: 100_000_000n,
            period_frequency: 10n,
            reduction_factor: 0n,
            number_of_periods: 0,
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
            migration_quote_threshold: 1_090n,
            curve: [
                { sqrt_price: ONE_Q64, liquidity: 1_000n * ONE_Q64 },
                { sqrt_price: 2n * ONE_Q64, liquidity: 1_000n * ONE_Q64 }
            ]
        },
        sqrt_price: (3n * ONE_Q64) / 2n,
        activation_point: 100n,
        current_point: 100n,
        timestamp: 1_000n,
        last_update_timestamp: 1_000n,
        sqrt_price_reference: (3n * ONE_Q64) / 2n,
        volatility_accumulator: 0n,
        volatility_reference: 0n,
        first_swap_with_min_fee: false
    };
}

function meteora_metadata(quote: DBCQuoteState, overrides: Record<string, unknown> = {}): SerializedMintMeta {
    const mint = address(1).toBase58();
    return {
        token_quote_mc: 12.5,
        mint_pubkey: mint,
        quote_mint_pubkey: USDC_MINT.toBase58(),
        token_program: TOKEN_PROGRAM_ID.toBase58(),
        migrated: false,
        platform_fee: 0.1,
        token_name: 'Synthetic Meteora Token',
        token_symbol: 'MET',
        token_mint: mint,
        mint,
        quote_mint: USDC_MINT.toBase58(),
        name: 'Synthetic Meteora Token',
        symbol: 'MET',
        pool: address(2).toBase58(),
        sol_reserves: '1000',
        token_reserves: '2000',
        total_supply: '100000000000',
        complete: false,
        market_cap: 12.5,
        token_decimal: 8,
        fee: 0.1,
        token_program_id: TOKEN_PROGRAM_ID.toBase58(),
        dbc_data: {
            sqrt_price: quote.sqrt_price,
            config: address(3).toBase58(),
            base_vault: address(4).toBase58(),
            quote_vault: address(5).toBase58(),
            quote
        },
        damm_v2_data: undefined,
        ...overrides
    };
}

function damm_pool(): DammPool {
    return {
        base_fee_data: time_fee_data(10_000_000n),
        protocol_fee_percent: 20,
        referral_fee_percent: 0,
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
        sqrt_max_price: 2n * ONE_Q64
    };
}

function write_u128(data: Buffer, offset: number, value: bigint): void {
    data.writeBigUInt64LE(value & ((1n << 64n) - 1n), offset);
    data.writeBigUInt64LE(value >> 64n, offset + 8);
}

function damm_state_data(pool: DammPool, token_mint: PublicKey): Buffer {
    // Raw offsets mirror the pinned on-chain Pool layout:
    // https://github.com/MeteoraAg/damm-v2/blob/a85c926607433f23f0ea60f4ca7b1ae92f4156cb/programs/cp-amm/src/state/pool.rs
    const data = Buffer.alloc(1112);
    Buffer.from(METEORA_DAMM_V2_STATE_HEADER).copy(data, 0);
    pool.base_fee_data.copy(data, 8);
    data.writeUInt8(pool.protocol_fee_percent, 48);
    data.writeUInt8(pool.referral_fee_percent, 50);
    data.writeUInt16LE(pool.compounding_fee_bps, 54);
    data.writeUInt8(pool.dynamic_fee_initialized, 56);
    data.writeUInt32LE(pool.dynamic_fee_variable_fee_control, 68);
    data.writeUInt16LE(pool.dynamic_fee_bin_step, 72);
    write_u128(data, 120, pool.dynamic_fee_volatility_accumulator);
    write_u128(data, 152, pool.init_sqrt_price);
    Buffer.from(token_mint.toBytes()).copy(data, 168);
    Buffer.from(SOL_MINT.toBytes()).copy(data, 200);
    Buffer.from(address(7).toBytes()).copy(data, 232);
    Buffer.from(address(8).toBytes()).copy(data, 264);
    write_u128(data, 360, pool.liquidity);
    write_u128(data, 424, pool.sqrt_min_price);
    write_u128(data, 440, pool.sqrt_max_price);
    write_u128(data, 456, pool.sqrt_price);
    data.writeBigUInt64LE(pool.activation_point, 472);
    data.writeUInt8(0, 480);
    data.writeUInt8(0, 481);
    data.writeUInt8(pool.collect_fee_mode, 484);
    data.writeUInt8(pool.fee_version, 486);
    data.writeBigUInt64LE(pool.token_a_amount, 680);
    data.writeBigUInt64LE(pool.token_b_amount, 688);
    data.writeUInt8(1, 696);
    return data;
}

function token_2022_mint_data(mint: PublicKey): Buffer {
    const authority = mint.toBase58() as Address;
    return Buffer.from(
        getMintEncoder().encode({
            mintAuthority: null,
            supply: 1_000_000_000n,
            decimals: 8,
            isInitialized: true,
            freezeAuthority: null,
            extensions: [
                {
                    __kind: 'TransferFeeConfig',
                    transferFeeConfigAuthority: authority,
                    withdrawWithheldAuthority: authority,
                    withheldAmount: 0n,
                    olderTransferFee: { epoch: 0n, maximumFee: 100n, transferFeeBasisPoints: 200 },
                    newerTransferFee: { epoch: 5n, maximumFee: 50n, transferFeeBasisPoints: 100 }
                }
            ]
        })
    );
}

function token_mint_data(): Buffer {
    const data = Buffer.alloc(82);
    data.writeUInt8(8, 44);
    data.writeUInt8(1, 45);
    return data;
}

function account(data: Buffer, owner: PublicKey): AccountInfo<Buffer> {
    return { data, owner, executable: false, lamports: 1n, rentEpoch: 0n };
}

function install_damm_accounts(pool_key: PublicKey, token_mint: PublicKey, pool: DammPool, transfer_fees = true): void {
    const pool_account = account(damm_state_data(pool, token_mint), METEORA_DAMM_V2_PROGRAM_ID);
    const mint_account = transfer_fees
        ? account(token_2022_mint_data(token_mint), TOKEN_2022_PROGRAM_ID)
        : account(token_mint_data(), TOKEN_PROGRAM_ID);
    global.CONNECTION = {
        getAccountInfoAndContext: async (key: PublicKey) => ({
            context: { slot: 100n },
            value: key.equals(pool_key) ? pool_account : null
        }),
        getAccountInfo: async (key: PublicKey) => (key.equals(token_mint) ? mint_account : null),
        getEpochInfo: async () => ({ epoch: 7n })
    } as unknown as Connection;
}

afterAll(() => {
    if (original_helius_key === undefined) delete process.env.HELIUS_API_KEY;
    else process.env.HELIUS_API_KEY = original_helius_key;
    if (original_pinata_jwt === undefined) delete process.env.PINATA_IPFS_JWT;
    else process.env.PINATA_IPFS_JWT = original_pinata_jwt;
});

afterEach(() => {
    mock.restore();
    global.TRANSACTION_VERSION = original_version;
    if (original_connection === undefined) delete (global as { CONNECTION?: Connection }).CONNECTION;
    else global.CONNECTION = original_connection;
});

describe('Meteora creation and migration', () => {
    const provider = new Provider();
    const config_key = address(60);
    const pool_key = address(61);

    function config_data(quote = USDC_MINT, token_type = 0) {
        const data = Buffer.alloc(1048);
        Buffer.from(constants.METEORA_CONFIG_HEADER).copy(data);
        Buffer.from(quote.toBytes()).copy(data, 8);
        data.writeBigUInt64LE(10_000_000n, 104);
        data.writeBigUInt64LE(10n, 112);
        data[233] = 1;
        data[235] = 8;
        data[237] = token_type;
        data[244] = 1;
        data.writeBigUInt64LE(500n, 256);
        data.writeBigUInt64LE(1000n, 264);
        data.writeBigUInt64LE(100n, 272);
        write_u128(data, 280, 2n * ONE_Q64);
        data.writeBigUInt64LE(10000n, 344);
        data[365] = 1;
        write_u128(data, 392, ONE_Q64);
        write_u128(data, 408, 2n * ONE_Q64);
        write_u128(data, 424, 1000n * ONE_Q64);
        return data;
    }

    function state_data(migrated = false) {
        const data = Buffer.alloc(368);
        Buffer.from(constants.METEORA_DBC_STATE_HEADER).copy(data);
        for (const [offset, key] of [
            [72, config_key],
            [104, wallet.publicKey],
            [136, create_mint.publicKey],
            [168, address(62)],
            [200, address(63)]
        ] as const)
            Buffer.from(key.toBytes()).copy(data, offset);
        data.writeBigUInt64LE(9000n, 232);
        data.writeBigUInt64LE(500n, 240);
        write_u128(data, 24, ONE_Q64);
        write_u128(data, 280, ONE_Q64);
        data.writeBigUInt64LE(100n, 296);
        data[305] = Number(migrated);
        return data;
    }

    test.each([
        [0, false],
        [0, true],
        [1, false],
        [1, true]
    ] as const)(
        'creates token type %s with creator-buy=%s and correct first-swap semantics',
        async (token_type, creator_buy) => {
            global.TRANSACTION_VERSION = 1;
            global.CONNECTION = {
                getAccountInfo: async () => account(config_data(USDC_MINT, token_type), METEORA_DBC_PROGRAM_ID)
            } as unknown as Connection;
            const result = await provider.create_token_instructions(
                create_mint,
                wallet,
                'Token',
                'TOK',
                'cid',
                { config: config_key.toBase58() },
                creator_buy
            );
            const meta = provider.deserialize_mint_meta(result.mint_meta.serialize());
            expect(meta.quote_mint_pubkey).toEqual(USDC_MINT);
            expect(meta.token_program).toEqual(token_type === 0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID);
            expect(meta.token_decimal).toBe(8);
            expect(meta.total_supply).toBe(10000n);
            expect(meta.dbc_data!.quote.first_swap_with_min_fee).toBe(creator_buy);
            expect(result.instructions).toHaveLength(1);
            const create = result.instructions[0]!;
            expect(create.programId).toEqual(METEORA_DBC_PROGRAM_ID);
            expect(create.keys[0]!.pubkey).toEqual(config_key);
            expect(create.keys[3]).toEqual({ pubkey: create_mint.publicKey, isSigner: true, isWritable: true });
            expect(create.keys[4]!.pubkey).toEqual(USDC_MINT);
            expect(create.keys).toHaveLength(token_type === 0 ? 16 : 14);
        }
    );

    test.each([
        [238, 1, 'quote token program'],
        [237, 2, 'Unsupported DBC token type'],
        [130, 2, 'fee scheduler'],
        [233, 0, 'DAMM v2 migration']
    ] as const)('rejects incompatible DBC config field %s', async (offset, value, message) => {
        const data = config_data();
        data[offset] = value;
        global.CONNECTION = {
            getAccountInfo: async () => account(data, METEORA_DBC_PROGRAM_ID)
        } as unknown as Connection;
        await expect(
            provider.create_token_instructions(create_mint, wallet, 'Token', 'TOK', 'cid', {
                config: config_key.toBase58()
            })
        ).rejects.toThrow(message);
    });

    test('discovers and decodes DBC state, correcting provisional quote and reserve metadata', async () => {
        global.CONNECTION = {
            getAccountInfo: async () => account(config_data(), METEORA_DBC_PROGRAM_ID),
            getSlot: async () => 120n
        } as unknown as Connection;
        spyOn(trade, 'get_program_accounts_v2').mockResolvedValue([
            { pubkey: pool_key, account: account(state_data(), METEORA_DBC_PROGRAM_ID) }
        ]);
        const initial = await provider.default_mint_meta(create_mint.publicKey, { name: 'Token', symbol: 'TOK' });
        const updated = await provider.update_mint_meta(initial);
        expect(updated.quote_mint_pubkey).toEqual(USDC_MINT);
        expect(updated.token_decimal).toBe(8);
        expect(updated.sol_reserves).toBe(500n);
        expect(updated.token_reserves).toBe(9000n);
        expect(updated.dbc_data!.quote.current_point).toBe(120n);
        expect(updated.pool).toBe(pool_key.toBase58());
        expect(initial.quote_mint_pubkey).toEqual(SOL_MINT);
    });

    test('switches a migrated DBC pool to DAMM metadata and refreshes it directly thereafter', async () => {
        const damm_key = address(64);
        const damm = account(damm_state_data(damm_pool(), create_mint.publicKey), METEORA_DAMM_V2_PROGRAM_ID);
        global.CONNECTION = {
            getAccountInfo: async () => account(config_data(SOL_MINT), METEORA_DBC_PROGRAM_ID),
            getSlot: async () => 120n,
            getAccountInfoAndContext: async () => ({ value: damm, context: { slot: 121n } })
        } as unknown as Connection;
        const discover = spyOn(trade, 'get_program_accounts_v2').mockImplementation(async (program) =>
            program.equals(METEORA_DBC_PROGRAM_ID)
                ? [{ pubkey: pool_key, account: account(state_data(true), METEORA_DBC_PROGRAM_ID) }]
                : [{ pubkey: damm_key, account: damm }]
        );
        const initial = await provider.default_mint_meta(create_mint.publicKey, { name: 'Token', symbol: 'TOK' });
        const updated = await provider.update_mint_meta(initial);
        expect(updated.migrated).toBeTrue();
        expect(updated.dbc_data).toBeUndefined();
        expect(updated.pool).toBe(damm_key.toBase58());
        expect(updated.sol_reserves).toBe(2_000_000n);
        expect(updated.token_reserves).toBe(1_000_000n);
        discover.mockClear();
        const refreshed = await provider.update_mint_meta(updated);
        expect(refreshed.damm_v2_data).toEqual(updated.damm_v2_data);
        expect(discover).not.toHaveBeenCalled();
    });

    test('hands subscriptions from DBC to DAMM and ignores older slots and events after unsubscribe', async () => {
        type Callback = (info: AccountInfo<Buffer>, context: { slot: bigint }) => void;
        const callbacks = new Map<string, Callback>();
        const damm_key = address(65);
        const damm = account(damm_state_data(damm_pool(), create_mint.publicKey), METEORA_DAMM_V2_PROGRAM_ID);
        const remove = mock(async (_id: number) => undefined);
        global.CONNECTION = {
            getAccountInfoAndContext: async () => ({
                value: account(state_data(true), METEORA_DBC_PROGRAM_ID),
                context: { slot: 110n }
            }),
            onAccountChange: (key: PublicKey, callback: Callback) => {
                callbacks.set(key.toBase58(), callback);
                return callbacks.size;
            },
            removeAccountChangeListener: remove
        } as unknown as Connection;
        spyOn(trade, 'get_program_accounts_v2').mockResolvedValue([{ pubkey: damm_key, account: damm }]);
        const initial = provider.deserialize_mint_meta(
            meteora_metadata(dbc_quote_state(), {
                mint: create_mint.publicKey.toBase58(),
                quote_mint: SOL_MINT.toBase58(),
                pool: pool_key.toBase58()
            })
        );
        const updates: ReturnType<typeof provider.deserialize_mint_meta>[] = [];
        let next_update: (() => void) | undefined;
        const stop = await provider.subscribe_mint_meta(initial, (meta) => {
            updates.push(meta);
            next_update?.();
        });
        expect(updates.map((meta) => meta.migrated)).toEqual([false, true]);
        expect(remove.mock.calls).toEqual([[1]]);
        const published = new Promise<void>((resolve) => {
            next_update = resolve;
        });
        const newer = account(
            damm_state_data({ ...damm_pool(), token_b_amount: 3_000_000n }, create_mint.publicKey),
            METEORA_DAMM_V2_PROGRAM_ID
        );
        callbacks.get(damm_key.toBase58())!(newer, { slot: 112n });
        callbacks.get(damm_key.toBase58())!(damm, { slot: 111n });
        await published;
        expect(updates).toHaveLength(3);
        expect(updates.at(-1)!.sol_reserves).toBe(3_000_000n);
        stop();
        expect(remove.mock.calls).toEqual([[1], [2]]);
        callbacks.get(damm_key.toBase58())!(damm, { slot: 113n });
        callbacks.get(pool_key.toBase58())!(account(state_data(), METEORA_DBC_PROGRAM_ID), { slot: 114n });
        expect(updates).toHaveLength(3);
    });
});

describe('Meteora DBC offline trade behavior', () => {
    const trader = new Provider();

    test('returns the encoded standalone and post-buy paired DBC minimum without mutating caller metadata', async () => {
        spyOn(trade, 'get_ltas').mockResolvedValue([]);
        global.CONNECTION = {
            getAccountInfo: async () => account(token_mint_data(), TOKEN_PROGRAM_ID)
        } as unknown as Connection;
        const state = dbc_quote_state();
        state.config.migration_quote_threshold = 10_000n;
        const metadata = trader.deserialize_mint_meta(meteora_metadata(state));
        const before = metadata.serialize();
        const standalone = await trader.sell_token_instructions(amount(20n, 8), wallet, metadata, 0.07);
        const sell = standalone.instructions.find((ix) => ix.programId.equals(METEORA_DBC_PROGRAM_ID))!;
        expect(standalone.minimum_quote_output).toEqual({
            amount: Buffer.from(sell.data).readBigUInt64LE(16).toString(),
            decimals: 6,
            uiAmount: null
        });
        const paired = await trader.buy_sell_instructions(amount(100n, 6), wallet, metadata, 0.07);
        const paired_sell = paired.sell.find((ix) => ix.programId.equals(METEORA_DBC_PROGRAM_ID))!;
        const sold = Buffer.from(paired_sell.data).readBigUInt64LE(8);
        const post_buy = trader.update_mint_meta_reserves(trader.deserialize_mint_meta(before), amount(100n, 6), 'buy');
        const post_estimate = await trader.estimate_sell_output(post_buy, amount(sold, 8), 0.07);
        const stale_estimate = await trader.estimate_sell_output(metadata, amount(sold, 8), 0.07);
        expect(paired.minimum_quote_output.amount).toBe(Buffer.from(paired_sell.data).readBigUInt64LE(16).toString());
        expect(paired.minimum_quote_output.amount).toBe(post_estimate.minimum.amount);
        expect(paired.minimum_quote_output.amount).not.toBe(stale_estimate.minimum.amount);
        expect(metadata.serialize()).toEqual(before);
    });

    test('round-trips serialized DBC metadata and restores bigint reserves', () => {
        const restored = trader.deserialize_mint_meta(meteora_metadata(dbc_quote_state()));
        const round_trip = trader.deserialize_mint_meta(restored.serialize());

        expect(round_trip.serialize()).toEqual(restored.serialize());
        expect(round_trip.sol_reserves).toBe(1_000n);
        expect(round_trip.token_reserves).toBe(2_000n);
        expect(round_trip.total_supply).toBe(100_000_000_000n);
        expect(round_trip.quote_mint_pubkey.equals(USDC_MINT)).toBeTrue();
    });

    test('matches pinned no-fee DBC buy and sell vectors with base and quote decimal units', async () => {
        const state = dbc_quote_state();
        state.config.cliff_fee_numerator = 0n;
        const metadata = trader.deserialize_mint_meta(meteora_metadata(state));
        const buy_input = 100n;
        const sell_input = 100n;

        // Adapted from the pinned SDK/program curve formulas, not this repository's quote implementation:
        // https://github.com/MeteoraAg/dynamic-bonding-curve-sdk/blob/aa1595c29a0457b23a80cfcf9843a04603954858/packages/dynamic-bonding-curve/src/math/curve.ts
        // https://github.com/MeteoraAg/dynamic-bonding-curve/blob/f552f20aa3c1c7631427c3827aeea7c58b902813/programs/dynamic-bonding-curve/src/curve.rs
        // L=1,000 Q64 and sqrt(P)=1.5 Q64: exact-in 100 produces 41 base buying and 195 quote selling.
        const expected_buy = 41n;
        const expected_sell = 195n;

        const buy = await trader.estimate_buy_output(metadata, amount(buy_input, 6), 0.05);
        const sell = await trader.estimate_sell_output(metadata, amount(sell_input, 8), 0.05);

        expect(buy.expected).toEqual({
            amount: expected_buy.toString(),
            decimals: 8,
            uiAmount: Number(expected_buy) / 10 ** 8
        });
        expect(sell.expected).toEqual({
            amount: expected_sell.toString(),
            decimals: 6,
            uiAmount: Number(expected_sell) / 10 ** 6
        });
        // The contract deducts floor(expected * 5 / 100), so a fractional deduction rounds down.
        expect(buy.minimum.amount).toBe((expected_buy - (expected_buy * 5n) / 100n).toString());
        expect(sell.minimum.amount).toBe((expected_sell - (expected_sell * 5n) / 100n).toString());
    });

    test('wires a separately computed DBC quote into reserves and quote state exactly once', () => {
        const state = dbc_quote_state();
        const metadata = trader.deserialize_mint_meta(meteora_metadata(state));
        const buy_input = 100n;
        // This local quote comparison intentionally tests update wiring, not estimator correctness.
        const buy_quote = quote_dbc_exact_in(state, buy_input, 'buy');

        const bought = trader.update_mint_meta_reserves(metadata, amount(buy_input, 6), 'buy');

        expect(bought.sol_reserves).toBe(1_000n + buy_quote.quote_amount);
        expect(bought.token_reserves).toBe(2_000n - buy_quote.base_amount);
        expect(bought.dbc_data?.sqrt_price).toBe(buy_quote.next.sqrt_price);
        expect(bought.dbc_data?.quote).toEqual(buy_quote.next);
        expect(bought.complete).toBeTrue();

        const sell_input = 20n;
        const sell_quote = quote_dbc_exact_in(buy_quote.next, sell_input, 'sell');
        trader.update_mint_meta_reserves(bought, amount(sell_input, 8), 'sell');

        expect(bought.sol_reserves).toBe(1_000n + buy_quote.quote_amount - sell_quote.quote_amount);
        expect(bought.token_reserves).toBe(2_000n - buy_quote.base_amount + sell_quote.base_amount);
        expect(bought.dbc_data?.quote).toEqual(sell_quote.next);
        expect(bought.complete).toBeFalse();
    });
});

describe('Meteora DAMM-v2 offline trade behavior', () => {
    const trader = new Provider();
    const token_mint = address(11);
    const pool_key = address(12);
    const pool = damm_pool();

    test('returns the encoded DAMM minimum after pool and transfer fees', async () => {
        spyOn(trade, 'get_ltas').mockResolvedValue([]);
        install_damm_accounts(pool_key, token_mint, pool);
        const output = await trader.sell_token_instructions(amount(10_000n, 8), wallet, metadata(), 0.07);
        const sell = output.instructions.find((ix) => ix.programId.equals(METEORA_DAMM_V2_PROGRAM_ID))!;
        const encoded = Buffer.from(sell.data).readBigUInt64LE(16);
        expect(output.minimum_quote_output).toEqual({ amount: encoded.toString(), decimals: 9, uiAmount: null });
        const estimate = await trader.estimate_sell_output(metadata(), amount(10_000n, 8), 0.07);
        expect(output.minimum_quote_output.amount).toBe(estimate.minimum.amount);
    });

    function metadata() {
        return trader.deserialize_mint_meta(
            meteora_metadata(dbc_quote_state(), {
                mint: token_mint.toBase58(),
                mint_pubkey: token_mint.toBase58(),
                token_mint: token_mint.toBase58(),
                quote_mint: SOL_MINT.toBase58(),
                quote_mint_pubkey: SOL_MINT.toBase58(),
                pool: pool_key.toBase58(),
                complete: true,
                migrated: true,
                token_program: TOKEN_2022_PROGRAM_ID.toBase58(),
                token_program_id: TOKEN_2022_PROGRAM_ID.toBase58(),
                dbc_data: undefined,
                damm_v2_data: {
                    token_a_mint: token_mint.toBase58(),
                    token_b_mint: SOL_MINT.toBase58(),
                    token_a_vault: address(7).toBase58(),
                    token_b_vault: address(8).toBase58(),
                    token_a_amount: pool.token_a_amount,
                    token_b_amount: pool.token_b_amount,
                    fee_numerator: 10_000_000n
                }
            })
        );
    }

    test('round-trips serialized DAMM-v2 metadata with bigint pool amounts', () => {
        const restored = metadata();
        const round_trip = trader.deserialize_mint_meta(restored.serialize());

        expect(round_trip.serialize()).toEqual(restored.serialize());
        expect(round_trip.migrated).toBeTrue();
        expect(round_trip.damm_v2_data?.token_a_amount).toBe(1_000_000n);
        expect(round_trip.damm_v2_data?.token_b_amount).toBe(2_000_000n);
    });

    test('matches pinned no-fee DAMM-v2 buy and sell vectors', async () => {
        const no_fee_pool = { ...pool, base_fee_data: time_fee_data(0n) };
        install_damm_accounts(pool_key, token_mint, no_fee_pool, false);
        const buy_input = 10_000n;
        const sell_input = 10_000n;

        // Adapted from the pinned SDK/program compounding-liquidity formulas, not local quote output:
        // https://github.com/MeteoraAg/damm-v2-sdk/blob/8ed7fcef1a70c972eb0fae5b82d876ae2427a6a3/src/math/liquidity/compoundingLiquidity.ts
        // https://github.com/MeteoraAg/damm-v2/blob/a85c926607433f23f0ea60f4ca7b1ae92f4156cb/programs/cp-amm/src/liquidity_handler/compounding_liquidity.rs
        // Reserves A=1,000,000 and B=2,000,000: exact-in 10,000 yields 4,975 A buying and 19,801 B selling.
        const expected_buy = 4_975n;
        const expected_sell = 19_801n;

        const buy = await trader.estimate_buy_output(metadata(), amount(buy_input, 9), 0.1);
        const sell = await trader.estimate_sell_output(metadata(), amount(sell_input, 8), 0.1);

        expect(buy.expected).toEqual({
            amount: expected_buy.toString(),
            decimals: 8,
            uiAmount: Number(expected_buy) / 10 ** 8
        });
        expect(sell.expected).toEqual({
            amount: expected_sell.toString(),
            decimals: 9,
            uiAmount: Number(expected_sell) / 10 ** 9
        });
        // The contract deducts floor(expected * 10 / 100), independently of the shared helper.
        expect(buy.minimum.amount).toBe((expected_buy - (expected_buy * 10n) / 100n).toString());
        expect(sell.minimum.amount).toBe((expected_sell - (expected_sell * 10n) / 100n).toString());
    });

    test('pool fees and Token-2022 transfer fees independently reduce output', async () => {
        const no_fee_pool = { ...pool, base_fee_data: time_fee_data(0n) };
        install_damm_accounts(pool_key, token_mint, no_fee_pool, false);
        const no_fee_buy = await trader.estimate_buy_output(metadata(), amount(10_000n, 9), 0);
        const no_fee_sell = await trader.estimate_sell_output(metadata(), amount(10_000n, 8), 0);

        install_damm_accounts(pool_key, token_mint, pool, false);
        const pool_fee_buy = await trader.estimate_buy_output(metadata(), amount(10_000n, 9), 0);
        const pool_fee_sell = await trader.estimate_sell_output(metadata(), amount(10_000n, 8), 0);

        install_damm_accounts(pool_key, token_mint, pool);
        const transfer_fee_buy = await trader.estimate_buy_output(metadata(), amount(10_000n, 9), 0);
        const transfer_fee_sell = await trader.estimate_sell_output(metadata(), amount(10_000n, 8), 0);

        expect(BigInt(pool_fee_buy.expected.amount)).toBeLessThan(BigInt(no_fee_buy.expected.amount));
        expect(BigInt(pool_fee_sell.expected.amount)).toBeLessThan(BigInt(no_fee_sell.expected.amount));
        expect(BigInt(transfer_fee_buy.expected.amount)).toBeLessThan(BigInt(pool_fee_buy.expected.amount));
        expect(BigInt(transfer_fee_sell.expected.amount)).toBeLessThan(BigInt(pool_fee_sell.expected.amount));
    });
});
