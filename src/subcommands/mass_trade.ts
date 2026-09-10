import { AddressLookupTableAccount, Keypair, TransactionInstruction } from '@solana/web3.js';
import * as common from '../common/common';
import * as trade from '../common/trade_common';
import { COMMITMENT, PriorityLevel } from '../constants';
import { get_program_compute_unit_limit } from '../common/get_trader';
import { Executor } from '../common/executor';

export async function bundle_buy(
    mint_meta: trade.IMintMeta,
    entries: [common.Wallet, number][],
    executor: Executor,
    slippage: number,
    bundle_tip: number,
    priority: PriorityLevel
): Promise<void> {
    const wallet_bundles = common.chunks(entries, trade.get_bundle_size());
    const bundles: Promise<void>[] = [];
    const ltas: AddressLookupTableAccount[] = [];
    let failed = 0;

    for (const wallet_bundle of wallet_bundles) {
        const instructions: TransactionInstruction[][] = [];
        const signers: Keypair[][] = [];
        for (const entry of wallet_bundle) {
            const [wallet, amount] = entry;
            const buyer = wallet.keypair;
            try {
                const funding = await executor.has_enough_balances(amount, buyer.publicKey, mint_meta, slippage);
                if (funding.status !== 'ready') continue;
                common.log(
                    `Buying ${amount.toFixed(6)} SOL worth of tokens with ${buyer.publicKey.toString().padEnd(44, ' ')} (${wallet.name})...`
                );
                const [buy_instructions, buy_ltas] = await executor.buy_token_instructions(
                    amount,
                    buyer,
                    mint_meta,
                    slippage
                );
                mint_meta = executor.trader.update_mint_meta_reserves(mint_meta, funding.quote_amount, 'buy');
                instructions.push(buy_instructions);
                signers.push([buyer]);
                for (const lta of buy_ltas || []) {
                    if (!ltas.some((existing) => existing.key.equals(lta.key))) ltas.push(lta);
                }
            } catch (error) {
                failed++;
                common.error(common.red(`Failed to add buy instruction to bundle ${wallet.name}: ${error}`));
            }
        }
        if (instructions.length === 0) continue;
        bundles.push(
            trade
                .send_bundle(instructions, signers, bundle_tip, priority, ltas, get_program_compute_unit_limit())
                .then((signature) => common.log(common.green(`Bundle completed, signature: ${signature}`)))
                .catch((error) => {
                    failed++;
                    common.error(common.red(`Bundle failed: ${error}`));
                })
        );
        await common.sleep(trade.get_bundle_interval_ms());
        mint_meta = await executor.trader.update_mint_meta(mint_meta);
    }
    await Promise.allSettled(bundles);
    if (failed > 0) throw new Error(`${failed} bundle buy operation(s) failed.`);
}

export async function bundle_sell(
    mint_meta: trade.IMintMeta,
    wallets: common.Wallet[],
    executor: Executor,
    percent: number,
    slippage: number,
    bundle_tip: number,
    priority: PriorityLevel
): Promise<void> {
    const wallets_with_balance = (
        await Promise.all(
            wallets.map(async (wallet) => {
                const token_amount = await trade.get_token_balance(
                    wallet.keypair.publicKey,
                    mint_meta.mint_pubkey,
                    COMMITMENT,
                    mint_meta.token_program
                );
                if (token_amount && token_amount.uiAmount && token_amount.uiAmount > 0) {
                    return {
                        ...wallet,
                        token_amount
                    };
                }
                return null;
            })
        )
    )
        .filter((wallet) => wallet !== null)
        .sort((a, b) => b!.token_amount.uiAmount! - a!.token_amount.uiAmount!);

    const wallet_bundles = common.chunks(wallets_with_balance, trade.get_bundle_size());
    const bundles: Promise<void>[] = [];
    const ltas: AddressLookupTableAccount[] = [];
    let failed = 0;

    for (const wallet_bundle of wallet_bundles) {
        const instructions: TransactionInstruction[][] = [];
        const signers: Keypair[][] = [];
        for (const wallet of wallet_bundle) {
            const seller = wallet.keypair;
            const token_amount = trade.get_token_amount_by_percent(wallet.token_amount, percent);
            try {
                common.log(
                    `Selling ${token_amount.uiAmount} tokens from ${seller.publicKey.toString().padEnd(44, ' ')} (${wallet.name})...`
                );
                const [sell_instructions, sell_ltas] = await executor.sell_token_instructions(
                    token_amount,
                    seller,
                    mint_meta,
                    slippage
                );
                mint_meta = executor.trader.update_mint_meta_reserves(mint_meta, token_amount, 'sell');
                instructions.push(sell_instructions);
                signers.push([seller]);
                for (const lta of sell_ltas || []) {
                    if (!ltas.some((existing) => existing.key.equals(lta.key))) ltas.push(lta);
                }
            } catch (error) {
                failed++;
                common.error(common.red(`Failed to add sell instruction to bundle ${wallet.name}: ${error}`));
            }
        }
        if (instructions.length === 0) continue;
        bundles.push(
            trade
                .send_bundle(instructions, signers, bundle_tip, priority, ltas, get_program_compute_unit_limit())
                .then((signature) => common.log(common.green(`Bundle completed, signature: ${signature}`)))
                .catch((error) => {
                    failed++;
                    common.error(common.red(`Bundle failed: ${error}`));
                })
        );
        await common.sleep(trade.get_bundle_interval_ms());
        mint_meta = await executor.trader.update_mint_meta(mint_meta);
    }
    await Promise.allSettled(bundles);
    if (failed > 0) throw new Error(`${failed} bundle sell operation(s) failed.`);
}

