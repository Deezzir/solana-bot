import { Keypair, PublicKey, Connection, TokenAmount } from '@solana/web3.js';
import { createWriteStream, existsSync, readFileSync } from 'fs';
import bs58 from 'bs58';
import {
    COMMANDS_BUY_SLIPPAGE,
    COMMANDS_INTERVAL_MS,
    COMMANDS_SELL_SLIPPAGE,
    COMMITMENT,
    HELIUS_RPC,
    PriorityLevel,
    SENDER_BENCHMARK_ENDPOINTS,
    SOL_MINT,
    TRADE_RETRIES,
    WALLETS_FILE_HEADERS
} from './constants';
import * as common from './common/common';
import * as trade from './common/trade_common';
import * as transfers from './subcommands/transfers';
import * as volume from './subcommands/volume';
import * as token_drop from './subcommands/token_drop';
import * as pnl from './subcommands/pnl';
import * as mass_trade from './subcommands/mass_trade';
import { get_sniper, create_executor } from './common/get_provider';
import { Executor } from './common/executor';
import { SubscriberType } from './common/subscriber';

type OutputFormat = 'table' | 'csv';

function require_program(supported: common.Program[], command: string): void {
    if (!supported.includes(global.PROGRAM)) throw new Error(`${command} is not supported for ${global.PROGRAM}.`);
}

export async function burn_token(mint: PublicKey, burner: Keypair, amount?: number, percent?: number): Promise<void> {
    if (!amount && !percent) throw new Error('Either amount or percent should be provided.');
    if (amount && percent) throw new Error('Only one of amount or percent should be provided.');
    if (amount && amount <= 0) throw new Error('Amount should be greater than 0.');
    if (percent && (percent <= 0 || percent > 1)) throw new Error('Percent should be between 0 and 1.');

    const mint_meta = await trade.get_token_meta(mint);
    if (!mint_meta) throw new Error(`Mint metadata not found for the mint: ${mint.toString()}.`);

    const token_amount = await trade.get_token_balance(burner.publicKey, mint, COMMITMENT, mint_meta.token_program);
    common.print_summary('Burn tokens', [
        ['Mint', mint.toBase58()],
        ['Wallet', burner.publicKey.toBase58()],
        ['Balance', `${token_amount.uiAmount || 0} ${mint_meta.token_symbol.toUpperCase()}`],
        ['Burn amount', amount ? `${amount} tokens` : `${percent! * 100}%`]
    ]);
    if (!token_amount || token_amount.uiAmount === 0 || !token_amount.uiAmount) throw new Error('No tokens to burn');

    const amount_to_burn = amount
        ? trade.get_token_amount(amount, mint_meta.token_decimal)
        : trade.get_token_amount_by_percent(token_amount, percent!);

    const signature = await trade.burn_token(amount_to_burn, burner, mint);
    common.log(common.green(`Transaction completed, signature: ${signature}`));
}

export async function clean(wallets: common.Wallet[], burn: boolean = false): Promise<void> {
    if (wallets.length === 0) throw new Error('No wallets available.');

    common.print_summary('Clean token accounts', [
        ['Wallets', wallets.length],
        ['Mode', burn ? 'Burn tokens and close accounts' : 'Close empty accounts']
    ]);
    const unsold_mints = new Map<string, { amount: bigint; decimals: number }>();
    const unclosed_wallets: common.Wallet[] = [];
    const unsold_wallets: common.Wallet[] = [];
    let total_closed_cnt = 0;
    let total_failed_cnt = 0;

    for (const batch of common.chunks(wallets, 40)) {
        await Promise.all(
            batch.map(async (wallet) => {
                try {
                    const closer = wallet.keypair;
                    const prefix = `${wallet.keypair.publicKey.toString().padEnd(44, ' ')} ${wallet.name} (${wallet.id})`;
                    common.log(`Cleaning ${prefix}...`);
                    const {
                        unsold_mints: unsold,
                        failed_cnt,
                        closed_cnt,
                        closed,
                        failures
                    } = await trade.close_accounts(closer, burn);
                    total_closed_cnt += closed_cnt;
                    total_failed_cnt += failed_cnt;
                    if (failed_cnt > 0) unclosed_wallets.push(wallet);
                    if (unsold.length > 0) unsold_wallets.push(wallet);
                    for (const result of closed) {
                        common.log(`${prefix} | ${result.count} accounts closed | Signature ${result.signature}`);
                    }
                    for (const failure of failures) {
                        common.error(
                            common.red(
                                `${prefix} | Failed to close ${failure.count} accounts after ${failure.attempts} attempts: ${failure.error}`
                            )
                        );
                    }
                    for (const mint of unsold) {
                        const existing = unsold_mints.get(mint.mint.toString());
                        unsold_mints.set(mint.mint.toString(), {
                            amount: (existing?.amount ?? 0n) + mint.amount,
                            decimals: mint.decimals
                        });
                    }
                    if (closed_cnt === 0 && failed_cnt === 0 && unsold.length === 0)
                        common.log(`${prefix} | No accounts to close`);
                } catch (error) {
                    unclosed_wallets.push(wallet);
                    common.error(
                        common.red(
                            `Failed to clean ${wallet.keypair.publicKey}: ${error} (failed account count unknown)`
                        )
                    );
                }
            })
        );
    }

    common.print_summary('Cleanup results', [
        ['Closed accounts', total_closed_cnt],
        ['Failed accounts', total_failed_cnt],
        ['Unclosed wallets', unclosed_wallets.length],
        ['Wallets with tokens', unsold_wallets.length]
    ]);

    if (unclosed_wallets.length > 0) {
        common.log(common.red(`\nUnclosed Wallets:`));
        for (const wallet of unclosed_wallets) {
            common.log(`${wallet.keypair.publicKey.toString()}`);
        }
    }

    if (unsold_wallets.length > 0) {
        common.log(common.yellow(`\nWallets With Unsold Tokens:`));
        for (const wallet of unsold_wallets) {
            common.log(`${wallet.keypair.publicKey.toString()}`);
        }
    }

    if (unsold_mints.size > 0) {
        common.log(common.red(`\nUnsold Tokens:`));
        for (const [mint, balance] of unsold_mints.entries()) {
            common.log(`${common.bold(mint)}: ${balance.amount} raw units (${balance.decimals} decimals)`);
        }
    }
    if (total_failed_cnt > 0 || unclosed_wallets.length > 0)
        throw new Error(`${total_failed_cnt || unclosed_wallets.length} clean operation(s) failed.`);
}

export async function claim_rewards(
    wallets: common.Wallet[],
    print_only: boolean,
    priority?: PriorityLevel
): Promise<void> {
    if (wallets.length === 0) throw new Error('No wallets available.');
    require_program(
        [common.Program.Pump, common.Program.Meteora, common.Program.Raydium, common.Program.Bonk],
        'Reward claims'
    );
    common.print_summary(print_only ? 'Available rewards' : 'Claim rewards', [
        ['Program', global.PROGRAM],
        ['Wallets', wallets.length]
    ]);
    const executor = create_executor();
    let total_sol_raw = 0n;
    let failed = 0;
    for (const wallet of wallets) {
        try {
            const prefix = `${wallet.keypair.publicKey.toString().padEnd(44, ' ')} ${wallet.name} (${wallet.id})`;
            const assets = await executor.get_rewards(wallet.keypair);
            const log_assets = (status: 'available' | 'claimed') => {
                for (const asset of assets) {
                    const is_sol = asset.mint.equals(SOL_MINT);
                    if (is_sol) total_sol_raw += asset.raw_amount;
                    const token_label = is_sol ? 'SOL' : asset.mint.toString();
                    const amount = (Number(asset.raw_amount) / 10 ** asset.decimals).toFixed(asset.decimals);
                    common.log(`${prefix}: ${status} ${amount} ${token_label} (${asset.source})`);
                }
            };
            if (assets.length === 0) {
                common.log(`${prefix} | No rewards available`);
                continue;
            }
            if (print_only) {
                log_assets('available');
                continue;
            }
            const signature = await executor.claim_rewards(wallet.keypair, assets, priority);
            log_assets('claimed');
            common.log(common.green(`${prefix}: signature ${signature}`));
        } catch (error) {
            failed++;
            common.error(common.red(`Failed to claim dev fees for ${wallet.name}: ${error}`));
        }
        await common.sleep(COMMANDS_INTERVAL_MS);
    }
    common.print_summary('Reward results', [
        [print_only ? 'Available SOL' : 'Claimed SOL', `${trade.lamports_to_sol(total_sol_raw)} SOL`],
        ['Failed wallets', failed]
    ]);
    if (!print_only && failed > 0) throw new Error(`${failed} reward claim(s) failed.`);
}

