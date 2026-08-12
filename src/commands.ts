import { Keypair, PublicKey, LAMPORTS_PER_SOL, Connection, TokenAmount, Signer } from '@solana/web3.js';
import { createWriteStream, existsSync, readFileSync } from 'fs';
import bs58 from 'bs58';
import {
    COMMANDS_BUY_SLIPPAGE,
    COMMANDS_INTERVAL_MS,
    COMMANDS_SELL_SLIPPAGE,
    COMMITMENT,
    HELIUS_RPC,
    PriorityLevel,
    TRADE_MAX_WALLETS_PER_CREATE_BUNDLE,
    WALLETS_FILE_HEADERS
} from './constants';
import * as common from './common/common';
import * as trade from './common/trade_common';
import * as transfers from './subcommands/transfers';
import * as volume from './subcommands/volume';
import * as token_drop from './subcommands/token_drop';
import * as pnl from './subcommands/pnl';
import * as mass_trade from './subcommands/mass_trade';
import { get_trader, get_sniper } from './common/get_trader';

export async function burn_token(mint: PublicKey, burner: Signer, amount?: number, percent?: number): Promise<void> {
    if (!amount && !percent) throw new Error('Either amount or percent should be provided.');
    if (amount && percent) throw new Error('Only one of amount or percent should be provided.');
    if (amount && amount <= 0) throw new Error('Amount should be greater than 0.');
    if (percent && (percent <= 0 || percent > 1)) throw new Error('Percent should be between 0 and 1.');

    const mint_meta = await trade.get_token_meta(mint);
    if (!mint_meta) throw new Error(`Mint metadata not found for the mint: ${mint.toString()}.`);

    common.log(common.yellow(`Burning the token by the mint ${mint.toString()}...`));
    common.log(
        common.yellow(`Burning ${amount ? `${amount} tokens` : `${percent! * 100}% of $${mint_meta.token_symbol}`}...`)
    );

    const token_amount = await trade.get_token_balance(burner.publicKey, mint, COMMITMENT, mint_meta.token_program);
    common.log(
        common.bold(
            `\nBurner address: ${burner.publicKey.toString()} | Balance: ${token_amount.uiAmount || 0} tokens\n`
        )
    );
    if (!token_amount || token_amount.uiAmount === 0 || !token_amount.uiAmount) throw new Error('No tokens to burn');

    const amount_to_burn = amount
        ? trade.get_token_amount(amount, mint_meta.token_decimal)
        : trade.get_token_amount_by_percent(token_amount, percent!);

    trade
        .burn_token(amount_to_burn, burner, mint)
        .then((signature) => common.log(common.green(`Transaction completed, signature: ${signature}`)))
        .catch((error) => common.error(common.red(`Transaction failed: ${error.message}`)));
}

