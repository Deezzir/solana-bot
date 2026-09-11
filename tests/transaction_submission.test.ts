import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import {
    ComputeBudgetProgram,
    Keypair,
    PublicKey,
    SendTransactionError,
    SystemProgram,
    VersionedTransaction,
    type Connection
} from '@solana/web3.js';
import bs58 from 'bs58';

const original_env = { HELIUS_API_KEY: process.env.HELIUS_API_KEY, PINATA_IPFS_JWT: process.env.PINATA_IPFS_JWT };
for (const name of Object.keys(original_env)) process.env[name] ||= 'unit-test';
const trade = await import('../src/common/trade_common');
const common = await import('../src/common/common');
const rate_limit = await import('../src/common/rate_limit');
const { TransactionRelay, PriorityLevel, SOL_MINT, COMPUTE_UNIT_BUFFER, MAX_COMPUTE_UNIT_LIMIT } =
    await import('../src/constants');
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = await import('../src/common/token');

type RelayRequest = { url: string; method: string; params: unknown[] };
const original_connection = global.CONNECTION;
const original_fetch = global.fetch;
const original_priority = global.PRIORITY_FEE;
const original_relay = global.TRANSACTION_RELAY;
const original_version = global.TRANSACTION_VERSION;
const payer = await Keypair.fromSeed(new Uint8Array(32).fill(90));
const recipient = await Keypair.fromSeed(new Uint8Array(32).fill(91));
const transfer = SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: recipient.publicKey, lamports: 123n });
const ctx = { context: { slot: 100n }, value: { blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 200n } };

function signature(transaction: VersionedTransaction): string {
    return bs58.encode(transaction.signatures[0]!);
}

function rpc() {
    const sent: VersionedTransaction[] = [];
    const methods = {
        getLatestBlockhashAndContext: mock(async () => ctx),
        simulateTransaction: mock(async () => ({
            context: { slot: 100n },
            value: { err: null as unknown, unitsConsumed: 10_000n, loadedAccountsDataSize: 8_000n }
        })),
        sendRawTransaction: mock(async (bytes: Uint8Array, _options?: unknown) => {
            const transaction = VersionedTransaction.deserialize(bytes);
            sent.push(transaction);
            return signature(transaction);
        }),
        getSignatureStatus: mock(async (_signature: string) => ({
            context: { slot: 100n },
            value: { confirmationStatus: 'confirmed' as string, err: null } as {
                confirmationStatus: string;
                err: unknown;
            } | null
        })),
        getTransaction: mock(async (_signature: string, _options?: unknown) => ({
            meta: { err: null as unknown, logMessages: [] as string[] }
        })),
        getBlockHeight: mock(async () => 150n)
    };
    global.CONNECTION = methods as unknown as Connection;
    return { ...methods, sent };
}

function relay(response?: (request: RelayRequest) => Response | Promise<Response>) {
    const requests: RelayRequest[] = [];
    const transactions: VersionedTransaction[][] = [];
    global.fetch = (async (url: unknown, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string);
        const request = { url: String(url), method: body.method as string, params: body.params as unknown[] };
        requests.push(request);
        if (response) return response(request);
        if (request.method === 'getInflightBundleStatuses')
            return Response.json({ result: { value: [{ bundle_id: 'bundle-id', status: 'Landed' }] } });
        const encoded =
            request.method === 'sendBundle' ? (request.params[0] as string[]) : [request.params[0] as string];
        const batch = encoded.map((value) => VersionedTransaction.deserialize(Buffer.from(value, 'base64')));
        transactions.push(batch);
        return Response.json({ result: request.method === 'sendBundle' ? 'bundle-id' : signature(batch[0]!) });
    }) as typeof fetch;
    return { requests, transactions };
}

beforeEach(() => {
    global.PRIORITY_FEE = 1_000;
    global.TRANSACTION_RELAY = TransactionRelay.Jito;
    global.TRANSACTION_VERSION = 0;
    spyOn(common, 'sleep').mockResolvedValue(undefined);
    spyOn(rate_limit, 'rate_limit_request').mockImplementation((request) => request());
    global.fetch = mock(async () => {
        throw new Error('Unexpected HTTP request');
    }) as unknown as typeof fetch;
});

