import { afterAll, afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { Keypair, PublicKey, type Connection, type TokenAmount } from '@solana/web3.js';

const original_helius_key = process.env.HELIUS_API_KEY;
const original_pinata_jwt = process.env.PINATA_IPFS_JWT;
process.env.HELIUS_API_KEY ||= 'unit-test';
process.env.PINATA_IPFS_JWT ||= 'unit-test';

const [{ RaydiumMintMeta, RaydiumProvider }, { apply_slippage_down }] = await Promise.all([
    import('../src/raydium/trade_raydium'),
    import('../src/common/trade_common')
]);
const trade = await import('../src/common/trade_common');
const { RAYDIUM_CPMM_PROGRAM_ID, RAYDIUM_LAUNCHPAD_PROGRAM_ID } = await import('../src/constants');
const constants = await import('../src/constants');
const original_connection = global.CONNECTION;
const original_version = global.TRANSACTION_VERSION;
const wallet = await Keypair.fromSeed(new Uint8Array(32).fill(24));
const create_mint = await Keypair.fromSeed(new Uint8Array(32).fill(56));
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
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

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

function raydium_metadata(overrides: Partial<InstanceType<typeof RaydiumMintMeta>> = {}) {
    return new RaydiumMintMeta({
        mint: address(6),
        quote_mint: USDC_MINT,
        name: 'Synthetic Token',
        symbol: 'SYN',
        base_vault: address(7),
        quote_vault: address(8),
        pool: address(9),
        config: address(10),
        global_config: address(11),
        creator: address(12),
        sol_reserves: 1_000_000n,
        token_reserves: 1_000_000n,
        total_supply: 10_000_000n,
        market_cap: 12.5,
        complete: false,
        observation_state: null,
        fee: 0.01,
        token_program_id: TOKEN_PROGRAM_ID,
        token_decimals: 8,
        ...overrides
    });
}

describe('Raydium offline trade behavior', () => {
    const trader = new RaydiumProvider();

    test.each([false, true])('returns the encoded sell minimum for CPMM=%s', async (complete) => {
        spyOn(trade, 'get_ltas').mockResolvedValue([]);
        const metadata = raydium_metadata({ complete, observation_state: address(25) });
        const output = await trader.sell_token_instructions(amount(100_000n, 8), wallet, metadata, 0.07);
        const program = complete ? RAYDIUM_CPMM_PROGRAM_ID : RAYDIUM_LAUNCHPAD_PROGRAM_ID;
        const sell = output.instructions.find((ix) => ix.programId.equals(program))!;
        const encoded = Buffer.from(sell.data).readBigUInt64LE(16);
        expect(encoded).toBeGreaterThan(0n);
        expect(output.minimum_quote_output).toEqual({ amount: encoded.toString(), decimals: 6, uiAmount: null });
        const paired = await trader.buy_sell_instructions(amount(10_000n, 6), wallet, metadata, 0.07);
        const paired_sell = paired.sell.find((ix) => ix.programId.equals(program))!;
        expect(paired.minimum_quote_output.amount).toBe(Buffer.from(paired_sell.data).readBigUInt64LE(16).toString());
    });

    test('round-trips serialized metadata with custom quote and token decimals', () => {
        const metadata = raydium_metadata();
        const restored = trader.deserialize_mint_meta(metadata.serialize());

        expect(restored.serialize()).toEqual(metadata.serialize());
        expect(String(restored.quote_mint_pubkey)).toBe(USDC_MINT);
        expect(restored.token_decimals).toBe(8);
        expect(restored.sol_reserves).toBe(1_000_000n);
        expect(restored.token_reserves).toBe(1_000_000n);
    });

    test('normalizes legacy quote and decimal fields', () => {
        const serialized = raydium_metadata().serialize();
        serialized.quote_mint = undefined;
        serialized.token_decimals = undefined;
        serialized.global_config = undefined;

        const restored = trader.deserialize_mint_meta(serialized);

        expect(String(restored.quote_mint_pubkey)).toBe(SOL_MINT);
        expect(restored.token_decimals).toBe(6);
        expect(restored.global_config).toBe('6s1xP3hpbAfFoNtUNF8mfHsjr2Bd97JxFJRWLbL6aHuX');
    });

    test('prices an obvious equal-reserve swap without fees', async () => {
        const metadata = raydium_metadata({ sol_reserves: 1_000n, token_reserves: 1_000n, fee: 0 });

        // 1,000 * 1,000 / 1,100 leaves 910 units after integer rounding, so the output is 90.
        const buy = await trader.estimate_buy_output(metadata, amount(100n, 6), 0.1);
        const sell = await trader.estimate_sell_output(metadata, amount(100n, 8), 0.1);

        expect(buy.expected.amount).toBe('90');
        expect(sell.expected.amount).toBe('90');
    });

    test('is monotonic and applies slippage while preserving base and quote units', async () => {
        const metadata = raydium_metadata();
        const small_buy = await trader.estimate_buy_output(metadata, amount(10_000n, 6), 0.01);
        const low_slippage = await trader.estimate_buy_output(metadata, amount(100_000n, 6), 0.01);
        const high_slippage = await trader.estimate_buy_output(metadata, amount(100_000n, 6), 0.1);
        const small_sell = await trader.estimate_sell_output(metadata, amount(10_000n, 8), 0.05);
        const large_sell = await trader.estimate_sell_output(metadata, amount(100_000n, 8), 0.05);

        expect(BigInt(low_slippage.expected.amount)).toBeGreaterThan(BigInt(small_buy.expected.amount));
        expect(BigInt(large_sell.expected.amount)).toBeGreaterThan(BigInt(small_sell.expected.amount));
        expect(high_slippage.expected).toEqual(low_slippage.expected);
        expect(BigInt(high_slippage.minimum.amount)).toBeLessThan(BigInt(low_slippage.minimum.amount));
        expect(low_slippage.expected.decimals).toBe(8);
        expect(large_sell.expected.decimals).toBe(6);
        expect_slippage_contract(low_slippage.expected, low_slippage.minimum, 0.01);
        expect_slippage_contract(high_slippage.expected, high_slippage.minimum, 0.1);
        expect_slippage_contract(large_sell.expected, large_sell.minimum, 0.05);
        expect_unit_consistency(low_slippage.expected);
    });

    test('reports expected sell UI amount in quote units', async () => {
        const estimate = await trader.estimate_sell_output(raydium_metadata(), amount(100_000n, 8), 0.05);

        expect_unit_consistency(estimate.expected);
    });

    test('fees reduce estimated buy and launch-sell output', async () => {
        const fee_metadata = raydium_metadata();
        const no_fee_metadata = raydium_metadata({ fee: 0 });
        const quote_input = amount(100_000n, 6);
        const token_input = amount(100_000n, 8);
        const fee_buy = await trader.estimate_buy_output(fee_metadata, quote_input, 0.05);
        const no_fee_buy = await trader.estimate_buy_output(no_fee_metadata, quote_input, 0.05);
        const fee_sell = await trader.estimate_sell_output(fee_metadata, token_input, 0.05);
        const no_fee_sell = await trader.estimate_sell_output(no_fee_metadata, token_input, 0.05);

        expect(BigInt(fee_buy.expected.amount)).toBeLessThan(BigInt(no_fee_buy.expected.amount));
        expect(BigInt(fee_sell.expected.amount)).toBeLessThan(BigInt(no_fee_sell.expected.amount));
    });

    test('moves launch reserves in trade direction without lowering the constant product', () => {
        const buy_metadata = raydium_metadata();
        const initial_quote = buy_metadata.sol_reserves;
        const initial_base = buy_metadata.token_reserves;
        const initial_product = initial_quote * initial_base;

        trader.update_mint_meta_reserves(buy_metadata, amount(100_000n, 6), 'buy');

        expect(buy_metadata.sol_reserves).toBeGreaterThan(initial_quote);
        expect(buy_metadata.token_reserves).toBeLessThan(initial_base);
        expect(buy_metadata.sol_reserves * buy_metadata.token_reserves).toBeGreaterThanOrEqual(initial_product);

        const sell_metadata = raydium_metadata();
        trader.update_mint_meta_reserves(sell_metadata, amount(100_000n, 8), 'sell');

        expect(sell_metadata.sol_reserves).toBeLessThan(initial_quote);
        expect(sell_metadata.token_reserves).toBeGreaterThan(initial_base);
        expect(sell_metadata.sol_reserves * sell_metadata.token_reserves).toBeGreaterThanOrEqual(initial_product);
    });
});

describe('LaunchLab creation and CPMM migration', () => {
    const provider = new RaydiumProvider();
    const usdc = new PublicKey(USDC_MINT);

    function launch_state(status = 0) {
        const data = Buffer.alloc(429);
        Buffer.from(constants.RAYDIUM_LAUNCHPAD_POOL_HEADER).copy(data);
        data[17] = status;
        data[18] = 8;
        data[19] = 6;
        data.writeBigUInt64LE(10_000n, 21);
        data.writeBigUInt64LE(1000n, 37);
        data.writeBigUInt64LE(2000n, 45);
        data.writeBigUInt64LE(100n, 53);
        data.writeBigUInt64LE(500n, 61);
        for (const [offset, key] of [
            [141, address(40)],
            [173, address(41)],
            [205, address(6)],
            [237, USDC_MINT],
            [269, address(42)],
            [301, address(43)],
            [333, wallet.publicKey.toBase58()]
        ] as const)
            Buffer.from(new PublicKey(key).toBytes()).copy(data, offset);
        return { data, owner: RAYDIUM_LAUNCHPAD_PROGRAM_ID, executable: false, lamports: 1n, rentEpoch: 0n };
    }

    function cpmm_state(reverse = false) {
        const data = Buffer.alloc(637);
        Buffer.from(constants.RAYDIUM_CPMM_POOL_STATE_HEADER).copy(data);
        for (const [offset, key] of [
            [8, address(41)],
            [72, address(42)],
            [104, address(43)],
            [168, reverse ? USDC_MINT : address(6)],
            [200, reverse ? address(6) : USDC_MINT],
            [232, TOKEN_PROGRAM_ID],
            [264, TOKEN_PROGRAM_ID],
            [296, address(44)]
        ] as const)
            Buffer.from(new PublicKey(key).toBytes()).copy(data, offset);
        data[331] = reverse ? 6 : 8;
        data[332] = reverse ? 8 : 6;
        for (const offset of [341, 349, 357, 365, 397, 405]) data.writeBigUInt64LE(10n, offset);
        return { data, owner: RAYDIUM_CPMM_PROGRAM_ID, executable: false, lamports: 1n, rentEpoch: 0n };
    }

    test('creates a non-SOL curve from config fees, fundraising and required platform accounts', async () => {
        global.TRANSACTION_VERSION = 1;
        const config = Buffer.alloc(115);
        config.writeBigUInt64LE(1500n, 27);
        Buffer.from(usdc.toBytes()).copy(config, 83);
        const platform = Buffer.alloc(834);
        platform.writeBigUInt64LE(1000n, 104);
        platform.writeBigUInt64LE(500n, 720);
        platform[832] = 1;
        platform[833] = 1;
        global.CONNECTION = {
            getMultipleAccountsInfo: async () =>
                [config, platform].map((data) => ({ data, owner: RAYDIUM_LAUNCHPAD_PROGRAM_ID }))
        } as unknown as Connection;
        const result = await provider.create_token_instructions(create_mint, wallet, 'Token', 'TOK', 'cid', {
            quote_mint: USDC_MINT,
            fundraising: '1000000'
        });
        expect(result.mint_meta.quote_mint_pubkey).toEqual(usdc);
        expect(result.mint_meta.platform_fee).toBe(0.003);
        const create = result.instructions[0]!;
        expect(create.programId).toEqual(RAYDIUM_LAUNCHPAD_PROGRAM_ID);
        expect(create.keys[7]!.pubkey).toEqual(usdc);
        expect(create.keys).toHaveLength(20);
        expect(create.keys.filter((key) => key.isSigner).map((key) => key.pubkey)).toEqual([
            wallet.publicKey,
            create_mint.publicKey
        ]);
        expect(Buffer.from(create.data).readBigUInt64LE(create.data.length - 34)).toBe(1_000_000n);
        await expect(
            provider.create_token_instructions(create_mint, wallet, 'Token', 'TOK', 'cid', { quote_mint: USDC_MINT })
        ).rejects.toThrow('requires config.fundraising');
        await expect(
            provider.create_token_instructions(create_mint, wallet, 'Token', 'TOK', 'cid', { quote_mint: SOL_MINT })
        ).rejects.toThrow('does not match');
    });

    test('replaces provisional reserves and quote units from LaunchLab state', async () => {
        global.CONNECTION = { getAccountInfo: async () => launch_state() } as unknown as Connection;
        const initial = raydium_metadata({ quote_mint: SOL_MINT });
        const updated = await provider.update_mint_meta(initial);
        expect(updated.sol_reserves).toBe(2500n);
        expect(updated.token_reserves).toBe(900n);
        expect(updated.quote_mint_pubkey).toEqual(usdc);
        expect(updated.token_decimals).toBe(8);
        expect(updated.base_vault).toBe(address(42));
        expect(updated.migrated).toBeFalse();
        expect(initial.quote_mint_pubkey).toEqual(new PublicKey(SOL_MINT));
    });

    test.each([false, true])(
        'migrates into CPMM with fee-adjusted reserves in either mint order (reversed=%s)',
        async (reverse) => {
            const state = cpmm_state(reverse);
            global.CONNECTION = { getAccountInfo: async () => launch_state(1) } as unknown as Connection;
            spyOn(trade, 'get_program_accounts_v2').mockResolvedValue([
                { pubkey: new PublicKey(address(45)), account: state }
            ]);
            spyOn(trade, 'get_vault_balance').mockImplementation(async (key) => ({
                balance: key.toBase58() === address(42) ? 1000n : 2000n,
                decimals: 6
            }));
            spyOn(trade, 'get_token_supply').mockResolvedValue({ supply: 10000n, decimals: 8 });
            const updated = await provider.update_mint_meta(raydium_metadata());
            expect(updated.migrated).toBeTrue();
            expect(updated.quote_mint_pubkey).toEqual(usdc);
            expect(updated.token_decimals).toBe(8);
            expect(updated.token_reserves).toBe(reverse ? 1970n : 970n);
            expect(updated.sol_reserves).toBe(reverse ? 970n : 1970n);
            expect(updated.observation_state).toBe(address(44));
        }
    );

    test('publishes CPMM updates only after pool and vault observations agree on a slot', async () => {
        type Callback = (info: { data: Buffer; owner: PublicKey }, context: { slot: bigint }) => void;
        const listeners = new Map<string, Callback>();
        const state = cpmm_state();
        const vault = (amount: bigint) => {
            const data = Buffer.alloc(165);
            data.writeBigUInt64LE(amount, 64);
            data[108] = 1;
            return { data, owner: new PublicKey(TOKEN_PROGRAM_ID) };
        };
        const remove = mock(async (_id: number) => undefined);
        global.CONNECTION = {
            onAccountChange: (key: PublicKey, callback: Callback) => {
                listeners.set(key.toBase58(), callback);
                return listeners.size;
            },
            removeAccountChangeListener: remove,
            getAccountInfoAndContext: async () => ({ value: state, context: { slot: 10n } }),
            getMultipleAccountsInfoAndContext: async () => ({
                value: [state, vault(1000n), vault(2000n)],
                context: { slot: 10n }
            })
        } as unknown as Connection;
        const publish = mock(() => undefined);
        const stop = await provider.subscribe_mint_meta(
            raydium_metadata({ complete: true, observation_state: address(44) }),
            publish
        );
        publish.mockClear();
        listeners.get(address(42))!(vault(1100n), { slot: 11n });
        listeners.get(address(43))!(vault(2100n), { slot: 11n });
        expect(publish).not.toHaveBeenCalled();
        const update = new Promise<void>((resolve) =>
            publish.mockImplementation(() => {
                resolve();
            })
        );
        listeners.get(address(9))!(state, { slot: 11n });
        await update;
        expect(publish).toHaveBeenCalledTimes(1);
        stop();
        expect(remove).toHaveBeenCalledTimes(3);
        listeners.get(address(42))!(vault(1200n), { slot: 12n });
        expect(publish).toHaveBeenCalledTimes(1);
    });
});
