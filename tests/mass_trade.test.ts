import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import {
    Keypair,
    PublicKey,
    type AddressLookupTableAccount,
    type TokenAmount,
    type TransactionInstruction
} from '@solana/web3.js';
import type { Executor } from '../src/common/executor';
import type { IMintMeta, IProgramProvider, SerializedMintMeta, TradeOp } from '../src/common/trade_common';

const original_env = {
    HELIUS_API_KEY: process.env.HELIUS_API_KEY,
    PINATA_IPFS_JWT: process.env.PINATA_IPFS_JWT,
    JUPITER_API_KEY: process.env.JUPITER_API_KEY
};
process.env.HELIUS_API_KEY ||= 'unit-test';
process.env.PINATA_IPFS_JWT ||= 'unit-test';
process.env.JUPITER_API_KEY ||= 'unit-test';

const common = await import('../src/common/common');
const trade = await import('../src/common/trade_common');
const { Executor: RealExecutor } = await import('../src/common/executor');
const { PriorityLevel, SOL_MINT } = await import('../src/constants');
const { bundle_buy, bundle_sell, seq_buy, seq_sell } = await import('../src/subcommands/mass_trade');

type Funding = Awaited<ReturnType<Executor['has_enough_balances']>>;
type BuyCall = Parameters<Executor['buy_token']>;
type SellCall = Parameters<Executor['sell_token']>;
type BuyInstructionCall = Parameters<Executor['buy_token_instructions']>;
type SellInstructionCall = Parameters<Executor['sell_token_instructions']>;
type ReserveCall = [IMintMeta, TokenAmount, TradeOp];

const wallets = await Promise.all(
    ['ready', 'empty', 'fundable', 'failure'].map(async (name, index) => ({
        name,
        id: index + 1,
        is_reserve: false,
        keypair: await Keypair.fromSeed(new Uint8Array(32).fill(index + 1))
    }))
);
const mint = new PublicKey(new Uint8Array(32).fill(20));
const quote_mint = new PublicKey(new Uint8Array(32).fill(21));
const token_program = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

function mint_meta(name = 'initial'): IMintMeta {
    return {
        token_name: name,
        token_symbol: 'UNIT',
        token_mint: mint.toBase58(),
        token_quote_mc: 1,
        migrated: false,
        platform_fee: 0,
        mint_pubkey: mint,
        quote_mint_pubkey: quote_mint,
        token_program,
        serialize: () => ({}) as SerializedMintMeta
    };
}

function token_amount(amount: string, decimals = 6): TokenAmount {
    return { amount, decimals, uiAmount: Number(amount) / 10 ** decimals };
}

function funding(status: Funding['status'], amount = '1000000'): Funding {
    return {
        status,
        quote_amount: token_amount(amount),
        quote_balance_raw: 0n,
        sol_balance_raw: 1_000_000_000n
    };
}

function lookup_table(seed: number): AddressLookupTableAccount {
    return { key: new PublicKey(new Uint8Array(32).fill(seed)) } as AddressLookupTableAccount;
}

function instruction(seed: number): TransactionInstruction {
    return { seed } as unknown as TransactionInstruction;
}

type FakeOptions = {
    funding?: (args: Parameters<Executor['has_enough_balances']>) => Funding | Promise<Funding>;
    buy?: (args: BuyCall) => String | Promise<String>;
    sell?: (args: SellCall) => String | Promise<String>;
    buy_instructions?: (
        args: BuyInstructionCall
    ) => ReturnType<Executor['buy_token_instructions']> | Awaited<ReturnType<Executor['buy_token_instructions']>>;
    sell_instructions?: (
        args: SellInstructionCall
    ) => ReturnType<Executor['sell_token_instructions']> | Awaited<ReturnType<Executor['sell_token_instructions']>>;
    update?: (meta: IMintMeta) => IMintMeta | Promise<IMintMeta>;
    reserve?: (meta: IMintMeta, amount: TokenAmount, op: TradeOp) => IMintMeta;
};

