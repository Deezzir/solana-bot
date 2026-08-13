import { Keypair, LAMPORTS_PER_SOL, Signer, SystemProgram, TokenAmount, TransactionInstruction } from '@solana/web3.js';
import {
    COMMANDS_INTERVAL_MS,
    COMMITMENT,
    JITO_BUNDLE_INTERVAL_MS,
    PriorityLevel,
    TRANSFER_INTERVAL_MS,
    TRANSFER_MAX_DEPTH,
    TRANSFER_MAX_WALLETS_PER_TX
} from '../constants';
import * as common from '../common/common';
import * as trade from '../common/trade_common';
import {
    createAssociatedTokenAccountIdempotentInstruction,
    createCloseAccountInstruction,
    createTransferInstruction
} from '@solana/spl-token';

type SpiderTreeNode = {
    amount: number;
    left: SpiderTreeNode | null;
    right: SpiderTreeNode | null;
    keypair: Keypair;
};

type SpiderTree = {
    head: SpiderTreeNode | null;
    depth: number;
};

function build_spider_tree(tree: SpiderTree, amount: number, keys_cnt: number, payer: Keypair): SpiderTree {
    if (tree.head) return tree;

    let wallet_cnt_tmp = keys_cnt;
    let layer_cnt = tree.depth;
    tree.head = {
        amount: 0,
        left: null,
        right: null,
        keypair: payer
    } as SpiderTreeNode;

    const _build_tree = (node: SpiderTreeNode | null, layer_cnt: number): SpiderTreeNode | null => {
        if (layer_cnt === 0 || wallet_cnt_tmp === 0) return null;
        if (layer_cnt === 1) wallet_cnt_tmp--;

        if (node === null) {
            node = {
                amount: amount,
                left: null,
                right: null,
                keypair: new Keypair()
            } as SpiderTreeNode;
        }

        node.right = _build_tree(node.right, layer_cnt - 1);
        node.left = _build_tree(node.left, layer_cnt - 1);

        if (node.right || node.left) node.amount = (node.left?.amount || 0) + (node.right?.amount || 0);
        return node;
    };

    tree.head = _build_tree(tree.head, layer_cnt);
    return tree;
}

function display_spider_tree(tree: SpiderTree) {
    if (!tree.head) return;

    common.log(`Spider tree depth: ${tree.depth}`);

    const _display_spider_tree = (
        node: SpiderTreeNode | null,
        layer_cnt: number = 0,
        prefix: string = '',
        isLeft: boolean = true
    ) => {
        if (node === null) return;

        const connector = layer_cnt === 0 ? ' ' : isLeft ? '├── ' : '└── ';
        const child_prefix = prefix + (layer_cnt === 0 ? ' ' : isLeft ? '│   ' : '    ');
        const node_display = `${node.amount.toFixed(4)} SOL - ${node.keypair.publicKey.toString()}`;

        common.log(`${prefix}${layer_cnt === 0 ? ' ' : '│'}`);
        common.log(`${prefix}${connector}${node_display}`);

        if (node.left || node.right) {
            if (node.left) {
                _display_spider_tree(node.left, layer_cnt + 1, child_prefix, true);
            }

            if (node.right) {
                _display_spider_tree(node.right, layer_cnt + 1, child_prefix, false);
            }
        }
    };

    _display_spider_tree(tree.head);
    common.log('');
}

function backup_spider_tree(tree: SpiderTree): string {
    if (!tree.head) throw new Error('Spider tree is empty');

    const target_file = common.setup_rescue_file();
    let postfixes: Map<number, number> = new Map();

    const _backup_spider_tree = (node: SpiderTreeNode | null, layer_cnt: number = 0): boolean => {
        if (node === null) return true;

        postfixes.set(layer_cnt, (postfixes.get(layer_cnt) ?? 0) + 1);
        const ok = common.save_rescue_key(node.keypair, target_file, layer_cnt, postfixes.get(layer_cnt) || 0);
        if (!ok) return false;

        if (node.left) {
            const ok = _backup_spider_tree(node.left, layer_cnt + 1);
            if (!ok) return false;
        }

        if (node.right) {
            const ok = _backup_spider_tree(node.right, layer_cnt + 1);
            if (!ok) return false;
        }

        return true;
    };

    const ok = _backup_spider_tree(tree.head);
    if (!ok) throw new Error('Something went wrong during the spider transfer');

    common.log(`Successfully backed the keys up for the spider transfer`);
    return target_file;
}

