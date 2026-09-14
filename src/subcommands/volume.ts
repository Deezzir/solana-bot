import inquirer from 'inquirer';
import * as common from '../common/common';
import {
    AddressLookupTableAccount,
    Keypair,
    PublicKey,
    SystemProgram,
    TokenAmount,
    TransactionInstruction
} from '@solana/web3.js';
import * as trade from '../common/trade_common';
import {
    VOLUME_MAX_WALLETS_PER_EXEC,
    VOLUME_TRADE_SLIPPAGE,
    VOLUME_MAX_WALLETS_PER_COLLECT_TX,
    VOLUME_MAX_WALLETS_PER_FUND_TX,
    VOLUME_SIGNATURE_FEE_LAMPORTS,
    VOLUME_WALLET_RENT_RESERVE_SOL,
    VOLUME_NATURAL_DEFAULTS,
    COMMANDS_BUY_SLIPPAGE,
    COMMANDS_SELL_SLIPPAGE,
    PriorityLevel,
    SENDER_MAX_MIN_PRIORITY_FEE,
    MAX_COMPUTE_UNIT_LIMIT,
    MAX_TRANSACTION_SIGNATURES,
    COMPUTE_UNIT_BUFFER,
    TransactionRelay,
    COMMITMENT
} from '../constants';
import {
    createCloseAccountInstruction,
    createHarvestWithheldTokensToMintInstruction,
    getMint,
    decode_token_account,
    TOKEN_2022_PROGRAM_ID
} from '../common/token';
import { Executor } from '../common/executor';

type VolumeConfig = {
    type: VolumeType;
    mint: PublicKey;
    wallet_cnt: number;
    min_sol_amount: number;
    max_sol_amount: number;
    executions: number;
    delay: number;
    bundle_tip: number;
    hold_min?: number;
    hold_max?: number;
};

type Position = {
    buy_signature: string;
    fill?: Awaited<ReturnType<typeof get_natural_fill>>;
    sell_at: number;
    sell_signature?: string;
};

type WalletTrade = { keypair: Keypair; instructions: TransactionInstruction[][] };

export enum VolumeType {
    Fast = 'Fast',
    Natural = 'Natural',
    Bump = 'Bump'
}

export async function execute_fast(
    funder: Keypair,
    volume_config: VolumeConfig,
    executor: Executor
): Promise<common.Wallet[]> {
    const target_file = common.setup_rescue_file();
    if (!target_file) throw new Error('Failed to create the volume rescue file.');
    common.log(`Recovery wallets: ${target_file}`);
    const mint_meta = await executor.get_mint_meta(volume_config.mint);
    if (!mint_meta) throw new Error('Failed to fetch mint metadata.');
    if (
        calc_buy_amount(
            trade.sol_to_lamports(volume_config.min_sol_amount),
            VOLUME_TRADE_SLIPPAGE,
            mint_meta.platform_fee,
            volume_config.bundle_tip,
            trade.get_bundle_size(),
            trade.get_bundle_size()
        ) <= 0n
    )
        throw new Error('Minimum wallet funding is insufficient for the trade, fees, tip and account rent.');

    for (let exec = 0; exec < volume_config.executions; exec++) {
        await validate_funder(funder, volume_config);
        const keypairs: Keypair[] = [];
        for (let i = 0; i < volume_config.wallet_cnt; i++) {
            const pair = await Keypair.generate();
            common.save_rescue_key(pair, target_file, exec, i);
            keypairs.push(pair);
        }
        const keypairs_with_amounts = common.zip(
            keypairs,
            Array.from({ length: volume_config.wallet_cnt }, () =>
                trade.sol_to_lamports(common.uniform_random(volume_config.min_sol_amount, volume_config.max_sol_amount))
            )
        );
        common.log(common.blue(`\nRunning execution: ${exec + 1}`));

        let lta: AddressLookupTableAccount | undefined;
        if ((global.TRANSACTION_VERSION ?? 0) === 0) {
            common.log(`\nCreating Address Lookup Table Account...`);
            lta = await trade.generate_trade_lta(funder, keypairs, volume_config.mint, mint_meta.token_program);
            common.log(common.green(`LTA created: ${lta.key.toBase58()}`));
        }

        try {
            common.log('\nFunding the wallets...');
            await fund_bundles(keypairs_with_amounts, funder, volume_config.bundle_tip, lta);

            common.log(`\nTrading the tokens...`);
            await buy_sell_bundles(
                keypairs_with_amounts,
                executor,
                await executor.update_mint_meta(mint_meta),
                volume_config.bundle_tip,
                lta
            );

            common.log('\nCollecting the funds from the wallets...');
            await collect_bundles(keypairs, funder, volume_config.bundle_tip, lta);
        } finally {
            if (lta) {
                await trade
                    .deactivate_ltas(funder, [lta])
                    .then(() =>
                        common.log(
                            `LTA deactivated: ${lta.key.toBase58()}. Its rent can be reclaimed with close-ltas after cooldown.`
                        )
                    )
                    .catch((error) => common.warn(`Could not deactivate ALT ${lta!.key}: ${error}`));
            }
        }

        if (exec + 1 < volume_config.executions && volume_config.delay > 0) {
            const delay_seconds = Math.max(0, common.normal_random(volume_config.delay, volume_config.delay * 0.1));
            common.log(common.blue(`Sleeping for ${delay_seconds.toFixed(1)} seconds`));
            await common.sleep(delay_seconds * 1000);
        }
    }

    common.log(common.green('\nThe Fast Volume Bot completed\n'));
    return common.get_wallets(target_file);
}