function fake_executor(options: FakeOptions = {}) {
    const calls = {
        funding: [] as Parameters<Executor['has_enough_balances']>[],
        buys: [] as BuyCall[],
        sells: [] as SellCall[],
        buy_instructions: [] as BuyInstructionCall[],
        sell_instructions: [] as SellInstructionCall[],
        updates: [] as IMintMeta[],
        reserves: [] as ReserveCall[]
    };
    const fake = {
        get_compute_unit_limit: (funded = false) => (funded ? 700_000 : 300_000),
        update_mint_meta: async (meta: IMintMeta) => {
            calls.updates.push(meta);
            return (await options.update?.(meta)) ?? meta;
        },
        update_mint_meta_reserves: (meta: IMintMeta, amount: TokenAmount, op: TradeOp) => {
            calls.reserves.push([meta, amount, op]);
            return options.reserve?.(meta, amount, op) ?? meta;
        },
        has_enough_balances: async (...args: Parameters<Executor['has_enough_balances']>) => {
            calls.funding.push(args);
            return (await options.funding?.(args)) ?? funding('ready');
        },
        buy_token: async (...args: BuyCall) => {
            calls.buys.push(args);
            return (await options.buy?.(args)) ?? 'buy-signature';
        },
        sell_token: async (...args: SellCall) => {
            calls.sells.push(args);
            return (await options.sell?.(args)) ?? 'sell-signature';
        },
        buy_token_instructions: async (...args: BuyInstructionCall) => {
            calls.buy_instructions.push(args);
            return (await options.buy_instructions?.(args)) ?? [[[instruction(1)]], []];
        },
        sell_token_instructions: async (...args: SellInstructionCall) => {
            calls.sell_instructions.push(args);
            return (await options.sell_instructions?.(args)) ?? [[[instruction(2)]], []];
        }
    } satisfies Pick<
        Executor,
        | 'update_mint_meta'
        | 'get_compute_unit_limit'
        | 'update_mint_meta_reserves'
        | 'has_enough_balances'
        | 'buy_token'
        | 'sell_token'
        | 'buy_token_instructions'
        | 'sell_token_instructions'
    >;
    return { executor: fake as Executor, calls };
}