afterEach(() => {
    mock.restore();
    global.fetch = original_fetch;
    global.PRIORITY_FEE = original_priority;
    global.TRANSACTION_RELAY = original_relay;
    global.TRANSACTION_VERSION = original_version;
    if (original_connection === undefined) delete (global as { CONNECTION?: Connection }).CONNECTION;
    else global.CONNECTION = original_connection;
});
afterAll(() => {
    for (const [name, value] of Object.entries(original_env)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
});

describe('transaction preparation and RPC submission', () => {
    test.each([0, 1] as const)('signs, submits and confirms transaction version %s', async (version) => {
        const connection = rpc();
        const result = await trade.send_tx(
            [transfer],
            [payer],
            undefined,
            undefined,
            false,
            undefined,
            undefined,
            version
        );
        const transaction = connection.sent[0]!;
        expect(transaction.message.version).toBe(version);
        expect(transaction.message.staticAccountKeys[0]).toEqual(payer.publicKey);
        expect(transaction.signatures[0]!.some((byte) => byte !== 0)).toBeTrue();
        expect(result).toBe(signature(transaction));
        expect(connection.sendRawTransaction.mock.calls[0]?.[1]).toMatchObject({
            skipPreflight: false,
            preflightCommitment: 'confirmed',
            minContextSlot: 100n
        });
        expect(connection.getTransaction).toHaveBeenCalledWith(result, {
            maxSupportedTransactionVersion: 1,
            commitment: 'confirmed'
        });
        expect(connection.simulateTransaction).toHaveBeenCalledTimes(1);
        if (transaction.message.version === 0) {
            const budget = transaction.message.compiledInstructions[0]!;
            expect(Buffer.from(budget.data).readUInt32LE(1)).toBe(Math.ceil(10_000 * COMPUTE_UNIT_BUFFER));
            expect(transaction.message.staticAccountKeys[budget.programIdIndex]).toEqual(
                ComputeBudgetProgram.programId
            );
        }
    });

    test('uses an explicit v0 compute limit without simulation', async () => {
        const connection = rpc();
        await trade.send_tx([transfer], [payer], undefined, undefined, false, undefined, 300_000);
        expect(connection.simulateTransaction).not.toHaveBeenCalled();
        expect(Buffer.from(connection.sent[0]!.message.compiledInstructions[0]!.data).readUInt32LE(1)).toBe(300_000);
    });

    test.each([0, 1] as const)('rejects simulation errors before submission for version %s', async (version) => {
        const connection = rpc();
        connection.simulateTransaction.mockResolvedValue({
            context: { slot: 100n },
            value: {
                err: { InstructionError: [0, 'InvalidArgument'] },
                unitsConsumed: 10_000n,
                loadedAccountsDataSize: 8_000n
            }
        });
        await expect(
            trade.send_tx([transfer], [payer], undefined, undefined, false, undefined, undefined, version)
        ).rejects.toThrow('Transaction simulation failed');
        expect(connection.sendRawTransaction).not.toHaveBeenCalled();
    });

    test('rejects a v1 compute limit below actual simulated consumption', async () => {
        const connection = rpc();
        await expect(
            trade.send_tx([transfer], [payer], undefined, undefined, false, undefined, 9_000, 1)
        ).rejects.toThrow('Invalid compute unit limit for the simulated transaction');
        expect(connection.sendRawTransaction).not.toHaveBeenCalled();
    });

    test('rejects caller-supplied compute budget instructions', async () => {
        const connection = rpc();
        await expect(
            trade.send_tx([ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }), transfer], [payer])
        ).rejects.toThrow('cannot include compute budget instructions');
        expect(connection.sendRawTransaction).not.toHaveBeenCalled();
    });

    test('requires a positive protection tip before reading a blockhash', async () => {
        const connection = rpc();
        await expect(trade.send_tx([transfer], [payer], undefined, undefined, true)).rejects.toThrow(
            'MEV protection requires'
        );
        expect(connection.getLatestBlockhashAndContext).not.toHaveBeenCalled();
    });

    test('treats a mismatched RPC signature as an unknown outcome', async () => {
        const connection = rpc();
        connection.sendRawTransaction.mockResolvedValue('wrong-signature');
        await expect(trade.send_tx([transfer], [payer])).rejects.toMatchObject({
            outcome: 'unknown',
            signatures: [expect.any(String)]
        });
        expect(connection.getSignatureStatus).not.toHaveBeenCalled();
    });
});

