import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { clearLine, cursorTo } from 'readline';
import { Keypair, PublicKey } from '@solana/web3.js';
import { createInterface } from 'readline';
import { parse } from 'csv-parse/sync';
import { IPFS, IPFS_API, IPFS_JWT, PUMP_API_URL, WALLETS_FILE_HEADERS, WALLETS_RESCUE_DIR_PATH } from '../constants';
import base58 from 'bs58';
import path, { basename } from 'path';

type IPFSResponse = {
    id: string;
    name: string;
    cid: string;
    created_at: string;
    size: number;
    number_of_files: number;
    mime_type: string;
    user_id: string;
    group_id: string;
    is_duplicate: boolean;
};

export type Wallet = {
    name: string;
    keypair: Keypair;
    id: number;
    is_reserve: boolean;
};

export type IPFSMetadata = {
    name: string;
    symbol: string;
    description: string;
    image: string | undefined;
    showName: boolean | undefined;
    createdOn: string | undefined;
    twitter: string | undefined;
    telegram: string | undefined;
    website: string | undefined;
};

export enum Program {
    Pump = 'pump',
    Moonit = 'moonit',
    Meteora = 'meteora',
    Bonk = 'bonk',
    Generic = 'generic'
}

export function bold(message: string): string {
    if (global.NO_COLORS) return message;
    const boldStart = '\x1b[1m';
    const boldEnd = '\x1b[0m';
    return `${boldStart}${message}${boldEnd}`;
}

export function red(message: string) {
    if (global.NO_COLORS) return message;
    return `\x1b[31m${message}\x1b[0m`;
}

export function green(message: string) {
    if (global.NO_COLORS) return message;
    return `\x1b[32m${message}\x1b[0m`;
}

export function yellow(message: string) {
    if (global.NO_COLORS) return message;
    return `\x1b[33m${message}\x1b[0m`;
}

export function blue(message: string) {
    if (global.NO_COLORS) return message;
    return `\x1b[34m${message}\x1b[0m`;
}

export function format_currency(value: number): string {
    return value.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function log(message: string): void {
    clearLine(process.stdout, 0);
    cursorTo(process.stdout, 0);
    console.log(message);
    if (global.RL !== undefined) global.RL.prompt(true);
}

export function error(message: string): void {
    clearLine(process.stdout, 0);
    cursorTo(process.stdout, 0);
    console.error(message);
    if (global.RL !== undefined) global.RL.prompt(true);
}

export function check_reserve_exists(keys: Wallet[]): boolean {
    const reserveCount = keys.filter((wallet) => wallet.is_reserve).length;
    return reserveCount === 1;
}

export function get_reserve_wallet(keys: Wallet[]): Wallet | undefined {
    return keys.find((wallet) => wallet.is_reserve);
}

export function filter_wallets(wallet: Wallet[], from?: number, to?: number, list?: number[]): Wallet[] {
    return list ? wallet.filter((wallet) => list.includes(wallet.id)) : wallet.slice(from, to);
}

export async function to_confirm(message: string) {
    const rl = createInterface({
        input: process.stdin,
        output: process.stdout
    });

    await new Promise<void>((resolve) => rl.question(green(message), () => resolve()));

    rl.close();
}

export function setup_rescue_file(): string {
    const file_name = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '').replace(' ', '_');
    const target_file = `${file_name}.csv`;
    const target_file_path = path.join(WALLETS_RESCUE_DIR_PATH, target_file);

    try {
        if (!existsSync(WALLETS_RESCUE_DIR_PATH)) mkdirSync(WALLETS_RESCUE_DIR_PATH);
        try {
            if (existsSync(target_file_path)) throw 'Target already exists';
            writeFileSync(target_file_path, WALLETS_FILE_HEADERS.join(',') + '\n', 'utf-8');
            return target_file_path;
        } catch (err) {
            throw new Error(`Failed to create '${target_file_path}': ${err}`);
        }
    } catch (err) {
        throw new Error(`Failed to create '${WALLETS_RESCUE_DIR_PATH}': ${err}`);
    }
}