export async function create_token_metadata(json: common.IPFSMetadata, image_path: string | undefined) {
    const executor = create_executor();
    common.print_summary('Upload token metadata', [
        ['Metadata', JSON.stringify(json, null, 2)],
        ['Image', image_path || 'None']
    ]);
    common.log(common.yellow('Uploading metadata...\n'));
    const cid = await executor.create_token_metadata(json, image_path);
    common.print_summary(common.green('Metadata uploaded'), [['CID', cid]]);
}

export async function create_token(
    meta_cid: string,
    dev: common.Wallet,
    dev_buy?: number,
    mint?: Keypair,
    wallets?: common.Wallet[],
    min?: number,
    max?: number,
    bundle_tip?: number,
    config?: object
): Promise<void> {
    require_program(
        [common.Program.Pump, common.Program.Bonk, common.Program.Raydium, common.Program.Meteora],
        'Token creation'
    );
    if (wallets && (!min || !max)) throw new Error('Both min and max should be provided, when bundle buy is enabled.');

    dev_buy = dev_buy || 0;

    const executor = create_executor();
    const balance = trade.lamports_to_sol(await trade.get_balance(dev.keypair.publicKey, COMMITMENT));
    const meta = await common.fetch_ipfs_json(meta_cid);

    common.print_summary('Create token', [
        ['Program', global.PROGRAM],
        ['Developer', `${dev.name} (${dev.id})`],
        ['Wallet', dev.keypair.publicKey.toBase58()],
        ['Balance', `${balance} SOL`],
        ['Developer buy', `${dev_buy} SOL`]
    ]);

    let entries: [Keypair, number][] | undefined;
    if (wallets) {
        common.print_summary('Bundle buy', [
            ['Wallets', wallets.length],
            ['Buy per wallet', `${min} - ${max} SOL`],
            ['Bundle tip', bundle_tip === undefined ? 'Default' : `${bundle_tip} SOL`]
        ]);
        entries = wallets.map((w) => [w.keypair, common.uniform_random(min ?? 0, max ?? 0)]);
    }

    mint = mint || (await Keypair.generate());
    common.print_summary('Token details', [
        ['Mint', mint.publicKey.toBase58()],
        ['Name', meta.name],
        ['Symbol', meta.symbol],
        ['Metadata URI', meta_cid],
        ['Metadata', JSON.stringify(meta, common.json_bigint, 2)]
    ]);

    await common.to_confirm('Press ENTER to create the token...');

    try {
        const sig = await executor.create_token(
            mint,
            dev.keypair,
            meta.name,
            meta.symbol,
            meta_cid,
            dev_buy,
            entries,
            bundle_tip,
            PriorityLevel.HIGH,
            config
        );
        common.print_summary(common.green('Token created'), [
            ['Mint', mint.publicKey.toBase58()],
            ['Signature', String(sig)]
        ]);
    } catch (error) {
        throw new Error(`Failed to create token: ${error}`);
    }
}

export async function promote(times: number, meta_cid: string, dev: Keypair): Promise<void> {
    require_program([common.Program.Pump, common.Program.Bonk], 'Token promotion');
    const executor = create_executor();
    const balance = trade.lamports_to_sol(await trade.get_balance(dev.publicKey, COMMITMENT));
    const meta = await common.fetch_ipfs_json(meta_cid);

    common.print_summary('Promote token', [
        ['Tokens to create', times],
        ['Developer', dev.publicKey.toBase58()],
        ['Balance', `${balance} SOL`],
        ['Name', meta.name],
        ['Symbol', meta.symbol],
        ['Metadata URI', meta_cid]
    ]);

    const transactions = [];
    let failed = 0;

    while (times > 0) {
        const mint = await Keypair.generate();
        transactions.push(
            executor
                .create_token(mint, dev, meta.name, meta.symbol, meta_cid)
                .then((sig) =>
                    common.print_summary(common.green('Token created'), [
                        ['Mint', mint.publicKey.toBase58()],
                        ['Signature', String(sig)]
                    ])
                )
                .catch((error) => {
                    failed++;
                    common.error(common.red(`Transaction failed: ${error.message}`));
                })
        );
        times--;
        await common.sleep(COMMANDS_INTERVAL_MS);
    }

    await Promise.allSettled(transactions);
    if (failed > 0) throw new Error(`${failed} token promotion(s) failed.`);
}

