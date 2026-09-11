import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { Keypair, PublicKey, TransactionInstruction, type Connection } from '@solana/web3.js';
import type { Wallet } from '../src/common/common';
import type { IMintMeta, SerializedMintMeta } from '../src/common/trade_common';
import type { Executor } from '../src/common/executor';

const original_env = {
    HELIUS_API_KEY: process.env.HELIUS_API_KEY,
    PINATA_IPFS_JWT: process.env.PINATA_IPFS_JWT
};
process.env.HELIUS_API_KEY ||= 'unit-test';
process.env.PINATA_IPFS_JWT ||= 'unit-test';

const common = await import('../src/common/common');
const trade = await import('../src/common/trade_common');
const {
    COMMANDS_BUY_SLIPPAGE,
    PROGRAM_COMPUTE_UNIT_LIMITS,
    SENDER_MAX_MIN_PRIORITY_FEE,
    TransactionRelay,
    VOLUME_NATURAL_DEFAULTS,
    VOLUME_SIGNATURE_FEE_LAMPORTS,
    VOLUME_WALLET_RENT_RESERVE_SOL
} = await import('../src/constants');
const { setup_config, simulate, execute_fast, execute_natural, execute_bump, VolumeType } =
    await import('../src/subcommands/volume');

const mint = new PublicKey(new Uint8Array(32).fill(20));
const quote_mint = new PublicKey(new Uint8Array(32).fill(21));
const token_program = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const keypairs = await Promise.all([1, 2, 3].map((seed) => Keypair.fromSeed(new Uint8Array(32).fill(seed))));
const original_connection = global.CONNECTION;
const original_transaction_relay = global.TRANSACTION_RELAY;
const original_transaction_version = global.TRANSACTION_VERSION;

function mint_meta(platform_fee = 0.01): IMintMeta {
    return {
        token_name: 'Unit Token',
        token_symbol: 'UNIT',
        token_mint: mint.toBase58(),
        token_quote_mc: 1,
        migrated: false,
        platform_fee,
        mint_pubkey: mint,
        quote_mint_pubkey: quote_mint,
        token_program,
        serialize: () => ({}) as SerializedMintMeta
    };
}

function executor(platform_fee = 0.01): Executor {
    return {
        get_mint_meta: async () => mint_meta(platform_fee),
        get_compute_unit_limit: () => PROGRAM_COMPUTE_UNIT_LIMITS[common.Program.Pump]
    } as unknown as Executor;
}

function config(type: (typeof VolumeType)[keyof typeof VolumeType]) {
    return {
        type,
        mint,
        wallet_cnt: type === VolumeType.Bump ? 1 : 2,
        min_sol_amount: 0.1,
        max_sol_amount: 0.2,
        executions: 2,
        delay: type === VolumeType.Natural ? 5 : 0,
        bundle_tip: type === VolumeType.Natural ? 0 : 0.001,
        ...(type === VolumeType.Natural ? { hold_min: 10, hold_max: 20 } : {})
    };
}

function wallet(index: number, is_reserve = false): Wallet {
    return {
        name: `wallet-${index}`,
        id: index,
        is_reserve,
        keypair: keypairs[index]!
    };
}

beforeEach(() => {
    spyOn(common, 'log').mockImplementation(() => undefined);
    spyOn(common, 'print_header').mockImplementation(() => undefined);
    spyOn(common, 'print_row').mockImplementation(() => undefined);
    spyOn(common, 'print_footer').mockImplementation(() => undefined);
    spyOn(common, 'clear_lines_up').mockResolvedValue(undefined);
    spyOn(common, 'to_confirm').mockResolvedValue(undefined);
    global.TRANSACTION_RELAY = TransactionRelay.Jito;
    global.TRANSACTION_VERSION = 1;
});

afterEach(() => {
    mock.restore();
    if (original_connection === undefined) delete (global as { CONNECTION?: Connection }).CONNECTION;
    else global.CONNECTION = original_connection;
    global.TRANSACTION_RELAY = original_transaction_relay;
    global.TRANSACTION_VERSION = original_transaction_version;
});