export function save_rescue_key(keypair: Keypair, target_file_path: string, prefix: number, index: number): boolean {
    const key_name = `wallet${prefix}_${index}`;
    const private_key = base58.encode(keypair.secretKey);
    const public_key = keypair.publicKey.toString();
    const date = new Date().toLocaleDateString();

    if (existsSync(target_file_path)) {
        try {
            const row = [key_name, private_key, false, public_key, date].join(',');
            appendFileSync(target_file_path, row + '\n', 'utf8');
            return true;
        } catch (err) {
            error(red(`Failed to write a wallet to a rescue file: ${err}`));
        }
    }
    return false;
}

export function get_wallets(keys_csv_path: string): Wallet[] {
    const rows: Wallet[] = [];
    let index = 1;
    let reserve_found = false;
    try {
        const content = readFileSync(keys_csv_path);
        const records = parse(content, {
            delimiter: ',',
            trim: true,
            comment: '#',
            columns: WALLETS_FILE_HEADERS,
            skip_empty_lines: true,
            from_line: 2
        });

        records.forEach((record: any) => {
            const is_reserve = record.is_reserve === 'true';
            const entry = {
                name: record.name,
                id: is_reserve && !reserve_found ? 0 : index++,
                keypair: Keypair.fromSecretKey(base58.decode(record.private_key)),
                is_reserve: is_reserve
            };
            if (is_reserve) reserve_found = true;
            if (is_reserve) rows.unshift(entry);
            else rows.push(entry);
        });
        return rows;
    } catch (error) {
        throw new Error(`Failed to process wallets in ${keys_csv_path}: ${error}`);
    }
}

export function get_wallet(index: number, wallets: Wallet[]): Wallet | undefined {
    return wallets.find((wallet) => wallet.id == index);
}

export function chunks<T>(array: readonly T[], chunk_size = 10): T[][] {
    let res: T[][] = [];
    for (let currentChunk = 0; currentChunk < array.length; currentChunk += chunk_size) {
        res.push(array.slice(currentChunk, currentChunk + chunk_size));
    }
    return res;
}

export async function clear_lines_up(lines: number): Promise<void> {
    process.stdout.moveCursor(0, -lines);
    process.stdout.clearScreenDown();
}