describe('relay submission and bundles', () => {
    test.each([TransactionRelay.Sender, TransactionRelay.Jito])(
        'submits signed transactions through %s and verifies the returned signature',
        async (provider) => {
            const connection = rpc();
            global.TRANSACTION_RELAY = provider;
            const network = relay();
            const result = await trade.send_tx([transfer], [payer], undefined, 0.001, true);
            expect(result).toBe(signature(network.transactions[0]![0]!));
            expect(network.requests.every((request) => request.method === 'sendTransaction')).toBeTrue();
            if (provider === TransactionRelay.Sender) {
                expect(new URL(network.requests[0]!.url).searchParams.get('mev-protect')).toBe('true');
                expect(network.requests[0]!.params[1]).toEqual({
                    encoding: 'base64',
                    skipPreflight: true,
                    maxRetries: 0
                });
            }
            expect(connection.sendRawTransaction).not.toHaveBeenCalled();
            expect(connection.getSignatureStatus).toHaveBeenCalledWith(result);
        }
    );

    test.each([TransactionRelay.Sender, TransactionRelay.Jito])(
        'places a bundle tip on the last transaction only through %s',
        async (provider) => {
            const connection = rpc();
            global.TRANSACTION_RELAY = provider;
            const network = relay();
            const second = SystemProgram.transfer({
                fromPubkey: recipient.publicKey,
                toPubkey: payer.publicKey,
                lamports: 456n
            });
            const result = await trade.send_bundle([[transfer], [second]], [[payer], [recipient]], 0.001);
            const batch = network.transactions[0]!;
            expect(batch).toHaveLength(2);
            expect(batch[0]!.message.staticAccountKeys[0]).toEqual(payer.publicKey);
            expect(batch[1]!.message.staticAccountKeys[0]).toEqual(recipient.publicKey);
            expect(batch[0]!.message.recentBlockhash).toBe(batch[1]!.message.recentBlockhash);
            const transfers = batch.map((tx) =>
                tx.message.compiledInstructions.filter((ix) =>
                    tx.message.staticAccountKeys[ix.programIdIndex]!.equals(SystemProgram.programId)
                )
            );
            expect(transfers.map((instructions) => instructions.length)).toEqual([1, 2]);
            expect(Buffer.from(transfers[1]![1]!.data).readBigUInt64LE(4)).toBe(1_000_000n);
            expect(connection.getLatestBlockhashAndContext).toHaveBeenCalledTimes(1);
            expect(connection.simulateTransaction).not.toHaveBeenCalled();
            expect(result).toBe(provider === TransactionRelay.Jito ? 'bundle-id' : signature(batch[1]!));
        }
    );

    test('configures a v1 bundle without independently simulating dependent legs', async () => {
        const connection = rpc();
        const network = relay();
        await trade.send_bundle([[transfer]], [[payer]], 0.001, undefined, undefined, MAX_COMPUTE_UNIT_LIMIT, 1);
        expect(network.transactions[0]![0]!.message.version).toBe(1);
        expect(connection.simulateTransaction).not.toHaveBeenCalled();
    });

    test('rejects empty, oversized and signer-misaligned bundles before network requests', async () => {
        const connection = rpc();
        const count = trade.get_bundle_size() + 1;
        await expect(trade.send_bundle([], [], 0.001)).rejects.toThrow('Bundle size');
        await expect(
            trade.send_bundle(
                Array.from({ length: count }, () => [transfer]),
                Array.from({ length: count }, () => [payer]),
                0.001
            )
        ).rejects.toThrow('Bundle size');
        await expect(trade.send_bundle([[transfer]], [], 0.001)).rejects.toThrow('length mismatch');
        expect(connection.getLatestBlockhashAndContext).not.toHaveBeenCalled();
    });

    test('treats a mismatched relay signature as an unknown outcome', async () => {
        const connection = rpc();
        relay(() => Response.json({ result: 'wrong-signature' }));
        await expect(trade.send_tx([transfer], [payer], undefined, 0.001)).rejects.toMatchObject({
            outcome: 'unknown'
        });
        expect(connection.getSignatureStatus).not.toHaveBeenCalled();
    });
});

