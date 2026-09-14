import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Keypair, PublicKey } from '@solana/web3.js';
import type { MintAsset } from '../src/common/trade_common';

const original_env = {
    HELIUS_API_KEY: process.env.HELIUS_API_KEY,
    PINATA_IPFS_JWT: process.env.PINATA_IPFS_JWT
};
process.env.HELIUS_API_KEY ||= 'unit-test';
process.env.PINATA_IPFS_JWT ||= 'unit-test';

const { execute } = await import('../src/subcommands/token_drop');

let temporary_directory: string;

beforeEach(() => {
    temporary_directory = mkdtempSync(join(tmpdir(), 'solana-bot-token-drop-'));
});

afterEach(() => {
    rmSync(temporary_directory, { recursive: true, force: true });
});

afterAll(() => {
    for (const [name, value] of Object.entries(original_env)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
});

async function inert_arguments(): Promise<{ drop: Keypair; mint: MintAsset }> {
    const drop = await Keypair.fromSeed(new Uint8Array(32).fill(8));
    const mint = new PublicKey(new Uint8Array(32).fill(9));
    return {
        drop,
        mint: {
            token_name: 'Test Token',
            token_symbol: 'TEST',
            token_decimal: 6,
            token_supply: 1_000_000,
            price_per_token: 0,
            mint,
            token_program: new PublicKey(new Uint8Array(32).fill(10))
        }
    };
}

describe('token drop CSV public boundary', () => {
    test('rejects invalid percentage combinations before reading CSV files', async () => {
        const { drop, mint } = await inert_arguments();
        const cases = [
            { airdrop: -0.1, presale: 0, message: 'Percentages must be non-negative' },
            { airdrop: 0, presale: -0.1, message: 'Percentages must be non-negative' },
            { airdrop: 0, presale: 0, message: 'At least one percentage must be greater than 0' },
            { airdrop: 0.6, presale: 0.5, message: 'Combined percentages cannot exceed 100%' }
        ];

        for (const { airdrop, presale, message } of cases) {
            await expect(execute(drop, 1_000, mint, airdrop, presale, '', '')).rejects.toThrow(message);
        }
    });

    test('rejects nonpositive token balances before reading CSV files', async () => {
        const { drop, mint } = await inert_arguments();

        for (const balance of [0, -1]) {
            await expect(execute(drop, balance, mint, 0.1, 0, '', '')).rejects.toThrow(
                'Token balance must be greater than 0'
            );
        }
    });

    test('rejects malformed airdrop CSV before entering the drop flow', async () => {
        const { drop, mint } = await inert_arguments();
        const csv_path = join(temporary_directory, 'malformed-airdrop.csv');
        writeFileSync(csv_path, 'wallet,xUsername,xPostLink,tokensToSend,tx\n"unterminated');

        await expect(execute(drop, 1_000, mint, 0.1, 0, csv_path, '')).rejects.toThrow('Error parsing CSV file:');
    });

    test('reports a missing airdrop CSV path before entering the drop flow', async () => {
        const { drop, mint } = await inert_arguments();
        const csv_path = join(temporary_directory, 'missing-airdrop.csv');

        await expect(execute(drop, 1_000, mint, 0.1, 0, csv_path, '')).rejects.toThrow(csv_path);
    });
});
