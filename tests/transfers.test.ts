import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemInstruction, type TokenAmount } from '@solana/web3.js';
import type { Wallet } from '../src/common/common';
import type { MintAsset } from '../src/common/trade_common';

const original_env = {
    HELIUS_API_KEY: process.env.HELIUS_API_KEY,
    PINATA_IPFS_JWT: process.env.PINATA_IPFS_JWT
};
process.env.HELIUS_API_KEY ||= 'unit-test';
process.env.PINATA_IPFS_JWT ||= 'unit-test';

const common = await import('../src/common/common');
const trade = await import('../src/common/trade_common');
const { PriorityLevel, TRANSFER_MAX_DEPTH } = await import('../src/constants');
const {
    execute_depth_dist_token,
    execute_depth_sol_fund,
    execute_dist_token,
    execute_fund_sol,
    execute_spider_fund_sol
} = await import('../src/subcommands/transfers');

const keypairs = await Promise.all([1, 2, 3, 4].map((seed) => Keypair.fromSeed(new Uint8Array(32).fill(seed))));
const funder = keypairs[0]!;
const wallets: Wallet[] = keypairs.map((keypair, index) => ({
    name: `wallet-${index}`,
    id: index,
    is_reserve: false,
    keypair
}));
const mint = new PublicKey(new Uint8Array(32).fill(20));
const token_program = new PublicKey(new Uint8Array(32).fill(21));
const mint_meta: MintAsset = {
    token_name: 'Unit Token',
    token_symbol: 'UNIT',
    token_decimal: 6,
    token_supply: 1_000_000,
    price_per_token: 0,
    mint,
    token_program
};

function token_amount(amount: string): TokenAmount {
    return { amount, decimals: 6, uiAmount: Number(amount) / 1_000_000 };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((resolve_promise, reject_promise) => {
        resolve = resolve_promise;
        reject = reject_promise;
    });
    return { promise, resolve, reject };
}

