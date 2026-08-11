import {
    PublicKey,
    Signer,
    TokenAmount,
    TransactionInstruction,
    Keypair,
    AddressLookupTableAccount
} from '@solana/web3.js';
import { PriorityLevel, SOL_MINT, TRADE_RAYDIUM_SWAP_TAX } from '../constants';
import * as trade from '../common/trade_common';
import * as common from '../common/common';
import { swap_raydium_instructions } from '../common/trade_dex';

class MoonshotMintMeta implements trade.IMintMeta {
    mint!: string;
    name!: string;
    symbol!: string;
    usd_market_cap: number = 0;
    market_cap: number = 0;
    complete: boolean = false;
    fee: number = TRADE_RAYDIUM_SWAP_TAX;
    token_program_id!: string;

    constructor(data: Partial<MoonshotMintMeta> = {}) {
        Object.assign(this, data);
    }

    public get token_name(): string {
        return this.name;
    }

    public get token_mint(): string {
        return this.mint;
    }

    public get token_symbol(): string {
        return this.symbol;
    }

    public get token_usd_mc(): number {
        return this.usd_market_cap;
    }

    public get migrated(): boolean {
        return this.complete;
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
            usd_market_cap: this.usd_market_cap,
            market_cap: this.market_cap,
            complete: this.complete,
            fee: this.fee,
            token_program_id: this.token_program_id
        };
    }

    public static deserialize(data: trade.SerializedMintMeta): MoonshotMintMeta {
        return new MoonshotMintMeta({
            mint: data.mint as string,
            name: data.name as string,
            symbol: data.symbol as string,
            usd_market_cap: data.usd_market_cap as number,
            market_cap: data.market_cap as number,
            complete: data.complete as boolean,
            fee: data.fee as number,
            token_program_id: data.token_program_id as string
        });
    }
}

export class Trader implements trade.IProgramTrader {
    public get_name(): string {
        return common.Program.Moonit;
    }

    public get_lta_addresses(): PublicKey[] {
        return [];
    }

    public deserialize_mint_meta(data: trade.SerializedMintMeta): MoonshotMintMeta {
        return MoonshotMintMeta.deserialize(data);
    }

    public async claim_dev_fees(): Promise<{ signature: String | null; fees: number }> {
        throw new Error('Claiming dev fees is not implemented for Moonit.');
    }

    public async buy_token(
        sol_amount: number,
        buyer: Signer,
        mint_meta: MoonshotMintMeta,
        slippage: number = 0.05,
        priority?: PriorityLevel,
        protection_tip?: number
    ): Promise<String> {
        const [instructions, address_lt_accounts] = await this.buy_token_instructions(
            sol_amount,
            buyer,
            mint_meta,
            slippage
        );
        return await trade.send_tx(instructions, [buyer], priority, protection_tip, address_lt_accounts);
    }

    public async buy_token_instructions(
        sol_amount: number,
        buyer: Signer,
        mint_meta: MoonshotMintMeta,
        slippage: number = 0.05
    ): Promise<[TransactionInstruction[], AddressLookupTableAccount[]?]> {
        const amm = this.get_raydium_amm(mint_meta);
        if (!amm) {
            return this.get_buy_token_instructions(sol_amount, buyer, mint_meta, slippage);
        } else {
            const sol_token_amount = trade.get_sol_token_amount(sol_amount);
            return swap_raydium_instructions(sol_token_amount, buyer, amm, SOL_MINT, slippage);
        }
    }

    public async sell_token(
        token_amount: TokenAmount,
        seller: Signer,
        mint_meta: MoonshotMintMeta,
        slippage: number = 0.05,
        priority?: PriorityLevel,
        protection_tip?: number
    ): Promise<String> {
        const [instructions, address_lt_accounts] = await this.sell_token_instructions(
            token_amount,
            seller,
            mint_meta,
            slippage
        );
        return await trade.send_tx(instructions, [seller], priority, protection_tip, address_lt_accounts);
    }

    public async sell_token_instructions(
        token_amount: TokenAmount,
        seller: Signer,
        mint_meta: MoonshotMintMeta,
        slippage: number = 0.05
    ): Promise<[TransactionInstruction[], AddressLookupTableAccount[]?]> {
        const amm = this.get_raydium_amm(mint_meta);
        if (!amm) {
            return this.get_sell_token_instructions(token_amount, seller, mint_meta, slippage);
        } else {
            const mint = new PublicKey(mint_meta.mint);
            return swap_raydium_instructions(token_amount, seller, amm, mint, slippage);
        }
    }

    public async buy_sell_instructions(
        _sol_amount: number,
        _trader: Signer,
        _mint_meta: MoonshotMintMeta,
        _slippage: number = 0.05
    ): Promise<[TransactionInstruction[], TransactionInstruction[], AddressLookupTableAccount[]?]> {
        throw new Error('Not implemented');
    }

    public async buy_sell_bundle(
        _sol_amount: number,
        _trader: Signer,
        _mint_meta: MoonshotMintMeta,
        _tip: number,
        _slippage: number = 0.05,
        _priority?: PriorityLevel
    ): Promise<String> {
        throw new Error('Not implemented');
    }

    public async buy_sell(
        _sol_amount: number,
        _trader: Signer,
        _mint_meta: MoonshotMintMeta,
        _interval_ms: number,
        _slippage: number = 0.05,
        _priority?: PriorityLevel,
        _protection_tip?: number
    ): Promise<[String, String]> {
        throw new Error('Not implemented');
    }

    public async get_mint_meta(_mint: PublicKey, _sol_price: number): Promise<MoonshotMintMeta | undefined> {
        throw new Error('Not Implemented');
    }

    public async get_random_mints(_count: number): Promise<MoonshotMintMeta[]> {
        throw new Error('Not Implemented');
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

    public async create_token_metadata(_meta: common.IPFSMetadata, _image_path: string): Promise<string> {
        throw new Error('Not implemented');
    }

    public async default_mint_meta(_mint: PublicKey, _sol_price: number): Promise<MoonshotMintMeta> {
        throw new Error('Not Implemented');
    }

    public update_mint_meta_reserves(_mint_meta: MoonshotMintMeta, _amount: number | TokenAmount): MoonshotMintMeta {
        throw new Error('Not Implemented');
    }

    public async update_mint_meta(_mint_meta: MoonshotMintMeta, _sol_price: number): Promise<MoonshotMintMeta> {
        throw new Error('Not Implemented');
    }

    public async subscribe_mint_meta(
        _mint_meta: MoonshotMintMeta,
        _callback: (mint_meta: MoonshotMintMeta) => void
    ): Promise<() => void> {
        throw new Error('Not implemented');
    }

    private get_raydium_amm(_mint_meta: MoonshotMintMeta): PublicKey | undefined {
        throw new Error('Not Implemented');
    }

    private async get_sell_token_instructions(
        _token_amount: TokenAmount,
        _seller: Signer,
        _mint_meta: Partial<MoonshotMintMeta>,
        _slippage: number = 0.05
    ): Promise<[TransactionInstruction[], AddressLookupTableAccount[]?]> {
        throw new Error('Not Implemented');
    }

    private async get_buy_token_instructions(
        _sol_amount: number,
        _buyer: Signer,
        _mint_meta: Partial<MoonshotMintMeta>,
        _slippage: number = 0.05
    ): Promise<[TransactionInstruction[], AddressLookupTableAccount[]?]> {
        throw new Error('Not Implemented');
    }
}