export async function seq_buy(
    mint_meta: trade.IMintMeta,
    entries: [common.Wallet, number][],
    executor: Executor,
    slippage: number,
    priority: PriorityLevel,
    protection_tip?: number,
    mev_protect: boolean = false
): Promise<void> {
    let failed = 0;

    for (const entry of entries) {
        const [wallet, amount] = entry;
        const buyer = wallet.keypair;
        try {
            const funding = await executor.has_enough_balances(amount, buyer.publicKey, mint_meta, slippage);
            if (funding.status !== 'ready') continue;
            common.log(
                `Buying ${amount.toFixed(6)} SOL worth of tokens with ${buyer.publicKey.toString().padEnd(44, ' ')} (${wallet.name})...`
            );
            try {
                const signature = await executor.buy_token(
                    amount,
                    buyer,
                    mint_meta,
                    slippage,
                    priority,
                    protection_tip,
                    mev_protect
                );
                common.log(common.green(`Transaction completed for ${wallet.name}, signature: ${signature}`));
            } catch (error) {
                failed++;
                const message = error instanceof Error ? error.message : String(error);
                common.error(common.red(`Transaction failed for ${wallet.name} (${wallet.id}): ${message}`));
            }
            mint_meta = await executor.trader.update_mint_meta(mint_meta);
        } catch (error) {
            failed++;
            common.error(common.red(`Failed to buy the token for ${wallet.name}: ${error}`));
        }
    }
    if (failed > 0) throw new Error(`${failed} sequential buy operation(s) failed.`);
}

export async function seq_sell(
    mint_meta: trade.IMintMeta,
    wallets: common.Wallet[],
    executor: Executor,
    percent: number,
    slippage: number,
    priority: PriorityLevel,
    protection_tip?: number,
    mev_protect: boolean = false
): Promise<void> {
    let failed = 0;

    for (const wallet of wallets) {
        const seller = wallet.keypair;
        try {
            const token_amount = await trade.get_token_balance(
                seller.publicKey,
                mint_meta.mint_pubkey,
                COMMITMENT,
                mint_meta.token_program
            );
            if (!token_amount || token_amount.uiAmount === 0 || !token_amount.uiAmount) continue;
            const token_amount_to_sell = trade.get_token_amount_by_percent(token_amount, percent);
            common.log(
                `Selling ${token_amount_to_sell.uiAmount} tokens from ${seller.publicKey.toString().padEnd(44, ' ')} (${wallet.name})...`
            );
            try {
                const signature = await executor.sell_token(
                    token_amount_to_sell,
                    seller,
                    mint_meta,
                    slippage,
                    priority,
                    protection_tip,
                    mev_protect
                );
                common.log(common.green(`Transaction completed for ${wallet.name}, signature: ${signature}`));
            } catch (error) {
                failed++;
                const message = error instanceof Error ? error.message : String(error);
                common.error(common.red(`Transaction failed for ${wallet.name} (${wallet.id}): ${message}`));
            }
            mint_meta = await executor.trader.update_mint_meta(mint_meta);
        } catch (error) {
            failed++;
            common.error(common.red(`Failed to sell the token for ${wallet.name}: ${error}`));
        }
    }
    if (failed > 0) throw new Error(`${failed} sequential sell operation(s) failed.`);
}
