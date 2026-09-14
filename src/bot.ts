#!/usr/bin/env bun

import figlet from 'figlet';
import { Command, InvalidArgumentError, InvalidOptionArgumentError, Option } from 'commander';
import { existsSync, readFileSync } from 'fs';
import * as common from './common/common';
import * as commands from './commands';
import { exit } from 'process';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
    COMMITMENT,
    DROP_AIRDROP_CSV,
    DROP_PRESALE_CSV,
    HELIUS_RPC,
    JITO_MIN_TIP,
    PriorityLevel,
    TransactionRelay,
    TRADE_MAX_SLIPPAGE,
    TRANSFER_MAX_DEPTH,
    WALLETS_FILE
} from './constants';
import base58 from 'bs58';
import { rpc_connection_config } from './common/rate_limit';
import { SubscriberType } from './common/subscriber';
import { get_max_transaction_version } from './common/trade_common';

const MULTI_CHARACTER_OPTION_ALIASES: Record<string, string> = {
    '-pr': '--pr',
    '-pt': '--pt',
    '-rl': '--rl',
    '-nc': '--nc',
    '-fm': '--fm',
    '-mn': '--mn',
    '-mx': '--mx',
    '-bu': '--bu',
    '-ap': '--ap',
    '-pp': '--pp',
    '-af': '--af',
    '-pf': '--pf'
};

function reserve_wallet_check(wallets: common.Wallet[]) {
    if (!common.check_reserve_exists(wallets)) {
        common.error(common.red('Reserve wallet not found.'));
        exit(1);
    }
}

async function get_wallets_from_file(file: string): Promise<common.Wallet[]> {
    try {
        const wallets = await common.get_wallets(file);
        if (wallets.length === 0) common.error(common.yellow('The file does not contain any wallets.'));
        return wallets;
    } catch (error) {
        common.error(common.yellow(`${error}`));
    }
    return [];
}

function get_priority_option(): Option {
    return new Option('--pr, --priority <level>', 'specify priority level')
        .choices(Object.values(PriorityLevel) as string[])
        .default(PriorityLevel.DEFAULT, PriorityLevel.DEFAULT);
}

function get_json_config_option(): Option {
    return new Option('-c, --config <path>', 'Path to the JSON config file').argParser((value) => {
        if (!existsSync(value)) throw new InvalidOptionArgumentError('Config file does not exist.');
        return common.read_json(value);
    });
}

function get_from_option(wallet_cnt: number): Option {
    return new Option('-f, --from <number>', 'Starting from the provided index').argParser((value) => {
        if (!common.validate_int(value, 0, wallet_cnt))
            throw new InvalidOptionArgumentError(`Not a valid range(0 - ${wallet_cnt}).`);
        return parseInt(value, 10);
    });
}

function get_to_option(wallet_cnt: number): Option {
    return new Option('-t, --to <number>', 'Ending at the provided index (exclusive)').argParser((value) => {
        if (!common.validate_int(value, 0, wallet_cnt))
            throw new InvalidOptionArgumentError(`Not a valid range(0 - ${wallet_cnt}).`);
        return parseInt(value, 10);
    });
}

function get_list_option(wallet_cnt: number): Option {
    return new Option('-l, --list <wallets...>', 'Specify the list of wallet files').argParser((value, prev: any) => {
        if (!common.validate_int(value, 0, wallet_cnt))
            throw new InvalidOptionArgumentError(`Not a valid range(0 - ${wallet_cnt}).`);
        return prev ? prev?.concat(parseInt(value, 10)) : [parseInt(value, 10)];
    });
}

function get_bundle_tip_option(): Option {
    return new Option('-b, --bundle <tip>', 'Enable bundles by providing tip amount').argParser((value) => {
        const tip = parseFloat(value);
        if (isNaN(tip) || tip < JITO_MIN_TIP)
            throw new InvalidOptionArgumentError(`Not a valid tip amount. Must be at least ${JITO_MIN_TIP}.`);
        return tip;
    });
}

function get_mev_protect_option(): Option {
    return new Option('-m, --mev', 'Enable MEV protection').default(false).conflicts('bundle');
}

function get_protection_tip_option(): Option {
    return new Option('--pt, --protection-tip <tip>', 'Enable protected transaction routing by providing a tip')
        .argParser((value) => {
            const tip = parseFloat(value);
            if (isNaN(tip) || tip < JITO_MIN_TIP)
                throw new InvalidOptionArgumentError(`Not a valid tip amount. Must be at least ${JITO_MIN_TIP}.`);
            return tip;
        })
        .conflicts('bundle');
}

function get_slippage_option(): Option {
    return new Option('-s, --slippage <number>', 'Slippage in percents').argParser((value) => {
        const parsed_value = parseFloat(value);
        if (isNaN(parsed_value)) throw new InvalidOptionArgumentError('Not a number.');
        if (parsed_value < 0.0 || parsed_value > TRADE_MAX_SLIPPAGE * 100)
            throw new InvalidOptionArgumentError(`Invalid range (0.0 - ${(TRADE_MAX_SLIPPAGE * 100).toFixed(1)}).`);
        return parsed_value / 100;
    });
}

