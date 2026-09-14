import { mock } from 'bun:test';
import { readFileSync, writeFileSync } from 'fs';

const calls_file = process.env.SOLANA_BOT_CLI_CALLS_FILE;
const expected_command = process.env.SOLANA_BOT_CLI_EXPECTED_COMMAND;

if (!calls_file || !expected_command) {
    throw new Error('CLI command mock requires a calls file and an expected command.');
}
const calls_path = calls_file;
const expected = expected_command;

function normalize(value: unknown): unknown {
    if (value === undefined) return { type: 'undefined' };
    if (Array.isArray(value)) return value.map(normalize);
    if (!value || typeof value !== 'object') return value;

    const candidate = value as Record<string, any>;
    if (typeof candidate.toBase58 === 'function') {
        return { type: 'PublicKey', value: candidate.toBase58() };
    }
    if (candidate.keypair && typeof candidate.keypair.publicKey?.toBase58 === 'function') {
        return {
            type: 'Wallet',
            id: candidate.id,
            name: candidate.name,
            isReserve: candidate.is_reserve,
            publicKey: candidate.keypair.publicKey.toBase58()
        };
    }
    if (candidate.publicKey && typeof candidate.publicKey.toBase58 === 'function') {
        return { type: 'Keypair', publicKey: candidate.publicKey.toBase58() };
    }

    return Object.fromEntries(Object.entries(candidate).map(([key, entry]) => [key, normalize(entry)]));
}

async function record(command: string, args: unknown[]): Promise<void> {
    if (command !== expected) {
        throw new Error(`Unexpected command call: ${command}; expected ${expected}.`);
    }

    const calls = JSON.parse(readFileSync(calls_path, 'utf8')) as unknown[];
    calls.push({
        command,
        cwd: process.cwd(),
        args: normalize(args),
        globals: {
            program: global.PROGRAM,
            relay: global.TRANSACTION_RELAY,
            noColors: global.NO_COLORS,
            transactionVersion: global.TRANSACTION_VERSION
        }
    });
    writeFileSync(calls_path, JSON.stringify(calls));
}

const command_names = [
    'balance',
    'benchmark',
    'burn_token',
    'buy_token',
    'buy_token_once',
    'claim_fees',
    'clean',
    'close_ltas',
    'collect',
    'collect_token',
    'create_lta',
    'create_token',
    'create_token_metadata',
    'deactivate_ltas',
    'distribute_token',
    'drop',
    'extend_lta',
    'fund_sol',
    'generate',
    'get_sender_endpoint',
    'promote',
    'sell_token',
    'sell_token_once',
    'snipe',
    'start_volume',
    'token_balance',
    'transfer_sol',
    'transfer_token',
    'wallet_pnl',
    'warmup'
] as const;

mock.module('../src/commands', () =>
    Object.fromEntries(command_names.map((name) => [name, (...args: unknown[]) => record(name, args)]))
);