export async function token_balance(wallets: common.Wallet[], mint: PublicKey, format: OutputFormat): Promise<void> {
    if (wallets.length === 0) throw new Error('No wallets available.');
    const sol_price = await common.fetch_sol_price();

    let decimals, supply, supply_raw;
    let token_name, token_symbol;
    let token_program;

    let total_tokens_all = 0;
    let total_tokens_cur = 0;
    let total_spendings_all = 0;
    let total_spendings_cur = 0;
    let total_fees_all = 0;
    let total_fees_cur = 0;

    try {
        ({ token_name, token_symbol, token_program } = await trade.get_token_meta(mint));
        ({ supply: supply_raw, decimals } = await trade.get_token_supply(mint));
        supply = Number(supply_raw);
    } catch (error) {
        throw new Error(`Failed to get the token information: ${error}`);
    }
    const wallet_results = await Promise.all(
        wallets.map(async (wallet) => {
            try {
                return await Promise.all([
                    trade.get_token_balance(wallet.keypair.publicKey, mint, COMMITMENT, token_program),
                    trade.get_cost_basis(wallet.keypair.publicKey, mint, COMMITMENT, token_program, sol_price)
                ]);
            } catch (error) {
                throw new Error(`Failed to get token data for wallet ${wallet.id}: ${error}`);
            }
        })
    );
    const token_balances: TokenAmount[] = wallet_results.map(([token_balance]) => token_balance);
    const cost_basiss = wallet_results.map(([, cost_basis]) => cost_basis);

    const wallet_count = token_balances.filter((balance) => (balance.uiAmount || 0) > 0).length;

    if (format === 'csv') {
        common.log(`id,name,pubkey,mint,allocation,token_balance,entry_mcap`);
    } else if (format === 'table') {
        common.print_summary('Token balances', [
            ['Mint', mint.toBase58()],
            ['Token', `${token_name} (${token_symbol})`],
            ['Wallets with tokens', wallet_count]
        ]);

        common.print_header([
            { title: 'Id', width: common.COLUMN_WIDTHS.id },
            { title: 'Name', width: common.COLUMN_WIDTHS.name },
            { title: 'Public Key', width: common.COLUMN_WIDTHS.publicKey },
            { title: 'Allocation', width: common.COLUMN_WIDTHS.allocation, align: 'right' },
            { title: `${token_symbol} Balance`, width: common.COLUMN_WIDTHS.tokenBalance, align: 'right' },
            { title: `Entry MC`, width: common.COLUMN_WIDTHS.entryMcap, align: 'right' }
        ]);
    } else {
        throw new Error("Invalid output format. Supported formats are 'table' and 'csv'.");
    }

    for (let i = 0; i < wallets.length; i++) {
        const wallet = wallets[i];
        const cost_basis = cost_basiss[i];
        const ui_balance = token_balances[i].uiAmount || 0;
        if (!cost_basis) {
            const allocation = ((ui_balance / (supply / 10 ** decimals)) * 100).toFixed(2);
            if (format === 'csv') {
                common.log(
                    `${wallet.id.toString()},${common.format_name(wallet.name)},${wallet.keypair.publicKey.toString()},${mint.toString()},${allocation},${ui_balance.toFixed(2)},null`
                );
            } else {
                common.print_row([
                    { content: wallet.id.toString(), width: common.COLUMN_WIDTHS.id },
                    { content: common.format_name(wallet.name), width: common.COLUMN_WIDTHS.name },
                    { content: wallet.keypair.publicKey.toString(), width: common.COLUMN_WIDTHS.publicKey },
                    { content: `${allocation}%`, width: common.COLUMN_WIDTHS.allocation, align: 'right' },
                    { content: ui_balance.toFixed(decimals), width: common.COLUMN_WIDTHS.tokenBalance, align: 'right' },
                    { content: 'N/A', width: common.COLUMN_WIDTHS.entryMcap, align: 'right' }
                ]);
            }
            total_tokens_cur += ui_balance;
            continue;
        }

        const entry_mcap = ((cost_basis.average_cost_basis * supply) / 10 ** decimals) * sol_price;
        const alloc = (ui_balance / (supply / 10 ** decimals)) * 100;

        total_tokens_cur += ui_balance;
        total_tokens_all += cost_basis.total_tokens;
        total_spendings_all += cost_basis.total_spendings;
        if (ui_balance > 0) total_spendings_cur += cost_basis.total_spendings;
        total_fees_all += cost_basis.total_fees;
        if (ui_balance > 0) total_fees_cur += cost_basis.total_fees;

        if (format === 'csv') {
            common.log(
                `${wallet.id.toString()},${common.format_name(wallet.name)},${wallet.keypair.publicKey.toString()},${mint.toString()},${alloc.toFixed(2)},${ui_balance.toFixed(2)},${entry_mcap.toFixed(2)}`
            );
        } else {
            common.print_row([
                { content: wallet.id.toString(), width: common.COLUMN_WIDTHS.id },
                { content: common.format_name(wallet.name), width: common.COLUMN_WIDTHS.name },
                { content: wallet.keypair.publicKey.toString(), width: common.COLUMN_WIDTHS.publicKey },
                { content: `${alloc.toFixed(2)}%`, width: common.COLUMN_WIDTHS.allocation, align: 'right' },
                { content: ui_balance.toFixed(decimals), width: common.COLUMN_WIDTHS.tokenBalance, align: 'right' },
                {
                    content: `${(entry_mcap / 1000).toFixed(2)}K$`,
                    width: common.COLUMN_WIDTHS.entryMcap,
                    align: 'right'
                }
            ]);
        }
    }

    if (format === 'csv') return;

    common.print_footer([
        { width: common.COLUMN_WIDTHS.id },
        { width: common.COLUMN_WIDTHS.name },
        { width: common.COLUMN_WIDTHS.publicKey },
        { width: common.COLUMN_WIDTHS.allocation },
        { width: common.COLUMN_WIDTHS.tokenBalance },
        { width: common.COLUMN_WIDTHS.entryMcap }
    ]);

    const allocation_all = (total_tokens_all / (supply / 10 ** decimals)) * 100;
    const allocation_cur = (total_tokens_cur / (supply / 10 ** decimals)) * 100;
    const average_entry_mcap_all =
        (((((total_spendings_all - total_fees_all) / total_tokens_all) * supply) / 10 ** decimals) * sol_price) /
            1000 || 0;
    const average_entry_mcap_cur =
        (((((total_spendings_cur - total_fees_cur) / total_tokens_cur) * supply) / 10 ** decimals) * sol_price) /
            1000 || 0;

    common.print_summary('All holdings', [
        ['Average entry MC', `$${average_entry_mcap_all.toFixed(1)}K`],
        ['Total balance', `${common.format_currency(total_tokens_all)} ${token_symbol}`],
        ['Total cost', `${common.format_currency(total_spendings_all)} SOL`],
        ['Total allocation', `${allocation_all.toFixed(2)}%`]
    ]);
    common.print_summary('Current holdings', [
        ['Average entry MC', `$${average_entry_mcap_cur.toFixed(1)}K`],
        ['Total balance', `${common.format_currency(total_tokens_cur)} ${token_symbol}`],
        ['Total cost', `${common.format_currency(total_spendings_cur)} SOL`],
        ['Total allocation', `${allocation_cur.toFixed(2)}%`]
    ]);
}

export async function transfer_sol(amount: number, receiver: PublicKey, sender: Keypair): Promise<void> {
    if (sender.publicKey.equals(receiver)) throw new Error('Sender and receiver addresses are the same.');
    common.print_summary('Transfer SOL', [
        ['From', sender.publicKey.toBase58()],
        ['To', receiver.toBase58()],
        ['Amount', `${amount} SOL`]
    ]);
    const balance = await trade.get_balance(sender.publicKey, COMMITMENT);
    const lamports = trade.sol_to_lamports(amount);
    if (balance < lamports) throw new Error(`Sender balance is not enough to transfer ${amount} SOL`);
    const signature = await trade.send_lamports(lamports, sender, receiver, PriorityLevel.HIGH);
    common.log(common.green(`Transaction completed, signature: ${signature}`));
}

export async function transfer_token(
    mint: PublicKey,
    amount: number,
    receiver: PublicKey,
    sender: Keypair
): Promise<void> {
    if (sender.publicKey.equals(receiver)) throw new Error('Sender and receiver addresses are the same.');
    const mint_meta = await trade.get_token_meta(mint);
    if (!mint_meta) throw new Error(`Mint metadata not found`);

    common.print_summary('Transfer tokens', [
        ['Mint', mint.toBase58()],
        ['From', sender.publicKey.toBase58()],
        ['To', receiver.toBase58()],
        ['Amount', `${amount} ${mint_meta.token_symbol}`]
    ]);

    const token_balance = await trade.get_token_balance(sender.publicKey, mint, COMMITMENT, mint_meta.token_program);
    if (!token_balance.uiAmount) throw new Error(`Sender has no token balance for ${mint_meta.token_name}`);
    if (token_balance.uiAmount < amount)
        throw new Error(`Sender balance is not enough to transfer ${amount} ${mint_meta.token_symbol}`);

    const signature = await trade.send_tokens(
        trade.get_token_amount(amount, mint_meta.token_decimal),
        mint,
        sender,
        receiver,
        undefined,
        mint_meta.token_program
    );
    common.log(common.green(`Transaction completed, signature: ${signature}`));
}