export async function execute_natural(
    wallets: common.Wallet[],
    config: VolumeConfig,
    executor: Executor
): Promise<void> {
    const states: {
        wallet: common.Wallet;
        last_used: number;
        buy_at?: number;
        position?: Position;
    }[] = (await get_natural_wallets(wallets, config)).map(({ wallet }) => ({ wallet, last_used: 0 }));
    let mint_meta = await executor.get_mint_meta(config.mint);
    if (!mint_meta) throw new Error('Failed to fetch mint metadata.');
    const interval = config.delay * 1000;
    const hold_min = config.hold_min ?? VOLUME_NATURAL_DEFAULTS.hold_min;
    const hold_max = config.hold_max ?? VOLUME_NATURAL_DEFAULTS.hold_max;
    let next_execution = Date.now();
    let executions = 0;
    const buys = new Set<string>();
    let sells = 0;
    let stopping = false;
    const failures: string[] = [];
    const unresolved: { wallet: string; position: Position }[] = [];
    const stop_buys = (error: unknown) => {
        stopping = true;
        failures.push(String(error));
        common.warn(`Natural volume is stopping new buys: ${error}`);
        for (const state of states) {
            state.buy_at = undefined;
            if (state.position) state.position.sell_at = Date.now();
        }
    };

    while (
        (!stopping && executions < config.executions) ||
        states.some((state) => state.buy_at !== undefined || state.position)
    ) {
        const now = Date.now();
        const seller = states
            .filter((state) => state.position)
            .sort((a, b) => a.position!.sell_at - b.position!.sell_at)[0];
        const buyer = states.filter((state) => state.buy_at !== undefined).sort((a, b) => a.buy_at! - b.buy_at!)[0];
        if (seller?.position && seller.position.sell_at <= now) {
            const position = seller.position;
            try {
                if (position.sell_signature) {
                    const tx = await trade.retry_get_tx(position.sell_signature);
                    if (!tx?.meta) throw new Error(`Sell outcome is still unknown: ${position.sell_signature}`);
                    if (tx.meta.err === null) {
                        sells++;
                        seller.position = undefined;
                        continue;
                    }
                    throw new Error(`Sell failed on-chain: ${position.sell_signature}`);
                }
                const fill = (position.fill ??= await get_natural_fill(
                    position.buy_signature,
                    seller.wallet.keypair.publicKey,
                    mint_meta
                ));
                buys.add(position.buy_signature);
                const ata = await trade.calc_ata(seller.wallet.keypair.publicKey, config.mint, mint_meta.token_program);
                const account = await global.CONNECTION.getAccountInfo(ata, {
                    commitment: COMMITMENT,
                    minContextSlot: fill.slot
                });
                const available = account ? decode_token_account(account).amount - fill.baseline : 0n;
                const bought = BigInt(fill.amount.amount);
                const amount = available < bought ? available : bought;
                if (amount > 0n) {
                    mint_meta = await executor.update_mint_meta(mint_meta);
                    const signature = await executor.sell_token(
                        { amount: amount.toString(), decimals: fill.amount.decimals, uiAmount: null },
                        seller.wallet.keypair,
                        mint_meta,
                        COMMANDS_SELL_SLIPPAGE,
                        PriorityLevel.HIGH
                    );
                    common.log(common.green(`Natural sell | ${seller.wallet.name} | ${signature}`));
                    sells++;
                } else
                    common.log(
                        common.yellow(`Skipping ${seller.wallet.name}: the run's token balance is no longer available.`)
                    );
                seller.position = undefined;
                seller.last_used = Date.now();
            } catch (error) {
                stop_buys(error);
                if (error instanceof trade.TransactionSubmissionError && error.outcome === 'unknown') {
                    position.sell_signature = error.signatures[0];
                } else {
                    unresolved.push({ wallet: seller.wallet.keypair.publicKey.toBase58(), position });
                    seller.position = undefined;
                }
            }
            continue;
        }
        if (buyer?.buy_at !== undefined && buyer.buy_at <= now) {
            buyer.buy_at = undefined;
            buyer.last_used = now;
            try {
                const balance = await trade.get_balance(buyer.wallet.keypair.publicKey, COMMITMENT);
                const maximum = natural_buy_limit(balance, config);
                if (maximum < trade.sol_to_lamports(config.min_sol_amount)) {
                    common.log(common.yellow(`Skipping ${buyer.wallet.name}: insufficient SOL for a buy and fees.`));
                    continue;
                }
                const amount = common.uniform_random(config.min_sol_amount, trade.lamports_to_sol(maximum));
                mint_meta = await executor.update_mint_meta(mint_meta);
                const signature = await executor.buy_token(
                    amount,
                    buyer.wallet.keypair,
                    mint_meta,
                    COMMANDS_BUY_SLIPPAGE,
                    PriorityLevel.HIGH
                );
                common.log(common.green(`Natural buy | ${buyer.wallet.name} | ${amount} SOL | ${signature}`));
                buyer.position = {
                    buy_signature: signature.toString(),
                    sell_at: Date.now() + common.uniform_random(hold_min, hold_max) * 1000
                };
                buys.add(signature.toString());
            } catch (error) {
                stop_buys(error);
                if (error instanceof trade.TransactionSubmissionError && error.outcome === 'unknown')
                    buyer.position = { buy_signature: error.signatures[0], sell_at: Date.now() };
            }
            continue;
        }
        if (!stopping && executions < config.executions && next_execution <= now) {
            const candidates = states
                .filter((state) => !state.position && state.buy_at === undefined && now - state.last_used >= interval)
                .map((state) => ({ state, rank: Math.random() * Math.max(interval, now - state.last_used) }))
                .sort((a, b) => b.rank - a.rank);
            if (candidates.length) {
                const count = 1 + Math.floor(Math.random() * Math.min(config.wallet_cnt, candidates.length));
                for (const { state } of candidates.slice(0, count)) {
                    state.buy_at = now + common.uniform_random(0, config.delay) * 1000;
                    state.last_used = now;
                }
                executions++;
                common.log(
                    common.blue(`Natural execution ${executions}/${config.executions} | ${count} wallets selected`)
                );
            }
            next_execution = now + Math.max(1, common.normal_random(config.delay, config.delay * 0.1) * 1000);
            continue;
        }
        const next_event = Math.min(
            seller?.position?.sell_at ?? Infinity,
            buyer?.buy_at ?? Infinity,
            !stopping && executions < config.executions ? next_execution : Infinity
        );
        await common.sleep(Math.min(1000, Math.max(1, next_event - Date.now())));
    }
    if (failures.length) {
        const pending = unresolved.map(
            ({ wallet, position }) =>
                `${wallet}: buy ${position.buy_signature}, sell ${position.sell_signature ?? 'not confirmed'}, ` +
                `purchased tokens ${position.fill?.amount.amount ?? 'unresolved'}`
        );
        throw new Error(
            `Natural volume stopped | ${buys.size} confirmed buys | ${sells} confirmed sells.\n` +
                [...failures, ...pending].join('\n')
        );
    }
    common.log(common.green(`\nNatural volume completed | ${buys.size} buys | ${sells} sells\n`));
}