async function process_inner_transfers(tree: SpiderTree): Promise<Keypair[]> {
    if (!tree.head) throw new Error('Spider tree is empty');
    const entries: Keypair[] = [];

    let postfixes: Map<number, number> = new Map();

    const _process_inner_transfers = async (node: SpiderTreeNode | null, layer_cnt: number = 0): Promise<boolean> => {
        if (node === null) return true;
        if (layer_cnt === tree.depth - 1) entries.push(node.keypair);

        postfixes.set(layer_cnt, (postfixes.get(layer_cnt) ?? 0) + 1);

        if (node.left) {
            const amount = node.left.amount;
            const sol_amount = Math.ceil(amount * LAMPORTS_PER_SOL);
            const sender = node.keypair;
            const receiver = node.left.keypair;
            const layer_name = `${layer_cnt}_${postfixes.get(layer_cnt) || 0}`;

            common.log(
                `${sender.publicKey.toString().padEnd(44, ' ')} is sending ${amount.toFixed(4).padEnd(7, ' ')} SOL to ${receiver.publicKey.toString().padEnd(44, ' ')} (Layer: ${layer_name})...`
            );

            try {
                const sig = await trade.retry_send_lamports(
                    sol_amount,
                    sender,
                    receiver.publicKey,
                    PriorityLevel.DEFAULT
                );
                common.log(`Transaction completed for ${layer_name}, signature: ${sig}`);
            } catch (error) {
                common.error(common.red(`Failed to send lamports: ${error}`));
                return false;
            }

            await common.sleep(TRANSFER_INTERVAL_MS);

            const ok = await _process_inner_transfers(node.left, layer_cnt + 1);
            if (!ok) return false;
        }

        if (node.right) {
            const amount = node.right.amount;
            const sol_amount = Math.ceil(amount * LAMPORTS_PER_SOL);
            const sender = node.keypair;
            const receiver = node.right.keypair;
            const layer_name = `${layer_cnt}_${postfixes.get(layer_cnt) || 0}`;

            common.log(
                `${sender.publicKey.toString().padEnd(44, ' ')} is sending ${amount.toFixed(4).padEnd(7, ' ')} SOL to ${receiver.publicKey.toString().padEnd(44, ' ')} (Layer: ${layer_name}})...`
            );
            try {
                let sig = await trade.retry_send_lamports(
                    sol_amount,
                    sender,
                    receiver.publicKey,
                    PriorityLevel.DEFAULT
                );
                common.log(`Transaction completed for ${layer_name}, signature: ${sig}`);
            } catch (error) {
                common.error(common.red(`Failed to send lamports: ${error}`));
                return false;
            }

            await common.sleep(TRANSFER_INTERVAL_MS);

            const ok = await _process_inner_transfers(node.right, layer_cnt + 1);
            if (!ok) return false;
        }

        return true;
    };

    const ok = await _process_inner_transfers(tree.head);
    if (!ok) throw new Error('Something went wrong during the spider transfer, check the logs for details');

    return entries;
}

