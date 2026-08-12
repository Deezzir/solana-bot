import { Keypair, PublicKey, Signer, TransactionInstruction } from '@solana/web3.js';
import * as common from '../common/common';
import * as trade from '../common/trade_common';
import {
    BONK_CONFIG,
    BONK_CONFIG_2,
    BONK_CONFIG_3,
    BONK_IPFS_IMAGE_API_URL,
    BONK_IPFS_META_API_URL,
    IPFS,
    METAPLEX_META_SEED,
    METAPLEX_PROGRAM_ID,
    RENT_PROGRAM_ID,
    RAYDIUM_LAUNCHPAD_API_URL,
    PriorityLevel,
    RAYDIUM_LAUNCHPAD_AUTHORITY,
    RAYDIUM_LAUNCHPAD_CREATE_DISCRIMINATOR,
    RAYDIUM_LAUNCHPAD_EVENT_AUTHORITY,
    RAYDIUM_LAUNCHPAD_GLOBAL_CONFIG,
    RAYDIUM_LAUNCHPAD_PROGRAM_ID,
    SOL_MINT,
    SYSTEM_PROGRAM_ID,
    TRADE_DEFAULT_TOKEN_DECIMALS,
    TRADE_MAX_WALLETS_PER_CREATE_BUNDLE,
    TRADE_MAX_WALLETS_PER_CREATE_TX
} from '../constants';
import { RaydiumMintMeta, RaydiumTrader } from '../raydium/trade_raydium';
import { readFileSync } from 'fs';
import { basename } from 'path';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

export class BonkTrader extends RaydiumTrader {
    public override get_name(): string {
        return common.Program.Bonk;
    }

    public override async get_random_mints(count: number): Promise<RaydiumMintMeta[]> {
        if (count <= 0) return [];
        const url = `${RAYDIUM_LAUNCHPAD_API_URL}/get/list?sort=new&size=${Math.min(count, 100)}&mintType=default&platformId=${BONK_CONFIG_2.toBase58()},${BONK_CONFIG_3.toBase58()},${BONK_CONFIG.toBase58()}`;
        try {
            const response = await fetch(url);
            const data = await response.json();
            if (!data?.success) return [];
            const mints = await Promise.all(
                common
                    .pick_random(data.data.rows as { mint: string }[], count)
                    .map((item) => this.get_mint_meta(new PublicKey(item.mint)))
            );
            return mints.filter((mint): mint is RaydiumMintMeta => mint !== undefined);
        } catch (error) {
            common.error(common.red(`Failed fetching the mints: ${error}`));
            return [];
        }
    }

    public override async create_token(
        mint: Keypair,
        creator: Signer,
        token_name: string,
        token_symbol: string,
        meta_cid: string,
        sol_amount: number = 0,
        traders?: [Signer, number][],
        bundle_tip?: number,
        priority?: PriorityLevel
    ): Promise<String> {
        if ((traders && !bundle_tip) || (!traders && bundle_tip)) throw new Error('Invalid create bundle parameters');
        if (traders && (traders.length > TRADE_MAX_WALLETS_PER_CREATE_BUNDLE || traders.length < 1))
            throw new Error(`Invalid traders count: ${traders.length}`);
        let mint_meta = await this.default_mint_meta(mint.publicKey);
        const create_instructions = this.get_create_token_instructions(
            creator,
            token_name,
            token_symbol,
            meta_cid,
            mint
        );
        if (sol_amount > 0)
            create_instructions.push(...(await this.get_buy_instructions(sol_amount, creator, mint_meta, 0.005)));
        const ltas = await trade.get_ltas(this.get_lta_addresses());
        if (!traders)
            return await trade.send_tx(create_instructions, [creator, mint], PriorityLevel.HIGH, undefined, ltas);
        const generated_lta = await trade.generate_trade_lta(
            creator,
            traders.map(([trader]) => Keypair.fromSecretKey(trader.secretKey)),
            mint.publicKey
        );
        mint_meta = this.update_mint_meta_reserves(mint_meta, sol_amount);
        const buy_instructions: TransactionInstruction[][] = [];
        const bundle_signers: Signer[][] = [];
        for (const group of common.chunks(traders, TRADE_MAX_WALLETS_PER_CREATE_TX - 1)) {
            const instructions: TransactionInstruction[] = [];
            for (const [buyer, amount] of group) {
                instructions.push(...(await this.get_buy_instructions(amount, buyer, mint_meta, 0.05)));
                mint_meta = this.update_mint_meta_reserves(mint_meta, amount);
            }
            buy_instructions.push(instructions);
            bundle_signers.push(group.map(([buyer]) => buyer));
        }
        return await trade.retry_send_bundle(
            [create_instructions, ...buy_instructions],
            [[creator, mint], ...bundle_signers],
            bundle_tip!,
            priority,
            [generated_lta, ...ltas]
        );
    }