async function get_natural_wallets(
    wallets: common.Wallet[],
    config: VolumeConfig
): Promise<{ wallet: common.Wallet; maximum: bigint }[]> {
    const reserves = new Set(
        wallets.filter((wallet) => wallet.is_reserve).map((wallet) => wallet.keypair.publicKey.toBase58())
    );
    const traders = [
        ...new Map(
            wallets
                .filter((wallet) => !reserves.has(wallet.keypair.publicKey.toBase58()))
                .map((wallet) => [wallet.keypair.publicKey.toBase58(), wallet])
        ).values()
    ];
    if (!traders.length) throw new Error('Natural volume requires non-reserve trader wallets from the keys file.');
    const funded: { wallet: common.Wallet; maximum: bigint }[] = [];
    for (const group of common.chunks(traders, 100)) {
        const accounts = await global.CONNECTION.getMultipleAccountsInfo(
            group.map((wallet) => wallet.keypair.publicKey),
            COMMITMENT
        );
        group.forEach((wallet, index) => {
            const maximum = natural_buy_limit(accounts[index]?.lamports ?? 0n, config);
            if (maximum >= trade.sol_to_lamports(config.min_sol_amount)) funded.push({ wallet, maximum });
        });
    }
    if (!funded.length) throw new Error('No trader wallet has enough SOL for the minimum buy and fees.');
    return funded;
}

function natural_buy_limit(balance_lamports: bigint, config: VolumeConfig): bigint {
    const reserve =
        trade.sol_to_lamports(VOLUME_WALLET_RENT_RESERVE_SOL) +
        (BigInt(VOLUME_SIGNATURE_FEE_LAMPORTS) + minimum_priority_fee()) * 2n;
    const maximum = trade.sol_to_lamports(config.max_sol_amount);
    const available = balance_lamports > reserve ? balance_lamports - reserve : 0n;
    const limit = (available * 10000n) / (10000n + BigInt(Math.floor(COMMANDS_BUY_SLIPPAGE * 10000)));
    return limit < maximum ? limit : maximum;
}

async function get_natural_fill(
    signature: string,
    owner: PublicKey,
    mint_meta: trade.IMintMeta
): Promise<{ baseline: bigint; amount: TokenAmount; slot: bigint }> {
    const ata = await trade.calc_ata(owner, mint_meta.mint_pubkey, mint_meta.token_program);
    const tx = await trade.retry_get_tx(signature);
    if (tx) {
        if (!tx.meta || tx.meta.err || !tx.meta.preTokenBalances || !tx.meta.postTokenBalances)
            throw new Error(`Missing successful token balance metadata for Natural buy ${signature}.`);
        const index = tx.transaction.message.accountKeys.findIndex((key) => key.pubkey.equals(ata));
        const before = tx.meta.preTokenBalances.find(
            (entry) => entry.accountIndex === index && entry.mint === mint_meta.token_mint
        );
        const after = tx.meta.postTokenBalances.find(
            (entry) => entry.accountIndex === index && entry.mint === mint_meta.token_mint
        );
        const baseline = BigInt(before?.uiTokenAmount.amount ?? '0');
        const received = BigInt(after?.uiTokenAmount.amount ?? '0') - baseline;
        if (!after || received <= 0n) throw new Error(`No token credit found for Natural buy ${signature}.`);
        return {
            baseline,
            slot: tx.slot,
            amount: { amount: received.toString(), decimals: after.uiTokenAmount.decimals, uiAmount: null }
        };
    }
    throw new Error(
        `Natural buy ${signature} was submitted, but its token credit could not be read. Stopping without resubmitting.`
    );
}