export async function balance(wallets: common.Wallet[], format: OutputFormat): Promise<void> {
    if (wallets.length === 0) throw new Error('No wallets available.');

    let total = 0;
    const sol_price = await common.fetch_sol_price();
    const balances = await Promise.all(
        wallets.map((wallet) => trade.get_balance(wallet.keypair.publicKey, COMMITMENT))
    );
    switch (format) {
        case 'csv': {
            common.log('id,name,pubkey,sol_balance,usd_balance');
            for (let i = 0; i < wallets.length; i++) {
                const wallet = wallets[i];
                const balance = trade.lamports_to_sol(balances[i]);
                const usd_value = balance * sol_price;
                total += balance;
                common.log(
                    `${wallet.id.toString()},${common.format_name(wallet.name)},${wallet.keypair.publicKey.toString()},${balance.toFixed(9)},${usd_value.toFixed(2)}`
                );
            }
            return;
        }
        case 'table': {
            common.print_summary('Wallet balances', [['Wallets', wallets.length]]);

            common.print_header([
                { title: 'Id', width: common.COLUMN_WIDTHS.id },
                { title: 'Name', width: common.COLUMN_WIDTHS.name },
                { title: 'Public Key', width: common.COLUMN_WIDTHS.publicKey },
                { title: 'SOL Balance', width: common.COLUMN_WIDTHS.solBalance, align: 'right' },
                { title: 'USD Value', width: common.COLUMN_WIDTHS.usdBalance, align: 'right' }
            ]);

            for (let i = 0; i < wallets.length; i++) {
                const wallet = wallets[i];
                const balance = trade.lamports_to_sol(balances[i]);
                const usd_value = balance * sol_price;
                total += balance;

                common.print_row([
                    {
                        content: wallet.id.toString().concat(wallet.is_reserve ? '*' : ''),
                        width: common.COLUMN_WIDTHS.id
                    },
                    { content: common.format_name(wallet.name), width: common.COLUMN_WIDTHS.name },
                    { content: wallet.keypair.publicKey.toString(), width: common.COLUMN_WIDTHS.publicKey },
                    { content: balance.toFixed(9), width: common.COLUMN_WIDTHS.solBalance, align: 'right' },
                    { content: usd_value.toFixed(2), width: common.COLUMN_WIDTHS.usdBalance, align: 'right' }
                ]);
            }

            common.print_footer([
                { width: common.COLUMN_WIDTHS.id },
                { width: common.COLUMN_WIDTHS.name },
                { width: common.COLUMN_WIDTHS.publicKey },
                { width: common.COLUMN_WIDTHS.solBalance },
                { width: common.COLUMN_WIDTHS.usdBalance }
            ]);

            common.print_summary('Balance totals', [
                ['SOL', `${common.format_currency(total)} SOL`],
                ['USD', `$${common.format_currency(total * sol_price)}`]
            ]);
            return;
        }
        default:
            throw new Error("Invalid output format. Supported formats are 'table' and 'csv'.");
    }
}

export async function sell_token_once(
    mint: PublicKey,
    seller: Keypair,
    percent?: number,
    slippage?: number,
    protection_tip?: number,
    mev_protect?: boolean,
    priority: PriorityLevel = PriorityLevel.DEFAULT
): Promise<void> {
    slippage = slippage || COMMANDS_SELL_SLIPPAGE;
    percent ??= 1.0;
    const executor = create_executor();
    const mint_meta = await executor.get_mint_meta(mint);
    if (!mint_meta) throw new Error(`Mint metadata not found for program: ${global.PROGRAM}.`);

    const token_amount = await trade.get_token_balance(seller.publicKey, mint, COMMITMENT, mint_meta.token_program);
    common.print_summary('Sell tokens', [
        ['Mint', mint.toBase58()],
        ['Wallet', seller.publicKey.toBase58()],
        ['Balance', `${token_amount.uiAmount || 0} ${mint_meta.token_symbol.toUpperCase()}`],
        ['Sell amount', `${percent * 100}%`],
        ['Slippage', `${slippage * 100}%`]
    ]);
    if (!token_amount || token_amount.uiAmount === 0 || !token_amount.uiAmount) throw new Error('No tokens to sell');

    const token_amount_to_sell = trade.get_token_amount_by_percent(token_amount, percent);
    common.log(
        `Selling ${token_amount_to_sell.uiAmount} tokens from ${seller.publicKey.toString().padEnd(44, ' ')}...`
    );

    const signature = await executor.sell_token(
        token_amount_to_sell,
        seller,
        mint_meta,
        slippage,
        priority,
        protection_tip,
        mev_protect
    );
    common.log(common.green(`Transaction completed, signature: ${signature}`));
}

export async function buy_token_once(
    amount: number,
    mint: PublicKey,
    buyer: Keypair,
    slippage?: number,
    protection_tip?: number,
    mev_protect?: boolean,
    priority: PriorityLevel = PriorityLevel.DEFAULT
): Promise<void> {
    slippage = slippage || COMMANDS_BUY_SLIPPAGE;
    const executor = create_executor();
    const mint_meta = await executor.get_mint_meta(mint);
    if (!mint_meta) throw new Error(`Mint metadata not found for program: ${global.PROGRAM}.`);

    const balances = await executor.has_enough_balances(amount, buyer.publicKey, mint_meta, slippage);
    let balance_msg = `${trade.lamports_to_sol(balances.sol_balance_raw)} SOL`;
    if (!mint_meta.quote_mint_pubkey.equals(SOL_MINT)) {
        const quote_ui_amount = Number(balances.quote_balance_raw) / 10 ** balances.quote_amount.decimals;
        const quote_ticker = await trade.get_quote_name_by_mint(mint_meta.quote_mint_pubkey);
        balance_msg += `, ${quote_ui_amount.toFixed(5)} ${quote_ticker}`;
    }
    common.print_summary('Buy tokens', [
        ['Mint', mint.toBase58()],
        ['Wallet', buyer.publicKey.toBase58()],
        ['Balance', balance_msg],
        ['Buy amount', `${amount} SOL`],
        ['Slippage', `${slippage * 100}%`]
    ]);

    if (balances.status === 'insufficient') throw new Error(`Buyer balances is not enough to buy ${amount} SOL`);

    const signature = await executor.buy_token(
        amount,
        buyer,
        mint_meta,
        slippage,
        priority,
        protection_tip,
        mev_protect
    );
    common.log(common.green(`Transaction completed, signature: ${signature}`));
}

export async function warmup(
    wallets: common.Wallet[],
    priority: PriorityLevel = PriorityLevel.DEFAULT,
    bundle_tip?: number,
    interval?: number,
    min?: number,
    max?: number
): Promise<void> {
    require_program(
        [common.Program.Pump, common.Program.Bonk, common.Program.Raydium, common.Program.Meteora],
        'Warmup'
    );
    const get_random_mints = async (executor: Executor, count: number) => {
        const mints = new Map<string, trade.IMintMeta>();
        for (let attempt = 0; attempt < TRADE_RETRIES && mints.size < count; attempt++) {
            for (const mint of await executor.get_random_mints(count)) mints.set(mint.token_mint, mint);
            if (mints.size < count && attempt + 1 < TRADE_RETRIES) await common.sleep(2000);
        }
        if (!mints.size) throw new Error('No tradable mints found after repeated discovery attempts.');
        if (mints.size < count)
            common.warn(`Found ${mints.size} of ${count} requested mints; using the available mints.`);
        return [...mints.values()].slice(0, count);
    };

    min = min || 1;
    max = max || 5;
    const slippage = COMMANDS_BUY_SLIPPAGE;

    if (wallets.length === 0) throw new Error('No wallets available.');
    if (max < min) throw new Error('Invalid min and max values.');
    if (interval && bundle_tip) throw new Error('Interval and bundle tip cannot be used together.');

    common.print_summary('Warm up wallets', [
        ['Wallets', wallets.length],
        ['Tokens per wallet', `${min} - ${max}`],
        ['Mode', bundle_tip ? 'Bundle' : 'Sequential'],
        ['Priority', priority]
    ]);

    const token_counts = Array.from({ length: wallets.length }, () => Math.floor(Math.random() * (max - min) + min));
    if (token_counts.length !== wallets.length) throw new Error();
    const executor = create_executor();

    for (const [i, wallet] of wallets.entries()) {
        const buyer = wallet.keypair;

        const mints = await get_random_mints(executor, token_counts[i]);
        common.log(
            common.yellow(
                `\nWarming up ${buyer.publicKey.toString().padEnd(44, ' ')} ${wallet.name} (${wallet.id}) with ${token_counts[i]} tokens...`
            )
        );
        for (const mint of mints) {
            let amount = parseFloat(common.uniform_random(0.05, 0.25).toFixed(4));
            common.log(
                `Warming up with ${amount} SOL of the token '${mint.token_name}' with mint ${mint.token_mint}...`
            );
            try {
                const funding = await executor.has_enough_balances(amount, buyer.publicKey, mint, slippage);
                if (funding.status === 'insufficient') continue;
                if (bundle_tip) {
                    const signature = await executor.buy_sell_bundle(
                        amount,
                        buyer,
                        mint,
                        bundle_tip,
                        slippage,
                        priority
                    );
                    common.log(common.green(`Bundle completed for ${wallet.name} | Signature: ${signature}`));
                } else {
                    const [buy_sig, sell_sig] = await executor.buy_sell(
                        amount,
                        buyer,
                        mint,
                        slippage,
                        interval ? interval * 1000 : undefined,
                        priority
                    );
                    common.print_summary(common.green('Warmup trade completed'), [
                        ['Wallet', `${wallet.name} (${wallet.id})`],
                        ['Buy signature', String(buy_sig)],
                        ['Sell signature', String(sell_sig)]
                    ]);
                }
            } catch (error) {
                common.error(
                    common.red(
                        `Failed to trade '${mint.token_name}' for ${wallet.name} (${wallet.id}): ${error}. Continuing...`
                    )
                );
            }
        }
    }
}