beforeEach(() => {
    spyOn(common, 'log').mockImplementation(() => undefined);
    spyOn(common, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
    mock.restore();
});

afterAll(() => {
    for (const [name, value] of Object.entries(original_env)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
});

describe('sequential mass trades', () => {
    test('buys ready wallets, skips insufficient wallets, and forwards execution options', async () => {
        const meta = mint_meta();
        const fake = fake_executor({
            funding: ([, account]) => funding(account.equals(wallets[0]!.keypair.publicKey) ? 'ready' : 'insufficient')
        });

        await seq_buy(
            meta,
            [
                [wallets[0]!, 1.25],
                [wallets[1]!, 2.5]
            ],
            fake.executor,
            0.03,
            PriorityLevel.HIGH,
            0.001,
            true
        );

        expect(fake.calls.buys).toEqual([[1.25, wallets[0]!.keypair, meta, 0.03, PriorityLevel.HIGH, 0.001, true]]);
        expect(fake.calls.updates).toEqual([meta]);
    });

    test('filters empty token wallets, converts the requested percent, and forwards sell options', async () => {
        const meta = mint_meta();
        const balances = new Map([
            [wallets[0]!.keypair.publicKey.toBase58(), token_amount('1000000')],
            [wallets[1]!.keypair.publicKey.toBase58(), token_amount('0')]
        ]);
        const balance_requests: Parameters<typeof trade.get_token_balance>[] = [];
        spyOn(trade, 'get_token_balance').mockImplementation(async (...args) => {
            balance_requests.push(args);
            return balances.get(args[0].toBase58()) ?? token_amount('0');
        });
        const fake = fake_executor();

        await seq_sell(meta, wallets.slice(0, 3), fake.executor, 0.25, 0.04, PriorityLevel.LOW, 0.002, true);

        expect(balance_requests).toEqual(
            wallets.slice(0, 3).map((wallet) => [wallet.keypair.publicKey, mint, 'confirmed', token_program])
        );
        expect(fake.calls.sells).toEqual([
            [token_amount('250000'), wallets[0]!.keypair, meta, 0.04, PriorityLevel.LOW, 0.002, true]
        ]);
        expect(fake.calls.updates).toEqual([meta]);
    });

    test('continues independent buys and reports one aggregate error count', async () => {
        const fake = fake_executor({
            funding: ([, account]) => {
                if (account.equals(wallets[1]!.keypair.publicKey)) throw new Error('balance unavailable');
                return funding('ready');
            },
            buy: ([, buyer]) => {
                if (buyer.publicKey.equals(wallets[0]!.keypair.publicKey)) throw new Error('submission rejected');
                return 'successful-signature';
            }
        });

        await expect(
            seq_buy(
                mint_meta(),
                wallets.slice(0, 3).map((wallet) => [wallet, 1]),
                fake.executor,
                0.05,
                PriorityLevel.DEFAULT
            )
        ).rejects.toThrow('2 sequential buy operation(s) failed.');

        expect(fake.calls.buys.map(([, buyer]) => buyer.publicKey)).toEqual([
            wallets[0]!.keypair.publicKey,
            wallets[2]!.keypair.publicKey
        ]);
    });

    test('lets a funding-enabled executor fund a needs_funding buy', async () => {
        const meta = mint_meta();
        const trader = {
            update_mint_meta: async (value: IMintMeta) => value
        } as IProgramProvider;
        const executor = new RealExecutor(trader, true);
        spyOn(executor, 'has_enough_balances').mockResolvedValue(funding('needs_funding'));
        const buy = spyOn(executor, 'buy_token').mockResolvedValue('funded-signature');

        await seq_buy(meta, [[wallets[0]!, 1]], executor, 0.05, PriorityLevel.DEFAULT);

        expect(buy.mock.calls).toEqual([[1, wallets[0]!.keypair, meta, 0.05, PriorityLevel.DEFAULT, undefined, false]]);
    });
});

describe('bundle mass trades', () => {
    test.each(['buy', 'sell'] as const)(
        'keeps funded %s wallet groups together and uses funded compute limits',
        async (op) => {
            spyOn(common, 'sleep').mockResolvedValue(undefined);
            spyOn(trade, 'get_bundle_size').mockReturnValue(3);
            spyOn(trade, 'get_token_balance').mockResolvedValue(token_amount('1000000'));
            const send = spyOn(trade, 'send_bundle').mockResolvedValue('bundle');
            const first = [instruction(10), instruction(11)];
            const second = [instruction(12), instruction(13)];
            const tables = [lookup_table(50), lookup_table(51)];
            const groups = (wallet: Keypair): [TransactionInstruction[][], AddressLookupTableAccount[]] => {
                const index = wallet.publicKey.equals(wallets[0]!.keypair.publicKey) ? 0 : 1;
                return [(index === 0 ? first : second).map((ix) => [ix]), [tables[index]!]];
            };
            const fake = fake_executor({
                buy_instructions: ([, wallet]) => groups(wallet),
                sell_instructions: ([, wallet]) => groups(wallet)
            });
            if (op === 'buy')
                await bundle_buy(
                    mint_meta(),
                    wallets.slice(0, 2).map((wallet) => [wallet, 1]),
                    fake.executor,
                    0.01,
                    0.001,
                    PriorityLevel.HIGH
                );
            else await bundle_sell(mint_meta(), wallets.slice(0, 2), fake.executor, 1, 0.01, 0.001, PriorityLevel.HIGH);
            expect(send.mock.calls).toEqual([
                [
                    first.map((ix) => [ix]),
                    [[wallets[0]!.keypair], [wallets[0]!.keypair]],
                    0.001,
                    PriorityLevel.HIGH,
                    [tables[0]],
                    700_000
                ],
                [
                    second.map((ix) => [ix]),
                    [[wallets[1]!.keypair], [wallets[1]!.keypair]],
                    0.001,
                    PriorityLevel.HIGH,
                    [tables[1]],
                    700_000
                ]
            ]);
            expect(fake.calls.reserves).toHaveLength(2);
        }
    );

    test('rejects an oversized wallet without submitting a partial funding leg', async () => {
        spyOn(trade, 'get_bundle_size').mockReturnValue(1);
        const send = spyOn(trade, 'send_bundle').mockResolvedValue('bundle');
        const fake = fake_executor({ buy_instructions: () => [[[instruction(1)], [instruction(2)]], []] });
        await expect(
            bundle_buy(mint_meta(), [[wallets[0]!, 1]], fake.executor, 0.01, 0.001, PriorityLevel.HIGH)
        ).rejects.toThrow('failed');
        expect(send).not.toHaveBeenCalled();
        expect(fake.calls.reserves).toHaveLength(0);
    });

    test('groups wallets while carrying reserve metadata and unique lookup tables into each bundle', async () => {
        spyOn(common, 'sleep').mockResolvedValue(undefined);
        spyOn(trade, 'get_bundle_size').mockReturnValue(2);
        const sent: Parameters<typeof trade.send_bundle>[] = [];
        spyOn(trade, 'send_bundle').mockImplementation(async (...args) => {
            sent.push([args[0], args[1], args[2], args[3], [...(args[4] ?? [])], args[5]]);
            return `bundle-${sent.length}`;
        });
        const initial = mint_meta('initial');
        const reserve_1 = mint_meta('reserve-1');
        const reserve_2 = mint_meta('reserve-2');
        const refreshed = mint_meta('refreshed');
        const reserve_3 = mint_meta('reserve-3');
        const lta_a = lookup_table(30);
        const lta_b = lookup_table(31);
        const lta_c = lookup_table(32);
        const txs = [instruction(1), instruction(2), instruction(3)];
        const fake = fake_executor({
            funding: ([amount]) => funding('ready', String(amount * 1_000_000)),
            buy_instructions: ([, buyer]) => {
                if (buyer.publicKey.equals(wallets[0]!.keypair.publicKey)) return [[[txs[0]!]], [lta_a]];
                if (buyer.publicKey.equals(wallets[1]!.keypair.publicKey)) return [[[txs[1]!]], [lta_a, lta_b]];
                return [[[txs[2]!]], [lta_b, lta_c]];
            },
            reserve: (meta) => {
                if (meta === initial) return reserve_1;
                if (meta === reserve_1) return reserve_2;
                if (meta === refreshed) return reserve_3;
                throw new Error(`Unexpected reserve metadata: ${meta.token_name}`);
            },
            update: (meta) => {
                if (meta === reserve_2) return refreshed;
                if (meta === reserve_3) return reserve_3;
                throw new Error(`Unexpected refresh metadata: ${meta.token_name}`);
            }
        });

        await bundle_buy(
            initial,
            wallets.slice(0, 3).map((wallet, index) => [wallet, index + 1]),
            fake.executor,
            0.02,
            0.003,
            PriorityLevel.HIGH
        );

        expect(
            fake.calls.buy_instructions.map(([amount, buyer, meta, slippage]) => [amount, buyer, meta, slippage])
        ).toEqual([
            [1, wallets[0]!.keypair, initial, 0.02],
            [2, wallets[1]!.keypair, reserve_1, 0.02],
            [3, wallets[2]!.keypair, refreshed, 0.02]
        ]);
        expect(fake.calls.reserves).toEqual([
            [initial, token_amount('1000000'), 'buy'],
            [reserve_1, token_amount('2000000'), 'buy'],
            [refreshed, token_amount('3000000'), 'buy']
        ]);
        expect(fake.calls.updates).toEqual([reserve_2, reserve_3]);
        expect(
            sent.map(([instructions, signers, tip, priority, ltas]) => ({ instructions, signers, tip, priority, ltas }))
        ).toEqual([
            {
                instructions: [[txs[0]], [txs[1]]],
                signers: [[wallets[0]!.keypair], [wallets[1]!.keypair]],
                tip: 0.003,
                priority: PriorityLevel.HIGH,
                ltas: [lta_a, lta_b]
            },
            {
                instructions: [[txs[2]]],
                signers: [[wallets[2]!.keypair]],
                tip: 0.003,
                priority: PriorityLevel.HIGH,
                ltas: [lta_b, lta_c]
            }
        ]);
    });
});

describe('Executor instruction contracts used by mass-trade bundles', () => {
    function instruction_trader() {
        const expected_buy: Awaited<ReturnType<IProgramProvider['buy_token_instructions']>> = [[instruction(40)], []];
        const expected_sell: Awaited<ReturnType<IProgramProvider['sell_token_instructions']>> = {
            instructions: [instruction(41)],
            ltas: [],
            minimum_quote_output: token_amount('100', 9)
        };
        const buy_calls: Parameters<IProgramProvider['buy_token_instructions']>[] = [];
        const sell_calls: Parameters<IProgramProvider['sell_token_instructions']>[] = [];
        const trader = {
            buy_token_instructions: async (...args: Parameters<IProgramProvider['buy_token_instructions']>) => {
                buy_calls.push(args);
                return expected_buy;
            },
            sell_token_instructions: async (...args: Parameters<IProgramProvider['sell_token_instructions']>) => {
                sell_calls.push(args);
                return expected_sell;
            }
        } as unknown as IProgramProvider;
        return { trader, expected_buy, expected_sell, buy_calls, sell_calls };
    }

    test('wraps provider buy instructions in an executor transaction group', async () => {
        const fake = instruction_trader();
        const executor = new RealExecutor(fake.trader);
        const meta = { ...mint_meta(), quote_mint_pubkey: SOL_MINT };

        await expect(executor.buy_token_instructions(1, wallets[0]!.keypair, meta, 0.05)).resolves.toEqual([
            [fake.expected_buy[0]],
            fake.expected_buy[1]
        ]);
        expect(fake.buy_calls).toEqual([[token_amount('1000000000', 9), wallets[0]!.keypair, meta, 0.05]]);
    });

    test('wraps provider sell instructions in an executor transaction group', async () => {
        const fake = instruction_trader();
        const executor = new RealExecutor(fake.trader);
        const amount = token_amount('500000');
        const meta = mint_meta();

        await expect(executor.sell_token_instructions(amount, wallets[0]!.keypair, meta, 0.05)).resolves.toEqual([
            [fake.expected_sell.instructions],
            fake.expected_sell.ltas
        ]);
        expect(fake.sell_calls).toEqual([[amount, wallets[0]!.keypair, meta, 0.05]]);
    });
});
