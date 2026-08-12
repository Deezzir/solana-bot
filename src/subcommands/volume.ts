import inquirer from 'inquirer';
import * as common from '../common/common';
import {
    AddressLookupTableAccount,
    Keypair,
    LAMPORTS_PER_SOL,
    PublicKey,
    Signer,
    SystemProgram,
    TransactionInstruction
} from '@solana/web3.js';
import * as trade from '../common/trade_common';
import {
    JITO_BUNDLE_SIZE,
    VOLUME_MAX_WALLETS_PER_EXEC,
    VOLUME_TRADE_SLIPPAGE,
    JITO_BUNDLE_INTERVAL_MS,
    VOLUME_MAX_WALLETS_PER_COLLECT_TX,
    VOLUME_MAX_WALLETS_PER_FUND_TX,
    VOLUME_MAX_WALLETS_PER_TRADE_TX,
    VOLUME_MAX_WALLETS_PER_TRADE_BUNDLE,
    COMMITMENT
} from '../constants';
import { createCloseAccountInstruction } from '@solana/spl-token';

type VolumeConfig = {
    type: VolumeType;
    mint: PublicKey;
    wallet_cnt: number;
    min_sol_amount: number;
    max_sol_amount: number;
    executions: number;
    delay: number;
    bundle_tip: number;
};

export enum VolumeType {
    Fast = 'Fast',
    Natural = 'Natural',
    Bump = 'Bump'
}

export async function execute_fast(
    funder: Signer,
    volume_config: VolumeConfig,
    trader: trade.IProgramTrader
): Promise<common.Wallet[]> {
    await validate_funder(funder, volume_config);
    const target_file = common.setup_rescue_file();
    if (!target_file) throw new Error('Failed to create a target file for the spider transfer');
    const mint_meta = await trader.get_mint_meta(volume_config.mint);
    if (!mint_meta) throw new Error('Failed to fetch mint metadata.');

    for (let exec = 0; exec < volume_config.executions; exec++) {
        const keypairs = Array.from({ length: volume_config.wallet_cnt }, (_v, i) => {
            const pair = new Keypair();
            common.save_rescue_key(pair, target_file, exec, i);
            return pair;
        });
        const keypairs_with_amounts = common.zip(
            keypairs,
            Array.from({ length: volume_config.wallet_cnt }, () =>
                common.uniform_random(volume_config.min_sol_amount, volume_config.max_sol_amount)
            )
        );
        common.log(common.blue(`\nRunning execution: ${exec + 1}`));

        common.log(`\nCreating Address Lookup Table Account...`);
        let lta: AddressLookupTableAccount;
        try {
            lta = await trade.generate_trade_lta(funder, keypairs, volume_config.mint);
            common.log(common.green(`LTA created: ${lta.key.toBase58()}`));
        } catch (error) {
            common.error(common.red(`LTA creation failed: ${error}, skipping execution...`));
            continue;
        }

        common.log('\nFunding the wallets...');
        try {
            await fund_bundles(keypairs_with_amounts, funder, volume_config.bundle_tip, lta);
        } catch (error) {
            common.error(common.red(`Fund failed: ${error} for execution ${exec + 1}, skipping...`));
            continue;
        }

        common.log(`\nTrading the tokens...`);
        await buy_sell_bundles(keypairs_with_amounts, trader, mint_meta!, volume_config.bundle_tip, lta);

        common.log('\nCollecting the funds from the wallets...');
        await collect_bundles(keypairs, funder, volume_config.bundle_tip, lta);

        const delay_seconds = common.normal_random(volume_config.delay, volume_config.delay * 0.1);
        common.log(common.blue(`Sleeping for ${delay_seconds.toFixed(1)} seconds`));
        await common.sleep(delay_seconds * 1000);
    }

    common.log(common.green('\nThe Fast Volume Bot completed\n'));
    return common.get_wallets(target_file);
}

export async function execute_natural(_volume_config: VolumeConfig, _trader: trade.IProgramTrader) {
    throw new Error('Not implemented.');
}

export async function execute_bump(_volume_config: VolumeConfig, _trader: trade.IProgramTrader) {
    throw new Error('Not implemented.');
}