export async function collect(wallets: common.Wallet[], receiver: PublicKey): Promise<void> {
    if (wallets.length === 0) throw new Error('No wallets available.');

    common.print_summary('Collect SOL', [
        ['Wallets', wallets.length],
        ['Receiver', receiver.toBase58()]
    ]);

    const transactions = [];
    const failed: string[] = [];
    for (const wallet of wallets) {
        const sender = wallet.keypair;
        const amount = await trade.get_balance(sender.publicKey, COMMITMENT);
        if (amount === 0n || receiver.equals(sender.publicKey)) continue;

        common.log(
            `Collecting ${trade.lamports_to_sol(amount)} SOL from ${sender.publicKey.toString().padEnd(44, ' ')} (${wallet.name})...`
        );
        transactions.push(
            trade
                .send_lamports(amount, sender, receiver, PriorityLevel.HIGH)
                .then((signature) =>
                    common.log(common.green(`Transaction completed for ${wallet.name}, signature: ${signature} `))
                )
                .catch((error) => {
                    failed.push(wallet.name);
                    common.error(common.red(`Transaction failed for ${wallet.name}: ${error.message} `));
                })
        );
        await common.sleep(COMMANDS_INTERVAL_MS);
    }
    await Promise.allSettled(transactions);
    if (failed.length > 0) throw new Error(`${failed.length} SOL collection(s) failed.`);
}

export async function collect_token(wallets: common.Wallet[], mint: PublicKey, receiver: PublicKey): Promise<void> {
    if (wallets.length === 0) throw new Error('No wallets available.');

    const mint_meta = await trade.get_token_meta(mint);
    if (!mint_meta) throw new Error(`Mint metadata not found`);

    common.print_summary('Collect tokens', [
        ['Token', mint_meta.token_symbol],
        ['Mint', mint.toBase58()],
        ['Wallets', wallets.length],
        ['Receiver', receiver.toBase58()]
    ]);
    const transactions = [];
    const failed: string[] = [];

    for (const wallet of wallets) {
        try {
            const sender = wallet.keypair;
            if (sender.publicKey.equals(receiver)) continue;
            const token_amount = await trade.get_token_balance(
                sender.publicKey,
                mint,
                COMMITMENT,
                mint_meta.token_program
            );
            if (!token_amount.uiAmount || token_amount.uiAmount <= 0) continue;

            common.log(
                `Collecting ${token_amount.uiAmount} tokens from ${sender.publicKey.toString().padEnd(44, ' ')} (${wallet.name})...`
            );
            transactions.push(
                trade
                    .send_tokens(token_amount, mint, sender, receiver, undefined, mint_meta.token_program)
                    .then((signature) =>
                        common.log(common.green(`Transaction completed for ${wallet.name}, signature: ${signature} `))
                    )
                    .catch((error) => {
                        failed.push(wallet.name);
                        common.error(common.red(`Transaction failed for ${wallet.name}: ${error.message} `));
                    })
            );
        } catch (error) {
            failed.push(wallet.name);
            common.error(common.red(`Failed to collect the token from ${wallet.name}: ${error} `));
        }
        await common.sleep(COMMANDS_INTERVAL_MS);
    }
    await Promise.allSettled(transactions);
    if (failed.length > 0) throw new Error(`${failed.length} token collection(s) failed.`);
}

export async function buy_token(
    wallets: common.Wallet[],
    mint: PublicKey,
    priority: PriorityLevel = PriorityLevel.DEFAULT,
    protection_tip?: number,
    mev_protect?: boolean,
    bundle_tip?: number,
    amount?: number,
    min?: number,
    max?: number,
    slippage?: number
): Promise<void> {
    const SLIPPAGE = slippage || COMMANDS_BUY_SLIPPAGE;

    if (protection_tip && bundle_tip) throw new Error('Protection tip and bundle tip cannot be used together.');
    if (mev_protect && bundle_tip) throw new Error('MEV protection and bundle tip cannot be used together.');
    if (wallets.length === 0) throw new Error('No wallets available.');
    if (!amount && (!min || !max)) throw new Error('Either amount or min and max should be provided.');
    if ((min && !max) || (!min && max)) throw new Error('Both min and max should be provided.');
    if (max && min && max < min) throw new Error('Invalid min and max values.');

    const executor = create_executor();
    const entries: [common.Wallet, number][] = wallets.map((w) => [
        w,
        amount || common.uniform_random(min ?? 0, max ?? 0)
    ]);
    let mint_meta = await executor.get_mint_meta(mint);
    if (!mint_meta) throw new Error(`Mint metadata not found for program: ${global.PROGRAM}.`);
    common.print_summary('Buy tokens', [
        ['Mint', mint.toBase58()],
        ['Wallets', wallets.length],
        ['Buy per wallet', amount ? `${amount} SOL` : `${min} - ${max} SOL`],
        ['Slippage', `${SLIPPAGE * 100}%`],
        ['Mode', bundle_tip ? 'Bundle' : 'Sequential'],
        ['Priority', priority]
    ]);

    if (!bundle_tip)
        return await mass_trade.seq_buy(mint_meta, entries, executor, SLIPPAGE, priority, protection_tip, mev_protect);
    return await mass_trade.bundle_buy(mint_meta, entries, executor, SLIPPAGE, bundle_tip, priority);
}

export async function sell_token(
    wallets: common.Wallet[],
    mint: PublicKey,
    priority: PriorityLevel = PriorityLevel.DEFAULT,
    protection_tip?: number,
    mev_protect?: boolean,
    bundle_tip?: number,
    percent?: number,
    slippage?: number
): Promise<void> {
    slippage = slippage || COMMANDS_SELL_SLIPPAGE;
    percent ??= 1.0;

    if (protection_tip && bundle_tip) throw new Error('Protection tip and bundle tip cannot be used together.');
    if (mev_protect && bundle_tip) throw new Error('MEV protection and bundle tip cannot be used together.');
    if (wallets.length === 0) throw new Error('No wallets available.');
    const executor = create_executor();
    let mint_meta = await executor.get_mint_meta(mint);
    if (!mint_meta) throw new Error(`Mint metadata not found for program: ${global.PROGRAM}.`);

    common.print_summary('Sell tokens', [
        ['Mint', mint.toBase58()],
        ['Wallets', wallets.length],
        ['Sell per wallet', `${percent * 100}%`],
        ['Slippage', `${slippage * 100}%`],
        ['Mode', bundle_tip ? 'Bundle' : 'Sequential'],
        ['Priority', priority]
    ]);

    if (!bundle_tip)
        return await mass_trade.seq_sell(
            mint_meta,
            wallets,
            executor,
            percent,
            slippage,
            priority,
            protection_tip,
            mev_protect
        );
    return await mass_trade.bundle_sell(mint_meta, wallets, executor, percent, slippage, bundle_tip, priority);
}

