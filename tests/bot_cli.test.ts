import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { Keypair } from '@solana/web3.js';
import base58 from 'bs58';

const project_root = resolve(import.meta.dir, '..');
const bot_path = join(project_root, 'src/bot.ts');
const preload_path = join(project_root, 'tests/cli_commands_preload.ts');
const mint = (await Keypair.fromSeed(new Uint8Array(32).fill(50))).publicKey.toBase58();
const subprocess_timeout_ms = 5_000;

type CliCall = {
    command: string;
    cwd: string;
    args: unknown[];
    globals: {
        program: string;
        relay: string;
        noColors: boolean;
        transactionVersion: number;
    };
};

type CliResult = {
    exitCode: number;
    stdout: string;
    stderr: string;
    calls: CliCall[];
};

let temporary_directory: string;
let wallets_path: string;

beforeEach(async () => {
    temporary_directory = mkdtempSync(join(tmpdir(), 'solana-bot-cli-'));
    wallets_path = join(temporary_directory, 'wallets.csv');
    const rows = ['name,private_key,is_reserve,public_key,created_at'];
    for (let index = 0; index < 4; index++) {
        const keypair = await Keypair.fromSeed(new Uint8Array(32).fill(index + 1));
        rows.push(
            [
                index === 0 ? 'reserve' : `wallet-${index}`,
                base58.encode(keypair.secretKey),
                index === 0 ? 'true' : 'false',
                keypair.publicKey.toBase58(),
                '2026-01-01'
            ].join(',')
        );
    }
    writeFileSync(wallets_path, `${rows.join('\n')}\n`);
});

afterEach(() => {
    rmSync(temporary_directory, { recursive: true, force: true });
});

async function run_cli(args: readonly string[], expected_command = 'none'): Promise<CliResult> {
    const calls_path = join(temporary_directory, `${crypto.randomUUID()}.json`);
    writeFileSync(calls_path, '[]');

    const child = Bun.spawn(
        [process.execPath, '--no-env-file', '--preload', preload_path, bot_path, '-k', wallets_path, ...args],
        {
            cwd: temporary_directory,
            env: {
                HOME: temporary_directory,
                PATH: process.env.PATH ?? '',
                HELIUS_API_KEY: 'cli-test',
                PINATA_IPFS_JWT: 'cli-test',
                RPC_REQUESTS_PER_SECOND: '50',
                NO_COLOR: '1',
                SOLANA_BOT_CLI_CALLS_FILE: calls_path,
                SOLANA_BOT_CLI_EXPECTED_COMMAND: expected_command
            },
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'pipe'
        }
    );

    let timed_out = false;
    const timeout = setTimeout(() => {
        timed_out = true;
        child.kill('SIGKILL');
    }, subprocess_timeout_ms);
    const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text()
    ]).finally(() => clearTimeout(timeout));

    if (timed_out) {
        throw new Error(`CLI subprocess timed out after ${subprocess_timeout_ms}ms: ${args.join(' ')}`);
    }

    return {
        exitCode,
        stdout,
        stderr,
        calls: JSON.parse(readFileSync(calls_path, 'utf8')) as CliCall[]
    };
}

function wallet_ids(call: CliCall): number[] {
    return (call.args[0] as Array<{ id: number }>).map(({ id }) => id);
}

describe('bot CLI subprocess boundary', () => {
    test('token-balance alias normalizes the multi-character format alias and forwards a typed mint', async () => {
        const result = await run_cli(['tb', mint, '-fm', 'csv'], 'token_balance');

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.calls).toHaveLength(1);
        expect(result.calls[0]).toMatchObject({
            command: 'token_balance',
            cwd: temporary_directory,
            args: [
                [
                    { type: 'Wallet', id: 0, name: 'reserve', isReserve: true },
                    { type: 'Wallet', id: 1, name: 'wallet-1', isReserve: false },
                    { type: 'Wallet', id: 2, name: 'wallet-2', isReserve: false },
                    { type: 'Wallet', id: 3, name: 'wallet-3', isReserve: false }
                ],
                { type: 'PublicKey', value: mint },
                'csv'
            ]
        });
    });

    test('buy-token forwards typed numeric, slippage, priority, tip, and global options through aliases', async () => {
        const result = await run_cli(
            [
                '-g',
                'meteora',
                '-rl',
                'jito',
                '-nc',
                'bt',
                mint,
                '-a',
                '1.25',
                '-s',
                '2.5',
                '-f',
                '1',
                '-t',
                '3',
                '-pt',
                '0.002',
                '-pr',
                'High'
            ],
            'buy_token'
        );

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.calls).toHaveLength(1);
        expect(wallet_ids(result.calls[0]!)).toEqual([1, 2]);
        expect(result.calls[0]).toEqual({
            command: 'buy_token',
            cwd: temporary_directory,
            args: [
                expect.any(Array),
                { type: 'PublicKey', value: mint },
                'High',
                0.002,
                false,
                { type: 'undefined' },
                1.25,
                { type: 'undefined' },
                { type: 'undefined' },
                0.025
            ],
            globals: {
                program: 'meteora',
                relay: 'jito',
                noColors: true,
                transactionVersion: 0
            }
        });
    });

    test('buy-token list selection is forwarded in wallet order', async () => {
        const result = await run_cli(['bt', mint, '-l', '3', '1'], 'buy_token');

        expect(result.exitCode).toBe(0);
        expect(result.calls).toHaveLength(1);
        expect(wallet_ids(result.calls[0]!)).toEqual([1, 3]);
    });

    test.each([
        {
            name: 'address',
            args: ['tb', 'not-an-address'],
            fragments: ['error: command-argument value', 'Not an address.', 'Use --help for additional information']
        },
        {
            name: 'number',
            args: ['bto', 'not-a-number', mint, '1'],
            fragments: ['error: command-argument value', 'Not a number.', 'Use --help for additional information']
        },
        {
            name: 'format',
            args: ['tb', mint, '-fm', 'json'],
            fragments: ['Invalid format.', 'csv', 'table', 'Use --help for additional information']
        }
    ])('reports invalid $name input with the help suffix without running a command', async ({ args, fragments }) => {
        const result = await run_cli(args);

        expect(result.exitCode).not.toBe(0);
        expect(result.calls).toEqual([]);
        for (const fragment of fragments) expect(result.stderr).toContain(fragment);
    });

    test('command help exposes stable usage, argument, and normalized option details without running a command', async () => {
        const result = await run_cli(['tb', '--help']);

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.calls).toEqual([]);
        expect(result.stdout).toContain('Usage:');
        expect(result.stdout).toContain('token-balance|tb');
        expect(result.stdout).toContain('<mint>');
        expect(result.stdout).toContain('-fm, --format <type>');
    });
});