export async function simulate(sol_price: number, volume_config: VolumeConfig, trader: trade.IProgramTrader) {
    const mint_meta = await trader.get_mint_meta(volume_config.mint);
    if (!mint_meta) throw new Error('Failed to fetch mint metadata.');

    switch (volume_config.type) {
        case VolumeType.Fast: {
            const total_wallet_cnt = volume_config.wallet_cnt * volume_config.executions;
            let total_fee_sol = 0;
            let total_volume_sol = 0;
            let total_sol_utilization = volume_config.max_sol_amount * volume_config.wallet_cnt;

            total_fee_sol +=
                Math.ceil(total_wallet_cnt / (VOLUME_MAX_WALLETS_PER_FUND_TX * JITO_BUNDLE_SIZE)) *
                volume_config.bundle_tip;
            for (let i = 0; i < volume_config.executions; i++) {
                for (let j = 0; j < volume_config.wallet_cnt; j++) {
                    const sol_amount = common.uniform_random(
                        volume_config.min_sol_amount,
                        volume_config.max_sol_amount
                    );
                    total_fee_sol += sol_amount * mint_meta.platform_fee * 2;
                    total_volume_sol += sol_amount;
                }
            }
            total_fee_sol +=
                Math.ceil(total_wallet_cnt / VOLUME_MAX_WALLETS_PER_TRADE_BUNDLE) * volume_config.bundle_tip;
            total_fee_sol +=
                Math.ceil(total_wallet_cnt / (VOLUME_MAX_WALLETS_PER_COLLECT_TX * JITO_BUNDLE_SIZE)) *
                volume_config.bundle_tip;

            return {
                total_sol_utilization,
                total_fee_sol: total_fee_sol,
                total_fee_usd: total_fee_sol * sol_price,
                total_volume_sol,
                total_volume_usd: total_volume_sol * sol_price
            };
        }
        default:
            throw new Error('Not implemented.');
    }
}

async function validate_funder(funder: Signer, volume_config: VolumeConfig): Promise<void> {
    const balance = await trade.get_balance(funder.publicKey, COMMITMENT);
    const required_balance = volume_config.max_sol_amount * LAMPORTS_PER_SOL * volume_config.wallet_cnt;
    if (balance < required_balance)
        throw new Error(
            `Funder has insufficient balance. Required: ${required_balance.toFixed(2)} SOL, Available: ${(balance / LAMPORTS_PER_SOL).toFixed(2)} SOL`
        );
}

function calc_buy_amount(amount_sol: number, slippage: number, platform_fee: number, bundle_tip: number = 0): number {
    return (
        amount_sol / (slippage + 1.0) -
        amount_sol * platform_fee * 2 -
        5000 / LAMPORTS_PER_SOL -
        bundle_tip -
        0.0021 * 3
    );
}

async function fund_bundles(
    wallets: [Keypair, number][],
    funder: Signer,
    bundle_tip: number,
    lta: AddressLookupTableAccount
): Promise<void> {
    if (wallets.length === 0) throw new Error('No wallets to fund');
    let instructions: TransactionInstruction[] = [];
    wallets.forEach(([keypair, amount]) => {
        const receiver = keypair.publicKey;
        instructions.push(
            SystemProgram.transfer({
                fromPubkey: funder.publicKey,
                toPubkey: receiver,
                lamports: Math.floor(amount * LAMPORTS_PER_SOL)
            })
        );
    });

    const bundles = common.chunks(common.chunks(instructions, VOLUME_MAX_WALLETS_PER_FUND_TX), JITO_BUNDLE_SIZE);
    const promises: Promise<void>[] = [];
    for (const bundle_instructions of bundles) {
        promises.push(
            trade
                .send_bundle(
                    bundle_instructions,
                    Array.from({ length: bundle_instructions.length }, () => [funder]),
                    bundle_tip,
                    undefined,
                    [lta]
                )
                .then((signature) => common.log(common.green(`Fund Bundle completed, signature: ${signature}`)))
                .catch((error) => {
                    throw error;
                })
        );
        await common.sleep(JITO_BUNDLE_INTERVAL_MS);
    }
    await Promise.all(promises);
}