export async function fund_sol(
    wallets: common.Wallet[],
    amount: number,
    funder: Keypair,
    is_spider: boolean,
    is_random: boolean,
    depth?: number,
    bundle_tip?: number
): Promise<void> {
    if (wallets.length === 0) throw new Error('No wallets available.');
    if (depth && is_spider) throw new Error('Transfers and spider cannot be used together.');
    if (depth && !bundle_tip) throw new Error('Bundle tip is required for depth transfers.');
    if (bundle_tip && !depth) throw new Error('Bundle tip is only available for depth transfers.');
    const total_amount = wallets.length * amount;
    let amounts: number[] = [];

    const balance = trade.lamports_to_sol(await trade.get_balance(funder.publicKey, COMMITMENT));
    common.print_summary('Fund wallets', [
        ['Funder', funder.publicKey.toBase58()],
        ['Balance', `${balance} SOL`],
        ['Wallets', wallets.length],
        ['Total funding', `${total_amount} SOL`],
        ['Allocation', is_random ? 'Random' : `${amount} SOL per wallet`],
        ['Route', is_spider ? 'Spider' : depth ? `${depth} intermediate wallets` : 'Direct']
    ]);
    if (balance < total_amount) {
        throw new Error(`Payer balance is not enough to top up ${total_amount} SOL to ${wallets.length} wallets`);
    }

    if (is_random) {
        amounts = common.random_amounts(total_amount, wallets.length);
    } else {
        amounts = Array.from({ length: wallets.length }, () => amount);
    }

    if (is_spider) {
        const rescue_wallets = await transfers.execute_spider_fund_sol(wallets, amount, funder);
        common.print_summary('Collect remaining SOL from temporary wallets');
        await collect(rescue_wallets, funder.publicKey);
        return;
    }

    if (depth && bundle_tip) {
        const rescue_wallets = await transfers.execute_depth_sol_fund(
            common.zip(wallets, amounts),
            funder,
            depth,
            bundle_tip
        );
        common.print_summary('Collect remaining SOL from temporary wallets');
        await collect(rescue_wallets, funder.publicKey);
        return;
    }

    await transfers.execute_fund_sol(common.zip(wallets, amounts), funder);
}

export async function distribute_token(
    wallets: common.Wallet[],
    mint: PublicKey,
    percent: number,
    funder: Keypair,
    is_random: boolean,
    depth?: number,
    bundle_tip?: number
): Promise<void> {
    if (wallets.length === 0) throw new Error('No wallets available.');
    if (depth && !bundle_tip) throw new Error('Bundle tip is required for depth transfers.');
    if (bundle_tip && !depth) throw new Error('Bundle tip is only available for depth transfers.');
    if (percent < 0 || percent > 1) throw new Error('Percent should be between 0 and 1.');
    const mint_meta = await trade.get_token_meta(mint);
    let amounts: TokenAmount[] = [];

    const balance = await trade.get_token_balance(funder.publicKey, mint, COMMITMENT, mint_meta.token_program);
    if (!balance.uiAmount) throw new Error(`Distributer has no token balance for ${mint_meta.token_name}`);
    const total_amount = balance.uiAmount * percent;
    common.print_summary('Distribute tokens', [
        ['Mint', mint.toBase58()],
        ['Distributor', funder.publicKey.toBase58()],
        ['Balance', `${balance.uiAmount} ${mint_meta.token_symbol}`],
        ['Wallets', wallets.length],
        ['Total distribution', `${total_amount} ${mint_meta.token_symbol} (${percent * 100}%)`],
        ['Allocation', is_random ? 'Random' : 'Equal'],
        ['Route', depth ? `${depth} intermediate wallets` : 'Direct']
    ]);

    if (is_random) {
        amounts = common
            .random_amounts(total_amount, wallets.length)
            .map((amount) => trade.get_token_amount(amount, mint_meta.token_decimal));
    } else {
        const amount = total_amount / wallets.length;
        amounts = Array.from({ length: wallets.length }, () => trade.get_token_amount(amount, mint_meta.token_decimal));
    }

    if (depth && bundle_tip) {
        const rescue_wallets = await transfers.execute_depth_dist_token(
            common.zip(wallets, amounts),
            mint_meta,
            funder,
            depth,
            bundle_tip
        );
        common.print_summary('Collect remaining SOL from temporary wallets');
        await collect(rescue_wallets, funder.publicKey);
        return;
    }

    await transfers.execute_dist_token(common.zip(wallets, amounts), mint_meta, funder);
}

export async function snipe(
    wallets: common.Wallet[],
    subscriber_type: SubscriberType = SubscriberType.Tx,
    json_config?: object
): Promise<void> {
    if (wallets.length === 0) throw new Error('No wallets available.');
    const worker_count = wallets.filter((wallet) => !wallet.is_reserve).length;
    if (worker_count === 0) throw new Error('No non-reserve wallets available for sniping.');

    common.print_summary('Snipe tokens', [
        ['Program', global.PROGRAM],
        ['Available wallets', worker_count]
    ]);
    const sol_price = await common.fetch_sol_price();
    const sniper = get_sniper(subscriber_type);
    await sniper.setup_config(worker_count, json_config);
    await sniper.snipe(wallets, sol_price);
}

export async function generate(
    file_path: string,
    create_reserve: boolean,
    count: number = 0,
    secrets_path?: string,
    index?: number
): Promise<void> {
    common.print_summary('Generate wallets', [
        ['Output', file_path],
        ['Source', secrets_path ? 'Import private keys' : `${count} new wallets`],
        ['Create reserve', create_reserve ? 'Yes' : 'No']
    ]);

    const wallets: Partial<common.Wallet>[] = [];
    const starting_index = index || 1;

    if (create_reserve) wallets.push({ keypair: await Keypair.generate(), name: 'reserve', is_reserve: true });

    if (secrets_path && existsSync(secrets_path)) {
        const private_keys = readFileSync(secrets_path, 'utf8')
            .split('\n')
            .filter((i) => i);
        for (let [i, wallet] of private_keys.entries()) {
            if (wallet.length < 10) continue;
            wallet = wallet.trim();
            try {
                const decoded_key = Array.from(bs58.decode(wallet));
                wallets.push({
                    keypair: await Keypair.fromSecretKey(new Uint8Array(decoded_key)),
                    name: `wallet[${i + starting_index}]`,
                    is_reserve: false
                });
            } catch {
                throw new Error(`Invalid key at line ${i + 1} `);
            }
        }
    } else if (count) {
        for (let i = 0; i < count; i++)
            wallets.push({
                keypair: await Keypair.generate(),
                name: `wallet[${i + starting_index}]`,
                is_reserve: false
            });
    }

    const file_exists = existsSync(file_path);
    const writeStream = createWriteStream(file_path, { encoding: 'utf8', flags: file_exists ? 'a' : 'w' });
    if (!file_exists) writeStream.write(WALLETS_FILE_HEADERS.join(',') + '\n');

    wallets.forEach((wallet) => {
        if (wallet.name && wallet.keypair) {
            const row = [
                wallet.name,
                bs58.encode(wallet.keypair.secretKey),
                wallet.is_reserve,
                wallet.keypair.publicKey.toString(),
                new Date().toLocaleDateString()
            ].join(',');
            writeStream.write(row + '\n');
        }
    });

    common.print_summary(common.green('Wallet generation completed'), [
        ['Wallets', wallets.length],
        ['Saved to', file_path]
    ]);
}