async function process_final_transfers(entries: [common.Wallet, Keypair][]): Promise<void> {
    const transactions: Promise<void>[] = [];

    for (const entry of entries) {
        const [wallet, sender] = entry;
        const receiver = wallet.keypair;
        const amount = await trade.get_balance(sender.publicKey, COMMITMENT);
        if (amount <= 0) continue;

        common.log(
            `${sender.publicKey.toString().padEnd(44, ' ')} is sending ${(amount / LAMPORTS_PER_SOL).toFixed(3).padEnd(7, ' ')} SOL to ${receiver.publicKey.toString().padEnd(44, ' ')}...`
        );
        transactions.push(
            trade
                .retry_send_lamports(amount, sender, receiver.publicKey, PriorityLevel.HIGH)
                .then((sig) =>
                    common.log(
                        common.green(`Transaction completed for ${receiver.publicKey.toString()}, signature: ${sig}`)
                    )
                )
                .catch((error) =>
                    common.error(common.red(`Transaction failed for ${receiver.publicKey.toString()}: ${error}`))
                )
        );
    }

    await Promise.all(transactions);
}

function generate_depth_transfer_map(
    entries: [common.Wallet, number | TokenAmount][],
    sender: Keypair,
    depth: number,
    target_file: string
): { amount: number | TokenAmount; wallet: common.Wallet; path: Keypair[] }[] {
    return entries.map((entry, index) => {
        const [wallet, amount] = entry;
        const path = [
            sender,
            ...Array.from({ length: depth }, (_v, i) => {
                const pair = new Keypair();
                common.save_rescue_key(pair, target_file, index, i);
                return pair;
            }),
            wallet.keypair
        ];

        return {
            amount,
            wallet,
            path
        };
    });
}

export async function execute_spider_fund_sol(
    wallets: common.Wallet[],
    amount: number,
    funder: Keypair
): Promise<common.Wallet[]> {
    const wallet_cnt = wallets.length;

    let tree = {
        head: null,
        depth: Math.ceil(Math.log2(wallet_cnt)) + 1
    } as SpiderTree;

    tree = build_spider_tree(tree, amount, wallet_cnt, funder);
    display_spider_tree(tree);
    const target_file = backup_spider_tree(tree);

    try {
        common.log(`Processing inner transfers...\n`);
        const final_entries = await process_inner_transfers(tree);
        common.log(`\nProcessing final transfers...\n`);
        await process_final_transfers(common.zip(wallets, final_entries));
    } catch (error) {
        common.error(common.red(`Failed to process transfers: ${error}`));
    }

    return common.get_wallets(target_file);
}

export async function execute_depth_sol_fund(
    entries: [common.Wallet, number][],
    funder: Keypair,
    depth: number,
    bundle_tip: number
): Promise<common.Wallet[]> {
    const target_file = common.setup_rescue_file();
    if (depth > TRANSFER_MAX_DEPTH) throw new Error(`Max depth is ${TRANSFER_MAX_DEPTH}, but ${depth} was provided`);
    if (!target_file) throw new Error('Failed to create a target file for the funding transfers');

    const transfer_map = generate_depth_transfer_map(entries, funder, depth, target_file);

    const promises: Promise<void>[] = [];
    const failed: { name: string; id: number }[] = [];
    for (const bundle of transfer_map) {
        const wallet = bundle.wallet;
        const fund_amount = bundle.amount as number;
        const txs: Keypair[][] = [];
        for (let start = 0; start < bundle.path.length - 1; start += TRANSFER_MAX_WALLETS_PER_TX - 1)
            txs.push(bundle.path.slice(start, start + TRANSFER_MAX_WALLETS_PER_TX));
        const bundle_instructions: TransactionInstruction[][] = [];
        const bundle_signers: Signer[][] = [];
        common.log(
            `Sending ${fund_amount} SOL to ${wallet.keypair.publicKey.toString().padEnd(44, ' ')} ${wallet.name} (${wallet.id})...`
        );

        for (const [tx_idx, tx] of txs.entries()) {
            const tx_instructions: TransactionInstruction[] = [];
            const tx_signers: Signer[] = [];
            const tx_lamports = Math.floor(
                Math.floor(fund_amount * LAMPORTS_PER_SOL) -
                    (5000 * tx.length - 2) -
                    (tx_idx === txs.length - 1 ? bundle_tip * LAMPORTS_PER_SOL : 0)
            );
            for (let wallet_idx = 1; wallet_idx < tx.length; wallet_idx++) {
                const sender = tx[wallet_idx - 1];
                const receiver = tx[wallet_idx];
                tx_instructions.push(
                    SystemProgram.transfer({
                        fromPubkey: sender.publicKey,
                        toPubkey: receiver.publicKey,
                        lamports: tx_lamports
                    })
                );
                tx_signers.push(sender);
            }
            bundle_instructions.push(tx_instructions);
            bundle_signers.push(tx_signers);
        }
        promises.push(
            trade
                .retry_send_bundle(bundle_instructions, bundle_signers, bundle_tip)
                .then((signature) =>
                    common.log(common.green(`Fund Bundle completed for ${wallet.name}, signature: ${signature}`))
                )
                .catch((error) => {
                    common.error(common.red(`Fund Bundle failed for ${wallet.name}: ${error}`));
                    failed.push({ name: wallet.name, id: wallet.id });
                })
        );
        await common.sleep(JITO_BUNDLE_INTERVAL_MS);
    }
    await Promise.allSettled(promises);

    if (failed.length > 0) {
        common.error(common.red(`Failed transactions:`));
        for (const item of failed) common.error(common.bold(`Wallet: ${item.name} (${item.id})`));
        throw new Error(`${failed.length} depth funding transfer(s) failed.`);
    }

    return common.get_wallets(target_file);
}