async function collect_bundles(
    wallets: Keypair[],
    receiver: Signer,
    bundle_tip: number,
    lta: AddressLookupTableAccount
): Promise<void> {
    if (wallets.length === 0) throw new Error('No wallets to collect from');
    let filtered_keypairs = (
        await Promise.all(
            wallets.map(async (keypair) => {
                const balance = await trade.get_balance(keypair.publicKey, COMMITMENT);
                if (balance === 0) return;
                return { keypair, balance };
            })
        )
    ).filter((pair) => pair !== undefined);
    const bundles = common.chunks(
        common.chunks(filtered_keypairs, VOLUME_MAX_WALLETS_PER_COLLECT_TX),
        JITO_BUNDLE_SIZE
    );

    const promises: Promise<void>[] = [];
    for (const bundle of bundles) {
        const bundle_instructions: TransactionInstruction[][] = [];
        const bundle_signers: Signer[][] = [];
        for (const [tx_idx, tx] of bundle.entries()) {
            const tx_instructions: TransactionInstruction[] = [];
            const tx_signers: Signer[] = [];
            for (const [wallet_idx, wallet] of tx.entries()) {
                const amount =
                    Math.floor(wallet.balance) -
                    (!wallet_idx ? 5000 * tx.length : 0) -
                    (!wallet_idx && tx_idx === bundle.length - 1 ? bundle_tip * LAMPORTS_PER_SOL : 0);
                tx_instructions.push(
                    SystemProgram.transfer({
                        fromPubkey: wallet.keypair.publicKey,
                        toPubkey: receiver.publicKey,
                        lamports: amount
                    })
                );
                tx_signers.push(wallet.keypair);
            }
            bundle_instructions.push(tx_instructions);
            bundle_signers.push(tx_signers);
        }
        promises.push(
            trade
                .retry_send_bundle(bundle_instructions, bundle_signers, bundle_tip, undefined, [lta])
                .then((signature) => common.log(common.green(`Collect Bundle completed, signature: ${signature}`)))
                .catch((error) => common.error(common.red(`Collect Bundle failed: ${error}`)))
        );
        await common.sleep(JITO_BUNDLE_INTERVAL_MS);
    }
    await Promise.all(promises);
}

async function buy_sell_bundles(
    wallets: [Keypair, number][],
    trader: trade.IProgramTrader,
    mint_meta: trade.IMintMeta,
    bundle_tip: number,
    lta: AddressLookupTableAccount
): Promise<void> {
    if (wallets.length === 0) throw new Error('No wallets to buy/sell');
    const bundles = common
        .chunks(wallets, VOLUME_MAX_WALLETS_PER_TRADE_BUNDLE)
        .map((chunk) => common.chunks(chunk, VOLUME_MAX_WALLETS_PER_TRADE_TX));

    const promises: Promise<void>[] = [];
    const ltas: AddressLookupTableAccount[] = [];
    for (const bundle of bundles) {
        const bundle_instructions: TransactionInstruction[][] = [];
        const bundle_signers: Signer[][] = [];
        for (const [tx_idx, tx] of bundle.entries()) {
            const tx_instructions: TransactionInstruction[] = [];
            const tx_signers: Signer[] = [];
            for (const [wallet_idx, wallet] of tx.entries()) {
                const [keypair, amount] = wallet;
                const adjusted_amount = calc_buy_amount(
                    amount,
                    VOLUME_TRADE_SLIPPAGE,
                    mint_meta.platform_fee,
                    !wallet_idx && tx_idx === bundle.length - 1 ? bundle_tip : 0
                );
                const [buy_instrs, sell_instrs, trade_ltas] = await trader.buy_sell_instructions(
                    adjusted_amount,
                    keypair,
                    mint_meta,
                    VOLUME_TRADE_SLIPPAGE
                );
                const close_account_instruction = createCloseAccountInstruction(
                    trade.calc_ata(keypair.publicKey, mint_meta.mint_pubkey),
                    keypair.publicKey,
                    keypair.publicKey
                );
                tx_instructions.unshift(...buy_instrs);
                tx_instructions.push(...sell_instrs, close_account_instruction);
                tx_signers.push(keypair);
                if (ltas.length === 0) ltas.push(...(trade_ltas || []), lta);
            }
            bundle_instructions.push(tx_instructions);
            bundle_signers.push(tx_signers);
        }
        promises.push(
            trade
                .send_bundle(bundle_instructions, bundle_signers, bundle_tip, undefined, ltas)
                .then((signature) => common.log(common.green(`Trade Bundle completed, signature: ${signature}`)))
                .catch((error) => common.error(common.red(`Trade Bundle failed: ${error}`)))
        );
        await common.sleep(JITO_BUNDLE_INTERVAL_MS);
        mint_meta = await trader.update_mint_meta(mint_meta);
    }
    await Promise.all(promises);
}