describe('confirmation and retry outcomes', () => {
    test('waits through processed status and accepts finalized confirmation', async () => {
        const connection = rpc();
        connection.getSignatureStatus
            .mockResolvedValueOnce({ context: { slot: 100n }, value: { confirmationStatus: 'processed', err: null } })
            .mockResolvedValueOnce({ context: { slot: 100n }, value: { confirmationStatus: 'finalized', err: null } });
        await trade.send_tx([transfer], [payer]);
        expect(connection.getSignatureStatus).toHaveBeenCalledTimes(2);
        expect(common.sleep).toHaveBeenCalledWith(1000);
        expect(connection.getTransaction).toHaveBeenCalledTimes(1);
    });

    test('reports a confirmed on-chain failure with its Anchor log', async () => {
        const connection = rpc();
        connection.getTransaction.mockResolvedValue({
            meta: {
                err: { InstructionError: [0, { Custom: 6001 }] },
                logMessages: ['Program log: AnchorError: slippage exceeded']
            }
        });
        await expect(trade.send_tx([transfer], [payer])).rejects.toMatchObject({
            outcome: 'failed',
            message: expect.stringContaining('AnchorError: slippage exceeded')
        });
    });

    test('does not retry a transport error with an unknown submission outcome', async () => {
        const connection = rpc();
        connection.sendRawTransaction.mockRejectedValue(new Error('connection reset after send'));
        await expect(
            trade.retry_send_tx([transfer], [payer], undefined, undefined, false, undefined, undefined, 3)
        ).rejects.toMatchObject({ outcome: 'unknown' });
        expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
        expect(common.sleep).not.toHaveBeenCalled();
    });

    test.each(['preflight rejected', 'already processed'])(
        'classifies RPC send errors correctly: %s',
        async (message) => {
            const connection = rpc();
            connection.sendRawTransaction.mockRejectedValue(
                new SendTransactionError({ action: 'send', signature: '', transactionMessage: message, logs: [] })
            );
            const unknown = message === 'already processed';
            await expect(
                trade.retry_send_tx([transfer], [payer], undefined, undefined, false, undefined, undefined, 2)
            ).rejects.toMatchObject({ outcome: unknown ? 'unknown' : 'rejected' });
            expect(connection.sendRawTransaction).toHaveBeenCalledTimes(unknown ? 1 : 2);
        }
    );

    test('retries a known on-chain failure and returns the succeeding attempt', async () => {
        const connection = rpc();
        connection.getTransaction.mockResolvedValueOnce({
            meta: { err: 'InstructionError', logMessages: ['Program failed: slippage'] }
        });
        const result = await trade.retry_send_tx(
            [transfer],
            [payer],
            undefined,
            undefined,
            false,
            undefined,
            undefined,
            2
        );
        expect(result).toBe(signature(connection.sent[1]!));
        expect(connection.sendRawTransaction).toHaveBeenCalledTimes(2);
        expect(common.sleep).toHaveBeenCalledTimes(1);
    });

    test('stops after blockhash expiry rather than blindly resubmitting', async () => {
        const connection = rpc();
        connection.getSignatureStatus.mockResolvedValue({ context: { slot: 100n }, value: null });
        connection.getBlockHeight.mockResolvedValue(201n);
        await expect(trade.retry_send_tx([transfer], [payer])).rejects.toMatchObject({
            outcome: 'unknown',
            message: expect.stringContaining('Blockhash has expired')
        });
        expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
    });

    test.each(['rejected', 'unknown'] as const)('bundle retry policy preserves %s relay outcomes', async (outcome) => {
        const connection = rpc();
        relay(() =>
            outcome === 'rejected'
                ? Response.json({ error: { message: 'bundle rejected' } })
                : Response.json({}, { status: 503 })
        );
        await expect(
            trade.retry_send_bundle([[transfer]], [[payer]], 0.001, undefined, undefined, undefined, 2)
        ).rejects.toMatchObject({ outcome, signatures: [expect.any(String)] });
        expect(connection.getLatestBlockhashAndContext).toHaveBeenCalledTimes(outcome === 'rejected' ? 2 : 1);
    });

    test('reports a failed Jito bundle while signature confirmation is unavailable', async () => {
        const connection = rpc();
        connection.getSignatureStatus.mockResolvedValue({ context: { slot: 100n }, value: null });
        relay((request) =>
            Response.json({
                result:
                    request.method === 'sendBundle'
                        ? 'bundle-id'
                        : { value: [{ bundle_id: 'bundle-id', status: 'Failed' }] }
            })
        );
        await expect(trade.send_bundle([[transfer]], [[payer]], 0.001)).rejects.toMatchObject({
            outcome: 'failed',
            message: expect.stringContaining('bundle-id failed')
        });
    });
});