export async function execute_fund_sol(entries: [common.Wallet, number][], funder: Keypair): Promise<void> {
    const transactions = [];
    const failed: { name: string; id: number }[] = [];

    for (const entry of entries) {
        const [wallet, fund_amount] = entry;
        const receiver = wallet.keypair;
        if (receiver.publicKey.equals(funder.publicKey)) continue;
        common.log(
            `Sending ${fund_amount} SOL, for ${receiver.publicKey.toString().padEnd(44, ' ')} ${wallet.name} (${wallet.id})...`
        );
        transactions.push(
            trade
                .send_lamports(fund_amount * LAMPORTS_PER_SOL, funder, receiver.publicKey, PriorityLevel.HIGH)
                .then((signature) =>
                    common.log(common.green(`Transaction completed for ${wallet.name}, signature: ${signature}`))
                )
                .catch((error) => {
                    common.error(common.red(`Transaction failed for ${wallet.name}: ${error.message}`));
                    failed.push({ name: wallet.name, id: wallet.id });
                })
        );

        await common.sleep(COMMANDS_INTERVAL_MS);
    }
    await Promise.allSettled(transactions);

    if (failed.length > 0) {
        common.error(common.red(`\nFailed transactions:`));
        for (const item of failed) common.error(common.bold(`Wallet: ${item.name} (${item.id})`));
        throw new Error(`${failed.length} funding transfer(s) failed.`);
    }
}