export async function clean(wallets: common.Wallet[], burn: boolean = false): Promise<void> {
    if (wallets.length === 0) throw new Error('No wallets available.');

    common.log(common.yellow(`${burn ? 'Burning tokens and closing' : 'Closing'} token accounts for the wallets...`));
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
                    common.log(`Cleaning ${closer.publicKey.toString().padEnd(44, ' ')} (${wallet.name})...`);
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
                        common.log(
                            `${closer.publicKey.toString().padEnd(44, ' ')} (${wallet.name}) | ${result.count} accounts closed after ${result.attempts} attempts | Signature ${result.signature}`
                        );
                    }
                    for (const failure of failures) {
                        common.error(
                            common.red(
                                `${closer.publicKey.toString().padEnd(44, ' ')} (${wallet.name}) | Failed to close ${failure.count} accounts after ${failure.attempts} attempts: ${failure.error}`
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
                        common.log(
                            `${closer.publicKey.toString().padEnd(44, ' ')} (${wallet.name}) | No accounts to close`
                        );
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

    common.log(
        common.bold(`\nTotal closed accounts: ${total_closed_cnt} | Total failed accounts: ${total_failed_cnt}`)
    );

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
}

export async function claim_dev_fees(
    wallets: common.Wallet[],
    program: common.Program,
    dry_run: boolean,
    priority?: PriorityLevel
): Promise<void> {
    if (wallets.length === 0) throw new Error('No wallets available.');
    const trader = get_trader(program);
    let total_fees = 0;
    for (const wallet of wallets) {
        try {
            const result = await trader.claim_dev_fees(wallet.keypair, dry_run, priority);
            total_fees += result.fees;
            if (result.fees === 0) continue;

            const prefix = `${wallet.id} ${wallet.keypair.publicKey.toString()} (${wallet.name})`;
            if (dry_run) common.log(`${prefix}: ${result.fees} SOL available`);
            else common.log(common.green(`${prefix}: claimed ${result.fees} SOL, signature: ${result.signature}`));
        } catch (error) {
            common.error(common.red(`Failed to claim dev fees for ${wallet.name}: ${error}`));
        }
        await common.sleep(COMMANDS_INTERVAL_MS);
    }
    common.log(common.bold(`${dry_run ? 'Available' : 'Claimed'} dev fees: ${total_fees} SOL`));
}

export async function create_token_metadata(
    json: common.IPFSMetadata,
    image_path: string,
    program = common.Program.Pump
) {
    const trader = get_trader(program);
    common.log(common.yellow('Uploading metadata...'));
    common.log(JSON.stringify(json, null, 2));
    const cid = await trader.create_token_metadata(json, image_path);
    common.log(`CID: ${common.bold(cid)}`);
}

export async function create_token(
    meta_cid: string,
    dev: common.Wallet,
    program: common.Program = common.Program.Pump,
    dev_buy?: number,
    mint?: Keypair,
    wallets?: common.Wallet[],
    min?: number,
    max?: number,
    bundle_tip?: number,
    config?: object
): Promise<void> {
    if (wallets && (wallets.length === 0 || wallets.length > TRADE_MAX_WALLETS_PER_CREATE_BUNDLE))
        throw new Error(
            `Invalid wallet count: ${wallets.length}. The number of wallets should be between 1 and ${TRADE_MAX_WALLETS_PER_CREATE_BUNDLE}`
        );
    if (bundle_tip && !wallets) throw new Error('Bundle tip is only available for bundle buy.');
    if (wallets && !bundle_tip) throw new Error('Bundle tip is required for bundle buy.');
    if (wallets && (!min || !max)) throw new Error('Both min and max should be provided, when bundle buy is enabled.');

    common.log('Creating a token...\n');
    dev_buy = dev_buy || 0;

    const trader = get_trader(program);
    const balance = (await trade.get_balance(dev.keypair.publicKey, COMMITMENT)) / LAMPORTS_PER_SOL;
    const meta = await common.fetch_ipfs_json(meta_cid);

    if (dev_buy && dev_buy > balance) throw new Error(`Dev balance is not enough to buy for ${dev_buy} SOL`);

    common.log(common.yellow(`Dev: ${dev.keypair.publicKey.toString()} | Balance: ${balance.toFixed(2)} SOL`));
    common.log(common.bold(`Dev Buy: ${dev_buy.toFixed(2)} SOL\n`));

    let entries: [Signer, number][] | undefined;
    if (wallets) {
        common.log(common.yellow('Bundle buy'));
        common.log(common.bold(`Wallets count: ${wallets.length} | Amounts between ${min} and ${max} SOL...`));
        entries = wallets.map((w) => [w.keypair, common.uniform_random(min ?? 0, max ?? 0)]);
    }

    mint = mint || Keypair.generate();
    common.log(common.yellow(`\nMint address: ${mint.publicKey.toString()}`));
    common.log(common.yellow(`Token Name: ${meta.name} | Symbol: $${meta.symbol}`));
    common.log(common.bold(`Token Meta: ${JSON.stringify(meta, null, 2)}`));

    try {
        const sig = await trader.create_token(
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
        common.log(common.green(`\nToken created | Signature: ${sig}`));
        common.log(common.green(`Mint address: ${mint.publicKey.toBase58()}`));
    } catch (error) {
        throw new Error(`Failed to create token: ${error}`);
    }
}

export async function promote(
    times: number,
    meta_cid: string,
    dev: Keypair,
    program: common.Program = common.Program.Pump
): Promise<void> {
    common.log(common.yellow(`Creating ${times} tokens with CID ${meta_cid}...\n`));

    const trader = get_trader(program);
    const balance = (await trade.get_balance(dev.publicKey, COMMITMENT)) / LAMPORTS_PER_SOL;
    const meta = await common.fetch_ipfs_json(meta_cid);

    common.log(common.bold(`Dev address: ${dev.publicKey.toString()} | Balance: ${balance.toFixed(5)} SOL`));
    common.log(common.bold(`Token name: ${meta.name} | Symbol: ${meta.symbol}\n`));

    const transactions = [];

    while (times > 0) {
        const mint = Keypair.generate();
        transactions.push(
            trader
                .create_token(mint, dev, meta.name, meta.symbol, meta_cid)
                .then(([sig, mint]) =>
                    common.log(common.green(`Signature: ${sig.toString().padEnd(88, ' ')} | Mint: ${mint}`))
                )
                .catch((error) => common.error(common.red(`Transaction failed: ${error.message}`)))
        );
        times--;
        await common.sleep(COMMANDS_INTERVAL_MS);
    }

    await Promise.allSettled(transactions);
}

export async function token_balance(wallets: common.Wallet[], mint: PublicKey): Promise<void> {
    if (wallets.length === 0) throw new Error('No wallets available.');
    const sol_price = await common.fetch_sol_price();

    common.log(common.yellow(`Getting the token balance of the wallets by the mint ${mint.toString()}...`));

    let decimals, supply, supply_raw;
    let token_name, token_symbol;
    let token_program;

    try {
        ({ token_name, token_symbol, token_program } = await trade.get_token_meta(mint));
        ({ supply: supply_raw, decimals } = await trade.get_token_supply(mint));
        supply = Number(supply_raw);
    } catch (error) {
        throw new Error(`Failed to get the token information: ${error}`);
    }
    const [token_balances, cost_basiss] = await Promise.all([
        Promise.all(
            wallets.map((wallet) => trade.get_token_balance(wallet.keypair.publicKey, mint, COMMITMENT, token_program))
        ),
        Promise.all(
            wallets.map((wallet) => trade.get_cost_basis(wallet.keypair.publicKey, mint, COMMITMENT, token_program))
        )
    ]);

    const wallet_count = cost_basiss.filter((cb) => cb).length;
    common.log(common.yellow(`Token: ${token_name} | Symbol: $${token_symbol}`));
    common.log(common.green(`Wallet Count: ${wallet_count}\n`));

    common.print_header([
        { title: 'Id', width: common.COLUMN_WIDTHS.id },
        { title: 'Name', width: common.COLUMN_WIDTHS.name },
        { title: 'Public Key', width: common.COLUMN_WIDTHS.publicKey },
        { title: 'Allocation', width: common.COLUMN_WIDTHS.allocation, align: 'right' },
        { title: `$${token_symbol} Balance`, width: common.COLUMN_WIDTHS.tokenBalance, align: 'right' },
        { title: `Entry MC`, width: common.COLUMN_WIDTHS.entryMcap, align: 'right' }
    ]);

    let total_tokens_all = 0;
    let total_tokens_cur = 0;
    let total_spendings_all = 0;
    let total_spendings_cur = 0;
    let total_fees_all = 0;
    let total_fees_cur = 0;

    for (let i = 0; i < wallets.length; i++) {
        const wallet = wallets[i];
        const cost_basis = cost_basiss[i];
        const ui_balance = token_balances[i].uiAmount || 0;
        if (!cost_basis) continue;

        const entry_mcap = (((cost_basis.average_cost_basis * supply) / 10 ** decimals) * sol_price) / 1000;
        const alloc = (ui_balance / (supply / 10 ** decimals)) * 100;

        total_tokens_cur += ui_balance;
        total_tokens_all += cost_basis.total_tokens;
        total_spendings_all += cost_basis.total_spendings;
        if (ui_balance > 0) total_spendings_cur += cost_basis.total_spendings;
        total_fees_all += cost_basis.total_fees;
        if (ui_balance > 0) total_fees_cur += cost_basis.total_fees;

        common.print_row([
            { content: wallet.id.toString(), width: common.COLUMN_WIDTHS.id },
            { content: common.format_name(wallet.name), width: common.COLUMN_WIDTHS.name },
            { content: wallet.keypair.publicKey.toString(), width: common.COLUMN_WIDTHS.publicKey },
            { content: `${alloc.toFixed(2)}%`, width: common.COLUMN_WIDTHS.allocation, align: 'right' },
            { content: ui_balance.toFixed(2), width: common.COLUMN_WIDTHS.tokenBalance, align: 'right' },
            {
                content: `${entry_mcap.toFixed(1)}K$`,
                width: common.COLUMN_WIDTHS.entryMcap,
                align: 'right'
            }
        ]);
    }

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

    common.log('\nALL:');
    common.log(`    Average Entry MC: ${common.bold(average_entry_mcap_all.toFixed(1) + 'K$')}`);
    common.log(`    Total Balance: ${common.bold(common.format_currency(total_tokens_all))} ${token_symbol}`);
    common.log(`    Total Cost: ${common.red(common.format_currency(total_spendings_all) + ' SOL')}`);
    common.log(`    Total Allocation: ${common.bold(allocation_all.toFixed(2) + '%')}`);

    common.log('\nCURRENT:');
    common.log(`    Average Entry MC: ${common.bold(average_entry_mcap_cur.toFixed(1) + 'K$')}`);
    common.log(`    Total Balance: ${common.bold(common.format_currency(total_tokens_cur))} ${token_symbol}`);
    common.log(`    Total Cost: ${common.red(common.format_currency(total_spendings_cur) + ' SOL')}`);
    common.log(`    Total Allocation: ${common.bold(allocation_cur.toFixed(2) + '%')}\n`);
}

export async function transfer_sol(amount: number, receiver: PublicKey, sender: Keypair): Promise<void> {
    if (sender.publicKey.equals(receiver)) throw new Error('Sender and receiver addresses are the same.');
    common.log(
        common.yellow(`Transferring ${amount} SOL from ${sender.publicKey.toString()} to ${receiver.toString()}...`)
    );
    const balance = await trade.get_balance(sender.publicKey, COMMITMENT);
    if (balance < amount * LAMPORTS_PER_SOL) throw new Error(`Sender balance is not enough to transfer ${amount} SOL`);
    trade
        .send_lamports(amount * LAMPORTS_PER_SOL, sender, receiver, PriorityLevel.HIGH)
        .then((signature) => common.log(common.green(`Transaction completed, signature: ${signature}`)))
        .catch((error) => common.error(common.red(`Transaction failed: ${error.message}`)));
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

    common.log(
        common.yellow(
            `Transferring ${amount} $${mint_meta.token_symbol} from ${sender.publicKey.toString()} to ${receiver.toString()}...`
        )
    );

    const token_balance = await trade.get_token_balance(sender.publicKey, mint, COMMITMENT, mint_meta.token_program);
    if (!token_balance.uiAmount) throw new Error(`Sender has no token balance for ${mint_meta.token_name}`);
    if (token_balance.uiAmount < amount)
        throw new Error(`Sender balance is not enough to transfer ${amount} $${mint_meta.token_symbol}`);

    trade
        .send_tokens(trade.get_token_amount(amount, mint_meta.token_decimal), mint, sender, receiver)
        .then((signature) => common.log(common.green(`Transaction completed, signature: ${signature}`)))
        .catch((error) => common.error(common.red(`Transaction failed: ${error.message}`)));
}

export async function balance(wallets: common.Wallet[], format: 'csv' | 'table'): Promise<void> {
    if (wallets.length === 0) throw new Error('No wallets available.');

    let total = 0;
    common.log(common.yellow('Getting the balance of the wallets...'));
    common.log(common.yellow(`Wallet Count: ${wallets.length}\n`));

    const balances = await Promise.all(
        wallets.map((wallet) => trade.get_balance(wallet.keypair.publicKey, COMMITMENT))
    );

    if (format === 'csv') {
        common.log(common.yellow('Wallet Id,Name,Public Key,SOL Balance'));
        for (let i = 0; i < wallets.length; i++) {
            const wallet = wallets[i];
            const balance = balances[i] / LAMPORTS_PER_SOL;
            total += balance;
            common.log(
                `${wallet.id.toString().concat(wallet.is_reserve ? '*' : '')},${common.format_name(wallet.name)},${wallet.keypair.publicKey.toString()},${balance.toFixed(9)}`
            );
        }
        common.log(`\nTotal balance: ${common.bold(common.format_currency(total) + ' SOL')}\n`);
    } else if (format === 'table') {
        common.print_header([
            { title: 'Id', width: common.COLUMN_WIDTHS.id },
            { title: 'Name', width: common.COLUMN_WIDTHS.name },
            { title: 'Public Key', width: common.COLUMN_WIDTHS.publicKey },
            { title: 'SOL Balance', width: common.COLUMN_WIDTHS.solBalance, align: 'right' }
        ]);

        for (let i = 0; i < wallets.length; i++) {
            const wallet = wallets[i];
            const balance = balances[i] / LAMPORTS_PER_SOL;
            total += balance;

            common.print_row([
                { content: wallet.id.toString().concat(wallet.is_reserve ? '*' : ''), width: common.COLUMN_WIDTHS.id },
                { content: common.format_name(wallet.name), width: common.COLUMN_WIDTHS.name },
                { content: wallet.keypair.publicKey.toString(), width: common.COLUMN_WIDTHS.publicKey },
                { content: balance.toFixed(9), width: common.COLUMN_WIDTHS.solBalance, align: 'right' }
            ]);
        }

        common.print_footer([
            { width: common.COLUMN_WIDTHS.id },
            { width: common.COLUMN_WIDTHS.name },
            { width: common.COLUMN_WIDTHS.publicKey },
            { width: common.COLUMN_WIDTHS.solBalance }
        ]);

        common.log(`\nTotal balance: ${common.bold(common.format_currency(total) + ' SOL')}\n`);
    }
}

export async function sell_token_once(
    mint: PublicKey,
    seller: Keypair,
    percent?: number,
    slippage?: number,
    protection_tip?: number,
    priority: PriorityLevel = PriorityLevel.DEFAULT,
    program: common.Program = common.Program.Pump
): Promise<void> {
    slippage = slippage || COMMANDS_SELL_SLIPPAGE;
    percent = percent || 1.0;
    const trader = get_trader(program);
    const mint_meta = await trader.get_mint_meta(mint);
    if (!mint_meta) throw new Error(`Mint metadata not found for program: ${program}.`);

    common.log(common.yellow(`Selling the token by the mint ${mint.toString()}...`));
    common.log(common.yellow(`Selling ${percent * 100}% of the tokens...`));
    const token_amount = await trade.get_token_balance(seller.publicKey, mint, COMMITMENT, mint_meta.token_program);
    common.log(
        common.bold(
            `\nSeller address: ${seller.publicKey.toString()} | Balance: ${token_amount.uiAmount || 0} tokens\n`
        )
    );
    if (!token_amount || token_amount.uiAmount === 0 || !token_amount.uiAmount) throw new Error('No tokens to sell');

    const token_amount_to_sell = trade.get_token_amount_by_percent(token_amount, percent);
    common.log(
        `Selling ${token_amount_to_sell.uiAmount} tokens from ${seller.publicKey.toString().padEnd(44, ' ')}...`
    );

    trader
        .sell_token(token_amount_to_sell, seller, mint_meta, slippage, priority, protection_tip)
        .then((signature) => common.log(common.green(`Transaction completed, signature: ${signature}`)))
        .catch((error) => common.error(common.red(`Transaction failed: ${error.message}`)));
}

export async function buy_token_once(
    amount: number,
    mint: PublicKey,
    buyer: Keypair,
    slippage?: number,
    protection_tip?: number,
    priority: PriorityLevel = PriorityLevel.DEFAULT,
    program: common.Program = common.Program.Pump
): Promise<void> {
    slippage = slippage || COMMANDS_BUY_SLIPPAGE;
    const trader = get_trader(program);
    const mint_meta = await trader.get_mint_meta(mint);
    if (!mint_meta) throw new Error(`Mint metadata not found for program: ${program}.`);

    common.log(common.yellow(`Buying ${amount} SOL of the token with mint ${mint.toString()}...`));

    const balance = (await trade.get_balance(buyer.publicKey, COMMITMENT)) / LAMPORTS_PER_SOL;
    common.log(common.bold(`\nBuyer address: ${buyer.publicKey.toString()} | Balance: ${balance.toFixed(5)} SOL\n`));
    if (balance < amount) throw new Error(`Buyer balance is not enough to buy ${amount} SOL`);

    trader
        .buy_token(amount, buyer, mint_meta, slippage, priority, protection_tip)
        .then((signature) => common.log(common.green(`Transaction completed, signature: ${signature}`)))
        .catch((error) => common.error(common.red(`Transaction failed: ${error.message}`)));
}

export async function warmup(
    wallets: common.Wallet[],
    priority: PriorityLevel = PriorityLevel.DEFAULT,
    program: common.Program = common.Program.Pump,
    bundle_tip?: number,
    interval?: number,
    min?: number,
    max?: number
): Promise<void> {
    const get_random_mints = async (trader: trade.IProgramTrader, count: number) => {
        let mints = [];
        do {
            mints = await trader.get_random_mints(count);
            if (mints.length < count) await common.sleep(2000);
        } while (mints.length < count);
        return mints;
    };

    min = min || 1;
    max = max || 5;
    const slippage = COMMANDS_BUY_SLIPPAGE;

    if (wallets.length === 0) throw new Error('No wallets available.');
    if (max < min) throw new Error('Invalid min and max values.');
    if (interval && bundle_tip) throw new Error('Interval and bundle tip cannot be used together.');

    common.log(common.yellow(`Warming up ${wallets.length} accounts...`));

    const token_cnts = Array.from({ length: wallets.length }, () => Math.floor(Math.random() * (max - min) + min));
    if (token_cnts.length !== wallets.length) throw new Error();
    const trader = get_trader(program);

    for (const [i, wallet] of wallets.entries()) {
        const buyer = wallet.keypair;

        const balance = await trade.get_balance(buyer.publicKey, COMMITMENT);
        if (balance === 0) {
            common.error(
                common.red(
                    `No balance for ${buyer.publicKey.toString().padEnd(44, ' ')} (${wallet.name}), skipping...\n`
                )
            );
            continue;
        }

        const mints = await get_random_mints(trader, token_cnts[i]);
        common.log(
            common.yellow(
                `\nWarming up ${buyer.publicKey.toString().padEnd(44, ' ')} with ${token_cnts[i]} tokens ${wallet.name} (${wallet.id})...`
            )
        );
        for (const mint of mints) {
            let amount = parseFloat(common.uniform_random(0.05, 0.25).toFixed(4));
            common.log(
                `Warming up with ${amount} SOL of the token '${mint.token_name}' with mint ${mint.token_mint}...`
            );
            try {
                if (bundle_tip) {
                    const signature = await trader.buy_sell_bundle(amount, buyer, mint, bundle_tip, 0.5, priority);
                    common.log(common.green(`Bundle completed for ${wallet.name}, signature: ${signature}`));
                } else {
                    const [buy_sig, sell_sig] = await trader.buy_sell(
                        amount,
                        buyer,
                        mint,
                        slippage,
                        interval ? interval * 1000 : undefined,
                        priority
                    );
                    common.log(
                        common.green(
                            `Trade completed for ${wallet.name}\nBuy signature: ${buy_sig}\nSell signature: ${sell_sig}`
                        )
                    );
                }
            } catch (error) {
                common.log(
                    common.red(
                        `Failed to trade token '${mint.token_name}' for ${wallet.name} (${wallet.id}), continuing...`
                    )
                );
            }
        }
    }
}

export async function collect(wallets: common.Wallet[], receiver: PublicKey): Promise<void> {
    if (wallets.length === 0) throw new Error('No wallets available.');

    common.log(common.yellow(`Collecting all the SOL from the accounts...`));
    common.log(common.yellow(`Receiver address: ${receiver.toString()}\n`));

    const transactions = [];
    for (const wallet of wallets) {
        const sender = wallet.keypair;
        const amount = await trade.get_balance(sender.publicKey, COMMITMENT);
        if (amount === 0 || receiver.equals(sender.publicKey)) continue;

        common.log(
            `Collecting ${amount / LAMPORTS_PER_SOL} SOL from ${sender.publicKey.toString().padEnd(44, ' ')} (${wallet.name})...`
        );
        transactions.push(
            trade
                .send_lamports(amount, sender, receiver, PriorityLevel.HIGH)
                .then((signature) =>
                    common.log(common.green(`Transaction completed for ${wallet.name}, signature: ${signature}`))
                )
                .catch((error) => common.error(common.red(`Transaction failed for ${wallet.name}: ${error.message}`)))
        );
        await common.sleep(COMMANDS_INTERVAL_MS);
    }
    await Promise.allSettled(transactions);
}

export async function collect_token(wallets: common.Wallet[], mint: PublicKey, receiver: PublicKey): Promise<void> {
    if (wallets.length === 0) throw new Error('No wallets available.');

    const mint_meta = await trade.get_token_meta(mint);
    if (!mint_meta) throw new Error(`Mint metadata not found`);

    common.log(common.yellow(`Collecting $${mint_meta.token_symbol} from the accounts to ${receiver}...`));
    const transactions = [];

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

            common.log(
                `Collecting ${token_amount.uiAmount} tokens from ${sender.publicKey.toString().padEnd(44, ' ')} (${wallet.name})...`
            );
            transactions.push(
                trade
                    .send_tokens(token_amount, mint, sender, receiver)
                    .then((signature) =>
                        common.log(common.green(`Transaction completed for ${wallet.name}, signature: ${signature}`))
                    )
                    .catch((error) =>
                        common.error(common.red(`Transaction failed for ${wallet.name}: ${error.message}`))
                    )
            );
        } catch (error) {
            common.error(common.red(`Failed to collect the token from ${wallet.name}: ${error}`));
        }
        await common.sleep(COMMANDS_INTERVAL_MS);
    }
    await Promise.allSettled(transactions);
}

export async function buy_token(
    wallets: common.Wallet[],
    mint: PublicKey,
    priority: PriorityLevel = PriorityLevel.DEFAULT,
    program: common.Program = common.Program.Pump,
    protection_tip?: number,
    bundle_tip?: number,
    amount?: number,
    min?: number,
    max?: number,
    slippage?: number
): Promise<void> {
    const SLIPPAGE = slippage || COMMANDS_BUY_SLIPPAGE;

    if (protection_tip && bundle_tip) throw new Error('Protection tip and bundle tip cannot be used together.');
    if (wallets.length === 0) throw new Error('No wallets available.');
    if (!amount && (!min || !max)) throw new Error('Either amount or min and max should be provided.');
    if ((min && !max) || (!min && max)) throw new Error('Both min and max should be provided.');
    if (max && min && max < min) throw new Error('Invalid min and max values.');

    const trader = get_trader(program);
    const entries: [common.Wallet, number][] = wallets.map((w) => [
        w,
        amount || common.uniform_random(min ?? 0, max ?? 0)
    ]);
    let mint_meta = await trader.get_mint_meta(mint);
    if (!mint_meta) throw new Error(`Mint metadata not found for program: ${program}.`);
    common.log(common.yellow(`Buying the tokens by the mint ${mint.toString()}...`));

    if (!bundle_tip) return await mass_trade.seq_buy(mint_meta, entries, trader, SLIPPAGE, priority, protection_tip);
    return await mass_trade.bundle_buy(mint_meta, entries, trader, SLIPPAGE, bundle_tip, priority);
}

export async function sell_token(
    wallets: common.Wallet[],
    mint: PublicKey,
    priority: PriorityLevel = PriorityLevel.DEFAULT,
    program: common.Program = common.Program.Pump,
    protection_tip?: number,
    bundle_tip?: number,
    percent?: number,
    slippage?: number
): Promise<void> {
    slippage = slippage || COMMANDS_SELL_SLIPPAGE;
    percent = percent || 1.0;

    if (protection_tip && bundle_tip) throw new Error(' Protection tip and bundle tip cannot be used together.');
    if (wallets.length === 0) throw new Error('No wallets available.');
    const trader = get_trader(program);
    let mint_meta = await trader.get_mint_meta(mint);
    if (!mint_meta) throw new Error(`Mint metadata not found for program: ${program}.`);

    common.log(common.yellow(`Selling all the tokens from the accounts by the mint ${mint.toString()}...`));
    common.log(common.yellow(`Selling ${percent * 100}% of the tokens...\n`));

    if (!bundle_tip)
        return await mass_trade.seq_sell(mint_meta, wallets, trader, percent, slippage, priority, protection_tip);
    return await mass_trade.bundle_sell(mint_meta, wallets, trader, percent, slippage, bundle_tip, priority);
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

    const balance = (await trade.get_balance(funder.publicKey, COMMITMENT)) / LAMPORTS_PER_SOL;
    common.log(common.yellow(`Funder address: ${funder.publicKey.toString()} | Balance: ${balance.toFixed(5)} SOL\n`));
    if (balance < total_amount) {
        throw new Error(`Payer balance is not enough to top up ${total_amount} SOL to ${wallets.length} wallets`);
    }

    if (is_random) {
        common.log(common.yellow(`Funding random amounts of SOL to every ${wallets.length} wallet...`));
        amounts = common.random_amounts(total_amount, wallets.length);
    } else {
        common.log(common.yellow(`Funding ${amount} SOL to every ${wallets.length} wallet...`));
        amounts = Array.from({ length: wallets.length }, () => amount);
    }

    if (is_spider) {
        common.log('Running spider:\n');
        const rescue_wallets = await transfers.execute_spider_fund_sol(wallets, amount, funder);
        common.log(`\nPerforming cleanup of the temporary wallets...\n`);
        await collect(rescue_wallets, funder.publicKey);
        return;
    }

    if (depth && bundle_tip) {
        common.log(`Running fund with depth ${depth}:\n`);
        const rescue_wallets = await transfers.execute_depth_sol_fund(
            common.zip(wallets, amounts),
            funder,
            depth,
            bundle_tip
        );
        common.log(`\nPerforming cleanup of the temporary wallets...\n`);
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
    common.log(
        common.yellow(
            `Distributer address: ${funder.publicKey.toString()} | Balance: ${balance.uiAmount.toFixed(5)} $${mint_meta.token_symbol}\n`
        )
    );
    const total_amount = balance.uiAmount * percent;

    if (is_random) {
        common.log(
            common.yellow(
                `Distributing random amount of $${mint_meta.token_symbol} to every ${wallets.length} wallet...`
            )
        );
        amounts = common
            .random_amounts(total_amount, wallets.length)
            .map((amount) => trade.get_token_amount(amount, mint_meta.token_decimal));
    } else {
        const amount = total_amount / wallets.length;
        common.log(
            common.yellow(`Distributing ${amount} $${mint_meta.token_symbol} to every ${wallets.length} wallet...`)
        );
        amounts = Array.from({ length: wallets.length }, () => trade.get_token_amount(amount, mint_meta.token_decimal));
    }

    if (depth && bundle_tip) {
        common.log(`Running distribute with depth ${depth}:\n`);
        const rescue_wallets = await transfers.execute_depth_dist_token(
            common.zip(wallets, amounts),
            mint_meta,
            funder,
            depth,
            bundle_tip
        );
        common.log(`\nPerforming cleanup of the temporary wallets...\n`);
        await collect(rescue_wallets, funder.publicKey);
        return;
    }

    await transfers.execute_dist_token(common.zip(wallets, amounts), mint_meta, funder);
}

export async function snipe(
    wallets: common.Wallet[],
    program: common.Program = common.Program.Pump,
    json_config?: object
): Promise<void> {
    if (wallets.length === 0) throw new Error('No wallets available.');

    const sol_price = await common.fetch_sol_price();
    const sniper = get_sniper(program);
    await sniper.setup_config(wallets.length, json_config);
    await sniper.snipe(wallets, sol_price);
}

export function generate(
    file_path: string,
    create_reserve: boolean,
    count: number = 0,
    secrets_path?: string,
    index?: number
): void {
    common.log(common.yellow(`Generating ${count + (create_reserve ? 1 : 0)} keypairs...\n`));

    const wallets: Partial<common.Wallet>[] = [];
    const starting_index = index || 1;

    if (create_reserve) wallets.push({ keypair: Keypair.generate(), name: 'reserve', is_reserve: true });

    if (secrets_path && existsSync(secrets_path)) {
        const private_keys = readFileSync(secrets_path, 'utf8')
            .split('\n')
            .filter((i) => i);
        private_keys.forEach((wallet, i) => {
            if (wallet.length < 10) return;
            wallet = wallet.trim();
            try {
                const decoded_key = Array.from(bs58.decode(wallet));
                wallets.push({
                    keypair: Keypair.fromSecretKey(new Uint8Array(decoded_key)),
                    name: `wallet[${i + starting_index}]`,
                    is_reserve: false
                });
            } catch {
                throw new Error(`Invalid key at line ${i + 1}`);
            }
        });
    } else if (count) {
        for (let i = 0; i < count; i++)
            wallets.push({ keypair: Keypair.generate(), name: `wallet[${i + starting_index}]`, is_reserve: false });
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

    common.log(common.green('Wallet generation completed\n'));
}

export async function wallet_pnl(public_key: PublicKey): Promise<void> {
    const sol_price = await common.fetch_sol_price();

    common.log(common.yellow(`Getting the wallet ${public_key.toString()} PnL...`));
    common.log(`SOL price: $${common.format_currency(sol_price)}\n`);

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
            { content: `$${token.symbol}`, width: common.COLUMN_WIDTHS.name },
            { content: token.mint, width: common.COLUMN_WIDTHS.publicKey },
            {
                content: `${common.format_currency(unrealized_usd)}`,
                width: common.COLUMN_WIDTHS.solBalance,
                align: 'right'
            },
            {
                content: `${common.format_currency(realized_usd)}`,
                width: common.COLUMN_WIDTHS.solBalance,
                align: 'right'
            },
            {
                content: `${common.format_currency(total_profit_usd)}`,
                width: common.COLUMN_WIDTHS.solBalance,
                align: 'right'
            },
            { content: `${buy_cnt}/${sell_cnt}`, width: common.COLUMN_WIDTHS.solBalance, align: 'right' }
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

    let accent = total_realized > 0 ? common.green : common.red;
    common.log(`\nTotal Realized: ${accent('$' + common.format_currency(total_realized))}`);

    accent = total_unrealized > 0 ? common.green : common.red;
    common.log(`Total Unrealized: ${accent('$' + common.format_currency(total_unrealized))}`);

    accent = total >= 0 ? common.green : common.red;
    common.log(
        `Total Profit: ${accent('$' + common.format_currency(total))} | ${accent(common.format_currency(total / sol_price) + ' SOL')}`
    );

    accent = total_pnl > 0 ? common.green : common.red;
    common.log(`Total PnL: ${accent(total_pnl.toFixed(2) + '%')}\n`);
}

export async function start_volume(
    funder: Keypair,
    program: common.Program = common.Program.Pump,
    simulate: boolean = false,
    json_config?: object
): Promise<void> {
    const trader = get_trader(program);
    const volume_config = await volume.setup_config(json_config);
    const volume_type_name = volume.VolumeType[volume_config.type];

    if (simulate) {
        const sol_price = await common.fetch_sol_price();
        const funder_balance = (await trade.get_balance(funder.publicKey, COMMITMENT)) / LAMPORTS_PER_SOL;
        common.log(common.yellow(`Simulating the ${volume_type_name} Volume Bot...\n`));
        const results = await volume.simulate(sol_price, volume_config, trader);

        if (volume_config.type === volume.VolumeType.Natural)
            common.log(common.red('Natural Volume simulation results may differ from the actual results\n'));

        common.log(common.bold('Simulation Results:'));
        common.log(`SOL price: $${common.format_currency(sol_price)}`);
        common.log(`Total SOL utilization: ${common.format_currency(results.total_sol_utilization)}`);
        common.log(`Post Funder balance: ${common.format_currency(funder_balance - results.total_fee_sol)}`);
        let accent = common.red;
        common.log(
            `\nTotal spent on fees: ${accent('$' + common.format_currency(results.total_fee_usd))} | ${accent(common.format_currency(results.total_fee_sol) + 'SOL')}`
        );
        accent = common.green;
        common.log(
            `Total volume: ${accent('$' + common.format_currency(results.total_volume_usd))} | ${accent(common.format_currency(results.total_volume_sol) + 'SOL')}\n`
        );
        return;
    }

    common.log(common.yellow(`Starting the ${volume_type_name} Volume Bot...`));

    let rescue_wallets: common.Wallet[] = [];
    switch (volume_config.type) {
        case volume.VolumeType.Fast: {
            rescue_wallets = await volume.execute_fast(funder, volume_config, trader);
            break;
        }
        case volume.VolumeType.Natural: {
            await volume.execute_natural(volume_config, trader);
            break;
        }
        case volume.VolumeType.Bump: {
            await volume.execute_bump(volume_config, trader);
            break;
        }
        default:
            throw new Error('Invalid Volume Bot type.');
    }
    common.log(`\nPerforming cleanup of the temporary wallets...\n`);
    await collect(rescue_wallets, funder.publicKey);
}

export async function benchmark(
    NUM_REQUESTS: number,
    test_public_key: string,
    batch_size = 10,
    update_interval = 10
): Promise<void> {
    const public_key = new PublicKey(test_public_key);

    let total_call_time = 0;
    let min_time = Number.MAX_VALUE;
    let max_time = 0;
    let errors = 0;
    let calls = 0;
    const connection = new Connection(HELIUS_RPC, { disableRetryOnRateLimit: true });
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

                process.stdout.write(
                    `\r[${i + 1}/${NUM_REQUESTS}] | ` +
                        `Errors: ${errors} | ` +
                        `Avg Time: ${avgTime.toFixed(2)} ms | ` +
                        `Min Time: ${min_time.toFixed(2)} ms | ` +
                        `Max Time: ${max_time.toFixed(2)} ms | ` +
                        `TPS: ${tps.toFixed(2)}`
                );
            }
        }
    }
    const workers = Array.from({ length: batch_size }, () => worker());
    await Promise.all(workers);

    const end_time = process.hrtime(start_time);
    const total_elapsed_time = end_time[0] * 1000 + end_time[1] / 1e6;
    const avg_time = total_elapsed_time / (NUM_REQUESTS - errors);
    const tps = (NUM_REQUESTS - errors) / (total_elapsed_time / 1000);

    common.log(common.green(`\n\nBenchmark Results:`));
    common.log(`Total Requests: ${NUM_REQUESTS}`);
    common.log(`Successful Requests: ${NUM_REQUESTS - errors}`);
    common.log(`Failed Requests: ${errors}`);
    common.log(`Total Time: ${total_elapsed_time.toFixed(2)} ms`);
    common.log(`Average Time per Request: ${avg_time.toFixed(2)} ms`);
    common.log(`Min Time: ${min_time.toFixed(2)} ms`);
    common.log(`Max Time: ${max_time.toFixed(2)} ms`);
    common.log(`Estimated TPS: ${tps.toFixed(2)}`);
}