function get_percent_option(): Option {
    return new Option('-p, --percent <number>', 'Percentage of the token to sell').argParser((value) => {
        const parsed_value = parseFloat(value);
        if (isNaN(parsed_value)) throw new InvalidOptionArgumentError('Not a number.');
        if (parsed_value < 0.0 || parsed_value > 1.0)
            throw new InvalidOptionArgumentError('Invalid range (0.0 - 1.0).');
        return parsed_value;
    });
}

function get_depth_option(): Option {
    return new Option(
        '-d, --depth <number>',
        'The number of transfers to be done between the sender and receiver'
    ).argParser((value) => {
        const parsed_value = parseInt(value);
        if (isNaN(parsed_value)) throw new InvalidOptionArgumentError('Not a number.');
        if (parsed_value < 1 || parsed_value > TRANSFER_MAX_DEPTH)
            throw new InvalidOptionArgumentError(
                `Invalid depth. Must be greater than 0 and less than or equal to ${TRANSFER_MAX_DEPTH}.`
            );
        return parsed_value;
    });
}

function lowercase_description(description: string): string {
    return description.replace(/^[A-Z](?=[a-z])/, (letter) => letter.toLowerCase());
}

function single_dash_aliases(flags: string): string {
    return flags.replace(/^--([a-z]{2}), /, '-$1, ');
}

function get_version(): string {
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return version;
}

//------------------------------------------------------------
// MAIN
// -----------------------------------------------------------