describe('SOL and token transfer submission', () => {
    test.each([0, 1] as const)(
        'deducts signature and priority fees from the SOL spend cap for v%s',
        async (version) => {
            const connection = rpc();
            global.TRANSACTION_VERSION = version;
            global.fetch = mock(async () =>
                Response.json({ result: { priorityFeeEstimate: 1000 } })
            ) as unknown as typeof fetch;
            await trade.send_lamports(1_000_000n, payer, recipient.publicKey, PriorityLevel.HIGH);
            const transaction = connection.sent[0]!;
            const instruction = transaction.message.compiledInstructions.find((ix) =>
                transaction.message.staticAccountKeys[ix.programIdIndex]!.equals(SystemProgram.programId)
            )!;
            const priority_fee = BigInt(Math.ceil((1000 * Math.ceil(10_000 * COMPUTE_UNIT_BUFFER)) / 1_000_000));
            expect(Buffer.from(instruction.data).readBigUInt64LE(4)).toBe(1_000_000n - 5000n - priority_fee);
            expect(transaction.message.staticAccountKeys[instruction.accountKeyIndexes[1]!]).toEqual(
                recipient.publicKey
            );
        }
    );

    test('preserves the exact transfer amount when no spend-cap priority option is supplied', async () => {
        const connection = rpc();
        await trade.send_lamports(123456789n, payer, recipient.publicKey);
        expect(Buffer.from(connection.sent[0]!.message.compiledInstructions[0]!.data).readBigUInt64LE(4)).toBe(
            123456789n
        );
        expect(connection.simulateTransaction).not.toHaveBeenCalled();
    });

    test('reduces a rejected transfer retry to the sender remaining balance', async () => {
        const connection = rpc();
        Object.assign(global.CONNECTION, { getBalance: mock(async () => 50_000n) });
        connection.sendRawTransaction.mockRejectedValueOnce(
            new SendTransactionError({
                action: 'send',
                signature: '',
                transactionMessage: 'insufficient funds',
                logs: []
            })
        );
        await trade.retry_send_lamports(100_000n, payer, recipient.publicKey, undefined, 2);
        expect(connection.sendRawTransaction).toHaveBeenCalledTimes(2);
        expect(Buffer.from(connection.sent[0]!.message.compiledInstructions[0]!.data).readBigUInt64LE(4)).toBe(50_000n);
    });

    test.each([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID])(
        'uses correct ATAs and exact raw token amount under %s',
        async (program) => {
            const connection = rpc();
            const raw = 9_007_199_254_740_993n;
            await trade.send_tokens(
                { amount: raw.toString(), decimals: 6, uiAmount: Number(raw) / 1e6 },
                recipient.publicKey,
                payer,
                recipient.publicKey,
                undefined,
                program
            );
            const tx = connection.sent[0]!;
            const instruction = tx.message.compiledInstructions.find((ix) =>
                tx.message.staticAccountKeys[ix.programIdIndex]!.equals(program)
            )!;
            expect(Buffer.from(instruction.data).readBigUInt64LE(1)).toBe(raw);
            expect(tx.message.staticAccountKeys[instruction.accountKeyIndexes[0]!]).toEqual(
                await trade.calc_ata(payer.publicKey, recipient.publicKey, program)
            );
            expect(tx.message.staticAccountKeys[instruction.accountKeyIndexes[1]!]).toEqual(
                await trade.calc_ata(recipient.publicKey, recipient.publicKey, program)
            );
        }
    );
});

