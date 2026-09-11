import { afterAll, afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { Keypair, PublicKey, type Connection, type TokenAmount } from '@solana/web3.js';
import type { SerializedMintMeta } from '../src/common/trade_common';

const original_helius_key = process.env.HELIUS_API_KEY;
const original_pinata_jwt = process.env.PINATA_IPFS_JWT;
process.env.HELIUS_API_KEY ||= 'unit-test';
process.env.PINATA_IPFS_JWT ||= 'unit-test';

const [{ Provider: PumpProvider }, { apply_slippage_down }] = await Promise.all([
    import('../src/pump/trade_pump'),
    import('../src/common/trade_common')
]);
const trade = await import('../src/common/trade_common');
const { PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID } = await import('../src/constants');
const constants = await import('../src/constants');
const original_connection = global.CONNECTION;
const original_version = global.TRANSACTION_VERSION;
const wallet = await Keypair.fromSeed(new Uint8Array(32).fill(22));
const create_mint = await Keypair.fromSeed(new Uint8Array(32).fill(55));
afterEach(() => {
    mock.restore();
    global.TRANSACTION_VERSION = original_version;
    if (original_connection === undefined) delete (global as { CONNECTION?: Connection }).CONNECTION;
    else global.CONNECTION = original_connection;
});

afterAll(() => {
    if (original_helius_key === undefined) delete process.env.HELIUS_API_KEY;
    else process.env.HELIUS_API_KEY = original_helius_key;

    if (original_pinata_jwt === undefined) delete process.env.PINATA_IPFS_JWT;
    else process.env.PINATA_IPFS_JWT = original_pinata_jwt;
});

const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

function address(seed: number): string {
    return new PublicKey(new Uint8Array(32).fill(seed)).toBase58();
}

function amount(raw: bigint, decimals: number): TokenAmount {
    return {
        amount: raw.toString(),
        decimals,
        uiAmount: Number(raw) / 10 ** decimals
    };
}

function expect_unit_consistency(value: TokenAmount): void {
    expect(value.uiAmount).toBe(Number(value.amount) / 10 ** value.decimals);
}

function expect_slippage_contract(expected: TokenAmount, minimum: TokenAmount, slippage: number): void {
    expect(minimum.amount).toBe(apply_slippage_down(BigInt(expected.amount), slippage).toString());
    expect(minimum.decimals).toBe(expected.decimals);
    expect_unit_consistency(minimum);
}

function serialized_core(mint: string, fee: number): SerializedMintMeta {
    return {
        token_quote_mc: 12.5,
        mint_pubkey: mint,
        token_program: TOKEN_PROGRAM_ID,
        migrated: false,
        platform_fee: fee,
        token_name: 'Synthetic Token',
        token_symbol: 'SYN',
        token_mint: mint
    };
}

function pump_metadata(overrides: Record<string, unknown> = {}): SerializedMintMeta {
    const mint = address(1);
    return {
        ...serialized_core(mint, 0.01),
        mint,
        quote_mint: SOL_MINT,
        name: 'Synthetic Token',
        symbol: 'SYN',
        base_vault: address(2),
        quote_vault: address(3),
        creator_vault: address(4),
        creator_vault_ata: address(5),
        amm_pool: null,
        sol_reserves: '1000000',
        token_reserves: '1000000',
        total_supply: '10000000',
        market_cap: 12.5,
        complete: false,
        fee: 0.01,
        token_program_id: TOKEN_PROGRAM_ID,
        is_mayhem: false,
        is_cashback: true,
        ...overrides
    };
}

describe('Pump offline trade behavior', () => {
    const trader = new PumpProvider();

    test.each([false, true])('returns the encoded sell minimum for AMM=%s', async (amm) => {
        spyOn(trade, 'get_ltas').mockResolvedValue([]);
        const metadata = trader.deserialize_mint_meta(
            pump_metadata({
                amm_pool: amm ? address(23) : null,
                quote_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
            })
        );
        const output = await trader.sell_token_instructions(amount(100_000n, 6), wallet, metadata, 0.07);
        const program = amm ? PUMP_AMM_PROGRAM_ID : PUMP_PROGRAM_ID;
        const sell = output.instructions.find((ix) => ix.programId.equals(program))!;
        const encoded = Buffer.from(sell.data).readBigUInt64LE(16);
        expect(encoded).toBeGreaterThan(0n);
        expect(output.minimum_quote_output).toEqual({ amount: encoded.toString(), decimals: 6, uiAmount: null });
        const paired = await trader.buy_sell_instructions(amount(10_000n, 6), wallet, metadata, 0.07);
        const paired_sell = paired.sell.find((ix) => ix.programId.equals(program))!;
        expect(paired.minimum_quote_output.amount).toBe(Buffer.from(paired_sell.data).readBigUInt64LE(16).toString());
    });

    test('round-trips serialized metadata and restores bigint fields', () => {
        const serialized = pump_metadata();
        const restored = trader.deserialize_mint_meta(serialized);

        expect(restored.serialize()).toEqual(serialized);
        expect(restored.sol_reserves).toBe(1_000_000n);
        expect(restored.token_reserves).toBe(1_000_000n);
        expect(restored.total_supply).toBe(10_000_000n);
        expect(String(restored.quote_mint_pubkey)).toBe(SOL_MINT);
    });

    test('normalizes omitted and default quote mints to wrapped SOL', () => {
        const omitted = pump_metadata({ quote_mint: undefined });
        const default_mint = pump_metadata({ quote_mint: PublicKey.default.toBase58() });

        expect(String(trader.deserialize_mint_meta(omitted).quote_mint_pubkey)).toBe(SOL_MINT);
        expect(String(trader.deserialize_mint_meta(default_mint).quote_mint_pubkey)).toBe(SOL_MINT);
    });

    test('prices an obvious equal-reserve swap without fees', async () => {
        const metadata = trader.deserialize_mint_meta(
            pump_metadata({ sol_reserves: '1000', token_reserves: '1000', fee: 0, platform_fee: 0 })
        );

        // 1,000 * 1,000 / 1,100 leaves 910 units after integer rounding, so the output is 90.
        const buy = await trader.estimate_buy_output(metadata, amount(100n, 9), 0.1);
        const sell = await trader.estimate_sell_output(metadata, amount(100n, 6), 0.1);

        expect(buy.expected.amount).toBe('90');
        expect(sell.expected.amount).toBe('90');
    });

    test('is monotonic and follows the shared slippage contract', async () => {
        const metadata = trader.deserialize_mint_meta(pump_metadata());
        const small_buy = await trader.estimate_buy_output(metadata, amount(10_000n, 9), 0.01);
        const low_slippage = await trader.estimate_buy_output(metadata, amount(100_000n, 9), 0.01);
        const high_slippage = await trader.estimate_buy_output(metadata, amount(100_000n, 9), 0.1);
        const small_sell = await trader.estimate_sell_output(metadata, amount(10_000n, 6), 0.05);
        const large_sell = await trader.estimate_sell_output(metadata, amount(100_000n, 6), 0.05);

        expect(BigInt(low_slippage.expected.amount)).toBeGreaterThan(BigInt(small_buy.expected.amount));
        expect(BigInt(large_sell.expected.amount)).toBeGreaterThan(BigInt(small_sell.expected.amount));
        expect(high_slippage.expected).toEqual(low_slippage.expected);
        expect(BigInt(high_slippage.minimum.amount)).toBeLessThan(BigInt(low_slippage.minimum.amount));
        expect_slippage_contract(low_slippage.expected, low_slippage.minimum, 0.01);
        expect_slippage_contract(high_slippage.expected, high_slippage.minimum, 0.1);
        expect_unit_consistency(low_slippage.expected);
        expect_unit_consistency(large_sell.expected);
    });

    test('fees reduce estimated buy and sell output', async () => {
        const fee_metadata = trader.deserialize_mint_meta(pump_metadata());
        const no_fee_metadata = trader.deserialize_mint_meta(pump_metadata({ fee: 0, platform_fee: 0 }));
        const quote_input = amount(100_000n, 9);
        const token_input = amount(100_000n, 6);
        const fee_buy = await trader.estimate_buy_output(fee_metadata, quote_input, 0.05);
        const no_fee_buy = await trader.estimate_buy_output(no_fee_metadata, quote_input, 0.05);
        const fee_sell = await trader.estimate_sell_output(fee_metadata, token_input, 0.05);
        const no_fee_sell = await trader.estimate_sell_output(no_fee_metadata, token_input, 0.05);

        expect(BigInt(fee_buy.expected.amount)).toBeLessThan(BigInt(no_fee_buy.expected.amount));
        expect(BigInt(fee_sell.expected.amount)).toBeLessThan(BigInt(no_fee_sell.expected.amount));
    });

    test('moves reserves in trade direction without lowering the constant product', () => {
        const buy_metadata = trader.deserialize_mint_meta(pump_metadata());
        const initial_quote = buy_metadata.sol_reserves;
        const initial_base = buy_metadata.token_reserves;
        const initial_product = initial_quote * initial_base;

        trader.update_mint_meta_reserves(buy_metadata, amount(100_000n, 9), 'buy');

        expect(buy_metadata.sol_reserves).toBeGreaterThan(initial_quote);
        expect(buy_metadata.token_reserves).toBeLessThan(initial_base);
        expect(buy_metadata.sol_reserves * buy_metadata.token_reserves).toBeGreaterThanOrEqual(initial_product);

        const sell_metadata = trader.deserialize_mint_meta(pump_metadata());
        trader.update_mint_meta_reserves(sell_metadata, amount(100_000n, 6), 'sell');

        expect(sell_metadata.sol_reserves).toBeLessThan(initial_quote);
        expect(sell_metadata.token_reserves).toBeGreaterThan(initial_base);
        expect(sell_metadata.sol_reserves * sell_metadata.token_reserves).toBeGreaterThanOrEqual(initial_product);
    });
});

describe('Pump creation and metadata transitions', () => {
    const provider = new PumpProvider();
    const usdc = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

    function curve_data(complete = false, quote = usdc) {
        const data = Buffer.alloc(115);
        Buffer.from(constants.PUMP_STATE_HEADER).copy(data);
        data.writeBigUInt64LE(1_000_000n, 8);
        data.writeBigUInt64LE(2_000_000n, 16);
        data.writeBigUInt64LE(10_000_000n, 40);
        data[48] = Number(complete);
        Buffer.from(wallet.publicKey.toBytes()).copy(data, 49);
        data[82] = 1;
        Buffer.from(quote.toBytes()).copy(data, 83);
        return data;
    }

    test.each([1, 2])('creates version %s with matching token program and UTF-8 metadata', async (version) => {
        global.TRANSACTION_VERSION = 1;
        const result = await provider.create_token_instructions(create_mint, wallet, 'Tökén', 'TOK', 'cid', {
            version,
            is_cashback: true
        });
        expect(result.instructions).toHaveLength(2);
        const create = result.instructions[0]!;
        expect([...create.data.slice(0, 8)]).toEqual([
            ...(version === 1 ? constants.PUMP_CREATE_V1_DISCRIMINATOR : constants.PUMP_CREATE_V2_DISCRIMINATOR)
        ]);
        expect(Buffer.from(create.data).readUInt32LE(8)).toBe(Buffer.byteLength('Tökén'));
        expect(result.mint_meta.token_program).toEqual(
            new PublicKey(version === 1 ? TOKEN_PROGRAM_ID : 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
        );
        expect(create.keys.filter((key) => key.isSigner).map((key) => key.pubkey)).toEqual([
            create_mint.publicKey,
            wallet.publicKey
        ]);
        expect(result.mint_meta.token_name).toBe('Tökén');
        expect(result.ltas).toEqual([]);
        if (version === 2) expect([...create.data.slice(-2)]).toEqual([0, 1]);
    });

    test('uses configured non-SOL reserves and quote accounts at creation', async () => {
        global.TRANSACTION_VERSION = 1;
        const data = Buffer.alloc(1045);
        Buffer.from(constants.PUMP_GLOBAL_HEADER).copy(data);
        data.writeBigUInt64LE(1_000_000n, 73);
        data.writeBigUInt64LE(10_000_000n, 97);
        data.writeBigUInt64LE(2_000_000n, 1005);
        Buffer.from(usdc.toBytes()).copy(data, 1013);
        global.CONNECTION = {
            getMultipleAccountsInfo: async () => [{ data, owner: PUMP_PROGRAM_ID }, null]
        } as unknown as Connection;
        const result = await provider.create_token_instructions(create_mint, wallet, 'Token', 'TOK', 'cid', {
            quote_mint: usdc.toBase58()
        });
        expect(result.mint_meta.quote_mint_pubkey).toEqual(usdc);
        expect(result.mint_meta.token_quote_mc).toBe(20);
        const serialized = result.mint_meta.serialize();
        expect(serialized.sol_reserves).toBe('2000000');
        expect(serialized.token_reserves).toBe('1000000');
        expect(result.instructions[0]!.keys[16]!.pubkey).toEqual(usdc);
    });

    test.each([
        { version: 1, quote_mint: usdc.toBase58() },
        { version: 2, is_mayhem: true, quote_mint: usdc.toBase58() },
        { version: 1, is_mayhem: true }
    ])('rejects incompatible creation options %#', async (config) => {
        await expect(
            provider.create_token_instructions(create_mint, wallet, 'Token', 'TOK', 'cid', config)
        ).rejects.toThrow();
    });

    test.each([false, true])(
        'refreshes curve reserves and corrects default SOL metadata (legacy=%s)',
        async (legacy) => {
            const initial = await provider.default_mint_meta(create_mint.publicKey, {
                name: 'Token',
                creator: wallet.publicKey
            });
            const data = curve_data();
            global.CONNECTION = {
                getAccountInfo: async () => ({ data: legacy ? data.subarray(0, 83) : data, owner: PUMP_PROGRAM_ID })
            } as unknown as Connection;
            const updated = await provider.update_mint_meta(initial);
            expect(updated.quote_mint_pubkey).toEqual(legacy ? constants.SOL_MINT : usdc);
            expect(updated.token_quote_mc).toBe(legacy ? 0.02 : 20);
            expect(updated.sol_reserves).toBe(2_000_000n);
            expect(initial.quote_mint_pubkey).toEqual(constants.SOL_MINT);
            expect(updated.is_cashback).toBeTrue();
        }
    );

    test('switches a completed curve to AMM reserves and vaults', async () => {
        const initial = await provider.default_mint_meta(create_mint.publicKey, { creator: wallet.publicKey });
        const data = Buffer.alloc(261);
        Buffer.from(constants.PUMP_AMM_STATE_HEADER).copy(data);
        Buffer.from(create_mint.publicKey.toBytes()).copy(data, 43);
        Buffer.from(usdc.toBytes()).copy(data, 75);
        Buffer.from(new PublicKey(address(70)).toBytes()).copy(data, 139);
        Buffer.from(new PublicKey(address(71)).toBytes()).copy(data, 171);
        Buffer.from(wallet.publicKey.toBytes()).copy(data, 211);
        data[244] = 1;
        data.writeBigUInt64LE(100n, 245);
        global.CONNECTION = {
            getAccountInfo: async (key: PublicKey) => ({
                data: key.toBase58() === initial.base_vault ? curve_data(true) : data,
                owner: key.toBase58() === initial.base_vault ? PUMP_PROGRAM_ID : PUMP_AMM_PROGRAM_ID
            })
        } as unknown as Connection;
        spyOn(trade, 'get_vault_balance').mockImplementation(async (key) => ({
            balance: key.toBase58() === address(70) ? 1000n : 2000n,
            decimals: 6
        }));
        spyOn(trade, 'get_token_supply').mockResolvedValue({ supply: 10000n, decimals: 6 });
        const migrated = await provider.update_mint_meta(initial);
        expect(migrated.migrated).toBeTrue();
        expect(migrated.base_vault).toBe(address(70));
        expect(migrated.quote_vault).toBe(address(71));
        expect(migrated.sol_reserves).toBe(2100n);
        expect(migrated.token_reserves).toBe(1000n);
        expect(migrated.quote_mint_pubkey).toEqual(usdc);
    });
});