export async function drop(
    mint: PublicKey,
    drop: Keypair,
    airdrop_path: string,
    presale_path: string,
    airdrop_percent: number = 0,
    presale_percent: number = 0
): Promise<void> {
    common.log(common.yellow(`Dropping the mint ${mint.toString()}...`));
    common.log(
        common.yellow(`Airdrop percent: ${airdrop_percent * 100}% | Presale percent: ${presale_percent * 100}%`)
    );

    const mint_meta = await trade.get_token_meta(mint);
    if (!mint_meta) throw new Error(`Mint metadata not found`);
    common.log(`Token name: ${mint_meta.token_name} | Symbol: ${mint_meta.token_symbol}\n`);

    let token_balance: number = 0;
    try {
        const balance = await trade.get_token_balance(
            drop.publicKey,
            mint_meta.mint,
            COMMITMENT,
            mint_meta.token_program
        );
        token_balance = Math.floor(balance.uiAmount || 0);
        common.log(
            common.yellow(
                `Drop address: ${drop.publicKey.toString()} | Balance: ${token_balance} ${mint_meta.token_symbol}\n`
            )
        );
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
    common.log(common.yellow(`Creating Address Lookup Table...`));
    common.log(`Authority address: ${wallet.keypair.publicKey.toString()}`);

    let [lta, create_sig] = await trade.create_lta(wallet.keypair);
    common.log(`\nAddress Lookup Table created, signature: ${create_sig}`);
    common.log(common.green(`Address: ${lta.toBase58()}`));
}

export async function extend_lta(wallet: common.Wallet, lta: PublicKey, address_file_path: any): Promise<void> {
    const addresses = common.read_pubkeys(address_file_path);
    if (addresses.length === 0) throw new Error('No addresses provided.');

    common.log(common.yellow(`Extending Address Lookup Table for ${addresses.length} addresses...`));
    common.log(`Authority: ${wallet.keypair.publicKey.toString()}`);
    common.log(`Address Lookup Table: ${lta.toBase58()}`);

    const extend_sigs = await trade.extend_lta(lta, wallet.keypair, addresses);
    common.log(common.green(`\nAddress Lookup Table extended, signatures:`));
    extend_sigs.forEach((sig) => common.log(common.green(`${sig}`)));
}

export async function deactivate_ltas(wallet: common.Wallet): Promise<void> {
    common.log(common.yellow(`Deactivating Address Lookup Tables...`));
    common.log(`Authority: ${wallet.keypair.publicKey.toString()}`);

    const ltas = await trade.get_ltas_by_authority(wallet.keypair.publicKey, true);
    if (ltas.length === 0) throw new Error('No Active Address Lookup Tables found for the authority.');
    common.log(`\nFound ${ltas.length} active Address Lookup Tables created by the authority`);

    const deactivate_sigs = await trade.deactivate_ltas(wallet.keypair, ltas);

    common.log(`\nAddress Lookup Tables deactivated, signatures:`);
    deactivate_sigs.forEach((sig) => common.log(`${sig}`));

    common.log(
        common.green(`\nDeactivated Address Lookup Tables:\n${ltas.map((lta) => lta.key.toBase58()).join('\n')}`)
    );
}

export async function close_ltas(wallet: common.Wallet): Promise<void> {
    common.log(common.yellow(`Closing Address Lookup Tables...`));
    common.log(`Authority: ${wallet.keypair.publicKey.toString()}`);

    const ltas = await trade.get_ltas_by_authority(wallet.keypair.publicKey, false);
    if (ltas.length === 0) throw new Error('No Deactivated Address Lookup Tables found for the authority.');
    common.log(`\nFound ${ltas.length} deactivated Address Lookup Tables created by the authority`);

    const close_sigs = await trade.close_ltas(wallet.keypair, ltas);

    common.log(`\nAddress Lookup Tables closed, signatures:`);
    close_sigs.forEach((sig) => common.log(`${sig}`));

    common.log(common.green(`\nClosed Address Lookup Tables:\n${ltas.map((lta) => lta.key.toBase58()).join('\n')}`));
}
