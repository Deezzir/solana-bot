import {
    AddressLookupTableAccount,
    Keypair,
    LAMPORTS_PER_SOL,
    PublicKey,
    TokenAmount,
    TransactionInstruction
} from '@solana/web3.js';
import { COMMITMENT, PriorityLevel, SOL_MINT } from '../constants';
import { IProgramTrader, IMintMeta, get_balance, get_token_balance, get_token_meta, MintAsset } from './trade_common';

type BuyFunding = {
    has_enough: boolean;
    quote_amount: TokenAmount;
    quote_balance_raw: bigint;
    quote_shortfall_raw: bigint;
    sol_balance_raw: bigint;
    required_sol_raw: bigint;
};

export class Executor {
    constructor(public readonly trader: IProgramTrader) { }

    public async buy_token(
        sol_amount: number,
        buyer: Keypair,
        mint_meta: IMintMeta,
        slippage: number,
        priority?: PriorityLevel,
        protection_tip?: number,
        mev_protect?: boolean
    ): Promise<String> {
        throw new Error('not implemented');
    }

    public async sell_token(
        token_amount: TokenAmount,
        seller: Keypair,
        mint_meta: IMintMeta,
        slippage: number,
        priority?: PriorityLevel,
        protection_tip?: number,
        mev_protect?: boolean
    ): Promise<String> {
        throw new Error('not implemented');
    }

    public async buy_sell_bundle(
        sol_amount: number,
        trader: Keypair,
        mint_meta: IMintMeta,
        tip: number,
        slippage: number,
        priority?: PriorityLevel
    ): Promise<String> {
        throw new Error('not implemented');
    }

    public async buy_sell(
        sol_amount: number,
        trader: Keypair,
        mint_meta: IMintMeta,
        slippage: number,
        interval_ms?: number,
        priority?: PriorityLevel,
        protection_tip?: number,
        mev_protect?: boolean
    ): Promise<[String, String]> {
        throw new Error('not implemented');
    }

    public async buy_token_instructions(
        sol_amount: number,
        buyer: Keypair,
        mint_meta: IMintMeta,
        slippage: number
    ): Promise<[TransactionInstruction[], AddressLookupTableAccount[]?]> {
        throw new Error('not implemented');
    }

    public async sell_token_instructions(
        token_amount: TokenAmount,
        seller: Keypair,
        mint_meta: IMintMeta,
        slippage: number
    ): Promise<[TransactionInstruction[], AddressLookupTableAccount[]?]> {
        throw new Error('not implemented');
    }

    public async buy_sell_instructions(
        sol_amount: number,
        trader: Keypair,
        mint_meta: IMintMeta,
        slippage: number
    ): Promise<[TransactionInstruction[], TransactionInstruction[], AddressLookupTableAccount[]?]> {
        throw new Error('not implemented');
    }

    public async create_token(
        mint: Keypair,
        creator: Keypair,
        token_name: string,
        token_symbol: string,
        meta_cid: string,
        sol_amount?: number,
        traders?: [Keypair, number][],
        bundle_tip?: number,
        priority?: PriorityLevel,
        config?: object
    ): Promise<String> {
        throw new Error('not implemented');
    }

    public async has_enough_balances(sol_amount: number, account: PublicKey, mint_meta: IMintMeta): Promise<BuyFunding> {
        const is_non_sol_quote = !mint_meta.quote_mint_pubkey.equals(SOL_MINT);
        const [sol_amount_raw, token_amount, token_meta] = await Promise.all([
            get_balance(account, COMMITMENT),
            is_non_sol_quote ? get_token_balance(account, mint_meta.quote_mint_pubkey, COMMITMENT) : null,
            is_non_sol_quote ? get_token_meta(mint_meta.quote_mint_pubkey) : null
        ]);
        const sol_balance = sol_amount_raw / LAMPORTS_PER_SOL;

        if (token_amount === null) {
            return {
                has_enough: sol_balance >= sol_amount,
                sol_balance,
                quote: null
            };
        } else {
            throw new Error('Token balance check not implemented for non-SOL quote mints.');
        }
    }
}
