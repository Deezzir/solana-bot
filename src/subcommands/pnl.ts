import { PublicKey, ParsedTransactionWithMeta, ConfirmedSignatureInfo } from '@solana/web3.js';
import * as common from '../common/common';
import { PNL_BATCH_DELAY_MS, PNL_BATCH_SIZE, SOL_MINT, TRADE_RETRY_INTERVAL_MS } from '../constants';
import { calc_token_balance_changes, get_token_meta, TxBalanceChanges } from '../common/trade_common';

type TransactionWithBalances = ParsedTransactionWithMeta & {
    balance_changes: TxBalanceChanges;
    transaction_data: {
        mint?: string;
        signature: string;
    };
};

type ProfitLossTX = {
    signature: string;
    change_sol: number;
    change_tokens: number;
    timestamp?: number;
};

type ProfitLoss = {
    mint: string;
    name: string;
    symbol: string;
    realized_pnl: number;
    unrealized_pnl: number;
    token_balance: number;
    transactions: ProfitLossTX[];
};

type WalletPNL = {
    address: PublicKey;
    profit_loss: ProfitLoss[];
    total_realized_pnl: number;
    total_unrealized_pnl: number;
};

async function get_all_signatures(public_key: PublicKey): Promise<ConfirmedSignatureInfo[]> {
    const all_signatures: ConfirmedSignatureInfo[] = [];
    let last_signature: string | undefined;

    while (true) {
        const options: any = { limit: 50 };
        if (last_signature) options.before = last_signature;

        const signatures = await common.retry_with_backoff(() =>
            global.CONNECTION.getSignaturesForAddress(public_key, options)
        );

        all_signatures.push(...signatures);
        if (signatures.length < 50 || signatures.length === 0) break;
        last_signature = signatures[signatures.length - 1].signature;

        await common.sleep(TRADE_RETRY_INTERVAL_MS);
    }

    return all_signatures;
}

async function get_transactions(signatures: string[]): Promise<(ParsedTransactionWithMeta | null)[]> {
    return common.retry_with_backoff(() =>
        global.CONNECTION.getParsedTransactions(signatures, {
            maxSupportedTransactionVersion: 0
        })
    );
}

async function fetch_transaction_batch(signatures: string[]): Promise<(ParsedTransactionWithMeta | null)[]> {
    return common.retry_with_backoff(async () => {
        const transactions: (ParsedTransactionWithMeta | null)[] = [];
        const signature_chunks = common.chunks(signatures, PNL_BATCH_SIZE);

        for (const chunk of signature_chunks) {
            const parsed_transactions = await get_transactions(chunk);
            transactions.push(...parsed_transactions);
            await common.sleep(PNL_BATCH_DELAY_MS);
        }
        return transactions;
    });
}

function extract_transaction_data(
    tx: ParsedTransactionWithMeta,
    public_key: PublicKey
): { mint: string; signature: string }[] {
    const mints = new Set<string>();
    const wallet = public_key.toString();

    for (const token_balance of [...(tx.meta?.preTokenBalances || []), ...(tx.meta?.postTokenBalances || [])]) {
        if (token_balance.owner === wallet && token_balance.mint !== SOL_MINT.toString()) mints.add(token_balance.mint);
    }

    return Array.from(mints, (mint) => ({ signature: tx.transaction.signatures[0], mint }));
}

async function calculate_profit_loss(
    transactions: TransactionWithBalances[],
    sol_price: number
): Promise<ProfitLoss[]> {
    const mint_entries = new Map<
        string,
        {
            total_sol_change: number;
            total_tokens_change: number;
            transactions: ProfitLossTX[];
        }
    >();

    for (const tx of transactions) {
        if (!tx.transaction_data.mint) continue;
        const mint = tx.transaction_data.mint;
        const fees = tx.balance_changes.fees;
        const change_sol = tx.balance_changes.change_sol - Math.sign(tx.balance_changes.change_sol) * fees;
        const change_tokens = tx.balance_changes.change_tokens;

        if (change_sol > 0 && change_tokens == 0) continue;

        if (!mint_entries.has(mint)) {
            mint_entries.set(mint, {
                total_sol_change: 0,
                total_tokens_change: 0,
                transactions: []
            });
        }

        const mint_entry = mint_entries.get(mint)!;
        mint_entry.total_sol_change += change_sol;
        mint_entry.total_tokens_change += change_tokens;
        mint_entry.transactions.push({
            signature: tx.transaction_data.signature,
            change_sol: change_sol,
            change_tokens: change_tokens,
            timestamp: tx.blockTime || undefined
        });
    }

    const profit_loss_promises = Array.from(mint_entries.entries()).map(async ([mint, data]) => {
        let token_price = 0.0;
        let name = 'Unknown';
        let symbol = 'Unknown';
        const meta = await get_token_meta(new PublicKey(mint));
        if (meta) {
            token_price = meta.price_per_token / sol_price;
            name = meta.token_name;
            symbol = meta.token_symbol;
        }
        let unrealized_pnl = data.total_tokens_change * token_price;
        if (unrealized_pnl < 1e-2 && unrealized_pnl > -1e-2) unrealized_pnl = 0.0;
        return {
            mint,
            name,
            symbol,
            realized_pnl: data.total_sol_change,
            unrealized_pnl,
            token_balance: data.total_tokens_change,
            transactions: data.transactions.sort((a, b) => {
                if (!a.timestamp || !b.timestamp) return 0;
                return b.timestamp - a.timestamp;
            })
        };
    });

    return Promise.all(profit_loss_promises);
}

export async function get_wallet_pnl(public_key: PublicKey, sol_price: number): Promise<WalletPNL> {
    try {
        common.log(`Fetching all signatures for wallet ${public_key.toString()}...`);
        const signatures = await get_all_signatures(public_key);
        common.log(`Found ${signatures.length} total transactions\n`);

        const signature_chunks = common.chunks(
            signatures.map((sig) => sig.signature),
            PNL_BATCH_SIZE
        );

        const all_transactions: (ParsedTransactionWithMeta | null)[] = [];
        for (const chunk of signature_chunks) {
            const batch_transactions = await fetch_transaction_batch(chunk);
            all_transactions.push(...batch_transactions);
            await common.sleep(PNL_BATCH_DELAY_MS);
        }

        const processed_transactions: TransactionWithBalances[] = all_transactions
            .map((tx) => {
                if (!tx) return;
                return extract_transaction_data(tx, public_key)
                    .map((transaction_data) => {
                        const balance_changes = calc_token_balance_changes(tx, public_key, transaction_data.mint);
                        if (!balance_changes) return;

                        return { balance_changes, transaction_data, ...tx };
                    })
                    .filter((transaction) => transaction !== undefined);
            })
            .flat()
            .filter((tx) => tx !== undefined);

        const profit_loss = await calculate_profit_loss(processed_transactions, sol_price);
        const total_realized_pnl = profit_loss.reduce((acc, cur) => acc + cur.realized_pnl, 0.0);
        const total_unrealized_pnl = profit_loss.reduce((acc, cur) => acc + cur.unrealized_pnl, 0.0);

        return {
            address: public_key,
            profit_loss,
            total_realized_pnl,
            total_unrealized_pnl
        };
    } catch (error) {
        common.error(common.red(`Error processing the wallet: ${error}`));
        throw error;
    }
}