export async function wallet_pnl(public_key: PublicKey): Promise<void> {
    const sol_price = await common.fetch_sol_price();

    common.print_summary('Wallet PnL', [
        ['Wallet', public_key.toBase58()],
        ['SOL price', `$${common.format_currency(sol_price)}`]
    ]);

    const wallet_pnl = await pnl.get_wallet_pnl(public_key, sol_price);

    common.print_header([
        { title: 'Symbol', width: common.COLUMN_WIDTHS.name },
        { title: 'Mint', width: common.COLUMN_WIDTHS.publicKey },
        { title: 'Unrealized($)', width: common.COLUMN_WIDTHS.solBalance, align: 'right' },
        { title: 'Realized($)', width: common.COLUMN_WIDTHS.solBalance, align: 'right' },
        { title: 'Profit($)', width: common.COLUMN_WIDTHS.solBalance, align: 'right' },
        { title: 'Buy/Sell TXs', width: common.COLUMN_WIDTHS.solBalance, align: 'right' }
    ]);

    let total_unrealized = 0;
    let total_realized = 0;
    let total_invested_sol = 0;

    for (const token of wallet_pnl.profit_loss) {
        const unrealized_usd = token.unrealized_pnl * sol_price;
        let realized_usd = token.realized_pnl * sol_price;
        const total_profit_usd = unrealized_usd + realized_usd;

        const buy_txs = token.transactions.filter((tx) => tx.change_sol < 0);
        const sell_txs = token.transactions.filter((tx) => tx.change_sol > 0);
        const buy_cnt = buy_txs.length;
        const sell_cnt = sell_txs.length;

        total_unrealized += unrealized_usd;
        total_realized += realized_usd;

        const total_invested = buy_txs.reduce((sum, tx) => sum + Math.abs(tx.change_sol), 0);
        total_invested_sol += total_invested;

        common.print_row([
            { content: `${token.symbol} `, width: common.COLUMN_WIDTHS.name },
            { content: token.mint, width: common.COLUMN_WIDTHS.publicKey },
            {
                content: `${common.format_currency(unrealized_usd)} `,
                width: common.COLUMN_WIDTHS.solBalance,
                align: 'right'
            },
            {
                content: `${common.format_currency(realized_usd)} `,
                width: common.COLUMN_WIDTHS.solBalance,
                align: 'right'
            },
            {
                content: `${common.format_currency(total_profit_usd)} `,
                width: common.COLUMN_WIDTHS.solBalance,
                align: 'right'
            },
            {
                content: `${buy_cnt}/${sell_cnt}`,
                width: common.COLUMN_WIDTHS.solBalance,
                align: 'right'
            }
        ]);
    }

    common.print_footer([
        { width: common.COLUMN_WIDTHS.name },
        { width: common.COLUMN_WIDTHS.publicKey },
        { width: common.COLUMN_WIDTHS.solBalance },
        { width: common.COLUMN_WIDTHS.solBalance },
        { width: common.COLUMN_WIDTHS.solBalance },
        { width: common.COLUMN_WIDTHS.solBalance }
    ]);

    const total = total_realized + total_unrealized;
    const total_invested_usd = total_invested_sol * sol_price;
    const total_pnl = total_invested_usd > 0 ? (total / total_invested_usd) * 100 : 0;

    common.print_summary('PnL totals', [
        ['Realized', (total_realized >= 0 ? common.green : common.red)(`$${common.format_currency(total_realized)}`)],
        [
            'Unrealized',
            (total_unrealized >= 0 ? common.green : common.red)(`$${common.format_currency(total_unrealized)}`)
        ],
        ['Profit (USD)', (total >= 0 ? common.green : common.red)(`$${common.format_currency(total)}`)],
        ['Profit (SOL)', (total >= 0 ? common.green : common.red)(`${common.format_currency(total / sol_price)} SOL`)],
        ['PnL', (total_pnl >= 0 ? common.green : common.red)(`${total_pnl.toFixed(2)}%`)]
    ]);
}

export async function start_volume(
    funder: Keypair | undefined,
    simulate: boolean = false,
    json_config?: object,
    wallets: common.Wallet[] = []
): Promise<void> {
    const executor = create_executor();
    const volume_config = await volume.setup_config(json_config);
    const volume_type_name = volume.VolumeType[volume_config.type];
    const natural = volume_config.type === volume.VolumeType.Natural;
    if (!natural && !funder) throw new Error('Fast and Bump volume require a reserve wallet.');

    if (simulate) {
        const sol_price = await common.fetch_sol_price();
        common.print_summary('Simulate volume', [['Mode', volume_type_name]]);
        const results = await volume.simulate(sol_price, volume_config, executor, wallets);

        const summary: [string, string | number][] = [
            ['SOL price', `$${common.format_currency(sol_price)}`],
            ['SOL utilization', `${common.format_currency(results.total_sol_utilization)} SOL`]
        ];
        if (funder && !natural) {
            const funder_balance = trade.lamports_to_sol(await trade.get_balance(funder.publicKey, COMMITMENT));
            summary.push([
                'Funder balance after fees',
                `${common.format_currency(funder_balance - results.total_fee_sol)} SOL`
            ]);
        }
        summary.push(
            ['Fees (USD)', `$${common.format_currency(results.total_fee_usd)}`],
            ['Fees (SOL)', `${common.format_currency(results.total_fee_sol)} SOL`],
            ['Volume (USD)', `$${common.format_currency(results.total_volume_usd)}`],
            ['Volume (SOL)', `${common.format_currency(results.total_volume_sol)} SOL`]
        );
        common.print_summary('Simulation results', summary);
        return;
    }

    common.print_summary('Start volume bot', [['Mode', volume_type_name]]);

    let rescue_wallets: common.Wallet[] = [];
    switch (volume_config.type) {
        case volume.VolumeType.Fast: {
            rescue_wallets = await volume.execute_fast(funder!, volume_config, executor);
            break;
        }
        case volume.VolumeType.Natural: {
            await volume.execute_natural(wallets, volume_config, executor);
            break;
        }
        case volume.VolumeType.Bump: {
            rescue_wallets = await volume.execute_bump(funder!, volume_config, executor);
            break;
        }
        default:
            throw new Error('Invalid Volume Bot type.');
    }
    if (rescue_wallets.length && funder) {
        common.print_summary('Collect remaining SOL from temporary wallets');
        await collect(rescue_wallets, funder.publicKey);
    }
}

export async function benchmark(
    NUM_REQUESTS: number,
    test_public_key: string,
    batch_size = 10,
    update_interval = 10
): Promise<void> {
    const public_key = new PublicKey(test_public_key);
    common.print_summary('RPC benchmark', [
        ['Requests', NUM_REQUESTS],
        ['Concurrency', batch_size]
    ]);

    let total_call_time = 0;
    let min_time = Number.MAX_VALUE;
    let max_time = 0;
    let errors = 0;
    let calls = 0;
    const connection = new Connection(HELIUS_RPC, { commitment: 'finalized', disableRetryOnRateLimit: true });
    const start_time = process.hrtime();

    const task_queue = Array.from({ length: NUM_REQUESTS }, (_, i) => i);
    async function worker(): Promise<void> {
        while (task_queue.length > 0) {
            const i = task_queue.shift();
            if (i === undefined) return;

            calls++;
            const startTime = process.hrtime();

            try {
                await connection.getBalance(public_key);
            } catch (error) {
                errors++;
                continue;
            }

            const [seconds, nanoseconds] = process.hrtime(startTime);
            const elapsed_time = seconds * 1000 + nanoseconds / 1e6;
            total_call_time += elapsed_time;

            if (elapsed_time < min_time) min_time = elapsed_time;
            if (elapsed_time > max_time) max_time = elapsed_time;

            if ((i + 1) % update_interval === 0 || i === NUM_REQUESTS - 1) {
                const avgTime = total_call_time / (i + 1 - errors);
                const tps = (i + 1 - errors) / (total_call_time / 1000);

                const progress =
                    `[${i + 1}/${NUM_REQUESTS}] | ` +
                    `Errors: ${errors} | ` +
                    `Avg Time: ${avgTime.toFixed(2)} ms | ` +
                    `Min Time: ${min_time.toFixed(2)} ms | ` +
                    `Max Time: ${max_time.toFixed(2)} ms | ` +
                    `TPS: ${tps.toFixed(2)}`;
                if (process.stdout.isTTY) process.stdout.write(`\r${progress}`);
                else common.log(progress);
            }
        }
    }
    const workers = Array.from({ length: batch_size }, () => worker());
    await Promise.all(workers);

    const end_time = process.hrtime(start_time);
    const total_elapsed_time = end_time[0] * 1000 + end_time[1] / 1e6;
    const successful = NUM_REQUESTS - errors;
    const avg_time = successful === 0 ? 0 : total_elapsed_time / successful;
    const tps = successful === 0 ? 0 : successful / (total_elapsed_time / 1000);

    common.print_summary('Benchmark results', [
        ['Total requests', NUM_REQUESTS],
        ['Successful', successful],
        ['Failed', errors],
        ['Total time', `${total_elapsed_time.toFixed(2)} ms`],
        ['Average time per request', `${avg_time.toFixed(2)} ms`],
        ['Min time', successful ? `${min_time.toFixed(2)} ms` : 'N/A'],
        ['Max time', successful ? `${max_time.toFixed(2)} ms` : 'N/A'],
        ['Estimated TPS', tps.toFixed(2)]
    ]);
}