beforeEach(() => {
    spyOn(common, 'log').mockImplementation(() => undefined);
    spyOn(common, 'error').mockImplementation(() => undefined);
    spyOn(common, 'sleep').mockResolvedValue(undefined);
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

describe('execute_fund_sol', () => {
    test('skips the funder and forwards exact lamports, signer, recipient, and priority', async () => {
        const send = spyOn(trade, 'send_lamports').mockResolvedValue('sol-signature');

        await execute_fund_sol(
            [
                [wallets[0]!, 99],
                [wallets[1]!, 1.25]
            ],
            funder
        );

        expect(send.mock.calls).toEqual([[1_250_000_000n, funder, wallets[1]!.keypair.publicKey, PriorityLevel.HIGH]]);
        expect(common.sleep).toHaveBeenCalledTimes(1);
    });

    test('starts independent submissions and waits for all of them to settle', async () => {
        const first = deferred<String>();
        const second = deferred<String>();
        const send = spyOn(trade, 'send_lamports')
            .mockImplementationOnce(() => first.promise)
            .mockImplementationOnce(() => second.promise);

        let completed = false;
        const execution = execute_fund_sol(
            [
                [wallets[1]!, 1],
                [wallets[2]!, 2]
            ],
            funder
        ).then(() => {
            completed = true;
        });
        await Promise.resolve();

        expect(send).toHaveBeenCalledTimes(2);
        expect(completed).toBeFalse();
        second.resolve('second-signature');
        await Promise.resolve();
        expect(completed).toBeFalse();
        first.resolve('first-signature');
        await execution;
        expect(completed).toBeTrue();
    });

    test('reports every failed wallet after all submissions complete', async () => {
        spyOn(trade, 'send_lamports')
            .mockRejectedValueOnce(new Error('first rejected'))
            .mockResolvedValueOnce('successful-signature')
            .mockRejectedValueOnce(new Error('third rejected'));

        await expect(
            execute_fund_sol(
                [
                    [wallets[1]!, 1],
                    [wallets[2]!, 2],
                    [wallets[3]!, 3]
                ],
                funder
            )
        ).rejects.toThrow('2 funding transfer(s) failed.');

        const errors = (common.error as ReturnType<typeof mock>).mock.calls.flat().join('\n');
        expect(errors).toContain('Wallet: wallet-1 (1)');
        expect(errors).toContain('Wallet: wallet-3 (3)');
    });
});

describe('spider funding execution', () => {
    function setup() {
        spyOn(common, 'setup_rescue_file').mockReturnValue('offline-rescue.json');
        const save = spyOn(common, 'save_rescue_key').mockReturnValue(true);
        const rescue = [wallets[0]!];
        spyOn(common, 'get_wallets').mockResolvedValue(rescue);
        spyOn(trade, 'get_balance').mockResolvedValue(900_000_000n);
        const send = spyOn(trade, 'retry_send_lamports').mockResolvedValue('transfer');
        return { send, save, rescue };
    }

    test('backs up all intermediates, conserves root funding and routes each leaf to its recipient', async () => {
        const { send, save, rescue } = setup();
        expect(await execute_spider_fund_sol(wallets.slice(1), 1, funder)).toBe(rescue);
        expect(save).toHaveBeenCalledTimes(6);
        const inner = send.mock.calls.filter((call) => call[3] === PriorityLevel.DEFAULT);
        const final = send.mock.calls.filter((call) => call[3] === PriorityLevel.HIGH);
        expect(inner).toHaveLength(5);
        expect(inner.filter((call) => call[1] === funder).reduce((total, call) => total + call[0], 0n)).toBe(
            3_000_000_000n
        );
        expect(final.map((call) => call[2])).toEqual(wallets.slice(1).map((wallet) => wallet.keypair.publicKey));
        for (const [amount, sender] of final) {
            expect(amount).toBe(900_000_000n);
            expect(inner.some((call) => call[2].equals(sender.publicKey))).toBeTrue();
            expect(save.mock.calls.some(([keypair]) => keypair === sender)).toBeTrue();
        }
    });

    test('does not start transfers when recovery-key persistence fails', async () => {
        const { send, save } = setup();
        save.mockReturnValue(false);
        await expect(execute_spider_fund_sol(wallets.slice(1), 1, funder)).rejects.toThrow('spider transfer');
        expect(send).not.toHaveBeenCalled();
    });

    test('stops downstream funding on an inner failure and returns recovery wallets', async () => {
        const { send, rescue } = setup();
        send.mockRejectedValue(new Error('transfer rejected'));
        expect(await execute_spider_fund_sol(wallets.slice(1), 1, funder)).toBe(rescue);
        expect(send).toHaveBeenCalledTimes(1);
        expect(common.error).toHaveBeenCalled();
    });

    test('settles independent final transfers even if one recipient transfer fails', async () => {
        const { send } = setup();
        send.mockImplementation(async (_amount, _sender, receiver, priority) => {
            if (priority === PriorityLevel.HIGH && receiver.equals(wallets[1]!.keypair.publicKey))
                throw new Error('recipient failed');
            return 'transfer';
        });
        await execute_spider_fund_sol(wallets.slice(1), 1, funder);
        expect(send.mock.calls.filter((call) => call[3] === PriorityLevel.HIGH)).toHaveLength(3);
        expect(common.error).toHaveBeenCalledTimes(1);
    });
});

describe('execute_dist_token', () => {
    test('skips the distributer and forwards the unchanged token amount and token program', async () => {
        const amount = token_amount('9007199254740993');
        const send = spyOn(trade, 'send_tokens').mockResolvedValue('token-signature');

        await execute_dist_token(
            [
                [wallets[0]!, token_amount('1')],
                [wallets[1]!, amount]
            ],
            mint_meta,
            funder
        );

        expect(send.mock.calls).toEqual([
            [amount, mint, funder, wallets[1]!.keypair.publicKey, PriorityLevel.HIGH, token_program]
        ]);
        expect(common.sleep).toHaveBeenCalledTimes(1);
    });

    test('starts independent submissions, waits for completion, and aggregates failures', async () => {
        const pending = deferred<String>();
        const send = spyOn(trade, 'send_tokens')
            .mockImplementationOnce(() => pending.promise)
            .mockRejectedValueOnce(new Error('second rejected'));

        let settled = false;
        const execution = execute_dist_token(
            [
                [wallets[1]!, token_amount('1000000')],
                [wallets[2]!, token_amount('2000000')]
            ],
            mint_meta,
            funder
        ).finally(() => {
            settled = true;
        });
        await Promise.resolve();

        expect(send).toHaveBeenCalledTimes(2);
        expect(settled).toBeFalse();
        pending.reject(new Error('first rejected'));
        await expect(execution).rejects.toThrow('2 token distribution(s) failed.');
        expect(settled).toBeTrue();
    });
});

describe('depth transfer public contracts', () => {
    test('validates excessive depth before setting up rescue files', async () => {
        const setup = spyOn(common, 'setup_rescue_file').mockReturnValue('/virtual/rescue.csv');
        const send_bundle = spyOn(trade, 'retry_send_bundle').mockResolvedValue('unused');

        await expect(execute_depth_sol_fund([], funder, TRANSFER_MAX_DEPTH + 1, 0)).rejects.toThrow(
            `Max depth is ${TRANSFER_MAX_DEPTH}, but ${TRANSFER_MAX_DEPTH + 1} was provided`
        );
        await expect(execute_depth_dist_token([], mint_meta, funder, TRANSFER_MAX_DEPTH + 1, 0)).rejects.toThrow(
            `Max depth is ${TRANSFER_MAX_DEPTH}, but ${TRANSFER_MAX_DEPTH + 1} was provided`
        );

        expect(setup).not.toHaveBeenCalled();
        expect(send_bundle).not.toHaveBeenCalled();
    });

    test('rejects depths below one at the public boundary', async () => {
        spyOn(common, 'setup_rescue_file').mockReturnValue('/virtual/rescue.csv');

        await expect(execute_depth_sol_fund([], funder, 0, 0)).rejects.toThrow('Min depth is 1, but 0 was provided');
        await expect(execute_depth_dist_token([], mint_meta, funder, -1, 0)).rejects.toThrow(
            'Min depth is 1, but -1 was provided'
        );
    });

    test('builds depth token instructions with bigint amounts, token program, signer progression, and order intact', async () => {
        const amount = token_amount('9007199254740993');
        spyOn(common, 'setup_rescue_file').mockReturnValue('/virtual/rescue.csv');
        spyOn(common, 'save_rescue_key').mockReturnValue(true);
        spyOn(common, 'get_wallets').mockResolvedValue([]);
        const intermediate = keypairs[3]!;
        spyOn(Keypair, 'generate').mockResolvedValue(intermediate);
        const funder_ata = new PublicKey(new Uint8Array(32).fill(30));
        const intermediate_ata = new PublicKey(new Uint8Array(32).fill(31));
        const receiver_ata = new PublicKey(new Uint8Array(32).fill(32));
        const atas = new Map([
            [funder.publicKey.toBase58(), funder_ata],
            [intermediate.publicKey.toBase58(), intermediate_ata],
            [wallets[1]!.keypair.publicKey.toBase58(), receiver_ata]
        ]);
        const ata = spyOn(trade, 'calc_ata').mockImplementation(async (owner) => atas.get(owner.toBase58())!);
        const send_bundle = spyOn(trade, 'retry_send_bundle').mockResolvedValue('bundle-signature');

        await execute_depth_dist_token([[wallets[1]!, amount]], mint_meta, funder, 1, 0.001);

        expect(ata.mock.calls).toEqual([
            [intermediate.publicKey, mint, token_program],
            [funder.publicKey, mint, token_program],
            [wallets[1]!.keypair.publicKey, mint, token_program],
            [intermediate.publicKey, mint, token_program]
        ]);
        const [instructions, signers, tip] = send_bundle.mock.calls[0]!;
        expect(signers).toEqual([[funder, intermediate]]);
        expect(tip).toBe(0.001);
        expect(instructions).toHaveLength(1);
        expect(instructions[0]).toHaveLength(5);
        const [create_intermediate, first_transfer, create_receiver, second_transfer, close_intermediate] =
            instructions[0]!;
        expect(create_intermediate!.keys.map(({ pubkey }) => pubkey)).toContainEqual(intermediate.publicKey);
        expect(create_receiver!.keys.map(({ pubkey }) => pubkey)).toContainEqual(wallets[1]!.keypair.publicKey);
        expect(
            [first_transfer!, second_transfer!].map((instruction) => ({
                program: instruction.programId,
                keys: instruction.keys.map(({ pubkey, isSigner }) => ({ pubkey, isSigner })),
                discriminator: instruction.data[0],
                amount: Buffer.from(instruction.data.subarray(1, 9)).readBigUInt64LE()
            }))
        ).toEqual([
            {
                program: token_program,
                keys: [
                    { pubkey: funder_ata, isSigner: false },
                    { pubkey: intermediate_ata, isSigner: false },
                    { pubkey: funder.publicKey, isSigner: true }
                ],
                discriminator: 3,
                amount: BigInt(amount.amount)
            },
            {
                program: token_program,
                keys: [
                    { pubkey: intermediate_ata, isSigner: false },
                    { pubkey: receiver_ata, isSigner: false },
                    { pubkey: intermediate.publicKey, isSigner: true }
                ],
                discriminator: 3,
                amount: BigInt(amount.amount)
            }
        ]);
        expect(close_intermediate!.programId).toEqual(token_program);
        expect(close_intermediate!.keys.map(({ pubkey, isSigner }) => ({ pubkey, isSigner }))).toEqual([
            { pubkey: intermediate_ata, isSigner: false },
            { pubkey: intermediate.publicKey, isSigner: true },
            { pubkey: intermediate.publicKey, isSigner: true }
        ]);
    });

    test('deducts one transaction fee and the bundle tip from a depth SOL transfer', async () => {
        spyOn(common, 'setup_rescue_file').mockReturnValue('/virtual/rescue.csv');
        spyOn(common, 'save_rescue_key').mockReturnValue(true);
        spyOn(common, 'get_wallets').mockResolvedValue([]);
        const intermediate = keypairs[3]!;
        spyOn(Keypair, 'generate').mockResolvedValue(intermediate);
        const send_bundle = spyOn(trade, 'retry_send_bundle').mockResolvedValue('bundle-signature');
        const amount = 1;
        const tip = 0.001;

        await execute_depth_sol_fund([[wallets[1]!, amount]], funder, 1, tip);

        const [instructions, signers] = send_bundle.mock.calls[0]!;
        expect(signers).toEqual([[funder, intermediate]]);
        const transfers = instructions[0]!.map((instruction) => SystemInstruction.decodeTransfer(instruction));
        expect(transfers.map(({ fromPubkey, toPubkey }) => ({ fromPubkey, toPubkey }))).toEqual([
            { fromPubkey: funder.publicKey, toPubkey: intermediate.publicKey },
            { fromPubkey: intermediate.publicKey, toPubkey: wallets[1]!.keypair.publicKey }
        ]);
        expect(transfers.map(({ lamports }) => lamports)).toEqual([
            BigInt(amount * LAMPORTS_PER_SOL - 2 * 5_000 - tip * LAMPORTS_PER_SOL),
            BigInt(amount * LAMPORTS_PER_SOL - 2 * 5_000 - tip * LAMPORTS_PER_SOL)
        ]);
    });
});