    public override async create_token_metadata(meta: common.IPFSMetadata, image_path: string): Promise<string> {
        const image = new File([readFileSync(image_path)], basename(image_path), { type: 'image/png' });
        const form = new FormData();
        form.append('image', image);
        const image_response = await fetch(BONK_IPFS_IMAGE_API_URL, { method: 'POST', body: form });
        if (!image_response.ok) throw new Error(`HTTP error! status: ${image_response.status}`);
        meta.image = await image_response.text();
        const meta_response = await fetch(BONK_IPFS_META_API_URL, {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify(meta)
        });
        if (!meta_response.ok) throw new Error(`HTTP error! status: ${meta_response.status}`);
        return (await meta_response.text()).split('/').slice(-1)[0];
    }

    private get_create_token_instructions(
        creator: Signer,
        token_name: string,
        token_symbol: string,
        meta_cid: string,
        mint: Keypair
    ): TransactionInstruction[] {
        const pool = this.calc_pool(mint.publicKey);
        const [base_vault, quote_vault] = this.calc_vault(mint.publicKey, pool);
        const [metadata] = PublicKey.findProgramAddressSync(
            [METAPLEX_META_SEED, METAPLEX_PROGRAM_ID.toBuffer(), mint.publicKey.toBuffer()],
            METAPLEX_PROGRAM_ID
        );
        return [
            new TransactionInstruction({
                programId: RAYDIUM_LAUNCHPAD_PROGRAM_ID,
                data: this.create_data(token_name, token_symbol, `${IPFS}${meta_cid}`),
                keys: [
                    { pubkey: creator.publicKey, isSigner: true, isWritable: true },
                    { pubkey: creator.publicKey, isSigner: true, isWritable: true },
                    { pubkey: RAYDIUM_LAUNCHPAD_GLOBAL_CONFIG, isSigner: false, isWritable: false },
                    { pubkey: BONK_CONFIG, isSigner: false, isWritable: false },
                    { pubkey: RAYDIUM_LAUNCHPAD_AUTHORITY, isSigner: false, isWritable: false },
                    { pubkey: pool, isSigner: false, isWritable: true },
                    { pubkey: mint.publicKey, isSigner: true, isWritable: true },
                    { pubkey: SOL_MINT, isSigner: false, isWritable: false },
                    { pubkey: base_vault, isSigner: false, isWritable: true },
                    { pubkey: quote_vault, isSigner: false, isWritable: true },
                    { pubkey: metadata, isSigner: false, isWritable: true },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: METAPLEX_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: RENT_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: RAYDIUM_LAUNCHPAD_EVENT_AUTHORITY, isSigner: false, isWritable: false },
                    { pubkey: RAYDIUM_LAUNCHPAD_PROGRAM_ID, isSigner: false, isWritable: false }
                ]
            })
        ];
    }

    private create_data(name: string, symbol: string, uri: string): Buffer {
        const string = (value: string) => {
            const data = Buffer.alloc(4 + Buffer.byteLength(value));
            data.writeUInt32LE(Buffer.byteLength(value));
            data.write(value, 4);
            return data;
        };
        const curve = Buffer.alloc(26);
        curve.writeUInt8(0);
        curve.writeBigUInt64LE(1_000_000_000_000_000n, 1);
        curve.writeBigUInt64LE(793_100_000_000_000n, 9);
        curve.writeBigUInt64LE(85_000_000_000n, 17);
        curve.writeUInt8(1, 25);
        return Buffer.concat([
            Buffer.from(RAYDIUM_LAUNCHPAD_CREATE_DISCRIMINATOR),
            Buffer.from([TRADE_DEFAULT_TOKEN_DECIMALS]),
            string(name),
            string(symbol),
            string(uri),
            curve,
            Buffer.alloc(24)
        ]);
    }
}
