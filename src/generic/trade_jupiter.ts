import {
    AddressLookupTableAccount,
    Keypair,
    PublicKey,
    Signer,
    TokenAmount,
    TransactionInstruction
} from '@solana/web3.js';
import * as common from '../common/common';
import * as trade from '../common/trade_common';
import { PriorityLevel, SOL_MINT, TRADE_DEFAULT_TOKEN_DECIMALS, TRADE_RAYDIUM_SWAP_TAX } from '../constants';
import { quote_jupiter, swap_jupiter, swap_jupiter_instructions } from '../common/trade_jupiter';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

class GenericMintMeta implements trade.IMintMeta {
    mint!: string;
    name: string = 'Unknown';
    symbol: string = 'Unknown';
    total_supply: bigint = BigInt(0);
    usd_market_cap: number = 0;
    market_cap: number = 0;
    fee: number = TRADE_RAYDIUM_SWAP_TAX;
    token_program_id!: string;

    constructor(data: Partial<GenericMintMeta> = {}) {
        Object.assign(this, data);
    }

    public get token_name(): string {
        return this.name;
    }

    public get token_mint(): string {
        return this.mint.toString();
    }

    public get token_symbol(): string {
        return this.symbol;
    }

    public get token_usd_mc(): number {
        return this.usd_market_cap;
    }

    public get migrated(): boolean {
        return false;
    }

    public get platform_fee(): number {
        return this.fee;
    }

    public get mint_pubkey(): PublicKey {
        return new PublicKey(this.mint);
    }

    public get token_program(): PublicKey {
        return new PublicKey(this.token_program_id);
    }

    public serialize(): trade.SerializedMintMeta {
        return {
            token_usd_mc: this.token_usd_mc,
            mint_pubkey: this.mint_pubkey.toBase58(),
            token_program: this.token_program.toBase58(),
            migrated: this.migrated,
            platform_fee: this.platform_fee,
            token_name: this.token_name,
            token_symbol: this.token_symbol,
            token_mint: this.token_mint,

            mint: this.mint,
            name: this.name,
            symbol: this.symbol,
            total_supply: this.total_supply.toString(),
            usd_market_cap: this.usd_market_cap,
            market_cap: this.market_cap,
            fee: this.fee
        };
    }

    public deserialize(data: trade.SerializedMintMeta): GenericMintMeta {
        return new GenericMintMeta({
            mint: data.mint as string,
            name: data.name as string,
            symbol: data.symbol as string,
            total_supply: BigInt(data.total_supply as string),
            usd_market_cap: data.usd_market_cap as number,
            market_cap: data.market_cap as number,
            fee: data.fee as number,
            token_program_id: data.token_program as string
        });
    }
}

export class Trader implements trade.IProgramTrader {
    public get_name(): string {
        return common.Program.Generic;
    }

    public get_lta_addresses(): PublicKey[] {
        return [];
    }

    public deserialize_mint_meta(data: trade.SerializedMintMeta): GenericMintMeta {
        return new GenericMintMeta().deserialize(data);
    }

    public async claim_dev_fees(): Promise<{ signature: String | null; fees: number }> {
        throw new Error('Claiming dev fees is not implemented for Generic.');
    }

    public async buy_token(
        sol_amount: number,
        buyer: Signer,
        mint_meta: GenericMintMeta,
        slippage: number = 0.05,
        priority?: PriorityLevel,
        protection_tip?: number
    ): Promise<String> {
        const sol_token_amount = trade.get_sol_token_amount(sol_amount);
        const mint = new PublicKey(mint_meta.mint);
        return await swap_jupiter(sol_token_amount, buyer, SOL_MINT, mint, slippage, priority, protection_tip);
    }

    public async buy_token_instructions(
        sol_amount: number,
        buyer: Signer,
        mint_meta: GenericMintMeta,
        slippage: number = 0.05
    ): Promise<[TransactionInstruction[], AddressLookupTableAccount[]?]> {
        const sol_token_amount = trade.get_sol_token_amount(sol_amount);
        const mint = new PublicKey(mint_meta.mint);
        const quote = await quote_jupiter(sol_token_amount, SOL_MINT, mint, slippage);
        return await swap_jupiter_instructions(buyer, quote);
    }

    public async sell_token(
        token_amount: TokenAmount,
        seller: Signer,
        mint_meta: GenericMintMeta,
        slippage: number = 0.05,
        priority: PriorityLevel,
        protection_tip?: number
    ): Promise<String> {
        const mint = new PublicKey(mint_meta.mint);
        return await swap_jupiter(token_amount, seller, mint, SOL_MINT, slippage, priority, protection_tip);
    }

    public async sell_token_instructions(
        token_amount: TokenAmount,
        seller: Signer,
        mint_meta: GenericMintMeta,
        slippage: number = 0.05
    ): Promise<[TransactionInstruction[], AddressLookupTableAccount[]?]> {
        const mint = new PublicKey(mint_meta.mint);
        const quote = await quote_jupiter(token_amount, mint, SOL_MINT, slippage);
        return await swap_jupiter_instructions(seller, quote);
    }

