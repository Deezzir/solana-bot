import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Keypair } from '@solana/web3.js';
import base58 from 'bs58';
import { parse } from 'csv-parse/sync';
import type { Wallet } from '../src/common/common';

const original_env = {
    HELIUS_API_KEY: process.env.HELIUS_API_KEY,
    PINATA_IPFS_JWT: process.env.PINATA_IPFS_JWT
};
process.env.HELIUS_API_KEY ||= 'unit-test';
process.env.PINATA_IPFS_JWT ||= 'unit-test';

const { check_reserve_exists, filter_wallets, get_reserve_wallet, get_wallet, get_wallets, save_rescue_key } =
    await import('../src/common/common');

const headers = 'name,private_key,is_reserve,public_key,created_at';
let temporary_directory: string;

beforeEach(() => {
    temporary_directory = mkdtempSync(join(tmpdir(), 'solana-bot-wallets-'));
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

async function deterministic_keypair(seed: number): Promise<Keypair> {
    return Keypair.fromSeed(new Uint8Array(32).fill(seed));
}

function csv_row(name: string, keypair: Keypair, is_reserve = false): string {
    return [name, base58.encode(keypair.secretKey), is_reserve, keypair.publicKey.toBase58(), '2026-01-01'].join(',');
}

function basic_wallet(id: number, is_reserve = false): Wallet {
    return {
        name: `wallet-${id}`,
        id,
        is_reserve,
        keypair: {} as Keypair
    };
}

describe('wallet CSV loading', () => {
    test('loads deterministic secret keys as Keypairs and places the reserve first with id zero', async () => {
        const first = await deterministic_keypair(1);
        const reserve = await deterministic_keypair(2);
        const last = await deterministic_keypair(3);
        const csv_path = join(temporary_directory, 'wallets.csv');
        writeFileSync(
            csv_path,
            [headers, csv_row('first', first), csv_row('reserve', reserve, true), csv_row('last', last), ''].join('\n')
        );

        const wallets = await get_wallets(csv_path);

        expect(wallets.map(({ name, id, is_reserve }) => ({ name, id, is_reserve }))).toEqual([
            { name: 'reserve', id: 0, is_reserve: true },
            { name: 'first', id: 1, is_reserve: false },
            { name: 'last', id: 2, is_reserve: false }
        ]);
        expect(wallets.every(({ keypair }) => keypair instanceof Keypair)).toBeTrue();
        expect(wallets[0]?.keypair.publicKey.toBase58()).toBe(reserve.publicKey.toBase58());
        expect(wallets[1]?.keypair.secretKey).toEqual(first.secretKey);
        expect(wallets[2]?.keypair.secretKey).toEqual(last.secretKey);
    });

    test('ignores comments and blank lines and trims wallet fields', async () => {
        const reserve = await deterministic_keypair(4);
        const regular = await deterministic_keypair(5);
        const csv_path = join(temporary_directory, 'formatted-wallets.csv');
        writeFileSync(
            csv_path,
            [
                headers,
                '# generated test wallets',
                '',
                `  regular  ,  ${base58.encode(regular.secretKey)}  , false , ${regular.publicKey.toBase58()} , 2026-01-01`,
                ` reserve , ${base58.encode(reserve.secretKey)} , true , ${reserve.publicKey.toBase58()} , 2026-01-01`,
                ''
            ].join('\n')
        );

        const wallets = await get_wallets(csv_path);

        expect(wallets.map(({ name, id }) => ({ name, id }))).toEqual([
            { name: 'reserve', id: 0 },
            { name: 'regular', id: 1 }
        ]);
    });

    test('reports the source path when the wallet CSV is malformed', async () => {
        const csv_path = join(temporary_directory, 'malformed.csv');
        writeFileSync(csv_path, `${headers}\n"unterminated`);

        await expect(get_wallets(csv_path)).rejects.toThrow(`Failed to process wallets in ${csv_path}:`);
    });

    test('reports the source path when a wallet secret key is malformed', async () => {
        const csv_path = join(temporary_directory, 'malformed-secret-key.csv');
        writeFileSync(csv_path, `${headers}\nwallet,not-a-secret-key,false,unused,2026-01-01\n`);

        await expect(get_wallets(csv_path)).rejects.toThrow(`Failed to process wallets in ${csv_path}:`);
    });

    test('reports the missing wallet CSV path', async () => {
        const csv_path = join(temporary_directory, 'missing.csv');

        await expect(get_wallets(csv_path)).rejects.toThrow(`Failed to process wallets in ${csv_path}:`);
    });
});

describe('wallet selection', () => {
    const wallets = [basic_wallet(0, true), basic_wallet(1), basic_wallet(2), basic_wallet(3)];

    test('selects an id list in wallet order or a half-open slice when no list is supplied', () => {
        expect(filter_wallets(wallets, 1, 3).map(({ id }) => id)).toEqual([1, 2]);
        expect(filter_wallets(wallets, 0, 1, [3, 1]).map(({ id }) => id)).toEqual([1, 3]);
        expect(filter_wallets(wallets, undefined, undefined, []).map(({ id }) => id)).toEqual([]);
    });

    test('detects exactly one reserve and returns the first reserve wallet', () => {
        expect(check_reserve_exists(wallets)).toBeTrue();
        expect(get_reserve_wallet(wallets)).toBe(wallets[0]);
        expect(check_reserve_exists(wallets.slice(1))).toBeFalse();
        expect(get_reserve_wallet(wallets.slice(1))).toBeUndefined();
        expect(check_reserve_exists([wallets[0]!, basic_wallet(4, true)])).toBeFalse();
    });

    test('looks up wallets by id and returns undefined for an absent id', () => {
        expect(get_wallet(2, wallets)).toBe(wallets[2]);
        expect(get_wallet(99, wallets)).toBeUndefined();
    });
});

describe('rescue CSV writing', () => {
    test('appends two independently parseable rows containing their generated key data', async () => {
        const first = await deterministic_keypair(6);
        const second = await deterministic_keypair(7);
        const csv_path = join(temporary_directory, 'rescue.csv');
        writeFileSync(csv_path, `${headers}\n`);

        expect(save_rescue_key(first, csv_path, 12, 3)).toBeTrue();
        expect(save_rescue_key(second, csv_path, 12, 4)).toBeTrue();

        const records = parse<Record<string, string>>(readFileSync(csv_path, 'utf8'), {
            columns: true,
            skip_empty_lines: true
        });
        expect(records).toHaveLength(2);
        expect(
            records.map(({ name, private_key, is_reserve, public_key }) => ({
                name,
                private_key,
                is_reserve,
                public_key
            }))
        ).toEqual([
            {
                name: 'wallet12_3',
                private_key: base58.encode(first.secretKey),
                is_reserve: 'false',
                public_key: first.publicKey.toBase58()
            },
            {
                name: 'wallet12_4',
                private_key: base58.encode(second.secretKey),
                is_reserve: 'false',
                public_key: second.publicKey.toBase58()
            }
        ]);
        expect(records.every(({ created_at }) => created_at.length > 0)).toBeTrue();
    });

    test('rejects a missing rescue CSV without creating it', async () => {
        const keypair = await deterministic_keypair(7);
        const csv_path = join(temporary_directory, 'missing-rescue.csv');

        expect(() => save_rescue_key(keypair, csv_path, 1, 1)).toThrow(`Rescue file does not exist: ${csv_path}`);
    });
});