describe('token account cleanup', () => {
    function setup(entries: { mint?: PublicKey; amount: bigint; program: PublicKey }[], balance = 1_000_000n) {
        const connection = rpc();
        const accounts = entries.map((entry, index) => {
            const data = Buffer.alloc(165);
            Buffer.from((entry.mint ?? recipient.publicKey).toBytes()).copy(data, 0);
            Buffer.from(payer.publicKey.toBytes()).copy(data, 32);
            data.writeBigUInt64LE(entry.amount, 64);
            data[108] = 1;
            return {
                pubkey: new PublicKey(new Uint8Array(32).fill(120 + index)),
                account: { data, owner: entry.program },
                program: entry.program
            };
        });
        Object.assign(global.CONNECTION, {
            getBalance: mock(async () => balance),
            getTokenAccountsByOwner: mock(async (_owner: PublicKey, { programId }: { programId: PublicKey }) => ({
                value: accounts.filter((entry) => entry.program.equals(programId))
            }))
        });
        spyOn(trade, 'get_token_supply').mockResolvedValue({ supply: 1000000n, decimals: 6 });
        return { connection, accounts };
    }

    test('closes empty and wrapped SOL accounts while reporting unsold tokens', async () => {
        const { connection, accounts } = setup([
            { amount: 0n, program: TOKEN_PROGRAM_ID },
            { amount: 0n, program: TOKEN_2022_PROGRAM_ID },
            { amount: 10n, mint: SOL_MINT, program: TOKEN_PROGRAM_ID },
            { amount: 55n, program: TOKEN_PROGRAM_ID }
        ]);
        const result = await trade.close_accounts(payer);
        expect(result).toMatchObject({
            closed_cnt: 3,
            failed_cnt: 0,
            unsold_mints: [{ mint: recipient.publicKey, amount: 55n, decimals: 6 }]
        });
        const tx = connection.sent[0]!;
        const closes = tx.message.compiledInstructions.filter((ix) => ix.data[0] === 9);
        expect(closes).toHaveLength(3);
        expect(closes.map((ix) => tx.message.staticAccountKeys[ix.accountKeyIndexes[0]!])).toEqual([
            accounts[0]!.pubkey,
            accounts[2]!.pubkey,
            accounts[1]!.pubkey
        ]);
    });

    test('burns explicitly requested Token-2022 balances before closing', async () => {
        const { connection } = setup([{ amount: 55n, program: TOKEN_2022_PROGRAM_ID }]);
        const result = await trade.close_accounts(payer, true);
        expect(result).toMatchObject({ closed_cnt: 1, failed_cnt: 0, unsold_mints: [] });
        const tx = connection.sent[0]!;
        const instructions = tx.message.compiledInstructions.filter((ix) =>
            tx.message.staticAccountKeys[ix.programIdIndex]!.equals(TOKEN_2022_PROGRAM_ID)
        );
        expect(instructions.map((ix) => ix.data[0])).toEqual([8, 9]);
        expect(Buffer.from(instructions[0]!.data).readBigUInt64LE(1)).toBe(55n);
    });

    test('reports unfunded cleanup without attempting submission', async () => {
        const { connection } = setup([{ amount: 0n, program: TOKEN_PROGRAM_ID }], 0n);
        expect(await trade.close_accounts(payer)).toMatchObject({
            closed_cnt: 0,
            failed_cnt: 1,
            failures: [{ count: 1, attempts: 0, error: 'No SOL balance' }]
        });
        expect(connection.sendRawTransaction).not.toHaveBeenCalled();
    });

    test('splits a batch after an instruction simulation failure and closes valid sub-batches', async () => {
        const { connection } = setup([
            { amount: 0n, program: TOKEN_PROGRAM_ID },
            { amount: 0n, program: TOKEN_PROGRAM_ID }
        ]);
        connection.simulateTransaction.mockResolvedValueOnce({
            context: { slot: 100n },
            value: {
                err: { InstructionError: [2, 'InvalidAccountData'] },
                unitsConsumed: 10_000n,
                loadedAccountsDataSize: 8_000n
            }
        });
        const result = await trade.close_accounts(payer);
        expect(result).toMatchObject({ closed_cnt: 2, failed_cnt: 0 });
        expect(result.closed.map((item) => item.count)).toEqual([1, 1]);
        expect(connection.sendRawTransaction).toHaveBeenCalledTimes(2);
    });

    test('does not retry an uncertain cleanup submission', async () => {
        const { connection } = setup([{ amount: 0n, program: TOKEN_PROGRAM_ID }]);
        connection.sendRawTransaction.mockRejectedValue(new Error('timeout'));
        const result = await trade.close_accounts(payer);
        expect(result).toMatchObject({ closed_cnt: 0, failed_cnt: 1 });
        expect(result.failures[0]!.attempts).toBe(1);
        expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
    });
});