export async function execute_bump(
    funder: Keypair,
    volume_config: VolumeConfig,
    executor: Executor
): Promise<common.Wallet[]> {
    let mint_meta = await executor.get_mint_meta(volume_config.mint);
    if (!mint_meta) throw new Error('Failed to fetch mint metadata.');
    const budget = estimate_bump_cost(volume_config, mint_meta.platform_fee);
    const balance = await trade.get_balance(funder.publicKey, COMMITMENT);
    if (balance < budget.total_lamports)
        throw new Error(
            `Funder has insufficient balance. Estimated requirement: ${trade.lamports_to_sol(budget.total_lamports).toFixed(6)} SOL.`
        );

    const target_file = common.setup_rescue_file();
    if (!target_file) throw new Error('Failed to create the volume rescue file.');
    common.log(`Recovery wallets: ${target_file}`);
    const wallet = await Keypair.generate();
    common.save_rescue_key(wallet, target_file, 0, 0);
    const close_instructions = await get_token_close_instructions(
        wallet.publicKey,
        mint_meta,
        await has_transfer_fee(mint_meta)
    );
    common.log(
        common.blue(
            `Bump wallet: ${wallet.publicKey.toBase58()} | Funding: ${trade.lamports_to_sol(budget.funding_amount).toFixed(6)} SOL`
        )
    );
    await fund_bundles([[wallet, budget.funding_amount]], funder, volume_config.bundle_tip);

    for (let exec = 0; exec < volume_config.executions; exec++) {
        mint_meta = await executor.update_mint_meta(mint_meta);
        const amount = common.uniform_random(volume_config.min_sol_amount, volume_config.max_sol_amount);
        const cycle_cost = estimate_bump_cost(volume_config, mint_meta.platform_fee).cycle_cost;
        const required =
            trade.apply_slippage_up(trade.sol_to_lamports(amount), VOLUME_TRADE_SLIPPAGE) +
            cycle_cost +
            trade.sol_to_lamports(VOLUME_WALLET_RENT_RESERVE_SOL);
        const wallet_balance = await trade.get_balance(wallet.publicKey, COMMITMENT);
        if (wallet_balance < required)
            throw new Error(
                `Bump wallet ${wallet.publicKey.toBase58()} has insufficient SOL for execution ${exec + 1}.`
            );
        const [buy_instructions, sell_instructions, ltas] = await executor.buy_sell_instructions(
            amount,
            wallet,
            mint_meta,
            VOLUME_TRADE_SLIPPAGE
        );
        const tip_instruction = trade.create_tip_instruction(wallet.publicKey, volume_config.bundle_tip);
        const instructions = pack_wallet_trade(
            [...buy_instructions, ...sell_instructions],
            exec + 1 === volume_config.executions ? close_instructions : [],
            wallet.publicKey,
            ltas,
            tip_instruction
        );
        const signature = await trade.send_bundle(
            instructions,
            instructions.map(() => [wallet]),
            volume_config.bundle_tip,
            undefined,
            ltas,
            undefined,
            global.TRANSACTION_VERSION ?? 0,
            { tip_account: tip_instruction.keys[1].pubkey }
        );
        common.log(
            common.green(`Bump ${exec + 1}/${volume_config.executions} | ${amount.toFixed(6)} SOL | ${signature}`)
        );
        if (exec + 1 < volume_config.executions)
            await common.sleep(Math.max(volume_config.delay * 1000, trade.get_bundle_interval_ms()));
    }

    await collect_bundles([wallet], funder, volume_config.bundle_tip);
    common.log(common.green('\nThe Bump Bot completed\n'));
    return common.get_wallets(target_file);
}