async function get_config() {
    let answers: VolumeConfig;
    do {
        let min_sol_amount: number;
        const { type } = await inquirer.prompt<{ type: VolumeType }>([
            {
                type: 'list',
                name: 'type',
                message: 'Choose the type of the Volume Bot:',
                choices: Object.values(VolumeType) as string[],
                default: VolumeType.Fast,
                filter: (value: string) => value as VolumeType
            }
        ]);

        const { wallet_cnt } =
            type === VolumeType.Natural
                ? await inquirer.prompt<{ wallet_cnt: number }>([
                      {
                          type: 'number',
                          name: 'wallet_cnt',
                          message: `Enter the number of wallets to use, max ${VOLUME_MAX_WALLETS_PER_EXEC} (eg. 2):`,
                          validate: (value: number | undefined) =>
                              value && value > 0 && value <= VOLUME_MAX_WALLETS_PER_EXEC
                                  ? true
                                  : 'Please enter a valid number greater than 0 and less than or equal to 5.'
                      }
                  ])
                : { wallet_cnt: 1 };

        answers = await inquirer.prompt<VolumeConfig>([
            {
                type: 'input',
                name: 'mint',
                message: 'Enter the Mint (CA) of the token:',
                validate: async (value: string) => {
                    if (!common.is_valid_pubkey(value)) return 'Please enter a valid public key.';
                    return true;
                },
                filter: (value: string) => new PublicKey(value)
            },
            {
                type: 'input',
                name: 'min_sol_amount',
                message: 'Enter the minimum amount of SOL to buy (eg. 0.1):',
                validate: (value: string) => {
                    if (!common.validate_float(value, 0.0001)) return 'Please enter a valid number greater than 0.001.';
                    min_sol_amount = parseFloat(value);
                    return true;
                },
                filter: () => min_sol_amount
            },
            {
                type: 'input',
                name: 'max_sol_amount',
                message: 'Enter the maximum amount of SOL to buy (eg. 0.5):',
                validate: (value: string) => {
                    if (!common.validate_float(value, 0.0001)) return 'Please enter a valid number greater than 0.001.';
                    if (parseFloat(value) < min_sol_amount)
                        return 'Please enter a number greater than the minimum amount.';
                    return true;
                },
                filter: (value: string) => parseFloat(value)
            },
            {
                type: 'number',
                name: 'executions',
                message: 'Enter the number of executions to perform (eg. 30):',
                validate: (value: number | undefined) =>
                    value && value > 0 ? true : 'Please enter a valid number greater than 0.'
            },
            {
                type: 'input',
                name: 'bundle_tip',
                message: 'Enter the JITO tip amount in SOL (eg. 0.0001):',
                validate: (value: string) => {
                    if (!common.validate_float(value, 0.00001))
                        return 'Please enter a valid number greater than 0.0001.';
                    return true;
                },
                filter: (value: string) => parseFloat(value)
            },
            {
                type: 'input',
                name: 'delay',
                message: 'Enter the delay in seconds between the executions (eg. 2.5):',
                validate: (value: string) => {
                    if (!common.validate_float(value, 0.0)) return 'Please enter a valid number greater than 0.0.';
                    return true;
                },
                filter: (value: string) => parseFloat(value)
            }
        ]);

        answers = { ...answers, type, wallet_cnt };

        await common.clear_lines_up(1);
        log_volume_config(answers);
        const prompt = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'proceed',
                message: 'Do you want to start the volume bot with the above configuration?'
            }
        ]);

        if (prompt.proceed) break;
        else await common.clear_lines_up(Object.keys(answers).length + 6);
    } while (true);

    return answers;
}

