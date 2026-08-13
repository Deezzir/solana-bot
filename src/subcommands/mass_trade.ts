import { AddressLookupTableAccount, LAMPORTS_PER_SOL, Signer, TransactionInstruction } from '@solana/web3.js';
import * as common from '../common/common';
import * as trade from '../common/trade_common';
import { COMMITMENT, JITO_BUNDLE_INTERVAL_MS, JITO_BUNDLE_SIZE, PriorityLevel, SENDER_INTERVAL_MS } from '../constants';

export async function bundle_buy(
    mint_meta: trade.IMintMeta,
    entries: [common.Wallet, number][],
    trader: trade.IProgramTrader,
    slippage: number,
    bundle_tip: number,
    priority: PriorityLevel
): Promise<void> {
    const wallet_bundles = common.chunks(entries, JITO_BUNDLE_SIZE);
    const bundles: Promise<void>[] = [];
    const ltas: AddressLookupTableAccount[] = [];
    let failed = 0;

    for (const wallet_bundle of wallet_bundles) {
        const instructions: TransactionInstruction[][] = [];
        const signers: Signer[][] = [];
        for (const entry of wallet_bundle) {
            const [wallet, amount] = entry;
            const buyer = wallet.keypair;
            try {
                const balance = await trade.get_balance(buyer.publicKey, COMMITMENT);
                if (balance < amount) continue;
                common.log(
                    `Buying ${amount.toFixed(6)} SOL worth of tokens with ${buyer.publicKey.toString().padEnd(44, ' ')} (${wallet.name})...`
                );
                const [buy_instructions, buy_ltas] = await trader.buy_token_instructions(
                    amount,
                    buyer,
                    mint_meta,
                    slippage
                );
                mint_meta = trader.update_mint_meta_reserves(mint_meta, amount);
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
                .send_bundle(instructions, signers, bundle_tip, priority, ltas)
                .then((signature) => common.log(common.green(`Bundle completed, signature: ${signature}`)))
                .catch((error) => {
                    failed++;
                    common.error(common.red(`Bundle failed: ${error}`));
                })
        );
        await common.sleep(JITO_BUNDLE_INTERVAL_MS);
        mint_meta = await trader.update_mint_meta(mint_meta);
    }
    await Promise.allSettled(bundles);
    if (failed > 0) throw new Error(`${failed} bundle buy operation(s) failed.`);
}

export async function bundle_sell(
    mint_meta: trade.IMintMeta,
    wallets: common.Wallet[],
    trader: trade.IProgramTrader,
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

    const wallet_bundles = common.chunks(wallets_with_balance, JITO_BUNDLE_SIZE);
    const bundles: Promise<void>[] = [];
    const ltas: AddressLookupTableAccount[] = [];
    let failed = 0;

    for (const wallet_bundle of wallet_bundles) {
        const instructions: TransactionInstruction[][] = [];
        const signers: Signer[][] = [];
        for (const wallet of wallet_bundle) {
            const seller = wallet.keypair;
            const token_amount = trade.get_token_amount_by_percent(wallet.token_amount, percent);
            try {
                common.log(
                    `Selling ${token_amount.uiAmount} tokens from ${seller.publicKey.toString().padEnd(44, ' ')} (${wallet.name})...`
                );
                const [sell_instructions, sell_ltas] = await trader.sell_token_instructions(
                    token_amount,
                    seller,
                    mint_meta,
                    slippage
                );
                mint_meta = trader.update_mint_meta_reserves(mint_meta, token_amount);
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
                .send_bundle(instructions, signers, bundle_tip, priority, ltas)
                .then((signature) => common.log(common.green(`Bundle completed, signature: ${signature}`)))
                .catch((error) => {
                    failed++;
                    common.error(common.red(`Bundle failed: ${error}`));
                })
        );
        await common.sleep(JITO_BUNDLE_INTERVAL_MS);
        mint_meta = await trader.update_mint_meta(mint_meta);
    }
    await Promise.allSettled(bundles);
    if (failed > 0) throw new Error(`${failed} bundle sell operation(s) failed.`);
}

export async function seq_buy(
    mint_meta: trade.IMintMeta,
    entries: [common.Wallet, number][],
    trader: trade.IProgramTrader,
    slippage: number,
    priority: PriorityLevel,
    protection_tip?: number
): Promise<void> {
    const transactions: Promise<void>[] = [];
    let failed = 0;

    for (const entry of entries) {
        const [wallet, amount] = entry;
        const buyer = wallet.keypair;
        try {
            const balance = (await trade.get_balance(buyer.publicKey, COMMITMENT)) / LAMPORTS_PER_SOL;
            if (balance < amount) continue;
            common.log(
                `Buying ${amount.toFixed(6)} SOL worth of tokens with ${buyer.publicKey.toString().padEnd(44, ' ')} (${wallet.name})...`
            );
            transactions.push(
                trader
                    .buy_token(amount, buyer, mint_meta, slippage, priority, protection_tip)
                    .then((signature) =>
                        common.log(common.green(`Transaction completed for ${wallet.name}, signature: ${signature}`))
                    )
                    .catch((error) => {
                        failed++;
                        common.error(
                            common.red(`Transaction failed for ${wallet.name} (${wallet.id}): ${error.message}`)
                        );
                    })
            );
            mint_meta = trader.update_mint_meta_reserves(mint_meta, amount);
            if (protection_tip) await common.sleep(SENDER_INTERVAL_MS);
            mint_meta = await trader.update_mint_meta(mint_meta);
        } catch (error) {
            failed++;
            common.error(common.red(`Failed to buy the token for ${wallet.name}: ${error}`));
        }
    }
    await Promise.allSettled(transactions);
    if (failed > 0) throw new Error(`${failed} sequential buy operation(s) failed.`);
}

export async function seq_sell(
    mint_meta: trade.IMintMeta,
    wallets: common.Wallet[],
    trader: trade.IProgramTrader,
    percent: number,
    slippage: number,
    priority: PriorityLevel,
    protection_tip?: number
): Promise<void> {
    const transactions: Promise<void>[] = [];
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
            transactions.push(
                trader
                    .sell_token(token_amount_to_sell, seller, mint_meta, slippage, priority, protection_tip)
                    .then((signature) =>
                        common.log(common.green(`Transaction completed for ${wallet.name}, signature: ${signature}`))
                    )
                    .catch((error) => {
                        failed++;
                        common.error(
                            common.red(`Transaction failed for ${wallet.name} (${wallet.id}): ${error.message}`)
                        );
                    })
            );
            mint_meta = trader.update_mint_meta_reserves(mint_meta, token_amount_to_sell);
            if (protection_tip) await common.sleep(SENDER_INTERVAL_MS);
            mint_meta = await trader.update_mint_meta(mint_meta);
        } catch (error) {
            failed++;
            common.error(common.red(`Failed to sell the token for ${wallet.name}: ${error}`));
        }
    }
    await Promise.allSettled(transactions);
    if (failed > 0) throw new Error(`${failed} sequential sell operation(s) failed.`);
}