export async function drop(
    mint: PublicKey,
    drop: Keypair,
    airdrop_path: string,
    presale_path: string,
    airdrop_percent: number = 0,
    presale_percent: number = 0
): Promise<void> {
    const mint_meta = await trade.get_token_meta(mint);
    if (!mint_meta) throw new Error(`Mint metadata not found`);

    let token_balance: number = 0;
    try {
        const balance = await trade.get_token_balance(
            drop.publicKey,
            mint_meta.mint,
            COMMITMENT,
            mint_meta.token_program
        );
        token_balance = balance.uiAmount || 0;
        common.print_summary('Token drop', [
            ['Mint', mint.toBase58()],
            ['Token', `${mint_meta.token_name} (${mint_meta.token_symbol})`],
            ['Wallet', drop.publicKey.toBase58()],
            ['Balance', `${token_balance} ${mint_meta.token_symbol}`],
            ['Airdrop', `${airdrop_percent * 100}%`],
            ['Presale', `${presale_percent * 100}%`]
        ]);
    } catch (err) {
        throw new Error('Failed to get dropper balance');
    }

    await token_drop.execute(
        drop,
        token_balance,
        mint_meta,
        airdrop_percent,
        presale_percent,
        airdrop_path,
        presale_path
    );
}

export async function create_lta(wallet: common.Wallet): Promise<void> {
    common.print_summary('Create address lookup table', [['Authority', wallet.keypair.publicKey.toBase58()]]);

    let [lta, create_sig] = await trade.create_lta(wallet.keypair);
    common.print_summary(common.green('Address lookup table created'), [
        ['Address', lta.toBase58()],
        ['Signature', String(create_sig)]
    ]);
}

export async function extend_lta(wallet: common.Wallet, lta: PublicKey, address_file_path: any): Promise<void> {
    const addresses = common.read_pubkeys(address_file_path);
    if (addresses.length === 0) throw new Error('No addresses provided.');

    common.print_summary('Extend address lookup table', [
        ['Authority', wallet.keypair.publicKey.toBase58()],
        ['Lookup table', lta.toBase58()],
        ['Addresses to add', addresses.length]
    ]);

    const extend_sigs = await trade.extend_lta(lta, wallet.keypair, addresses);
    common.print_summary(common.green('Address lookup table extended'), [['Signatures', extend_sigs.join('\n')]]);
}

export async function deactivate_ltas(wallet: common.Wallet): Promise<void> {
    common.print_summary('Deactivate address lookup tables', [['Authority', wallet.keypair.publicKey.toBase58()]]);

    const ltas = await trade.get_ltas_by_authority(wallet.keypair.publicKey, true);
    if (ltas.length === 0) throw new Error('No Active Address Lookup Tables found for the authority.');
    common.log(`Found ${ltas.length} active address lookup tables.`);

    const deactivate_sigs = await trade.deactivate_ltas(wallet.keypair, ltas);

    common.print_summary(common.green('Address lookup tables deactivated'), [
        ['Signatures', deactivate_sigs.join('\n')],
        ['Lookup tables', ltas.map((lta) => lta.key.toBase58()).join('\n')]
    ]);
}

export async function close_ltas(wallet: common.Wallet): Promise<void> {
    common.print_summary('Close address lookup tables', [['Authority', wallet.keypair.publicKey.toBase58()]]);

    const ltas = await trade.get_ltas_by_authority(wallet.keypair.publicKey, false);
    if (ltas.length === 0) throw new Error('No Deactivated Address Lookup Tables found for the authority.');
    common.log(`Found ${ltas.length} deactivated address lookup tables.`);

    const close_sigs = await trade.close_ltas(wallet.keypair, ltas);

    common.print_summary(common.green('Address lookup tables closed'), [
        ['Signatures', close_sigs.join('\n')],
        ['Lookup tables', ltas.map((lta) => lta.key.toBase58()).join('\n')]
    ]);
}

export async function get_sender_endpoint(): Promise<void> {
    common.log(common.bold('Measuring Sender endpoint latency...'));

    const measure_latency = async (url: string, samples: number = 5): Promise<number> => {
        const m: number[] = [];

        for (let i = 0; i < samples; i++) {
            const start = performance.now();

            try {
                const res = await fetch(url, {
                    method: 'GET',
                    signal: AbortSignal.timeout(5000)
                });
                if (!res.ok) throw new Error(`HTTP: ${res.status}`);
                m.push(performance.now() - start);
            } catch {
                m.push(Infinity);
            }
        }

        m.sort((a, b) => a - b);
        return m[Math.floor(m.length / 2)];
    };

    const results = await Promise.all(
        SENDER_BENCHMARK_ENDPOINTS.map(async (e) => ({
            endpoint: e,
            latency: await measure_latency(`${e}/ping`)
        }))
    );

    results.sort((a, b) => a.latency - b.latency);
    const endpoint_width = Math.max('Endpoint'.length, ...results.map((result) => result.endpoint.length));
    const latency_width = 12;
    common.print_header([
        { title: 'Endpoint', width: endpoint_width },
        { title: 'Latency', width: latency_width, align: 'right' }
    ]);
    for (const result of results) {
        common.print_row([
            { content: result.endpoint, width: endpoint_width },
            {
                content: Number.isFinite(result.latency) ? `${result.latency.toFixed(2)} ms` : 'Unavailable',
                width: latency_width,
                align: 'right'
            }
        ]);
    }
    common.print_footer([{ width: endpoint_width }, { width: latency_width }]);
    if (!Number.isFinite(results[0].latency)) {
        common.warn('No Sender endpoints responded.');
        return;
    }
    const https_endpoint = results.find(
        (result) => result.endpoint.startsWith('https:') && Number.isFinite(result.latency)
    );
    const selection: [string, string][] = [['Fastest', `${results[0].endpoint} (${results[0].latency.toFixed(2)} ms)`]];
    if (https_endpoint) {
        selection.push(
            ['HTTPS routing', `${https_endpoint.endpoint} (${https_endpoint.latency.toFixed(2)} ms)`],
            ['Set in .env', `SENDER_ENDPOINT=${https_endpoint.endpoint}`]
        );
    }
    common.log('');
    common.print_summary('Sender endpoint selection', selection);
    if (!https_endpoint) {
        common.warn('No HTTPS Sender endpoint responded; existing configuration is unchanged.');
    }
}