afterAll(() => {
    for (const [name, value] of Object.entries(original_env)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
});

describe('setup_config', () => {
    test('normalizes a valid fast configuration and confirms before returning it', async () => {
        const result = await setup_config({
            mint: mint.toBase58(),
            min_sol_amount: 0.1,
            max_sol_amount: 0.2,
            executions: 3,
            bundle_tip: 0.001
        });

        expect(result).toEqual({
            type: VolumeType.Fast,
            mint,
            wallet_cnt: 1,
            min_sol_amount: 0.1,
            max_sol_amount: 0.2,
            executions: 3,
            delay: 0,
            bundle_tip: 0.001,
            hold_min: undefined,
            hold_max: undefined
        });
        expect(common.to_confirm).toHaveBeenCalledWith('Press ENTER to start the volume bot...');
    });

    test('applies natural defaults without accepting bundle tips', async () => {
        const result = await setup_config({
            type: VolumeType.Natural,
            mint: mint.toBase58(),
            min_sol_amount: 0.1,
            max_sol_amount: 0.2,
            executions: 3
        });

        expect(result).toMatchObject({
            type: VolumeType.Natural,
            wallet_cnt: VOLUME_NATURAL_DEFAULTS.wallet_cnt,
            delay: VOLUME_NATURAL_DEFAULTS.delay,
            bundle_tip: 0,
            hold_min: VOLUME_NATURAL_DEFAULTS.hold_min,
            hold_max: VOLUME_NATURAL_DEFAULTS.hold_max
        });
    });

    test.each([
        [
            { mint: 'invalid', min_sol_amount: 0.1, max_sol_amount: 0.2, executions: 1, bundle_tip: 0.001 },
            'Invalid token mint'
        ],
        [
            { mint: mint.toBase58(), min_sol_amount: 0, max_sol_amount: 0.2, executions: 1, bundle_tip: 0.001 },
            'min_sol_amount'
        ],
        [
            { mint: mint.toBase58(), min_sol_amount: 0.2, max_sol_amount: 0.1, executions: 1, bundle_tip: 0.001 },
            'max_sol_amount'
        ],
        [
            { mint: mint.toBase58(), min_sol_amount: 0.1, max_sol_amount: 0.2, executions: 1.5, bundle_tip: 0.001 },
            'executions'
        ],
        [
            {
                type: VolumeType.Natural,
                mint: mint.toBase58(),
                min_sol_amount: 0.1,
                max_sol_amount: 0.2,
                executions: 1,
                delay: 0,
                bundle_tip: 0
            },
            'positive delay'
        ],
        [
            {
                type: VolumeType.Bump,
                mint: mint.toBase58(),
                wallet_cnt: 2,
                min_sol_amount: 0.1,
                max_sol_amount: 0.2,
                executions: 1,
                bundle_tip: 0.001
            },
            'one temporary wallet'
        ]
    ])('rejects invalid public configuration %#', async (invalid_config, message) => {
        await expect(setup_config(invalid_config)).rejects.toThrow(message);
        expect(common.to_confirm).not.toHaveBeenCalled();
    });
});

describe('simulate', () => {
    test('reports bump volume independently from its fee budget', async () => {
        const result = await simulate(150, config(VolumeType.Bump), executor());

        expect(result.total_volume_sol).toBeCloseTo((0.1 + 0.2) * 2);
        expect(result.total_volume_usd).toBeCloseTo(result.total_volume_sol * 150);
        expect(result.total_fee_sol).toBeGreaterThan(0);
        expect(result.total_sol_utilization).toBeGreaterThan(result.total_fee_sol);
    });

    test('scales deterministic fast volume by wallets and executions', async () => {
        spyOn(common, 'uniform_random').mockImplementation((minimum) => minimum);
        const one_execution = { ...config(VolumeType.Fast), executions: 1 };
        const two_executions = { ...one_execution, executions: 2 };

        const once = await simulate(100, one_execution, executor(0));
        const twice = await simulate(100, two_executions, executor(0));

        expect(twice.total_volume_sol).toBeCloseTo(once.total_volume_sol * 2);
        expect(twice.total_fee_sol).toBeCloseTo(once.total_fee_sol * 2);
        expect(twice.total_volume_usd).toBeCloseTo(twice.total_volume_sol * 100);
        expect(twice.total_sol_utilization).toBeCloseTo(0.4 + twice.total_fee_sol);
    });

    test('filters reserve, duplicate, and underfunded wallets from natural estimates', async () => {
        const first = wallet(0);
        const duplicate = { ...wallet(0), name: 'duplicate' };
        const reserve = wallet(1, true);
        const underfunded = wallet(2);
        const get_accounts = mock(async (addresses: PublicKey[]) => {
            expect(addresses).toEqual([first.keypair.publicKey, underfunded.keypair.publicKey]);
            return [{ lamports: 1_000_000_000n }, { lamports: 1n }];
        });
        global.CONNECTION = { getMultipleAccountsInfo: get_accounts } as unknown as typeof global.CONNECTION;

        const result = await simulate(200, config(VolumeType.Natural), executor(0), [
            first,
            duplicate,
            reserve,
            underfunded
        ]);
        const reserve_lamports =
            trade.sol_to_lamports(VOLUME_WALLET_RENT_RESERVE_SOL) + 2n * BigInt(VOLUME_SIGNATURE_FEE_LAMPORTS);
        const available = 1_000_000_000n - reserve_lamports;
        const balance_limit = (available * 10_000n) / (10_000n + BigInt(Math.floor(COMMANDS_BUY_SLIPPAGE * 10_000)));
        const configured_limit = trade.sol_to_lamports(0.2);
        const maximum = balance_limit < configured_limit ? balance_limit : configured_limit;

        expect(get_accounts).toHaveBeenCalledTimes(1);
        expect(result.total_sol_utilization).toBeCloseTo(
            trade.lamports_to_sol(trade.apply_slippage_up(maximum, COMMANDS_BUY_SLIPPAGE))
        );
        expect(result.total_volume_usd).toBeCloseTo(result.total_volume_sol * 200);
    });

    test('accounts for the sender minimum priority fee', async () => {
        const volume_config = config(VolumeType.Bump);
        global.TRANSACTION_RELAY = TransactionRelay.Jito;
        const without_sender = await simulate(1, volume_config, executor(0));
        global.TRANSACTION_RELAY = TransactionRelay.Sender;
        const with_sender = await simulate(1, volume_config, executor(0));

        const priority_fee_delta = 4 * SENDER_MAX_MIN_PRIORITY_FEE;
        expect(with_sender.total_fee_sol - without_sender.total_fee_sol).toBeCloseTo(
            trade.lamports_to_sol(BigInt(priority_fee_delta))
        );
    });

    test('rejects missing mint metadata and insufficient fast wallet funding', async () => {
        const missing_meta = { get_mint_meta: async () => undefined } as unknown as Executor;
        await expect(simulate(1, config(VolumeType.Bump), missing_meta)).rejects.toThrow(
            'Failed to fetch mint metadata.'
        );

        spyOn(common, 'uniform_random').mockReturnValue(0.000001);
        await expect(simulate(1, { ...config(VolumeType.Fast), min_sol_amount: 0.000001 }, executor())).rejects.toThrow(
            'Wallet funding is insufficient'
        );
    });
});

describe('fast funded volume execution', () => {
    function setup(bundle_size = 5) {
        spyOn(common, 'setup_rescue_file').mockReturnValue('offline-rescue.json');
        spyOn(common, 'save_rescue_key').mockReturnValue(true);
        spyOn(common, 'get_wallets').mockResolvedValue([]);
        spyOn(common, 'sleep').mockResolvedValue(undefined);
        spyOn(common, 'uniform_random').mockImplementation((minimum) => minimum);
        spyOn(trade, 'get_balance').mockResolvedValue(10_000_000_000n);
        spyOn(trade, 'get_bundle_size').mockReturnValue(bundle_size);
        const send = spyOn(trade, 'send_bundle').mockResolvedValue('bundle');
        const collect = spyOn(trade, 'retry_send_bundle').mockResolvedValue('collection');
        const groups = [1, 2, 3, 4].map((seed) => [
            new TransactionInstruction({ programId: mint, keys: [], data: Buffer.from([seed]) })
        ]);
        const paired = mock<Executor['buy_sell_instructions']>(async () => [groups.slice(0, 2), groups.slice(2), []]);
        const meta = mint_meta(0);
        const fake = {
            get_mint_meta: async () => meta,
            update_mint_meta: async () => meta,
            get_compute_unit_limit: () => 300_000,
            buy_sell_instructions: paired
        } as unknown as Executor;
        return { fake, paired, send, collect, groups };
    }

    test('packs whole four-leg wallet cycles and appends cleanup after conversion', async () => {
        const { fake, paired, send, collect, groups } = setup();
        await execute_fast(keypairs[0]!, { ...config(VolumeType.Fast), executions: 1 }, fake);
        expect(paired).toHaveBeenCalledTimes(2);
        expect(send).toHaveBeenCalledTimes(3);
        for (const [index, call] of send.mock.calls.slice(1).entries()) {
            const wallet = paired.mock.calls[index]![1];
            expect(call[0]).toHaveLength(4);
            expect(call[0].map((instructions) => instructions[0])).toEqual(groups.flat());
            expect(call[1]).toEqual([[wallet], [wallet], [wallet], [wallet]]);
            const cleanup = call[0][3]![1]!;
            expect(cleanup.programId).toEqual(token_program);
            expect([...cleanup.data]).toEqual([9]);
            expect(cleanup.keys[0]!.pubkey).toEqual(await trade.calc_ata(wallet.publicKey, mint, token_program));
            expect(paired.mock.calls[index]![0]).toBeGreaterThan(0);
            expect(paired.mock.calls[index]![0]).toBeLessThan(0.1);
        }
        expect(collect).toHaveBeenCalledTimes(1);
    });

    test('rejects an oversized cycle before sending any of its trading legs', async () => {
        const { fake, send, collect } = setup(3);
        await expect(execute_fast(keypairs[0]!, { ...config(VolumeType.Fast), executions: 1 }, fake)).rejects.toThrow(
            'Wallet buy/sell cycle does not fit'
        );
        expect(send).toHaveBeenCalledTimes(1);
        expect(collect).not.toHaveBeenCalled();
    });
});

describe('natural volume lifecycle and recovery', () => {
    async function setup(available = 623n) {
        let now = 100_000;
        spyOn(Date, 'now').mockImplementation(() => now);
        spyOn(Math, 'random').mockReturnValue(0);
        spyOn(common, 'uniform_random').mockImplementation((minimum) => minimum);
        spyOn(common, 'normal_random').mockImplementation((mean) => mean);
        spyOn(common, 'sleep').mockImplementation(async (ms) => {
            now += ms;
        });
        spyOn(common, 'warn').mockImplementation(() => undefined);
        const balance = spyOn(trade, 'get_balance').mockResolvedValue(1_000_000_000n);
        const owner = wallet(0);
        const ata = await trade.calc_ata(owner.keypair.publicKey, mint, token_program);
        const data = Buffer.alloc(165);
        Buffer.from(mint.toBytes()).copy(data, 0);
        Buffer.from(owner.keypair.publicKey.toBytes()).copy(data, 32);
        data.writeBigUInt64LE(available, 64);
        data[108] = 1;
        const account = mock(async (_key: PublicKey, _config?: unknown) => ({
            data,
            owner: token_program,
            lamports: 1n
        }));
        global.CONNECTION = {
            getMultipleAccountsInfo: async () => [{ lamports: 1_000_000_000n }],
            getAccountInfo: account
        } as unknown as Connection;
        const token_balance = (amount: string) => ({
            accountIndex: 0,
            mint: mint.toBase58(),
            uiTokenAmount: { amount, decimals: 6, uiAmount: null }
        });
        const fill = {
            slot: 77n,
            transaction: { message: { accountKeys: [{ pubkey: ata }] } },
            meta: { err: null, preTokenBalances: [token_balance('500')], postTokenBalances: [token_balance('623')] }
        } as unknown as NonNullable<Awaited<ReturnType<typeof trade.retry_get_tx>>>;
        const get_tx = spyOn(trade, 'retry_get_tx').mockResolvedValue(fill);
        const buy = mock<Executor['buy_token']>(async () => 'buy');
        const sell = mock<Executor['sell_token']>(async () => 'sell');
        const meta = mint_meta(0);
        const fake = {
            get_mint_meta: async () => meta,
            update_mint_meta: async () => meta,
            buy_token: buy,
            sell_token: sell
        } as unknown as Executor;
        const options = { ...config(VolumeType.Natural), executions: 1, wallet_cnt: 1, hold_min: 2, hold_max: 2 };
        return { fake, owner, options, buy, sell, get_tx, fill, account, ata, balance };
    }

    test.each([
        [623n, '123'],
        [573n, '73'],
        [500n, null]
    ] as const)('preserves pre-existing tokens with current balance %s', async (available, expected) => {
        const state = await setup(available);
        await execute_natural([state.owner], state.options, state.fake);
        expect(state.buy).toHaveBeenCalledTimes(1);
        expect(state.get_tx).toHaveBeenCalledWith('buy');
        expect(state.account).toHaveBeenCalledWith(state.ata, { commitment: 'confirmed', minContextSlot: 77n });
        if (expected === null) expect(state.sell).not.toHaveBeenCalled();
        else {
            expect(state.sell).toHaveBeenCalledTimes(1);
            expect(state.sell.mock.calls[0]![0]).toEqual({ amount: expected, decimals: 6, uiAmount: null });
        }
        expect(common.sleep).toHaveBeenCalledWith(1000);
    });

    test('resolves an uncertain buy, closes its position and stops additional buys', async () => {
        const state = await setup();
        state.buy.mockRejectedValue(new trade.TransactionSubmissionError('buy', new Error('timeout'), 'unknown'));
        await expect(execute_natural([state.owner], { ...state.options, executions: 3 }, state.fake)).rejects.toThrow(
            '1 confirmed buys | 1 confirmed sells'
        );
        expect(state.buy).toHaveBeenCalledTimes(1);
        expect(state.get_tx).toHaveBeenCalledWith('buy');
        expect(state.sell).toHaveBeenCalledTimes(1);
    });

    test('confirms an uncertain sell without sending it again', async () => {
        const state = await setup();
        state.sell.mockRejectedValue(new trade.TransactionSubmissionError('sell', new Error('timeout'), 'unknown'));
        await expect(execute_natural([state.owner], state.options, state.fake)).rejects.toThrow(
            '1 confirmed buys | 1 confirmed sells'
        );
        expect(state.sell).toHaveBeenCalledTimes(1);
        expect(state.get_tx.mock.calls.map(([signature]) => signature)).toEqual(['buy', 'sell']);
    });

    test('reports an unresolved buy without guessing its fill or resubmitting', async () => {
        const state = await setup();
        state.get_tx.mockResolvedValue(null);
        await expect(execute_natural([state.owner], state.options, state.fake)).rejects.toThrow(
            'Stopping without resubmitting'
        );
        expect(state.buy).toHaveBeenCalledTimes(1);
        expect(state.sell).not.toHaveBeenCalled();
    });

    test('rejects failed buy metadata rather than selling an existing balance', async () => {
        const state = await setup();
        state.get_tx.mockResolvedValue({ ...state.fill, meta: { ...state.fill.meta!, err: 'AccountNotFound' } });
        await expect(execute_natural([state.owner], state.options, state.fake)).rejects.toThrow(
            'Missing successful token balance metadata'
        );
        expect(state.sell).not.toHaveBeenCalled();
    });

    test('skips a wallet whose spendable balance falls below minimum before buying', async () => {
        const state = await setup();
        state.balance.mockResolvedValue(1n);
        await execute_natural([state.owner], state.options, state.fake);
        expect(state.buy).not.toHaveBeenCalled();
        expect(state.sell).not.toHaveBeenCalled();
    });
});

describe('bump volume execution', () => {
    test('reuses one funded wallet and closes its token account only after the final cycle', async () => {
        spyOn(common, 'setup_rescue_file').mockReturnValue('offline-rescue.json');
        spyOn(common, 'save_rescue_key').mockReturnValue(true);
        spyOn(common, 'get_wallets').mockResolvedValue([]);
        spyOn(common, 'sleep').mockResolvedValue(undefined);
        spyOn(common, 'uniform_random').mockImplementation((minimum) => minimum);
        spyOn(trade, 'get_balance').mockResolvedValue(10_000_000_000n);
        const send = spyOn(trade, 'send_bundle').mockResolvedValue('bundle');
        const collect = spyOn(trade, 'retry_send_bundle').mockResolvedValue('collected');
        const instruction = new TransactionInstruction({ programId: mint, keys: [], data: Buffer.from([1]) });
        const paired = mock<Executor['buy_sell_instructions']>(async () => [[[instruction]], [[instruction]], []]);
        const meta = mint_meta(0);
        const fake = {
            get_mint_meta: async () => meta,
            update_mint_meta: async () => meta,
            buy_sell_instructions: paired
        } as unknown as Executor;
        await execute_bump(keypairs[0]!, config(VolumeType.Bump), fake);
        expect(paired).toHaveBeenCalledTimes(2);
        expect(paired.mock.calls[0]![1]).toBe(paired.mock.calls[1]![1]);
        expect(send).toHaveBeenCalledTimes(3);
        const cycles = send.mock.calls.slice(1).map(([groups]) => groups.flat());
        expect(cycles[0]!.some((ix) => ix.programId.equals(token_program))).toBeFalse();
        expect(cycles[1]!.at(-1)!.programId).toEqual(token_program);
        expect([...cycles[1]!.at(-1)!.data]).toEqual([9]);
        expect(collect).toHaveBeenCalledTimes(1);
    });
});
