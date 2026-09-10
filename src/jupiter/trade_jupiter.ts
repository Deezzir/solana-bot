import {
    AddressLookupTableAccount,
    Commitment,
    Keypair,
    PublicKey,
    TokenAmount,
    TransactionInstruction
} from '@solana/web3.js';
import * as common from '../common/common';
import * as trade from '../common/trade_common';
import {
    COMMITMENT,
    PriorityLevel,
    SOL_MINT,
    TRADE_DEFAULT_TOKEN_DECIMALS,
    TRADE_RAYDIUM_SWAP_TAX
} from '../constants';
import { TOKEN_PROGRAM_ID } from '../common/token';
import { quote_jupiter, swap_jupiter, swap_jupiter_instructions } from './swap_jupiter';

class JupiterMintMeta implements trade.IMintMeta {
    mint!: string;
    quote_mint!: string;
    name: string = 'Unknown';
    symbol: string = 'Unknown';
    total_supply: bigint = BigInt(0);
    market_cap: number = 0;
    fee: number = TRADE_RAYDIUM_SWAP_TAX;
    token_program_id!: string;

    constructor(data: Partial<JupiterMintMeta> = {}) {
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

    public get token_quote_mc(): number {
        return this.market_cap;
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

    public get quote_mint_pubkey(): PublicKey {
        return SOL_MINT;
    }

    public get token_program(): PublicKey {
        return new PublicKey(this.token_program_id);
    }

    public serialize(): trade.SerializedMintMeta {
        return {
            token_quote_mc: this.token_quote_mc,
            mint_pubkey: this.mint_pubkey.toBase58(),
            token_program: this.token_program.toBase58(),
            quote_mint_pubkey: this.quote_mint_pubkey.toBase58(),
            migrated: this.migrated,
            platform_fee: this.platform_fee,
            token_name: this.token_name,
            token_symbol: this.token_symbol,
            token_mint: this.token_mint,

            mint: this.mint,
            quote_mint: SOL_MINT.toBase58(),
            name: this.name,
            symbol: this.symbol,
            total_supply: this.total_supply.toString(),
            market_cap: this.market_cap,
            fee: this.fee
        };
    }

    public deserialize(data: trade.SerializedMintMeta): JupiterMintMeta {
        return new JupiterMintMeta({
            mint: data.mint as string,
            name: data.name as string,
            symbol: data.symbol as string,
            quote_mint: SOL_MINT.toBase58(),
            total_supply: BigInt(data.total_supply as string),
            market_cap: data.market_cap as number,
            fee: data.fee as number,
            token_program_id: data.token_program as string
        });
    }
}

export class Trader implements trade.IProgramTrader {
    public get_name(): string {
        return common.Program.Jupiter;
    }

    public get_lta_addresses(): PublicKey[] {
        return [];
    }

    public deserialize_mint_meta(data: trade.SerializedMintMeta): JupiterMintMeta {
        return new JupiterMintMeta().deserialize(data);
    }

    public async get_trader_rewards(_trader: Keypair): Promise<trade.ClaimableAsset[]> {
        return [];
    }

    public get_compute_unit_limit(): number | undefined {
        return undefined;
    }

    public async claim_trader_rewards(
        _trader: Keypair,
        _assets: trade.ClaimableAsset[],
        _priority?: PriorityLevel
    ): Promise<String> {
        throw new Error('Not supported');
    }

    public async buy_token(
        amount: TokenAmount,
        buyer: Keypair,
        mint_meta: JupiterMintMeta,
        slippage: number = 0.05,
        priority?: PriorityLevel,
        protection_tip?: number,
        mev_protect: boolean = false
    ): Promise<String> {
        const mint = new PublicKey(mint_meta.mint);
        return await swap_jupiter(amount, buyer, SOL_MINT, mint, slippage, priority, protection_tip, mev_protect);
    }

    public async buy_token_instructions(
        amount: TokenAmount,
        buyer: Keypair,
        mint_meta: JupiterMintMeta,
        slippage: number = 0.05
    ): Promise<[TransactionInstruction[], AddressLookupTableAccount[]?]> {
        const mint = new PublicKey(mint_meta.mint);
        const quote = await quote_jupiter(amount, SOL_MINT, mint, slippage);
        return await swap_jupiter_instructions(buyer, quote);
    }

    public async sell_token(
        token_amount: TokenAmount,
        seller: Keypair,
        mint_meta: JupiterMintMeta,
        slippage: number = 0.05,
        priority: PriorityLevel,
        protection_tip?: number,
        mev_protect: boolean = false
    ): Promise<String> {
        const mint = new PublicKey(mint_meta.mint);
        return await swap_jupiter(
            token_amount,
            seller,
            mint,
            SOL_MINT,
            slippage,
            priority,
            protection_tip,
            mev_protect
        );
    }

    public async sell_token_instructions(
        token_amount: TokenAmount,
        seller: Keypair,
        mint_meta: JupiterMintMeta,
        slippage: number = 0.05
    ): Promise<[TransactionInstruction[], AddressLookupTableAccount[]?]> {
        const mint = new PublicKey(mint_meta.mint);
        const quote = await quote_jupiter(token_amount, mint, SOL_MINT, slippage);
        return await swap_jupiter_instructions(seller, quote);
    }

    public async buy_sell_instructions(
        amount: TokenAmount,
        trader: Keypair,
        mint_meta: JupiterMintMeta,
        slippage: number = 0.05
    ): Promise<[TransactionInstruction[], TransactionInstruction[], AddressLookupTableAccount[]?]> {
        const mint = new PublicKey(mint_meta.mint);
        const quote = await quote_jupiter(amount, SOL_MINT, mint, slippage);
        const exact_out_quote = await quote_jupiter(
            { amount: quote.outAmount, decimals: TRADE_DEFAULT_TOKEN_DECIMALS, uiAmount: null },
            SOL_MINT,
            mint,
            slippage,
            'ExactOut'
        );
        if (exact_out_quote.swapMode !== 'ExactOut' || exact_out_quote.outAmount !== quote.outAmount)
            throw new Error('Jupiter did not return the requested exact-output buy quote.');

        const amount_raw = BigInt(amount.amount);
        const max_amount = amount_raw + (amount_raw * BigInt(Math.floor(slippage * 10000))) / 10000n;

        if (BigInt(exact_out_quote.otherAmountThreshold) > max_amount)
            throw new Error('Jupiter exact-output buy exceeds the SOL budget.');

        let [buy_instructions, ltas] = await swap_jupiter_instructions(trader, exact_out_quote);
        let [sell_instructions, sell_ltas] = await this.sell_token_instructions(
            {
                uiAmount: Number(quote.outAmount) / 10 ** TRADE_DEFAULT_TOKEN_DECIMALS,
                amount: quote.outAmount,
                decimals: TRADE_DEFAULT_TOKEN_DECIMALS
            },
            trader,
            mint_meta,
            slippage
        );

        return [buy_instructions, sell_instructions, [...ltas, ...(sell_ltas ?? [])]];
    }

    public async buy_sell(
        amount: TokenAmount,
        trader: Keypair,
        mint_meta: JupiterMintMeta,
        slippage: number = 0.05,
        interval_ms?: number,
        priority?: PriorityLevel,
        protection_tip?: number,
        mev_protect: boolean = false
    ): Promise<[String, String]> {
        const [buy_instructions, sell_instructions, ltas] = await this.buy_sell_instructions(
            amount,
            trader,
            mint_meta,
            slippage
        );

        if (interval_ms && interval_ms > 0) {
            const buy_signature = await trade.send_tx(
                buy_instructions,
                [trader],
                priority,
                protection_tip,
                mev_protect,
                ltas
            );
            await common.sleep(interval_ms);
            const sell_signature = await trade.retry_send_tx(
                sell_instructions,
                [trader],
                priority,
                protection_tip,
                mev_protect,
                ltas
            );
            return [buy_signature, sell_signature];
        }

        const signature = await trade.send_tx(
            [...buy_instructions, ...sell_instructions],
            [trader],
            priority,
            protection_tip,
            mev_protect,
            ltas
        );
        return [signature, signature];
    }

    public async buy_sell_bundle(
        amount: TokenAmount,
        trader: Keypair,
        mint_meta: JupiterMintMeta,
        tip: number,
        slippage: number = 0.05,
        priority?: PriorityLevel
    ): Promise<String> {
        const [buy_instructions, sell_instructions, ltas] = await this.buy_sell_instructions(
            amount,
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

    public async get_mint_meta(mint: PublicKey): Promise<JupiterMintMeta | undefined> {
        try {
            return await this.default_mint_meta(mint);
        } catch (error) {
            return undefined;
        }
    }

    public async get_random_mints(_count: number): Promise<JupiterMintMeta[]> {
        throw new Error('Not supported');
    }

    public async create_token(
        _mint: Keypair,
        _creator: Keypair,
        _token_name: string,
        _token_symbol: string,
        _meta_cid: string,
        _amount: TokenAmount = trade.get_sol_token_amount(0),
        _traders?: [Keypair, TokenAmount][],
        _bundle_tip?: number,
        _priority?: PriorityLevel
    ): Promise<String> {
        throw new Error('Not supported');
    }

    public update_mint_meta_reserves(
        mint_meta: JupiterMintMeta,
        _amount: TokenAmount,
        _op: trade.TradeOp
    ): JupiterMintMeta {
        return mint_meta;
    }

    public async update_mint_meta(mint_meta: JupiterMintMeta): Promise<JupiterMintMeta> {
        const mint = new PublicKey(mint_meta.mint);
        return this.default_mint_meta(mint);
    }

    public async default_mint_meta(mint: PublicKey): Promise<JupiterMintMeta> {
        const sol_price = await common.fetch_sol_price();
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
        return new JupiterMintMeta({
            mint: mint.toString(),
            quote_mint: SOL_MINT.toString(),
            name: meta.token_name,
            symbol: meta.token_symbol,
            total_supply: BigInt(meta.token_supply),
            market_cap,
            token_program_id: meta.token_program.toString()
        });
    }

    public async subscribe_mint_meta(
        _mint_meta: JupiterMintMeta,
        _callback: (mint_meta: JupiterMintMeta) => void,
        _commitment: Commitment = COMMITMENT
    ): Promise<() => void> {
        throw new Error('Not supported');
    }

    public async create_token_metadata(meta: common.IPFSMetadata, image_path: string): Promise<string> {
        return await common.upload_metadata_ipfs(meta, image_path);
    }

    public async estimate_buy_output(
        mint_meta: JupiterMintMeta,
        quote_amount: TokenAmount,
        slippage: number
    ): Promise<trade.OutputEstimate> {
        const [quote, base] = await Promise.all([
            quote_jupiter(quote_amount, SOL_MINT, mint_meta.mint_pubkey),
            trade.get_quote_info(mint_meta.mint_pubkey)
        ]);
        const minimum_quote = trade.apply_slippage_down(BigInt(quote.outAmount), slippage);
        return {
            expected: {
                amount: quote.outAmount,
                decimals: base.decimals,
                uiAmount: Number(quote.outAmount) / 10 ** base.decimals
            },
            minimum: {
                amount: minimum_quote.toString(),
                decimals: base.decimals,
                uiAmount: Number(minimum_quote) / 10 ** base.decimals
            }
        };
    }

    public async estimate_sell_output(
        mint_meta: JupiterMintMeta,
        token_amount: TokenAmount,
        slippage: number
    ): Promise<trade.OutputEstimate> {
        const quote = await quote_jupiter(token_amount, mint_meta.mint_pubkey, SOL_MINT);
        const minimum_quote = trade.apply_slippage_down(BigInt(quote.outAmount), slippage);
        return {
            expected: {
                amount: quote.outAmount,
                decimals: 9,
                uiAmount: Number(quote.outAmount) / 10 ** 9
            },
            minimum: {
                amount: minimum_quote.toString(),
                decimals: 9,
                uiAmount: Number(minimum_quote) / 10 ** 9
            }
        };
    }
}