export function is_valid_pubkey(input: string): boolean {
    if (!/[a-zA-Z0-9]{43,44}/.test(input) && !/[a-zA-Z0-9]{32}/.test(input)) return false;
    try {
        new PublicKey(input);
        return true;
    } catch (err) {
        return false;
    }
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function validate_int(input: string, min: number = -Infinity, max: number = Infinity): boolean {
    const num = parseInt(input, 10);
    if (isNaN(num) || num < min || num > max) return false;
    return true;
}

export function validate_float(input: string, min: number = -Infinity, max: number = Infinity): boolean {
    const num = parseFloat(input);
    if (isNaN(num) || num <= min || num > max) return false;
    return true;
}

export function random_amounts(total_amount: number, count: number): number[] {
    const mean = total_amount / count;
    const std = mean * 0.51;
    let amounts = Array.from({ length: count }, () => normal_random(mean, std));
    const sum = amounts.reduce((acc, curr) => acc + curr, 0);
    amounts = amounts.map((amount) => (amount / sum) * total_amount);

    amounts = amounts.map((amount) => Math.max(0, amount));

    const adjusted_sum = amounts.reduce((acc, curr) => acc + curr, 0);
    const correction = total_amount - adjusted_sum;
    amounts[0] += correction;
    amounts = amounts.map((amount) => parseFloat(amount.toFixed(3)));

    return amounts;
}

function box_muller(): number {
    let u = 0,
        v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

export function normal_random(mean: number, std: number): number {
    return Math.abs(mean + box_muller() * std);
}

export function uniform_random(min: number, max: number): number {
    return Math.random() * (max - min) + min;
}

export function read_json(file_path: string): object {
    try {
        const content = readFileSync(file_path, 'utf8');
        return JSON.parse(content);
    } catch (err) {
        throw new Error(`Failed to read JSON file: ${err}`);
    }
}

export async function fetch_ipfs_json(cid: string): Promise<IPFSMetadata> {
    try {
        const response = await fetch(`${IPFS}${cid}`);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const data = await response.json();
        return data as IPFSMetadata;
    } catch (error) {
        throw new Error(`Failed to fetch IPFS JSON: ${error}`);
    }
}

export function setup_readline(): void {
    if (global.RL) return;
    global.RL = createInterface({
        input: process.stdin,
        output: process.stdout
    });
}

export function close_readline(): void {
    if (!global.RL) return;
    global.RL.prompt(false);
    global.RL.pause().removeAllListeners('line').removeAllListeners('close').close();
    cursorTo(process.stdout, 0);
    clearLine(process.stdout, 0);
}

export function round_two(num: number): number {
    return Math.round((num + Number.EPSILON) * 100) / 100;
}

export const fetch_sol_price = async (): Promise<number> => {
    return fetch(`${PUMP_API_URL}/sol-price`)
        .then((response) => response.json())
        .then((data) => {
            if (!data || data.statusCode !== undefined) return 0.0;
            return data.solPrice;
        })
        .catch((err) => {
            error(red(`Failed fetching the SOL price: ${err}`));
            return 0.0;
        });
};

export function read_bytes(buf: Buffer, offset: number, length: number): Buffer {
    const end = offset + length;
    if (buf.byteLength < end) throw new RangeError('range out of bounds');
    return buf.subarray(offset, end);
}

export function read_biguint_le(buf: Buffer, offset: number, length: number): bigint {
    switch (length) {
        case 1:
            return BigInt(buf.readUint8(offset));
        case 2:
            return BigInt(buf.readUint16LE(offset));
        case 4:
            return BigInt(buf.readUint32LE(offset));
        case 8:
            return buf.readBigUint64LE(offset);
        case 16:
            return BigInt(buf.readBigUInt64LE(offset) + (buf.readBigUInt64LE(offset + 8) << BigInt(64)));
    }
    throw new Error(`unsupported data size (${length} bytes)`);
}

export const COLUMN_WIDTHS = {
    id: 5,
    name: 12,
    symbol: 7,
    publicKey: 44,
    solBalance: 14,
    allocation: 10,
    tokenBalance: 20,
    parameter: 20,
    entryMcap: 10
};

const BORDER_CHARS = {
    topLeft: '╭',
    topRight: '╮',
    bottomLeft: '╰',
    bottomRight: '╯',
    horizontal: '─',
    vertical: '│',
    middle: '┼',
    topMiddle: '┬',
    bottomMiddle: '┴',
    horizontalLeft: '├',
    horizontalRight: '┤'
};

export function format_name(name: string): string {
    return name.length > COLUMN_WIDTHS.name ? name.slice(0, COLUMN_WIDTHS.name - 3) + '...' : name;
}

function format_column(content: string, width: number, align: 'left' | 'right' | 'center' = 'left'): string {
    if (align === 'left') {
        return content.padEnd(width, ' ');
    }
    if (align === 'right') {
        return content.padStart(width, ' ');
    }
    const padStart = Math.floor((width - content.length) / 2);
    return content.padStart(padStart + content.length, ' ').padEnd(width, ' ');
}

export function print_header(columns: { title: string; width: number; align?: 'left' | 'right' | 'center' }[]) {
    const top_border = columns.map((col) => BORDER_CHARS.horizontal.repeat(col.width + 2)).join(BORDER_CHARS.topMiddle);

    const header = columns
        .map((col) => ` ${format_column(col.title, col.width, col.align)} `)
        .join(`${BORDER_CHARS.vertical}`);

    const separator = columns.map((col) => BORDER_CHARS.horizontal.repeat(col.width + 2)).join(BORDER_CHARS.middle);

    log(`${BORDER_CHARS.topLeft}${top_border}${BORDER_CHARS.topRight}`);
    log(`${BORDER_CHARS.vertical}${header}${BORDER_CHARS.vertical}`);
    log(`${BORDER_CHARS.horizontalLeft}${separator}${BORDER_CHARS.horizontalRight}`);
}

export function print_row(columns: { content: string; width: number; align?: 'left' | 'right' | 'center' }[]) {
    const row = columns
        .map((col) => format_column(col.content, col.width, col.align))
        .join(` ${BORDER_CHARS.vertical} `);
    log(`${BORDER_CHARS.vertical} ${row} ${BORDER_CHARS.vertical}`);
}

export function print_footer(columns: { width: number }[]) {
    const bottomBorder = columns
        .map((col) => BORDER_CHARS.horizontal.repeat(col.width + 2))
        .join(BORDER_CHARS.bottomMiddle);
    log(`${BORDER_CHARS.bottomLeft}${bottomBorder}${BORDER_CHARS.bottomRight}`);
}

export async function retry_with_backoff<T>(operation: () => Promise<T>, retries = 5, delay_ms = 100): Promise<T> {
    try {
        await sleep(delay_ms);
        return await operation();
    } catch (error: any) {
        if (retries === 0 || !error.toString().includes('429')) {
            throw error;
        }
        return retry_with_backoff(operation, retries - 1, delay_ms * 3);
    }
}

export function zip<T, A>(arr_1: readonly T[], arr_2: readonly A[]): [T, A][] {
    if (arr_1.length !== arr_2.length) throw new Error('Array lengths do not match');
    return arr_1.map((e, i) => [e, arr_2[i]]) as [T, A][];
}

export function pick_random<T>(arr: readonly T[], count: number): T[] {
    const result: T[] = [];
    const used = new Set<number>();

    while (result.length < count && result.length < arr.length) {
        const idx = Math.floor(Math.random() * arr.length);
        if (!used.has(idx)) {
            used.add(idx);
            result.push(arr[idx]);
        }
    }
    return result;
}
export function read_pubkeys(address_file_path: string): PublicKey[] {
    const pubkeys: PublicKey[] = [];
    try {
        const content = readFileSync(address_file_path, 'utf-8');
        const lines = content.split('\n').filter((line) => line.trim() !== '');
        for (const line of lines) {
            const address = line.trim();
            if (is_valid_pubkey(address)) {
                pubkeys.push(new PublicKey(address));
            } else {
                error(red(`Invalid address: ${address} at line ${lines.indexOf(line) + 1}`));
            }
        }
    } catch (error) {
        throw new Error(`Failed to read addresses from ${address_file_path}: ${error}`);
    }
    return pubkeys;
}

async function upload_ipfs(file: File): Promise<IPFSResponse> {
    const form_data = new FormData();

    form_data.append('file', file);
    form_data.append('network', 'public');
    form_data.append('name', file.name);

    const request: RequestInit = {
        method: 'POST',
        headers: { Authorization: `Bearer ${IPFS_JWT}` },
        body: form_data
    };

    try {
        const response = await fetch(IPFS_API, request);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const data = await response.json();
        return data.data as IPFSResponse;
    } catch (error) {
        throw new Error(`Failed to upload to IPFS: ${error}`);
    }
}

export async function upload_metadata_ipfs(meta: IPFSMetadata, image_path: string) {
    try {
        const uuid = crypto.randomUUID();
        const image_file = new File([readFileSync(image_path)], `${uuid}-${basename(image_path)}`, {
            type: 'image/png'
        });
        const image_resp = await upload_ipfs(image_file);
        meta.image = `${IPFS}${image_resp.cid}`;

        const json = JSON.stringify(meta);
        const json_blob = new Blob([json]);
        const json_file = new File([json_blob], `${uuid}-metadataon`, { type: 'application/json' });
        const meta_resp = await upload_ipfs(json_file);
        return meta_resp.cid;
    } catch (error) {
        throw new Error(`Failed to create metadata: ${error}`);
    }
}
