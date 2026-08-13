import { parse } from 'csv-parse/sync';
import { Keypair, PublicKey } from '@solana/web3.js';
import * as trade from '../common/trade_common';
import * as common from '../common/common';
import { DROP_RECORDS_PER_ITERATION } from '../constants';
import { readFileSync, writeFileSync } from 'fs';

type AirdropUser = {
    wallet: string;
    xUsername: string;
    xPostLink: string;
    tokensToSend: number;
    tx: string | null;
};

type PresaleUser = {
    wallet: string;
    solAmount: number;
    txEnroll: string[];
    tokensToSend: number;
    tx: string | null;
};

function read_csv<T>(file_path: string): T[] {
    const content = readFileSync(file_path, 'utf8');
    try {
        return parse(content, {
            columns: true,
            skip_empty_lines: true
        }) as T[];
    } catch (error) {
        throw new Error(`Error parsing CSV file: ${error}`);
    }
}

function write_csv<T extends Record<string, any>>(file_path: string, data: T[]): void {
    if (data.length === 0) {
        writeFileSync(file_path, '');
        return;
    }

    const headers = Object.keys(data[0]);
    const rows = [
        headers.join(','),
        ...data.map((row) =>
            headers
                .map((key) => {
                    const value = row[key];
                    if (value === null || value === undefined) return '';
                    const str = String(value).replace(/"/g, '""');
                    return `"${str}"`;
                })
                .join(',')
        )
    ];

    const content = rows.join('\n');
    writeFileSync(file_path, content);
}

function count_airdrop_records(airdrop_path: string): number {
    const records = read_csv<AirdropUser>(airdrop_path);
    return records.filter((r) => !r.tx).length;
}

function count_presale_records(presale_path: string): number {
    const records = read_csv<PresaleUser>(presale_path);
    return records.filter((r) => !r.tx && r.txEnroll?.length > 0).length;
}

function calc_airdrop_amount(airdrop_percent: number, total_tokens: number, record_count: number): number {
    return (airdrop_percent * total_tokens) / record_count;
}

function calc_presale_amounts(
    percent: number,
    total_tokens: number,
    presale_path: string
): { presale_tokens: number; presale_sol: number } {
    const records = read_csv<PresaleUser>(presale_path);
    const valid = records.filter((r) => !r.tx && r.txEnroll?.length > 0);
    const presale_tokens = percent * total_tokens;
    const presale_sol = common.round_two(valid.reduce((sum, r) => sum + Number(r.solAmount), 0));
    return { presale_tokens, presale_sol };
}

function update_airdrop_balance_csv(token_amount: number, airdrop_path: string): void {
    const records = read_csv<AirdropUser>(airdrop_path);
    for (const r of records) {
        if (!r.tx) r.tokensToSend = token_amount;
    }
    write_csv(airdrop_path, records);
}

function update_presale_balance_csv(token_amount: number, total_sol: number, presale_path: string): void {
    const records = read_csv<PresaleUser>(presale_path);
    for (const r of records) {
        if (!r.tx && r.txEnroll?.length > 0) {
            const portion = Number(r.solAmount) / total_sol;
            r.tokensToSend = token_amount * portion;
        }
    }
    write_csv(presale_path, records);
}

async function drop_tokens_csv<T extends AirdropUser | PresaleUser>(
    csv_file: string,
    drop: Keypair,
    mint_meta: trade.MintAsset
): Promise<void> {
    const records = read_csv<T>(csv_file);
    let pending = records.filter((r) => !r.tx).slice(0, DROP_RECORDS_PER_ITERATION);

    if (pending.length === 0) {
        common.error(common.yellow('No records to process'));
        return;
    }

    while (pending.length > 0) {
        common.log(common.yellow(`Processing ${pending.length} records...`));
        const promises = pending.map(async (record: any) => {
            try {
                const receiver = new PublicKey(record.wallet);
                const token_amount = trade.get_token_amount(record.tokensToSend, mint_meta.token_decimal);
                await trade
                    .send_tokens(token_amount, mint_meta.mint, drop, receiver, undefined, mint_meta.token_program)
                    .then((sig) => {
                        record.tx = sig;
                        common.log(common.green(`Sent ${record.tokensToSend} to ${receiver.toBase58()} | tx: ${sig}`));
                    });
            } catch (error: any) {
                common.error(common.red(`Failed to send tokens to ${record.wallet}: ${error.message}`));
                if (
                    error.message.includes('Provided owner is not allowed') ||
                    error.message.includes('Invalid public key')
                )
                    record.tx = error.message.includes('Invalid public key')
                        ? 'Invalid public key'
                        : 'Provided owner is not allowed';
            }
        });
        await Promise.allSettled(promises);

        write_csv<T>(csv_file, records);
        await common.sleep(500);
        pending = records.filter((r) => !r.tx).slice(0, DROP_RECORDS_PER_ITERATION);
    }
}

async function airdrop_csv(
    percent: number,
    balance: number,
    mint: trade.MintAsset,
    drop: Keypair,
    airdrop_path: string
): Promise<void> {
    const count = count_airdrop_records(airdrop_path);
    if (count === 0) {
        common.error(common.yellow('No airdrop records found.'));
        return;
    }

    const token_amount = calc_airdrop_amount(percent, balance, count);
    common.log(`\nAirdrop | Token amount: ${token_amount} | Records: ${count}`);
    await common.to_confirm('Press ENTER to start the airdrop...');

    update_airdrop_balance_csv(token_amount, airdrop_path);
    await drop_tokens_csv<AirdropUser>(airdrop_path, drop, mint);
    common.log(common.green('Airdrop completed.'));
}

async function presale_csv(
    percent: number,
    balance: number,
    mint: trade.MintAsset,
    drop: Keypair,
    presale_path: string
): Promise<void> {
    const count = count_presale_records(presale_path);
    if (count === 0) {
        common.error(common.yellow('No presale records found.'));
        return;
    }

    const { presale_tokens, presale_sol } = calc_presale_amounts(percent, balance, presale_path);
    common.log(`\nPresale | Token amount: ${presale_tokens} | Total SOL: ${presale_sol} | Records: ${count}`);
    await common.to_confirm('Press ENTER to start the presale drop...');

    update_presale_balance_csv(presale_tokens, presale_sol, presale_path);
    await drop_tokens_csv<PresaleUser>(presale_path, drop, mint);
    common.log(common.green('Presale drop completed.'));
}

export async function execute(
    drop: Keypair,
    token_balance: number,
    mint_meta: trade.MintAsset,
    airdrop_percent: number = 0,
    presale_percent: number = 0,
    airdrop_csv_file: string,
    presale_csv_file: string
): Promise<void> {
    if (airdrop_percent < 0 || presale_percent < 0) throw new Error('Percentages must be non-negative');
    if (airdrop_percent === 0 && presale_percent === 0)
        throw new Error('At least one percentage must be greater than 0');
    if (airdrop_percent + presale_percent > 1) throw new Error('Combined percentages cannot exceed 100%');
    if (token_balance <= 0) throw new Error('Token balance must be greater than 0');

    if (presale_percent > 0) await presale_csv(presale_percent, token_balance, mint_meta, drop, presale_csv_file);
    if (airdrop_percent > 0) await airdrop_csv(airdrop_percent, token_balance, mint_meta, drop, airdrop_csv_file);
}