export async function simulate(
    sol_price: number,
    volume_config: VolumeConfig,
    executor: Executor,
    wallets: common.Wallet[] = []
) {
    const mint_meta = await executor.get_mint_meta(volume_config.mint);
    if (!mint_meta) throw new Error('Failed to fetch mint metadata.');

    switch (volume_config.type) {
        case VolumeType.Natural: {
            const limits = (await get_natural_wallets(wallets, volume_config)).map(({ maximum }) => maximum);
            const subset = Math.min(volume_config.wallet_cnt, limits.length);
            const expected_trades = BigInt(volume_config.executions) * BigInt(1 + subset);
            const minimum = trade.sol_to_lamports(volume_config.min_sol_amount);
            const total_volume =
                (expected_trades * limits.reduce((sum, limit) => sum + minimum + limit, 0n)) /
                (2n * BigInt(limits.length));
            const total_fee =
                calc_platform_fee(total_volume, mint_meta.platform_fee) +
                expected_trades * (BigInt(VOLUME_SIGNATURE_FEE_LAMPORTS) + minimum_priority_fee());
            const total_volume_sol = trade.lamports_to_sol(total_volume);
            const total_fee_sol = trade.lamports_to_sol(total_fee);
            common.log(
                'Natural estimates assume funded wallets remain available; holding times, price changes, priority fees and setup rent affect actual results.\n'
            );
            return {
                total_sol_utilization: trade.lamports_to_sol(
                    limits
                        .sort((a, b) => (a === b ? 0 : a > b ? -1 : 1))
                        .slice(0, subset * volume_config.executions)
                        .reduce((sum, limit) => sum + trade.apply_slippage_up(limit, COMMANDS_BUY_SLIPPAGE), 0n)
                ),
                total_fee_sol,
                total_fee_usd: total_fee_sol * sol_price,
                total_volume_sol,
                total_volume_usd: total_volume_sol * sol_price
            };
        }
        case VolumeType.Bump: {
            const budget = estimate_bump_cost(volume_config, mint_meta.platform_fee);
            const total_volume_sol = trade.lamports_to_sol(
                (trade.sol_to_lamports(volume_config.min_sol_amount) +
                    trade.sol_to_lamports(volume_config.max_sol_amount)) *
                    BigInt(volume_config.executions)
            );
            common.log(
                'Estimates exclude priority fees above the relay minimum, price impact and retained program-account rent.\n'
            );
            return {
                total_sol_utilization: trade.lamports_to_sol(budget.total_lamports),
                total_fee_sol: trade.lamports_to_sol(budget.total_fee_lamports),
                total_fee_usd: trade.lamports_to_sol(budget.total_fee_lamports) * sol_price,
                total_volume_sol,
                total_volume_usd: total_volume_sol * sol_price
            };
        }
        case VolumeType.Fast: {
            const execution_cost = await estimate_fast_execution_cost(volume_config);
            let total_fee = execution_cost * BigInt(volume_config.executions);
            let total_volume = 0n;
            for (let i = 0; i < volume_config.executions; i++) {
                for (let j = 0; j < volume_config.wallet_cnt; j++) {
                    const funding = common.uniform_random(volume_config.min_sol_amount, volume_config.max_sol_amount);
                    const amount = calc_buy_amount(
                        trade.sol_to_lamports(funding),
                        VOLUME_TRADE_SLIPPAGE,
                        mint_meta.platform_fee,
                        volume_config.bundle_tip,
                        trade.get_bundle_size(),
                        trade.get_bundle_size()
                    );
                    if (amount <= 0n)
                        throw new Error('Wallet funding is insufficient for the trade, fees, tip and account rent.');
                    total_fee += calc_platform_fee(amount, mint_meta.platform_fee) * 2n;
                    total_volume += amount * 2n;
                }
            }
            common.log(
                'Cost estimates reserve a full trading bundle per wallet and include retained ALT rent. Variable priority fees, price impact and other setup rent are excluded.\n'
            );
            const total_fee_sol = trade.lamports_to_sol(total_fee);
            const total_volume_sol = trade.lamports_to_sol(total_volume);
            return {
                total_sol_utilization: trade.lamports_to_sol(
                    trade.sol_to_lamports(volume_config.max_sol_amount) * BigInt(volume_config.wallet_cnt) + total_fee
                ),
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

function estimate_bump_cost(config: VolumeConfig, platform_fee: number) {
    const signature_fee = BigInt(VOLUME_SIGNATURE_FEE_LAMPORTS);
    const priority_fee = minimum_priority_fee();
    const amount = trade.sol_to_lamports(config.max_sol_amount);
    const tip = trade.sol_to_lamports(config.bundle_tip);
    const cycle_cost =
        tip +
        BigInt(trade.get_bundle_size()) * (signature_fee + priority_fee) +
        calc_platform_fee(amount, platform_fee) * 2n;
    const fund_collect_cost = tip * 2n + signature_fee * 3n + priority_fee * 2n;
    const funding_amount =
        trade.apply_slippage_up(amount, VOLUME_TRADE_SLIPPAGE) +
        cycle_cost * BigInt(config.executions) +
        trade.sol_to_lamports(VOLUME_WALLET_RENT_RESERVE_SOL) * 2n;
    return {
        cycle_cost,
        funding_amount,
        total_lamports: funding_amount + fund_collect_cost,
        total_fee_lamports: cycle_cost * BigInt(config.executions) + fund_collect_cost
    };
}

async function validate_funder(funder: Keypair, volume_config: VolumeConfig): Promise<void> {
    const balance = await trade.get_balance(funder.publicKey, COMMITMENT);
    const required_balance =
        trade.sol_to_lamports(volume_config.max_sol_amount) * BigInt(volume_config.wallet_cnt) +
        (await estimate_fast_execution_cost(volume_config));
    if (balance < required_balance)
        throw new Error(
            `Funder has insufficient balance. Estimated funding, fees and ALT rent: ${trade.lamports_to_sol(required_balance).toFixed(4)} SOL, Available: ${trade.lamports_to_sol(balance).toFixed(4)} SOL`
        );
}

async function estimate_fast_execution_cost(config: VolumeConfig): Promise<bigint> {
    const funding_txs = Math.ceil(config.wallet_cnt / VOLUME_MAX_WALLETS_PER_FUND_TX);
    const trading_txs = config.wallet_cnt * trade.get_bundle_size();
    const collection_txs =
        (global.TRANSACTION_VERSION ?? 0) === 1
            ? Math.ceil(config.wallet_cnt / (MAX_TRANSACTION_SIGNATURES - 1))
            : Math.ceil(config.wallet_cnt / VOLUME_MAX_WALLETS_PER_COLLECT_TX);
    const bundles = [funding_txs, trading_txs, collection_txs].reduce(
        (total, count) => total + Math.ceil(count / trade.get_bundle_size()),
        0
    );
    let signatures = funding_txs + trading_txs + config.wallet_cnt + collection_txs;
    let transactions = funding_txs + trading_txs + collection_txs;
    let rent = 0n;
    if ((global.TRANSACTION_VERSION ?? 0) === 0) {
        const addresses = config.wallet_cnt * 3 + 2;
        rent = await global.CONNECTION.getMinimumBalanceForRentExemption(56 + addresses * 32);
        signatures += 2 + Math.ceil(addresses / 20);
        transactions += 2 + Math.ceil(addresses / 20);
    }
    return (
        BigInt(bundles) * trade.sol_to_lamports(config.bundle_tip) +
        BigInt(signatures) * BigInt(VOLUME_SIGNATURE_FEE_LAMPORTS) +
        BigInt(transactions) * minimum_priority_fee() +
        rent
    );
}

function calc_platform_fee(amount: bigint, rate: number): bigint {
    const fee_rate = BigInt(Math.round(rate * 1_000_000_000));
    return (amount * fee_rate + 999_999_999n) / 1_000_000_000n;
}

function minimum_priority_fee(): bigint {
    return (global.TRANSACTION_RELAY ?? TransactionRelay.Sender) === TransactionRelay.Sender
        ? BigInt(SENDER_MAX_MIN_PRIORITY_FEE)
        : 0n;
}

function calc_buy_amount(
    amount: bigint,
    slippage: number,
    platform_fee: number,
    bundle_tip: number = 0,
    signature_count: number = 1,
    transaction_count: number = 1
): bigint {
    return (
        (amount * 10000n) / (10000n + BigInt(Math.floor(slippage * 10000))) -
        calc_platform_fee(amount, platform_fee) * 2n -
        BigInt(signature_count) * BigInt(VOLUME_SIGNATURE_FEE_LAMPORTS) -
        BigInt(transaction_count) * minimum_priority_fee() -
        trade.sol_to_lamports(bundle_tip) -
        trade.sol_to_lamports(VOLUME_WALLET_RENT_RESERVE_SOL)
    );
}

async function fund_bundles(
    wallets: [Keypair, bigint][],
    funder: Keypair,
    bundle_tip: number,
    lta?: AddressLookupTableAccount
): Promise<void> {
    if (wallets.length === 0) throw new Error('No wallets to fund');
    let instructions: TransactionInstruction[] = [];
    wallets.forEach(([keypair, amount]) => {
        const receiver = keypair.publicKey;
        instructions.push(
            SystemProgram.transfer({
                fromPubkey: funder.publicKey,
                toPubkey: receiver,
                lamports: amount
            })
        );
    });

    const version = global.TRANSACTION_VERSION ?? 0;
    const tip = trade.create_tip_instruction(funder.publicKey, bundle_tip);
    const tip_account = tip.keys[1].pubkey;
    const transactions = trade.pack_tx_groups(
        instructions,
        (instruction) => [instruction],
        funder.publicKey,
        version,
        lta ? [lta] : undefined,
        [tip]
    );
    const bundles = common.chunks(transactions, trade.get_bundle_size());
    for (const bundle_instructions of bundles) {
        const signature = await trade.send_bundle(
            bundle_instructions,
            Array.from({ length: bundle_instructions.length }, () => [funder]),
            bundle_tip,
            undefined,
            lta ? [lta] : undefined,
            undefined,
            version,
            { tip_account }
        );
        common.log(common.green(`Fund Bundle completed, signature: ${signature}`));
        await common.sleep(trade.get_bundle_interval_ms());
    }
}

async function collect_bundles(
    wallets: Keypair[],
    receiver: Keypair,
    bundle_tip: number,
    lta?: AddressLookupTableAccount
): Promise<void> {
    if (wallets.length === 0) throw new Error('No wallets to collect from');
    let filtered_keypairs = (
        await Promise.all(
            wallets.map(async (keypair) => {
                const balance = await trade.get_balance(keypair.publicKey, COMMITMENT);
                if (balance === 0n) return;
                return { keypair, balance };
            })
        )
    ).filter((pair) => pair !== undefined);
    const version = global.TRANSACTION_VERSION ?? 0;
    const tip = trade.create_tip_instruction(receiver.publicKey, bundle_tip);
    const tip_account = tip.keys[1].pubkey;
    const transactions = trade.pack_tx_groups(
        filtered_keypairs,
        (wallet) => [
            SystemProgram.transfer({
                fromPubkey: wallet.keypair.publicKey,
                toPubkey: receiver.publicKey,
                lamports: wallet.balance
            })
        ],
        receiver.publicKey,
        version,
        lta ? [lta] : undefined,
        [tip]
    );
    const bundles = common.chunks(transactions, trade.get_bundle_size());

    for (const bundle of bundles) {
        const bundle_instructions: TransactionInstruction[][] = [];
        const bundle_signers: Keypair[][] = [];
        for (const tx of bundle) {
            const tx_instructions: TransactionInstruction[] = [];
            const tx_signers: Keypair[] = [receiver];
            for (const wallet of tx) {
                const amount = wallet.balance;
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
        const signature = await trade.retry_send_bundle(
            bundle_instructions,
            bundle_signers,
            bundle_tip,
            undefined,
            lta ? [lta] : undefined,
            undefined,
            undefined,
            { tip_account }
        );
        common.log(common.green(`Collect Bundle completed, signature: ${signature}`));
        await common.sleep(trade.get_bundle_interval_ms());
    }
}

async function buy_sell_bundles(
    wallets: [Keypair, bigint][],
    executor: Executor,
    mint_meta: trade.IMintMeta,
    bundle_tip: number,
    lta?: AddressLookupTableAccount
): Promise<void> {
    if (wallets.length === 0) throw new Error('No wallets to buy/sell');
    const harvest_fees = await has_transfer_fee(mint_meta);
    const version = global.TRANSACTION_VERSION ?? 0;
    const wallet_limit = Math.min(wallets.length, get_trade_wallet_limit(executor));
    const bundle_size = trade.get_bundle_size();
    for (const wallet_group of common.chunks(wallets, wallet_limit * trade.get_bundle_size())) {
        const entries: WalletTrade[] = [];
        const ltas = new Map<string, AddressLookupTableAccount>();
        if (lta) ltas.set(lta.key.toBase58(), lta);
        const tip_account = trade.create_tip_instruction(wallet_group[0][0].publicKey, bundle_tip).keys[1].pubkey;
        for (const [keypair, amount] of wallet_group) {
            const adjusted_amount = calc_buy_amount(
                amount,
                VOLUME_TRADE_SLIPPAGE,
                mint_meta.platform_fee,
                bundle_tip,
                bundle_size,
                bundle_size
            );
            if (adjusted_amount <= 0n)
                throw new Error('Wallet funding is insufficient for the trade, fees, tip and account rent.');
            const [buy_instrs, sell_instrs, trade_ltas] = await executor.buy_sell_instructions(
                trade.lamports_to_sol(adjusted_amount),
                keypair,
                mint_meta,
                VOLUME_TRADE_SLIPPAGE
            );
            for (const table of trade_ltas ?? []) ltas.set(table.key.toBase58(), table);
            const instructions = pack_wallet_trade(
                [...buy_instrs, ...sell_instrs],
                await get_token_close_instructions(keypair.publicKey, mint_meta, harvest_fees),
                keypair.publicKey,
                [...ltas.values()],
                trade.create_tip_instruction(keypair.publicKey, bundle_tip, undefined, tip_account)
            );
            entries.push({ keypair, instructions });
        }
        const tables = [...ltas.values()];
        while (entries.length > 0) {
            const instructions: TransactionInstruction[][] = [];
            const signers: Keypair[][] = [];
            for (let wallet_index = 0; wallet_index < entries.length;) {
                const entry = entries[wallet_index];
                if (instructions.length + entry.instructions.length > bundle_size) {
                    wallet_index++;
                    continue;
                }
                instructions.push(...entry.instructions);
                signers.push(...entry.instructions.map(() => [entry.keypair]));
                entries.splice(wallet_index, 1);
            }
            const signature = await trade.send_bundle(
                instructions,
                signers,
                bundle_tip,
                undefined,
                tables,
                undefined,
                version,
                { tip_account }
            );
            common.log(common.green(`Trade Bundle completed, signature: ${signature}`));
            await common.sleep(trade.get_bundle_interval_ms());
            mint_meta = await executor.update_mint_meta(mint_meta);
        }
    }
}

function pack_wallet_trade(
    groups: TransactionInstruction[][],
    cleanup: TransactionInstruction[],
    payer: PublicKey,
    ltas: AddressLookupTableAccount[] | undefined,
    tip: TransactionInstruction
): TransactionInstruction[][] {
    const version = global.TRANSACTION_VERSION ?? 0;
    const pack = (items: TransactionInstruction[][], max_items = Infinity) =>
        trade
            .pack_tx_groups(items, (instructions) => instructions, payer, version, ltas, [tip], max_items)
            .map((batch) => batch.flat());
    const instructions =
        groups.length > 2
            ? [
                  ...pack(groups.slice(0, -1), 1),
                  ...pack([groups[groups.length - 1], ...(cleanup.length ? [cleanup] : [])])
              ]
            : pack([...groups, ...(cleanup.length ? [cleanup] : [])]);
    if (instructions.length > trade.get_bundle_size())
        throw new Error('Wallet buy/sell cycle does not fit in one atomic bundle.');
    return instructions;
}

async function has_transfer_fee(mint_meta: trade.IMintMeta): Promise<boolean> {
    if (!mint_meta.token_program.equals(TOKEN_2022_PROGRAM_ID)) return false;
    const { extensions } = await getMint(global.CONNECTION, mint_meta.mint_pubkey, COMMITMENT, mint_meta.token_program);
    return (
        extensions.__option === 'Some' && extensions.value.some((extension) => extension.__kind === 'TransferFeeConfig')
    );
}

async function get_token_close_instructions(
    owner: PublicKey,
    mint_meta: trade.IMintMeta,
    harvest_fees: boolean
): Promise<TransactionInstruction[]> {
    const token_ata = await trade.calc_ata(owner, mint_meta.mint_pubkey, mint_meta.token_program);
    return [
        ...(harvest_fees ? [createHarvestWithheldTokensToMintInstruction(mint_meta.mint_pubkey, [token_ata])] : []),
        createCloseAccountInstruction(token_ata, owner, owner, mint_meta.token_program)
    ];
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
            type !== VolumeType.Bump
                ? await inquirer.prompt<{ wallet_cnt: number }>([
                      {
                          type: 'number',
                          name: 'wallet_cnt',
                          default: type === VolumeType.Natural ? VOLUME_NATURAL_DEFAULTS.wallet_cnt : 1,
                          message:
                              type === VolumeType.Natural
                                  ? `Maximum trader wallets per execution (1-${VOLUME_MAX_WALLETS_PER_EXEC}):`
                                  : `Enter the number of wallets to use, max ${VOLUME_MAX_WALLETS_PER_EXEC} (eg. 2):`,
                          validate: (value: number | undefined) =>
                              value !== undefined &&
                              Number.isSafeInteger(value) &&
                              value > 0 &&
                              value <= VOLUME_MAX_WALLETS_PER_EXEC
                                  ? true
                                  : `Please enter an integer between 1 and ${VOLUME_MAX_WALLETS_PER_EXEC}.`
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
                    min_sol_amount = Number(value);
                    if (!Number.isFinite(min_sol_amount) || min_sol_amount <= 0)
                        return 'Please enter a finite number greater than 0.';
                    return true;
                },
                filter: () => min_sol_amount
            },
            {
                type: 'input',
                name: 'max_sol_amount',
                message: 'Enter the maximum amount of SOL to buy (eg. 0.5):',
                validate: (value: string) => {
                    if (!Number.isFinite(Number(value)) || Number(value) <= 0)
                        return 'Please enter a finite number greater than 0.';
                    if (Number(value) < min_sol_amount) return 'Please enter a number greater than the minimum amount.';
                    return true;
                },
                filter: (value: string) => Number(value)
            },
            {
                type: 'number',
                name: 'executions',
                message: 'Enter the number of executions to perform (eg. 30):',
                validate: (value: number | undefined) =>
                    value !== undefined && Number.isSafeInteger(value) && value > 0
                        ? true
                        : 'Please enter an integer greater than 0.'
            },
            {
                type: 'input',
                name: 'bundle_tip',
                when: () => type !== VolumeType.Natural,
                message: `Enter the bundle tip in SOL (minimum ${get_minimum_bundle_tip()}):`,
                validate: (value: string) => {
                    if (!Number.isFinite(Number(value)) || Number(value) < get_minimum_bundle_tip())
                        return `Please enter a number greater than or equal to ${get_minimum_bundle_tip()}.`;
                    return true;
                },
                filter: (value: string) => Number(value)
            },
            {
                type: 'input',
                name: 'delay',
                default: String(type === VolumeType.Natural ? VOLUME_NATURAL_DEFAULTS.delay : 0),
                message: 'Enter the delay in seconds between the executions (eg. 2.5):',
                validate: (value: string) => {
                    if (type === VolumeType.Natural && Number(value) <= 0) return 'Natural requires a positive delay.';
                    if (!Number.isFinite(Number(value)) || Number(value) < 0)
                        return 'Please enter a finite number greater than or equal to 0.';
                    return true;
                },
                filter: (value: string) => Number(value)
            }
        ]);

        if (type === VolumeType.Natural) {
            let hold_min = VOLUME_NATURAL_DEFAULTS.hold_min;
            const holding = await inquirer.prompt<{ hold_min: number; hold_max: number }>([
                {
                    type: 'input',
                    name: 'hold_min',
                    message: 'Minimum holding time in seconds:',
                    default: String(hold_min),
                    validate: (value: string) => {
                        hold_min = Number(value);
                        return Number.isFinite(hold_min) && hold_min > 0 ? true : 'Enter a finite positive number.';
                    },
                    filter: () => hold_min
                },
                {
                    type: 'input',
                    name: 'hold_max',
                    message: 'Maximum holding time in seconds:',
                    default: String(VOLUME_NATURAL_DEFAULTS.hold_max),
                    validate: (value: string) =>
                        Number.isFinite(Number(value)) && Number(value) >= hold_min
                            ? true
                            : 'Enter a finite number greater than or equal to the minimum holding time.',
                    filter: (value: string) => Number(value)
                }
            ]);
            Object.assign(answers, holding);
        }

        answers = await validate_json_config({ ...answers, mint: answers.mint.toBase58(), type, wallet_cnt });

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

function validate_json_config(json: unknown): VolumeConfig {
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('Volume config must be an object.');
    const input = json as Record<string, unknown>;
    const type = input.type ?? VolumeType.Fast;
    if (type !== VolumeType.Fast && type !== VolumeType.Natural && type !== VolumeType.Bump)
        throw new Error(`Type must be one of: ${Object.values(VolumeType).join(', ')}.`);
    const natural = type === VolumeType.Natural;
    const number_field = (name: string, fallback?: number): number => {
        const value = input[name] ?? fallback;
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be a finite number.`);
        return value;
    };
    const mint = input.mint;
    const wallet_cnt = number_field('wallet_cnt', natural ? VOLUME_NATURAL_DEFAULTS.wallet_cnt : 1);
    const min_sol_amount = number_field('min_sol_amount');
    const max_sol_amount = number_field('max_sol_amount');
    const executions = number_field('executions');
    const delay = number_field('delay', natural ? VOLUME_NATURAL_DEFAULTS.delay : 0);
    const bundle_tip = number_field('bundle_tip', natural ? 0 : undefined);
    const hold_min = natural ? number_field('hold_min', VOLUME_NATURAL_DEFAULTS.hold_min) : undefined;
    const hold_max = natural ? number_field('hold_max', VOLUME_NATURAL_DEFAULTS.hold_max) : undefined;
    if (typeof mint !== 'string' || !common.is_valid_pubkey(mint)) {
        throw new Error('Invalid token mint public key.');
    }
    if (min_sol_amount <= 0) {
        throw new Error('Invalid min_sol_amount number. Must be greater than 0.');
    }
    if (max_sol_amount < min_sol_amount) {
        throw new Error('Invalid max_sol_amount number. Must be greater than 0 and min_sol_amount.');
    }
    if (!Number.isSafeInteger(executions) || executions <= 0) {
        throw new Error('Invalid executions number. Must be greater than 0.');
    }
    if (natural ? bundle_tip !== 0 : bundle_tip < get_minimum_bundle_tip()) {
        if (natural) throw new Error('Natural uses individual transactions; omit bundle_tip.');
        throw new Error(`Invalid bundle_tip. Must be at least ${get_minimum_bundle_tip()} SOL.`);
    }
    if (delay < 0 || !Number.isFinite(delay * 1000)) {
        throw new Error('Invalid delay. Must be a finite number greater than or equal to 0.');
    }
    if (!Number.isSafeInteger(wallet_cnt) || wallet_cnt <= 0 || wallet_cnt > VOLUME_MAX_WALLETS_PER_EXEC) {
        throw new Error(
            `Invalid wallet_cnt number. Must be greater than 0 and less than or equal to ${VOLUME_MAX_WALLETS_PER_EXEC}.`
        );
    }
    if (hold_min !== undefined && hold_max !== undefined) {
        if (delay <= 0) throw new Error('Natural requires a positive delay.');
        if (hold_min <= 0 || !Number.isFinite(hold_max * 1000) || hold_max < hold_min)
            throw new Error('Natural holding times must be positive, with hold_max greater than or equal to hold_min.');
    }
    if (type === VolumeType.Bump && wallet_cnt !== 1) throw new Error('Bump uses one temporary wallet.');
    trade.sol_to_lamports(min_sol_amount);
    trade.sol_to_lamports(max_sol_amount);
    trade.sol_to_lamports(bundle_tip);

    return {
        type,
        mint: new PublicKey(mint),
        wallet_cnt,
        min_sol_amount,
        max_sol_amount,
        executions,
        delay,
        bundle_tip,
        hold_min,
        hold_max
    };
}

const get_minimum_bundle_tip = trade.get_minimum_bundle_tip;

function get_trade_wallet_limit(executor: Executor): number {
    const units = executor.get_compute_unit_limit();
    return units ? Math.max(1, Math.floor(MAX_COMPUTE_UNIT_LIMIT / (2 * units * COMPUTE_UNIT_BUFFER))) : 1;
}

function log_volume_config(volume_config: VolumeConfig) {
    const { bundle_tip, hold_min, hold_max, ...config } = volume_config;
    const to_print = {
        ...config,
        type: VolumeType[volume_config.type],
        mint: volume_config.mint.toString(),
        min_sol_amount: `${volume_config.min_sol_amount} SOL`,
        max_sol_amount: `${volume_config.max_sol_amount} SOL`,
        delay: volume_config.delay ? `${volume_config.delay} secs` : 'N/A',
        ...(volume_config.type === VolumeType.Natural
            ? { hold_min: `${hold_min} secs`, hold_max: `${hold_max} secs` }
            : { bundle_tip: `${bundle_tip} SOL` })
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
