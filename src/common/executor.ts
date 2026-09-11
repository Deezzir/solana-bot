import { AddressLookupTableAccount, Keypair, PublicKey, TokenAmount, TransactionInstruction } from '@solana/web3.js';
import {
    COMMANDS_BUY_SLIPPAGE,
    COMMITMENT,
    EXECUTOR_JUPITER_COMPUTE_UNIT_ALLOWANCE,
    MAX_COMPUTE_UNIT_LIMIT,
    PriorityLevel,
    SOL_MINT
} from '../constants';
import {
    IProgramTrader,
    IMintMeta,
    get_balance,
    get_token_balance,
    sol_to_lamports,
    get_sol_token_amount as sol_to_token_amount,
    get_quote_info,
    send_bundle,
    send_tx,
    CompileTransactionError
} from './trade_common';
import { quote_jupiter, swap_jupiter_instructions } from '../jupiter/swap_jupiter';

type BuyFunding = {
    status: 'ready' | 'needs_funding' | 'insufficient';
    quote_amount: TokenAmount;
    quote_balance_raw: bigint;
    sol_balance_raw: bigint;
};

export class Executor {
    constructor(
        public readonly trader: IProgramTrader,
        private enable_funding: boolean = false
    ) {}

    public async buy_token(
        sol_amount: number,
        buyer: Keypair,
        mint_meta: IMintMeta,
        slippage: number,
        priority?: PriorityLevel,
        protection_tip?: number,
        mev_protect?: boolean
    ): Promise<String> {
        if (!this.is_non_sol_quote(mint_meta)) {
            const sol_token_amount = sol_to_token_amount(sol_amount);
            return this.trader.buy_token(
                sol_token_amount,
                buyer,
                mint_meta,
                slippage,
                priority,
                protection_tip,
                mev_protect
            );
        }

        const quote_mint = mint_meta.quote_mint_pubkey;
        const [quote_info, { quote_amount_raw, quote_min_out_amount, quote: budget_quote }] = await Promise.all([
            get_quote_info(quote_mint),
            this.get_token_quote_from_sol(sol_amount, quote_mint, slippage)
        ]);
        const quote_out_token_amount: TokenAmount = {
            amount: quote_amount_raw.toString(),
            decimals: quote_info.decimals,
            uiAmount: null
        };

        if (this.enable_funding) {
            const sol_amount_raw = sol_to_lamports(sol_amount);
            const quote_balance_raw = BigInt((await get_token_balance(buyer.publicKey, quote_mint, COMMITMENT)).amount);
            const { quote_shortfall_raw, sol_needed_raw } = this.calc_quote_shortfall(
                sol_amount_raw,
                quote_balance_raw,
                quote_amount_raw,
                quote_min_out_amount
            );

            if (sol_needed_raw === 0n) {
                return this.trader.buy_token(
                    quote_out_token_amount,
                    buyer,
                    mint_meta,
                    slippage,
                    priority,
                    protection_tip,
                    mev_protect
                );
            }

            if (sol_needed_raw > sol_amount_raw)
                throw new Error('Funding shortfall exceeds the SOL budget. Prefund the quote token before buying.');

            const quote =
                quote_shortfall_raw === quote_amount_raw
                    ? budget_quote
                    : await quote_jupiter(
                          { amount: sol_needed_raw.toString(), decimals: 9, uiAmount: null },
                          SOL_MINT,
                          quote_mint,
                          slippage,
                          'ExactIn'
                      );
            if (BigInt(quote.inAmount) > sol_amount_raw)
                throw new Error('Funding quote exceeds the SOL budget. Prefund the quote token before buying.');
            if (BigInt(quote.otherAmountThreshold) < quote_shortfall_raw)
                throw new Error('Funding quote minimum output does not cover the quote-token shortfall.');

            const [fund_instructions, fund_ltas] = await swap_jupiter_instructions(buyer, quote);
            const [trade_instructions, trade_ltas] = await this.trader.buy_token_instructions(
                quote_out_token_amount,
                buyer,
                mint_meta,
                slippage
            );

            if (protection_tip) {
                return send_bundle(
                    [fund_instructions, trade_instructions],
                    [[buyer], [buyer]],
                    protection_tip,
                    priority,
                    [...fund_ltas, ...(trade_ltas ?? [])],
                    this.get_funded_compute_unit_limit()
                );
            }

            try {
                return await send_tx(
                    [...fund_instructions, ...trade_instructions],
                    [buyer],
                    priority,
                    protection_tip,
                    mev_protect,
                    [...fund_ltas, ...(trade_ltas || [])],
                    this.get_funded_compute_unit_limit()
                );
            } catch (error) {
                if (!(error instanceof CompileTransactionError)) throw error;
                throw new Error(
                    'Funding and buy cannot fit in one transaction. Prefund the quote token or specify a bundle tip.',
                    { cause: error }
                );
            }
        } else {
            return this.trader.buy_token(
                quote_out_token_amount,
                buyer,
                mint_meta,
                slippage,
                priority,
                protection_tip,
                mev_protect
            );
        }
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
        const is_non_sol_quote = this.is_non_sol_quote(mint_meta);
        if (!is_non_sol_quote || (is_non_sol_quote && !this.enable_funding))
            return this.trader.sell_token(
                token_amount,
                seller,
                mint_meta,
                slippage,
                priority,
                protection_tip,
                mev_protect
            );

        const quote_mint = mint_meta.quote_mint_pubkey;
        const estimate = await this.trader.estimate_sell_output(mint_meta, token_amount, slippage);
        const { quote } = await this.get_sol_quote_from_token(estimate.minimum, quote_mint, slippage);

        const [trade_instructions, trade_ltas] = await this.trader.sell_token_instructions(
            token_amount,
            seller,
            mint_meta,
            slippage
        );
        const [fund_instructions, fund_ltas] = await swap_jupiter_instructions(seller, quote);

        if (protection_tip) {
            return send_bundle(
                [trade_instructions, fund_instructions],
                [[seller], [seller]],
                protection_tip,
                priority,
                [...(trade_ltas ?? []), ...fund_ltas],
                this.get_funded_compute_unit_limit()
            );
        }

        try {
            return await send_tx(
                [...trade_instructions, ...fund_instructions],
                [seller],
                priority,
                protection_tip,
                mev_protect,
                [...(trade_ltas || []), ...fund_ltas],
                this.get_funded_compute_unit_limit()
            );
        } catch (error) {
            if (!(error instanceof CompileTransactionError)) throw error;
            throw new Error('Sell and SOL conversion cannot fit in one transaction. Specify a bundle tip.', {
                cause: error
            });
        }
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

    public async has_enough_balances(
        sol_amount: number,
        account: PublicKey,
        mint_meta: IMintMeta,
        slippage = COMMANDS_BUY_SLIPPAGE
    ): Promise<BuyFunding> {
        const sol_amount_raw = sol_to_lamports(sol_amount);
        const [sol_balance_raw, quote_balance, quote_info] = await Promise.all([
            get_balance(account, COMMITMENT),
            this.is_non_sol_quote(mint_meta)
                ? get_token_balance(account, mint_meta.quote_mint_pubkey, COMMITMENT)
                : null,
            get_quote_info(mint_meta.quote_mint_pubkey)
        ]);

        if (quote_balance === null) {
            return {
                status: sol_balance_raw >= sol_amount_raw ? 'ready' : 'insufficient',
                quote_amount: sol_to_token_amount(sol_amount),
                sol_balance_raw,
                quote_balance_raw: 0n
            };
        } else {
            const { quote_amount_raw, quote_min_out_amount } = await this.get_token_quote_from_sol(
                sol_amount,
                mint_meta.quote_mint_pubkey,
                slippage
            );
            const quote_balance_raw = BigInt(quote_balance.amount);
            const { sol_needed_raw } = this.calc_quote_shortfall(
                sol_amount_raw,
                quote_balance_raw,
                quote_amount_raw,
                quote_min_out_amount
            );

            const status =
                quote_balance_raw >= quote_amount_raw
                    ? 'ready'
                    : sol_balance_raw >= sol_needed_raw
                      ? 'needs_funding'
                      : 'insufficient';

            return {
                status,
                quote_amount: {
                    amount: quote_amount_raw.toString(),
                    decimals: quote_info.decimals,
                    uiAmount: null
                },
                sol_balance_raw,
                quote_balance_raw
            };
        }
    }

    private get_funded_compute_unit_limit(): number {
        const trader_limit = this.trader.get_compute_unit_limit();
        return trader_limit === undefined
            ? MAX_COMPUTE_UNIT_LIMIT
            : Math.min(MAX_COMPUTE_UNIT_LIMIT, trader_limit + EXECUTOR_JUPITER_COMPUTE_UNIT_ALLOWANCE);
    }

    private is_non_sol_quote(mint_meta: IMintMeta): boolean {
        return !mint_meta.quote_mint_pubkey.equals(SOL_MINT);
    }

    private calc_quote_shortfall(
        sol_amount_raw: bigint,
        quote_balance_raw: bigint,
        required_quote_amount_raw: bigint,
        required_min_quote_amount_raw: bigint
    ): { sol_needed_raw: bigint; quote_shortfall_raw: bigint } {
        const quote_shortfall_raw =
            quote_balance_raw < required_quote_amount_raw ? required_quote_amount_raw - quote_balance_raw : 0n;
        const sol_needed_raw =
            quote_shortfall_raw !== 0n
                ? (quote_shortfall_raw * sol_amount_raw + required_min_quote_amount_raw - 1n) /
                  required_min_quote_amount_raw
                : 0n;
        return { sol_needed_raw, quote_shortfall_raw };
    }

    private async get_token_quote_from_sol(
        sol_amount: number,
        mint: PublicKey,
        slippage: number
    ): Promise<{
        quote_amount_raw: bigint;
        quote_min_out_amount: bigint;
        quote: Awaited<ReturnType<typeof quote_jupiter>>;
    }> {
        const sol_token_amount = sol_to_token_amount(sol_amount);
        const quote = await quote_jupiter(sol_token_amount, SOL_MINT, mint, slippage, 'ExactIn');
        return {
            quote_amount_raw: BigInt(this.enable_funding ? quote.otherAmountThreshold : quote.outAmount),
            quote_min_out_amount: BigInt(quote.otherAmountThreshold),
            quote
        };
    }

    private async get_sol_quote_from_token(
        token_amount: TokenAmount,
        mint: PublicKey,
        slippage: number
    ): Promise<{
        sol_amount_raw: bigint;
        sol_min_out_amount: bigint;
        quote: Awaited<ReturnType<typeof quote_jupiter>>;
    }> {
        const quote = await quote_jupiter(token_amount, mint, SOL_MINT, slippage);
        return {
            sol_amount_raw: BigInt(quote.outAmount),
            sol_min_out_amount: BigInt(quote.otherAmountThreshold),
            quote
        };
    }
}