export async function setup_config(json_config?: object): Promise<VolumeConfig> {
    if (json_config) {
        const volume_config = await validate_json_config(json_config);

        log_volume_config(volume_config);
        await common.to_confirm('Press ENTER to start the volume bot...');

        common.clear_lines_up(1);
        return volume_config;
    } else {
        try {
            const bot_config = await get_config();
            common.clear_lines_up(1);
            return bot_config;
        } catch (error) {
            if (error instanceof Error) {
                if (error.message.includes('prompt')) {
                    throw new Error('You cancelled the volume bot setup.');
                }
                throw new Error(`${error.message}`);
            } else {
                throw new Error('Failed to setup the volume bot.');
            }
        }
    }
}

async function validate_json_config(json: any): Promise<VolumeConfig> {
    const required_fields = ['mint', 'executions', 'bundle_tip', 'min_sol_amount', 'max_sol_amount'];
    for (const field of required_fields) {
        if (!json[field]) throw new Error(`Missing required field: ${field}`);
    }
    const { mint, wallet_cnt, min_sol_amount, max_sol_amount, executions, delay, bundle_tip, type } = json;
    if (type !== undefined) {
        if (typeof type !== 'string' || !Object.values(VolumeType).includes(type as VolumeType)) {
            throw new Error(`Type must be a valid string, values: ${Object.values(VolumeType)}`);
        }
        json.type = type as VolumeType;
    }
    if (!('type' in json)) json.type = VolumeType.Fast;
    if (!('wallet_cnt' in json)) json.wallet_cnt = 1;

    if (!common.is_valid_pubkey(mint)) {
        throw new Error('Invalid Raydium Pair ID (AMM) public key.');
    }
    if (typeof min_sol_amount !== 'number' || min_sol_amount <= 0) {
        throw new Error('Invalid min_sol_amount number. Must be greater than 0.');
    }
    if (typeof max_sol_amount !== 'number' || max_sol_amount <= 0 || max_sol_amount < min_sol_amount) {
        throw new Error('Invalid max_sol_amount number. Must be greater than 0 and min_sol_amount.');
    }
    if (typeof executions !== 'number' || !Number.isInteger(executions) || executions <= 0) {
        throw new Error('Invalid executions number. Must be greater than 0.');
    }
    if (typeof bundle_tip !== 'number' || bundle_tip <= 0.0) {
        throw new Error('Invalid bundle_tip number. Must be greater than 0.0.');
    }
    if (typeof delay !== 'number' || delay <= 0) {
        throw new Error('Invalid delay number. Must be greater than 0.');
    }
    if (
        json.type === VolumeType.Fast &&
        (!wallet_cnt || typeof wallet_cnt !== 'number' || wallet_cnt <= 0 || wallet_cnt > VOLUME_MAX_WALLETS_PER_EXEC)
    ) {
        throw new Error(
            `Invalid wallet_cnt number. Must be greater than 0 and less than or equal to ${VOLUME_MAX_WALLETS_PER_EXEC}.`
        );
    }
    if (json.type === VolumeType.Natural && wallet_cnt) {
        throw new Error('Invalid wallet_cnt number. Must be undefined for Natural type.');
    }
    json.mint = new PublicKey(mint);

    return json as VolumeConfig;
}

function log_volume_config(volume_config: VolumeConfig) {
    const to_print = {
        ...volume_config,
        type: VolumeType[volume_config.type],
        mint: volume_config.mint.toString(),
        min_sol_amount: `${volume_config.min_sol_amount} SOL`,
        max_sol_amount: `${volume_config.max_sol_amount} SOL`,
        bundle_tip: `${volume_config.bundle_tip} SOL`,
        delay: volume_config.delay ? `${volume_config.delay} secs` : 'N/A'
    };

    const max_length = Math.max(...Object.values(to_print).map((value) => value.toString().length));

    common.print_header([
        { title: 'Parameter', width: common.COLUMN_WIDTHS.parameter, align: 'center' },
        { title: 'Value', width: max_length, align: 'center' }
    ]);

    for (const [key, value] of Object.entries(to_print)) {
        common.print_row([
            { content: key, width: common.COLUMN_WIDTHS.parameter, align: 'center' },
            { content: value.toString(), width: max_length, align: 'left' }
        ]);
    }

    common.print_footer([{ width: common.COLUMN_WIDTHS.parameter }, { width: max_length }]);
}