export async function execute_depth_dist_token(
    entries: [common.Wallet, TokenAmount][],
    mint_meta: trade.MintAsset,
    distributer: Keypair,
    depth: number,
    bundle_tip: number
) {
    const target_file = common.setup_rescue_file();
    if (depth > TRANSFER_MAX_DEPTH) throw new Error(`Max depth is ${TRANSFER_MAX_DEPTH}, but ${depth} was provided`);
    if (!target_file) throw new Error('Failed to create a target file for the distribution transfers');

    const transfer_map = generate_depth_transfer_map(entries, distributer, depth, target_file);

    const promises: Promise<void>[] = [];
    const failed: { name: string; id: number }[] = [];
    for (const bundle of transfer_map) {
        const wallet = bundle.wallet;
        const token_amount = bundle.amount as TokenAmount;
        const txs: Keypair[][] = [];
        for (let start = 0; start < bundle.path.length - 1; start += TRANSFER_MAX_WALLETS_PER_TX - 1)
            txs.push(bundle.path.slice(start, start + TRANSFER_MAX_WALLETS_PER_TX));
        const bundle_instructions: TransactionInstruction[][] = [];
        const bundle_signers: Signer[][] = [];
        common.log(
            `Sending ${token_amount.uiAmount} $${mint_meta.token_symbol} to ${wallet.keypair.publicKey.toString().padEnd(44, ' ')} ${wallet.name} (${wallet.id})...`
        );

        for (const tx of txs) {
            const tx_instructions: TransactionInstruction[] = [];
            const tx_signers: Signer[] = [];
            for (let wallet_idx = 1; wallet_idx < tx.length; wallet_idx++) {
                const sender = tx[wallet_idx - 1];
                const receiver = tx[wallet_idx];
                const receiver_ata = trade.calc_ata(receiver.publicKey, mint_meta.mint, mint_meta.token_program);
                const sender_ata = trade.calc_ata(sender.publicKey, mint_meta.mint, mint_meta.token_program);
                const token_amount_raw = BigInt(token_amount.amount);
                tx_instructions.push(
                    createAssociatedTokenAccountIdempotentInstruction(
                        sender.publicKey,
                        receiver_ata,
                        receiver.publicKey,
                        mint_meta.mint,
                        mint_meta.token_program
                    ),
                    createTransferInstruction(
                        sender_ata,
                        receiver_ata,
                        sender.publicKey,
                        token_amount_raw,
                        [],
                        mint_meta.token_program
                    )
                );
                if (!sender.publicKey.equals(distributer.publicKey))
                    tx_instructions.push(
                        createCloseAccountInstruction(
                            sender_ata,
                            sender.publicKey,
                            sender.publicKey,
                            [],
                            mint_meta.token_program
                        )
                    );
                tx_signers.push(sender);
            }
            bundle_instructions.push(tx_instructions);
            bundle_signers.push(tx_signers);
        }
        promises.push(
            trade
                .retry_send_bundle(bundle_instructions, bundle_signers, bundle_tip)
                .then((signature) =>
                    common.log(common.green(`Fund Bundle completed for ${wallet.name}, signature: ${signature}`))
                )
                .catch((error) => {
                    common.error(common.red(`Fund Bundle failed for ${wallet.name}: ${error}`));
                    failed.push({ name: wallet.name, id: wallet.id });
                })
        );
        await common.sleep(JITO_BUNDLE_INTERVAL_MS);
    }
    await Promise.allSettled(promises);

    if (failed.length > 0) {
        common.error(common.red(`Failed transactions:`));
        for (const item of failed) common.error(common.bold(`Wallet: ${item.name} (${item.id})`));
        throw new Error(`${failed.length} depth token distribution(s) failed.`);
    }

    return common.get_wallets(target_file);
}

export async function execute_dist_token(
    entries: [common.Wallet, TokenAmount][],
    mint_meta: trade.MintAsset,
    distributer: Keypair
) {
    const transactions = [];
    const failed: { name: string; id: number }[] = [];

    for (const entry of entries) {
        const [wallet, token_amount] = entry;
        const receiver = wallet.keypair;
        if (receiver.publicKey.equals(distributer.publicKey)) continue;
        common.log(
            `Sending ${token_amount.uiAmount} $${mint_meta.token_symbol} to ${receiver.publicKey.toString().padEnd(44, ' ')} ${wallet.name} (${wallet.id})...`
        );
        transactions.push(
            trade
                .send_tokens(
                    token_amount,
                    mint_meta.mint,
                    distributer,
                    receiver.publicKey,
                    PriorityLevel.HIGH,
                    mint_meta.token_program
                )
                .then((signature) =>
                    common.log(common.green(`Transaction completed for ${wallet.name}, signature: ${signature}`))
                )
                .catch((error) => {
                    common.error(common.red(`Transaction failed for ${wallet.name}: ${error.message}`));
                    failed.push({ name: wallet.name, id: wallet.id });
                })
        );

        await common.sleep(COMMANDS_INTERVAL_MS);
    }
    await Promise.allSettled(transactions);

    if (failed.length > 0) {
        common.error(common.red(`\nFailed transactions:`));
        for (const item of failed) common.error(common.bold(`Wallet: ${item.name} (${item.id})`));
        throw new Error(`${failed.length} token distribution(s) failed.`);
    }
}