    public async buy_sell_instructions(
        sol_amount: number,
        trader: Signer,
        mint_meta: GenericMintMeta,
        slippage: number = 0.05
    ): Promise<[TransactionInstruction[], TransactionInstruction[], AddressLookupTableAccount[]?]> {
        const sol_token_amount = trade.get_sol_token_amount(sol_amount);
        const mint = new PublicKey(mint_meta.mint);
        const quote = await quote_jupiter(sol_token_amount, SOL_MINT, mint, slippage);
        let [buy_instructions, ltas] = await swap_jupiter_instructions(trader, quote);
        let [sell_instructions] = await this.sell_token_instructions(
            {
                uiAmount: Number(quote.outAmount) / 10 ** TRADE_DEFAULT_TOKEN_DECIMALS,
                amount: quote.outAmount,
                decimals: TRADE_DEFAULT_TOKEN_DECIMALS
            },
            trader,
            mint_meta,
            slippage
        );

        return [buy_instructions, sell_instructions, ltas];
    }

    public async buy_sell(
        sol_amount: number,
        trader: Signer,
        mint_meta: GenericMintMeta,
        slippage: number = 0.05,
        interval_ms?: number,
        priority?: PriorityLevel,
        protection_tip?: number
    ): Promise<[String, String]> {
        const [buy_instructions, sell_instructions, ltas] = await this.buy_sell_instructions(
            sol_amount,
            trader,
            mint_meta,
            slippage
        );

        if (interval_ms && interval_ms > 0) {
            const buy_signature = await trade.send_tx(buy_instructions, [trader], priority, protection_tip, ltas);
            await common.sleep(interval_ms);
            const sell_signature = await trade.retry_send_tx(
                sell_instructions,
                [trader],
                priority,
                protection_tip,
                ltas
            );
            return [buy_signature, sell_signature];
        }

        const signature = await trade.send_tx(
            [...buy_instructions, ...sell_instructions],
            [trader],
            priority,
            protection_tip,
            ltas
        );
        return [signature, signature];
    }

    public async buy_sell_bundle(
        sol_amount: number,
        trader: Signer,
        mint_meta: GenericMintMeta,
        tip: number,
        slippage: number = 0.05,
        priority?: PriorityLevel
    ): Promise<String> {
        const [buy_instructions, sell_instructions, ltas] = await this.buy_sell_instructions(
            sol_amount,
            trader,
            mint_meta,
            slippage
        );
        return await trade.send_bundle(
            [buy_instructions, sell_instructions],
            [[trader], [trader]],
            tip,
            priority,
            ltas
        );
    }

    public async get_mint_meta(mint: PublicKey, sol_price: number = 0): Promise<GenericMintMeta | undefined> {
        try {
            return await this.default_mint_meta(mint, sol_price);
        } catch (error) {
            return undefined;
        }
    }

    public async get_random_mints(_count: number): Promise<GenericMintMeta[]> {
        throw new Error('Not implemented');
    }

    public async create_token(
        _mint: Keypair,
        _creator: Signer,
        _token_name: string,
        _token_symbol: string,
        _meta_cid: string,
        _sol_amount: number = 0,
        _traders?: [Signer, number][],
        _bundle_tip?: number,
        _priority?: PriorityLevel
    ): Promise<String> {
        throw new Error('Not implemented');
    }

    public update_mint_meta_reserves(mint_meta: GenericMintMeta, _amount: number | TokenAmount): GenericMintMeta {
        return mint_meta;
    }

    public async update_mint_meta(mint_meta: GenericMintMeta, sol_price: number = 0.0): Promise<GenericMintMeta> {
        const mint = new PublicKey(mint_meta.mint);
        return this.default_mint_meta(mint, sol_price);
    }

    public async default_mint_meta(mint: PublicKey, sol_price: number = 0.0): Promise<GenericMintMeta> {
        const meta = await trade.get_token_meta(mint).catch(() => {
            return {
                token_name: 'Unknown',
                token_symbol: 'Unknown',
                token_supply: 10 ** 16,
                price_per_token: 0.0,
                token_decimal: 6,
                token_program: TOKEN_PROGRAM_ID
            };
        });

        const usd_market_cap = meta.price_per_token * (meta.token_supply / 10 ** meta.token_decimal);
        const market_cap = sol_price ? usd_market_cap / sol_price : 0;
        return new GenericMintMeta({
            mint: mint.toString(),
            name: meta.token_name,
            symbol: meta.token_symbol,
            total_supply: BigInt(meta.token_supply),
            usd_market_cap,
            market_cap,
            token_program_id: meta.token_program.toString()
        });
    }

    public async subscribe_mint_meta(
        _mint_meta: GenericMintMeta,
        _callback: (mint_meta: GenericMintMeta) => void
    ): Promise<() => void> {
        return () => {};
    }

    public async create_token_metadata(meta: common.IPFSMetadata, image_path: string): Promise<string> {
        return await common.upload_metadata_ipfs(meta, image_path);
    }
}