async function main() {
    const key_options = new Command().allowUnknownOption().allowExcessArguments().option('-k, --keys <path>');
    key_options.parseOptions(process.argv.slice(2).map((arg) => MULTI_CHARACTER_OPTION_ALIASES[arg] ?? arg));
    const wallets = await get_wallets_from_file(key_options.opts().keys ?? WALLETS_FILE);
    const wallet_cnt = wallets.length;

    global.CONNECTION = new Connection(HELIUS_RPC, rpc_connection_config({ commitment: COMMITMENT }));
    global.PROGRAM = common.Program.Pump;
    global.TRANSACTION_RELAY = TransactionRelay.Sender;
    global.TRANSACTION_VERSION = 0;
    global.NO_COLORS = false;
    global.FUNDING = false;

    const program = new Command();

    program.version(get_version(), '-v, --version').description('Solana Bot CLI');

    program.addHelpText('beforeAll', figlet.textSync('Solana Bot', { horizontalLayout: 'full' }));
    program.showHelpAfterError('Use --help for additional information');

    program.configureOutput({
        writeOut: (str) => process.stdout.write(str),
        writeErr: (str) => process.stderr.write(str),
        outputError: (str, write) => write(common.red(str))
    });
    program.configureHelp({
        optionTerm: (option) => single_dash_aliases(option.flags),
        optionDescription: (option) => lowercase_description(option.description),
        commandDescription: (command) =>
            command.parent ? lowercase_description(command.description()) : command.description(),
        subcommandDescription: (command) => lowercase_description(command.description())
    });

    program.addOption(
        new Option('-k, --keys <path>', 'Path to the CSV file with the wallets')
            .argParser((value) => {
                if (!existsSync(value)) throw new InvalidOptionArgumentError('Keys file does not exist.');
                return value;
            })
            .default(WALLETS_FILE, WALLETS_FILE)
    );
    program.addOption(
        new Option('-g, --program <type>', 'specify program')
            .choices(Object.values(common.Program) as string[])
            .default(common.Program.Pump, common.Program.Pump)
    );
    program.addOption(
        new Option('--rl, --relay <provider>', 'transaction relay for protected transactions and bundles')
            .choices(Object.values(TransactionRelay) as string[])
            .default(TransactionRelay.Sender, TransactionRelay.Sender)
    );
    program.addOption(new Option('--nc, --no-colors', 'Disable colored output'));
    program.addOption(new Option('--v1', 'Use v1 transactions; fail if upstream support cannot be verified'));
    program.addOption(new Option('--funding', 'Enable token funding'));

    program.hook('preAction', async () => {
        global.PROGRAM = program.opts().program;
        global.TRANSACTION_RELAY = program.opts().relay;
        global.FUNDING = program.opts().funding === true;
        global.NO_COLORS = program.opts().colors === false;
        if (program.opts().v1 && (await get_max_transaction_version()) !== 1)
            throw new Error(
                'V1 transactions are unsupported or support could not be verified through the configured RPC.'
            );
        global.TRANSACTION_VERSION = program.opts().v1 ? 1 : 0;
    });

    program
        .command('snipe')
        .alias('sn')
        .description('Start the snipe bot')
        .addOption(get_from_option(wallet_cnt))
        .addOption(get_json_config_option())
        .addOption(
            new Option('-s, --subscriber <type>', 'specify subscriber type')
                .choices(Object.values(SubscriberType) as string[])
                .default(SubscriberType.Tx, SubscriberType.Tx)
        )
        .hook('preAction', () => reserve_wallet_check(wallets))
        .action(async (options: any) => {
            let { config, from, subscriber } = options;
            await commands.snipe(common.filter_wallets(wallets, from), subscriber, config);
        });

    program
        .command('volume')
        .alias('v')
        .description('Start the volume bot')
        .option('-s, --simulate', 'Simulate the volume', false)
        .addOption(get_json_config_option())
        .action(async (options: any) => {
            const { config, simulate } = options;
            const funder = common.get_reserve_wallet(wallets);
            await commands.start_volume(funder?.keypair, simulate, config, wallets);
        });

    program
        .command('generate')
        .alias('g')
        .description('Generate the wallets')
        .argument('<file_path>', 'Path of the file to save the wallets')
        .option('-s, --secrets <path>', 'Path to the file with secret keys to convert', (value) => {
            if (!existsSync(value)) throw new InvalidOptionArgumentError('Keys file does not exist.');
            return value;
        })
        .option('-c, --count <number>', 'Number of wallets to generate', (value) => {
            const parsed_value = parseInt(value);
            if (isNaN(parsed_value)) throw new InvalidArgumentError('Not a number.');
            if (parsed_value < 1) throw new InvalidArgumentError('Invalid count. Must be greater than 0.');
            return parsed_value;
        })
        .option(
            '-i, --index <index>',
            'Starting index of the wallets',
            (value) => {
                if (!common.validate_int(value, 0))
                    throw new InvalidOptionArgumentError(`Index should be greater than 0.`);
                return parseInt(value, 10);
            },
            0
        )
        .option('-r, --reserve', 'Generate the reserve wallet', false)
        .action(async (name, options) => {
            let { secrets, index, reserve, count } = options;
            await commands.generate(name, reserve, count, secrets, index);
        });

    program
        .command('balance')
        .alias('b')
        .description('Get the balance of the wallets')
        .option('--fm, --format <type>', 'Format of the balance output (e.g., csv, table)', 'table')
        .action(async (options) => {
            let { format } = options;
            if (!['csv', 'table'].includes(format))
                throw new InvalidOptionArgumentError('Invalid format. Must be either "csv" or "table".');
            await commands.balance(wallets, format);
        });

    program
        .command('token-balance')
        .alias('tb')
        .description('Get the token balance of the wallets')
        .option('--fm, --format <type>', 'Format of the balance output (e.g., csv, table)', 'table')
        .argument('<mint>', 'Public address of the mint', (value) => {
            if (!common.is_valid_pubkey(value)) throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .action(async (mint, options) => {
            let { format } = options;
            if (!['csv', 'table'].includes(format))
                throw new InvalidOptionArgumentError('Invalid format. Must be either "csv" or "table".');
            await commands.token_balance(wallets, mint, format);
        });

    program
        .command('warmup')
        .alias('w')
        .description('Warmup the wallets with the tokens')
        .addOption(get_from_option(wallet_cnt))
        .addOption(get_to_option(wallet_cnt))
        .addOption(get_list_option(wallet_cnt))
        .option('--mn, --min <number>', 'Minimum amount of tokens for each wallet', (value) => {
            const parsed_value = parseInt(value);
            if (isNaN(parsed_value)) throw new InvalidOptionArgumentError('Not a number.');
            if (parsed_value < 1)
                throw new InvalidOptionArgumentError('Invalid minimum amount. Must be greater than 0.');
            return parsed_value;
        })
        .option('--mx, --max <number>', 'Maximum amount of tokens for each wallet', (value) => {
            const parsed_value = parseInt(value);
            if (isNaN(parsed_value)) throw new InvalidOptionArgumentError('Not a number.');
            if (parsed_value < 1 || parsed_value > 50)
                throw new InvalidOptionArgumentError('Invalid maximum amount. Must be between 1 and 50');
            return parsed_value;
        })
        .addOption(
            new Option('-i, --interval <number>', 'Interval between each buy/sell in seconds')
                .argParser((value) => {
                    const parsed_value = parseFloat(value);
                    if (isNaN(parsed_value)) throw new InvalidOptionArgumentError('Not a number.');
                    if (parsed_value < 0.0)
                        throw new InvalidOptionArgumentError('Invalid interval. Must be greater than 0.');
                    return parsed_value;
                })
                .conflicts('bundle')
        )
        .addOption(get_bundle_tip_option())
        .addOption(get_priority_option())
        .hook('preAction', () => reserve_wallet_check(wallets))
        .action(async (options) => {
            const { from, to, list, bundle, priority, min, max, interval } = options;
            await commands.warmup(common.filter_wallets(wallets, from, to, list), priority, bundle, interval, min, max);
        });

    program
        .command('clean')
        .alias('cl')
        .description('Clean the wallets by closing zero balance token accounts')
        .option('--bu, --burn', 'Burn non-SOL token balances before closing their accounts', false)
        .action(async (options) => await commands.clean(wallets, options.burn));

    program
        .command('claim-rewards')
        .alias('cf')
        .description('Claim trader/dev rewards for the wallets')
        .option('-p, --print', 'Print available fees without claiming them', false)
        .addOption(get_from_option(wallet_cnt))
        .addOption(get_to_option(wallet_cnt))
        .addOption(get_list_option(wallet_cnt))
        .addOption(get_priority_option())
        .action(async (options) => {
            const { print, from, to, list, priority } = options;
            await commands.claim_fees(common.filter_wallets(wallets, from, to, list), print, priority);
        });

    program
        .command('token-burn')
        .alias('tburn')
        .description('Burn the tokens by mint from a wallet')
        .argument('<mint>', 'Public address of the mint', (value) => {
            if (!common.is_valid_pubkey(value)) throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .argument('<burner_index>', 'Index of the burner wallet', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidArgumentError(`Not a valid range (0 - ${wallet_cnt}).`);
            const burner_wallet = common.get_wallet(parseInt(value, 10), wallets);
            if (!burner_wallet) throw new InvalidArgumentError('Invalid index.');
            return burner_wallet.keypair;
        })
        .option('-a, --amount <number>', 'Amount of tokens to burn', (value) => {
            const parsed_value = parseFloat(value);
            if (isNaN(parsed_value)) throw new InvalidOptionArgumentError('Not a number.');
            if (parsed_value < 0.0) throw new InvalidOptionArgumentError('Invalid amount. Must be greater than 0.0');
            return parsed_value;
        })
        .addOption(get_percent_option())
        .action(async (mint, burner, options) => {
            const { amount, percent } = options;
            await commands.burn_token(mint, burner, amount, percent);
        });

    program
        .command('collect')
        .alias('c')
        .description('Collect all the SOL from the wallets to the provided address')
        .argument('<receiver>', 'Public address of the receiver', (value) => {
            if (!common.is_valid_pubkey(value)) throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .addOption(get_from_option(wallet_cnt))
        .addOption(get_to_option(wallet_cnt))
        .addOption(get_list_option(wallet_cnt))
        .action(async (receiver, options) => {
            const { from, to, list } = options;
            await commands.collect(common.filter_wallets(wallets, from, to, list), receiver);
        });

    program
        .command('token-collect')
        .alias('tc')
        .description('Collect all tokens by mint from the wallets to the provided address')
        .argument('<mint>', 'Public address of the mint', (value) => {
            if (!common.is_valid_pubkey(value)) throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .argument('<receiver>', 'Public address of the receiver', (value) => {
            if (!common.is_valid_pubkey(value)) throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .addOption(get_from_option(wallet_cnt))
        .addOption(get_to_option(wallet_cnt))
        .addOption(get_list_option(wallet_cnt))
        .hook('preAction', () => reserve_wallet_check(wallets))
        .action(async (mint, receiver, options) => {
            const { from, to, list } = options;
            await commands.collect_token(common.filter_wallets(wallets, from, to, list), mint, receiver);
        });

    program
        .command('fund')
        .alias('f')
        .description('Fund the wallets with SOL using the provided wallet')
        .argument('<amount>', 'Amount of SOL to fund', (value) => {
            const parsed_value = parseFloat(value);
            if (isNaN(parsed_value)) throw new InvalidArgumentError('Not a number.');
            if (parsed_value < 0) throw new InvalidArgumentError('Invalid amount. Must be greater than 0.0');
            return parsed_value;
        })
        .argument('<sender_index>', 'Index of the sender wallet', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidArgumentError(`Not a valid range (0 - ${wallet_cnt}).`);
            const sender_wallet = common.get_wallet(parseInt(value, 10), wallets);
            if (!sender_wallet) throw new InvalidArgumentError('Invalid index.');
            return sender_wallet.keypair;
        })
        .addOption(
            new Option('-s, --spider', 'Fund the wallets using the spider (cannot be used with --depth parameter)')
                .default(false)
                .conflicts('depth')
        )
        .option('-r, --random', 'Fund randomly using <amount> argument as a mean value', false)
        .addOption(get_depth_option())
        .addOption(get_from_option(wallet_cnt))
        .addOption(get_to_option(wallet_cnt))
        .addOption(get_list_option(wallet_cnt))
        .addOption(get_bundle_tip_option())
        .hook('preAction', () => reserve_wallet_check(wallets))
        .action(async (amount, sender, options) => {
            const { from, to, list, depth, spider, random, bundle } = options;
            await commands.fund_sol(
                common.filter_wallets(wallets, from, to, list),
                amount,
                sender,
                spider,
                random,
                depth,
                bundle
            );
        });

    program
        .command('token-distribute')
        .alias('td')
        .description('Distribute the token by the mint from the sender to the wallets')
        .argument('<mint>', 'Public address of the mint', (value) => {
            if (!common.is_valid_pubkey(value)) throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .argument('<percent>', 'Percentage of the token to distribute', (value) => {
            const parsed_value = parseFloat(value);
            if (isNaN(parsed_value)) throw new InvalidArgumentError('Not a number.');
            if (parsed_value < 0.0 || parsed_value > 1.0) throw new InvalidArgumentError('Invalid range (0.0 - 1.0).');
            return parsed_value;
        })
        .argument('<sender_index>', 'Index of the sender wallet', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidArgumentError(`Not a valid range (0 - ${wallet_cnt}).`);
            const sender_wallet = common.get_wallet(parseInt(value, 10), wallets);
            if (!sender_wallet) throw new InvalidArgumentError('Invalid index.');
            return sender_wallet.keypair;
        })
        .option('-r, --random', 'Distribute randomly', false)
        .addOption(get_depth_option())
        .addOption(get_from_option(wallet_cnt))
        .addOption(get_to_option(wallet_cnt))
        .addOption(get_list_option(wallet_cnt))
        .addOption(get_bundle_tip_option())
        .action(async (mint, percent, sender, options) => {
            const { from, to, list, depth, random, bundle } = options;
            await commands.distribute_token(
                common.filter_wallets(wallets, from, to, list),
                mint,
                percent,
                sender,
                random,
                depth,
                bundle
            );
        });

    program
        .command('buy-token-once')
        .alias('bto')
        .description('Buy the token once with the provided amount')
        .argument('<amount>', 'Amount to buy in SOL', (value) => {
            const parsed_value = parseFloat(value);
            if (isNaN(parsed_value)) throw new InvalidArgumentError('Not a number.');
            return parsed_value;
        })
        .argument('<mint>', 'Public address of the mint', (value) => {
            if (!common.is_valid_pubkey(value)) throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .argument('<buyer_index>', 'Index of the buyer wallet', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidArgumentError(`Not a valid range (0 - ${wallet_cnt}).`);
            const buyer_wallet = common.get_wallet(parseInt(value, 10), wallets);
            if (!buyer_wallet) throw new InvalidArgumentError('Invalid index.');
            return buyer_wallet.keypair;
        })
        .addOption(get_slippage_option())
        .addOption(get_protection_tip_option())
        .addOption(get_mev_protect_option())
        .addOption(get_priority_option())
        .hook('preAction', () => reserve_wallet_check(wallets))
        .action(async (amount, mint, buyer, options) => {
            const { slippage, protectionTip, mev, priority } = options;
            await commands.buy_token_once(amount, mint, buyer, slippage, protectionTip, mev, priority);
        });

    program
        .command('sell-token-once')
        .alias('sto')
        .description('Sell the token once with the provided amount')
        .argument('<mint>', 'Public address of the mint', (value) => {
            if (!common.is_valid_pubkey(value)) throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .argument('<seller_index>', 'Index of the seller wallet', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidArgumentError(`Not a valid range (0 - ${wallet_cnt}).`);
            const seller_wallet = common.get_wallet(parseInt(value, 10), wallets);
            if (!seller_wallet) throw new InvalidArgumentError('Invalid index.');
            return seller_wallet.keypair;
        })
        .addOption(get_percent_option())
        .addOption(get_slippage_option())
        .addOption(get_protection_tip_option())
        .addOption(get_mev_protect_option())
        .addOption(get_priority_option())
        .hook('preAction', () => reserve_wallet_check(wallets))
        .action(async (mint, seller, options) => {
            const { percent, slippage, protectionTip, mev, priority } = options;
            await commands.sell_token_once(mint, seller, percent, slippage, protectionTip, mev, priority);
        });

    program
        .command('buy-token')
        .alias('bt')
        .description('Buy the token by the mint from the wallets')
        .argument('<mint>', 'Public address of the mint', (value) => {
            if (!common.is_valid_pubkey(value)) throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .option('-a, --amount <amount>', 'Amount to buy in SOL', (value) => {
            const parsed_value = parseFloat(value);
            if (isNaN(parsed_value)) throw new InvalidArgumentError('Not a number.');
            return parsed_value;
        })
        .option(
            '--mn, --min <number>',
            'Minimum amount for random buy in SOL (cannot be used with --amount parameter)',
            (value) => {
                const parsed_value = parseFloat(value);
                if (isNaN(parsed_value)) throw new InvalidOptionArgumentError('Not a number.');
                if (parsed_value <= 0.0)
                    throw new InvalidOptionArgumentError('Invalid minimum amount. Must be greater than 0.0.');
                return parsed_value;
            }
        )
        .option(
            '--mx, --max <number>',
            'Maximum amount for random buy in SOL (cannot be used with "--amount" parameter)',
            (value) => {
                const parsed_value = parseFloat(value);
                if (isNaN(parsed_value)) throw new InvalidOptionArgumentError('Not a number.');
                if (parsed_value <= 0.0)
                    throw new InvalidOptionArgumentError('Invalid maximum amount. Must be greater than 0.0.');
                return parsed_value;
            }
        )
        .addOption(get_slippage_option())
        .addOption(get_from_option(wallet_cnt))
        .addOption(get_to_option(wallet_cnt))
        .addOption(get_list_option(wallet_cnt))
        .addOption(get_bundle_tip_option())
        .addOption(get_protection_tip_option())
        .addOption(get_mev_protect_option())
        .addOption(get_priority_option())
        .hook('preAction', () => reserve_wallet_check(wallets))
        .action(async (mint, options) => {
            const { amount, min, max, slippage, from, to, list, bundle, protectionTip, mev, priority } = options;
            await commands.buy_token(
                common.filter_wallets(wallets, from, to, list),
                mint,
                priority,
                protectionTip,
                mev,
                bundle,
                amount,
                min,
                max,
                slippage
            );
        });

    program
        .command('sell-token')
        .alias('st')
        .description('Sell all the token by the mint from the wallets')
        .argument('<mint>', 'Public address of the mint', (value) => {
            if (!common.is_valid_pubkey(value)) throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .addOption(get_percent_option())
        .addOption(get_slippage_option())
        .addOption(get_from_option(wallet_cnt))
        .addOption(get_to_option(wallet_cnt))
        .addOption(get_list_option(wallet_cnt))
        .addOption(get_bundle_tip_option())
        .addOption(get_protection_tip_option())
        .addOption(get_mev_protect_option())
        .addOption(get_priority_option())
        .hook('preAction', () => reserve_wallet_check(wallets))
        .action(async (mint, options) => {
            const { percent, slippage, from, to, list, bundle, protectionTip, mev, priority } = options;
            await commands.sell_token(
                common.filter_wallets(wallets, from, to, list),
                mint,
                priority,
                protectionTip,
                mev,
                bundle,
                percent,
                slippage
            );
        });

    program
        .command('wallet-pnl')
        .alias('pnl')
        .description('Get the PNL of the wallet')
        .argument('<address>', 'Public address of the wallet', (value) => {
            if (!common.is_valid_pubkey(value)) throw new InvalidArgumentError('Not a address.');
            return new PublicKey(value);
        })
        .action(async (address) => await commands.wallet_pnl(address));

    program
        .command('transfer')
        .alias('tr')
        .description('Transfer SOL from the specified wallet to the receiver')
        .argument('<amount>', 'Amount of SOL to transfer', (value) => {
            const parsed_value = parseFloat(value);
            if (isNaN(parsed_value)) throw new InvalidArgumentError('Not a number.');
            if (parsed_value < 0) throw new InvalidArgumentError('Invalid amount. Must be greater than 0.0');
            return parsed_value;
        })
        .argument('<receiver>', 'Public address of the receiver', (value) => {
            if (!common.is_valid_pubkey(value)) throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .argument('<sender_index>', 'Index of the sender wallet', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidArgumentError(`Not a valid range (0 - ${wallet_cnt}).`);
            const sender_wallet = common.get_wallet(parseInt(value, 10), wallets);
            if (!sender_wallet) throw new InvalidArgumentError('Invalid index.');
            return sender_wallet.keypair;
        })
        .hook('preAction', () => reserve_wallet_check(wallets))
        .action(async (amount, receiver, sender) => await commands.transfer_sol(amount, receiver, sender));

    program
        .command('transfer-token')
        .alias('tt')
        .description('Transfer the token from the specified wallet to the receiver')
        .argument('<mint>', 'Public address of the mint', (value) => {
            if (!common.is_valid_pubkey(value)) throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .argument('<amount>', 'Amount of token to transfer', (value) => {
            const parsed_value = parseFloat(value);
            if (isNaN(parsed_value)) throw new InvalidArgumentError('Not a number.');
            if (parsed_value < 0) throw new InvalidArgumentError('Invalid amount. Must be greater than 0.0');
            return parsed_value;
        })
        .argument('<receiver>', 'Public address of the receiver', (value) => {
            if (!common.is_valid_pubkey(value)) throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .argument('<sender_index>', 'Index of the sender wallet', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidArgumentError(`Not a valid range (0 - ${wallet_cnt}).`);
            const sender_wallet = common.get_wallet(parseInt(value, 10), wallets);
            if (!sender_wallet) throw new InvalidArgumentError('Invalid index.');
            return sender_wallet.keypair;
        })
        .action(
            async (mint, amount, receiver, sender) => await commands.transfer_token(mint, amount, receiver, sender)
        );

    program
        .command('create-metadata')
        .alias('cm')
        .description('Upload the metadata of the token using the provided JSON file and image')
        .argument('<json_path>', 'Path to the JSON file', (value) => {
            if (!existsSync(value)) throw new InvalidOptionArgumentError('Config file does not exist.');
            const json = common.read_json(value);
            if (!json) throw new InvalidOptionArgumentError('Invalid JSON format.');
            return json as common.IPFSMetadata;
        })
        .argument('<image_path>', 'Path to the image file', (value) => {
            if (!existsSync(value)) throw new InvalidOptionArgumentError('Image file does not exist.');
            return value;
        })
        .action(async (json, image_path) => {
            await commands.create_token_metadata(json, image_path);
        });

    program
        .command('promote')
        .alias('pr')
        .description('Create promotion tokens using the provided wallet')
        .argument('<count>', 'Number of promotion tokens to create', (value) => {
            const parsed_value = parseInt(value);
            if (isNaN(parsed_value)) throw new InvalidArgumentError('Not a number.');
            if (parsed_value < 1) throw new InvalidArgumentError('Invalid count. Must be greater than 0.');
            return parsed_value;
        })
        .argument('<cid>', 'CID of the metadata on IPFS')
        .argument('<creator_index>', 'Index of the creator wallet', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidArgumentError(`Not a valid range (0 - ${wallet_cnt}).`);
            const creator_wallet = common.get_wallet(parseInt(value, 10), wallets);
            if (!creator_wallet) throw new InvalidArgumentError('Invalid index.');
            return creator_wallet.keypair;
        })
        .action(async (count, cid, creator) => {
            await commands.promote(count, cid, creator);
        });

    program
        .command('create-token')
        .alias('ct')
        .description('Create a token')
        .argument('<cid>', 'CID of the metadata on IPFS')
        .argument('<creator_index>', 'Index of the creator wallet', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidArgumentError(`Not a valid range (0 - ${wallet_cnt}).`);
            const creator_wallet = common.get_wallet(parseInt(value, 10), wallets);
            if (!creator_wallet) throw new InvalidArgumentError('Invalid index.');
            return creator_wallet;
        })
        .option('-m, --mint <mint_private_key>', 'Private key of the mint to create', (value) => {
            try {
                const secret = base58.decode(value);
                if (secret.length !== 64) throw new Error('Invalid secret key length');
                return secret;
            } catch {
                throw new InvalidOptionArgumentError(`Invalid private key provided`);
            }
        })
        .option('-a, --amount <number>', 'Amount of SOL to buy the token', (value) => {
            const parsed_value = parseFloat(value);
            if (isNaN(parsed_value) || parsed_value <= 0) throw new InvalidOptionArgumentError('Not a number.');
            return parsed_value;
        })
        .option('--mn, --min <number>', 'Minimum amount for random buy in SOL (if bundle buy is enabled)', (value) => {
            const parsed_value = parseFloat(value);
            if (isNaN(parsed_value)) throw new InvalidOptionArgumentError('Not a number.');
            if (parsed_value <= 0.0)
                throw new InvalidOptionArgumentError('Invalid minimum amount. Must be greater than 0.0.');
            return parsed_value;
        })
        .option('--mx, --max <number>', 'Maximum amount for random buy in SOL (if bundle buy is enabled)', (value) => {
            const parsed_value = parseFloat(value);
            if (isNaN(parsed_value)) throw new InvalidOptionArgumentError('Not a number.');
            if (parsed_value <= 0.0)
                throw new InvalidOptionArgumentError('Invalid maximum amount. Must be greater than 0.0.');
            return parsed_value;
        })
        .addOption(get_from_option(wallet_cnt))
        .addOption(get_to_option(wallet_cnt))
        .addOption(get_list_option(wallet_cnt))
        .addOption(get_bundle_tip_option())
        .addOption(get_json_config_option())
        .action(async (cid, creator, options) => {
            const { mint, amount, from, to, list, bundle, min, max, config } = options;
            let buyers: common.Wallet[] | undefined = undefined;
            if (from !== undefined || to !== undefined || list !== undefined)
                buyers = common.filter_wallets(wallets, from, to, list);
            await commands.create_token(
                cid,
                creator,
                amount,
                mint ? await Keypair.fromSecretKey(mint) : undefined,
                buyers,
                min,
                max,
                bundle,
                config
            );
        });

    program
        .command('create-lta')
        .alias('clta')
        .description('Create a Address Lookup Table Account')
        .argument('<authority_index>', 'Index of the authority wallet', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidArgumentError(`Not a valid range (0 - ${wallet_cnt}).`);
            const creator_wallet = common.get_wallet(parseInt(value, 10), wallets);
            if (!creator_wallet) throw new InvalidArgumentError('Invalid index.');
            return creator_wallet;
        })
        .action(async (authority) => await commands.create_lta(authority));

    program
        .command('extend-lta')
        .alias('elta')
        .description('Extend the Address Lookup Table Account')
        .argument('<authority_index>', 'Index of the authority wallet', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidArgumentError(`Not a valid range (0 - ${wallet_cnt}).`);
            const creator_wallet = common.get_wallet(parseInt(value, 10), wallets);
            if (!creator_wallet) throw new InvalidArgumentError('Invalid index.');
            return creator_wallet;
        })
        .argument('<lta>', 'Public address of the LTA', (value) => {
            if (!common.is_valid_pubkey(value)) throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .argument('<address_file>', 'Path to the file with the addresses', (value) => {
            if (!existsSync(value)) throw new InvalidOptionArgumentError('Address file does not exist.');
            return value;
        })
        .action(async (authority, lta, address_file) => await commands.extend_lta(authority, lta, address_file));

    program
        .command('deactivate-ltas')
        .alias('dltas')
        .description('Deactivate the Address Lookup Table Accounts by the provided authority')
        .argument('<authority_index>', 'Index of the authority wallet', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidArgumentError(`Not a valid range (0 - ${wallet_cnt}).`);
            const creator_wallet = common.get_wallet(parseInt(value, 10), wallets);
            if (!creator_wallet) throw new InvalidArgumentError('Invalid index.');
            return creator_wallet;
        })
        .action(async (authority) => await commands.deactivate_ltas(authority));

    program
        .command('close-ltas')
        .alias('cltas')
        .description('Close the Address Lookup Table Accounts by the provided authority')
        .argument('<authority_index>', 'Index of the authority wallet', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidArgumentError(`Not a valid range (0 - ${wallet_cnt}).`);
            const creator_wallet = common.get_wallet(parseInt(value, 10), wallets);
            if (!creator_wallet) throw new InvalidArgumentError('Invalid index.');
            return creator_wallet;
        })
        .action(async (authority) => await commands.close_ltas(authority));

    program
        .command('drop')
        .alias('dr')
        .description('Execute token airdrop/presale')
        .argument('<mint>', 'Public address of the mint', (value) => {
            if (!common.is_valid_pubkey(value)) throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .argument('<drop_index>', 'Index of the drop wallet', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidArgumentError(`Not a valid range (0-  ${wallet_cnt}).`);
            const drop_wallet = common.get_wallet(parseInt(value, 10), wallets);
            if (!drop_wallet) throw new InvalidArgumentError('Invalid index.');
            return drop_wallet.keypair;
        })
        .option('--ap, --airdrop <percent>', 'Percent of tokens to be airdropped', (value) => {
            const parsed_value = parseFloat(value);
            if (isNaN(parsed_value)) throw new InvalidArgumentError('Not a number.');
            if (parsed_value < 0 || parsed_value > 1.0) throw new InvalidArgumentError('Invalid range (0.0 - 1.0).');
            return parsed_value;
        })
        .option('--pp, --presale <percent>', 'Turn on the presale', (value) => {
            const parsed_value = parseFloat(value);
            if (isNaN(parsed_value)) throw new InvalidOptionArgumentError('Not a number.');
            if (parsed_value < 0 || parsed_value > 1.0)
                throw new InvalidOptionArgumentError('Invalid range (0.0 - 1.0).');
            return parsed_value;
        })
        .option(
            '--af, --airdrop-file <path>',
            'Path to the CSV file with the airdrop list',
            (value) => {
                if (!existsSync(value)) throw new InvalidOptionArgumentError('Airdrop file does not exist.');
                return value;
            },
            DROP_AIRDROP_CSV
        )
        .option(
            '--pf, --presale-file <path>',
            'Path to the CSV file with the presale list',
            (value) => {
                if (!existsSync(value)) throw new InvalidOptionArgumentError('Presale file does not exist.');
                return value;
            },
            DROP_PRESALE_CSV
        )
        .action(async (mint, drop, options) => {
            const { presale, airdrop, airdropFile, presaleFile } = options;
            await commands.drop(mint, drop, airdropFile, presaleFile, airdrop, presale);
        });

    program
        .command('benchmark')
        .alias('bh')
        .description('Benchmark the RPC connection')
        .argument('<requests>', 'Number of requests to send', (value) => {
            const parsed_value = parseInt(value);
            if (isNaN(parsed_value)) throw new InvalidArgumentError('Not a number.');
            if (parsed_value < 1) throw new InvalidArgumentError('Invalid count. Must be greater than 0.');
            return parsed_value;
        })
        .option('-t, --thread <number>', 'Number of threads to use', (value) => {
            const parsed_value = parseInt(value);
            if (isNaN(parsed_value)) throw new InvalidOptionArgumentError('Not a number.');
            if (parsed_value < 1) throw new InvalidOptionArgumentError('Invalid count. Must be greater than 0.');
            return parsed_value;
        })
        .option('-i --interval <number>', 'Interval between console logs', (value) => {
            const parsed_value = parseInt(value);
            if (isNaN(parsed_value)) throw new InvalidOptionArgumentError('Not a number.');
            if (parsed_value < 1) throw new InvalidOptionArgumentError('Invalid count. Must be greater than 0.');
            return parsed_value;
        })
        .action(async (requests, options) => {
            const { thread, interval } = options;
            await commands.benchmark(requests, '7536JKDpY6bGNq3qUcn87CAmwGPA4WcRctzsFDTr9i8N', thread, interval);
        });

    program
        .command('get-sender-endpoint')
        .alias('gse')
        .description('Get the Sender endpoint with the lowest latency')
        .action(async () => await commands.get_sender_endpoint());

    program
        .command('convert-key')
        .alias('ck')
        .description('Convert the private key from JSON file to base58 string')
        .argument('<json_path>', 'Path to the JSON file', (value) => {
            if (!existsSync(value)) throw new InvalidOptionArgumentError('Config file does not exist.');
            const json = common.read_json(value);
            if (!json) throw new InvalidOptionArgumentError('Invalid JSON format.');
            if (!Array.isArray(json) || json.length !== 64 || !json.every((n) => typeof n === 'number'))
                throw new InvalidOptionArgumentError('Invalid private key format. Must be an array of 64 numbers.');
            return Uint8Array.from(json);
        })
        .action(async (json) => console.log(base58.encode((await Keypair.fromSecretKey(json)).secretKey)));

    try {
        await program.parseAsync(process.argv.map((arg) => MULTI_CHARACTER_OPTION_ALIASES[arg] ?? arg));
        if (!process.argv.slice(2).length) {
            program.outputHelp();
        }
    } catch (error) {
        if (error instanceof Error) {
            program.error(error.message);
        } else {
            program.error(String(error));
        }
    }
}

main().catch(console.error);
