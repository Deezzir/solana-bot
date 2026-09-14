import { AddressLookupTableAccount, Keypair, PublicKey, TokenAmount, TransactionInstruction } from '@solana/web3.js';
import {
    COMMANDS_BUY_SLIPPAGE,
    COMMITMENT,
    EXECUTOR_JUPITER_COMPUTE_UNIT_ALLOWANCE,
    MAX_COMPUTE_UNIT_LIMIT,
    PriorityLevel,
    SOL_MINT,
    TRADE_MAX_WALLETS_PER_CREATE_TX
} from '../constants';
import {
    IProgramProvider,
    IMintMeta,
    SerializedMintMeta,
    TradeOp,
    ClaimableAsset,
    calc_ata,
    get_balance,
    get_token_balance,
    sol_to_lamports,
    get_sol_token_amount as sol_to_token_amount,
    get_quote_info,
    send_bundle,
    send_tx,
    retry_send_tx,
    retry_send_bundle,
    generate_trade_lta,
    deactivate_ltas,
    create_tip_instruction,
    pack_tx_groups,
    get_bundle_size,
    validate_create_token_parameters,
    CompileTransactionError
} from './trade_common';
import { quote_jupiter, swap_jupiter_instructions } from '../jupiter/swap_jupiter';
import { IPFSMetadata, sleep, log, warn } from './common';
import { decode_token_account } from './token';

type BuyFunding = {
    status: 'ready' | 'needs_funding' | 'insufficient';
    quote_amount: TokenAmount;
    quote_balance_raw: bigint;
    sol_balance_raw: bigint;
};

type InitialBuy = {
    buyer: Keypair;
    instructions: TransactionInstruction[];
    funding?: TransactionInstruction[][];
};

type CreateBundleOptions = {
    instructions: TransactionInstruction[];
    funding?: TransactionInstruction[][];
    creator: Keypair;
    mint: Keypair;
    buyers: InitialBuy[];
    tip: number;
    priority?: PriorityLevel;
    alts: AddressLookupTableAccount[];
    token_program: PublicKey;
    wallet_compute_units: number;
};

export class Executor {
    constructor(
        private readonly provider: IProgramProvider,
        private enable_funding: boolean = false
    ) {}

    public get_lta_addresses(): PublicKey[] {
        return this.provider.get_lta_addresses();
    }

    public get_compute_unit_limit(funded: boolean = false): number | undefined {
        const limit = this.provider.get_compute_unit_limit();
        return funded
            ? Math.min(
                  MAX_COMPUTE_UNIT_LIMIT,
                  (limit ?? MAX_COMPUTE_UNIT_LIMIT) + EXECUTOR_JUPITER_COMPUTE_UNIT_ALLOWANCE
              )
            : limit;
    }

    public deserialize_mint_meta(data: SerializedMintMeta): IMintMeta {
        return this.provider.deserialize_mint_meta(data);
    }

    public get_mint_meta(mint: PublicKey): Promise<IMintMeta | undefined> {
        return this.provider.get_mint_meta(mint);
    }

    public update_mint_meta(mint_meta: IMintMeta): Promise<IMintMeta> {
        return this.provider.update_mint_meta(mint_meta);
    }

    public update_mint_meta_reserves(mint_meta: IMintMeta, amount: TokenAmount, op: TradeOp): IMintMeta {
        return this.provider.update_mint_meta_reserves(mint_meta, amount, op);
    }

    public get_random_mints(count: number): Promise<IMintMeta[]> {
        return this.provider.get_random_mints(count);
    }

    public create_token_metadata(meta: IPFSMetadata, image_path: string): Promise<string> {
        return this.provider.create_token_metadata(meta, image_path);
    }

    public get_rewards(trader: Keypair): Promise<ClaimableAsset[]> {
        return this.provider.get_rewards(trader);
    }

    public async claim_rewards(trader: Keypair, assets: ClaimableAsset[], priority?: PriorityLevel): Promise<String> {
        const instructions = await this.provider.claim_rewards_instructions(trader, assets);
        return send_tx(
            instructions,
            [trader],
            priority,
            undefined,
            false,
            undefined,
            this.provider.get_compute_unit_limit()
        );
    }

    public async buy_token(
        sol_amount: number,
        buyer: Keypair,
        mint_meta: IMintMeta,
        slippage: number,
        priority?: PriorityLevel,
        protection_tip?: number,
        mev_protect?: boolean
    ): Promise<String> {
        const [instructions, ltas] = await this.buy_token_instructions(sol_amount, buyer, mint_meta, slippage);
        if (instructions.length !== 1 && instructions.length !== 2)
            throw new Error('Expected 1 or 2 sets of instructions for buy_token.');

        if (instructions.length === 2) {
            if (protection_tip) {
                return send_bundle(
                    instructions,
                    [[buyer], [buyer]],
                    protection_tip,
                    priority,
                    ltas,
                    this.get_compute_unit_limit(true)
                );
            }

            try {
                return await send_tx(
                    [...instructions[0], ...instructions[1]],
                    [buyer],
                    priority,
                    protection_tip,
                    mev_protect,
                    ltas,
                    this.get_compute_unit_limit(true)
                );
            } catch (error) {
                if (!(error instanceof CompileTransactionError)) throw error;
                throw new Error(
                    'Funding and buy cannot fit in one transaction. Prefund the quote token or specify a bundle tip.',
                    { cause: error }
                );
            }
        } else {
            return send_tx(
                instructions[0],
                [buyer],
                priority,
                protection_tip,
                mev_protect,
                ltas,
                this.provider.get_compute_unit_limit()
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
        const [instructions, ltas] = await this.sell_token_instructions(token_amount, seller, mint_meta, slippage);
        if (instructions.length === 1)
            return send_tx(
                instructions[0],
                [seller],
                priority,
                protection_tip,
                mev_protect,
                ltas,
                this.provider.get_compute_unit_limit()
            );

        if (instructions.length !== 2)
            throw new Error('Expected exactly 2 sets of instructions for sell_token with funding.');

        if (protection_tip) {
            return send_bundle(
                [instructions[0], instructions[1]],
                [[seller], [seller]],
                protection_tip,
                priority,
                ltas,
                this.get_compute_unit_limit(true)
            );
        }

        try {
            return await send_tx(
                [...instructions[0], ...instructions[1]],
                [seller],
                priority,
                protection_tip,
                mev_protect,
                ltas,
                this.get_compute_unit_limit(true)
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
        const [buy_instructions, sell_instructions, ltas] = await this.buy_sell_instructions(
            sol_amount,
            trader,
            mint_meta,
            slippage
        );
        const instructions = [...buy_instructions, ...sell_instructions];
        return send_bundle(
            instructions,
            instructions.map(() => [trader]),
            tip,
            priority,
            ltas,
            this.is_non_sol_quote(mint_meta) && this.enable_funding
                ? this.get_compute_unit_limit(true)
                : this.provider.get_compute_unit_limit()
        );
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
        if (interval_ms && interval_ms > 0) {
            const token_account = await calc_ata(trader.publicKey, mint_meta.mint_pubkey, mint_meta.token_program);
            const account_before = await global.CONNECTION.getAccountInfo(token_account, COMMITMENT);
            const balance_before = account_before ? decode_token_account(account_before).amount : 0n;
            const buy_signature = await this.buy_token(
                sol_amount,
                trader,
                mint_meta,
                slippage,
                priority,
                protection_tip,
                mev_protect
            );
            const { value: balance_after } = await global.CONNECTION.getTokenAccountBalance(token_account, COMMITMENT);
            const bought_amount = BigInt(balance_after.amount) - balance_before;
            if (bought_amount <= 0n) throw new Error('No tokens received from the buy; cannot execute the sell.');

            await sleep(interval_ms);
            mint_meta = await this.provider.update_mint_meta(mint_meta);
            const sell_signature = await this.sell_token(
                { amount: bought_amount.toString(), decimals: balance_after.decimals, uiAmount: null },
                trader,
                mint_meta,
                slippage,
                priority,
                protection_tip,
                mev_protect
            );
            return [buy_signature, sell_signature];
        }

        const [buy_instructions, sell_instructions, ltas] = await this.buy_sell_instructions(
            sol_amount,
            trader,
            mint_meta,
            slippage
        );
        try {
            const signature = await send_tx(
                [...buy_instructions.flat(), ...sell_instructions.flat()],
                [trader],
                priority,
                protection_tip,
                mev_protect,
                ltas,
                MAX_COMPUTE_UNIT_LIMIT
            );
            return [signature, signature];
        } catch (error) {
            if (!(error instanceof CompileTransactionError)) throw error;
            throw new Error('Buy/sell cannot fit in one transaction. Use a buy/sell bundle instead.', { cause: error });
        }
    }

    public async buy_token_instructions(
        sol_amount: number,
        buyer: Keypair,
        mint_meta: IMintMeta,
        slippage: number
    ): Promise<[TransactionInstruction[][], AddressLookupTableAccount[]?]> {
        const [quote_amount, funding_instructions, funding_ltas] = await this.prepare_buy_funding(
            sol_amount,
            buyer,
            mint_meta,
            slippage
        );
        const [instructions, ltas] = await this.provider.buy_token_instructions(
            quote_amount,
            buyer,
            mint_meta,
            slippage
        );
        return [
            [...funding_instructions, instructions],
            [...funding_ltas, ...(ltas ?? [])]
        ];
    }

    public async sell_token_instructions(
        token_amount: TokenAmount,
        seller: Keypair,
        mint_meta: IMintMeta,
        slippage: number
    ): Promise<[TransactionInstruction[][], AddressLookupTableAccount[]?]> {
        const is_non_sol_quote = this.is_non_sol_quote(mint_meta);
        const { instructions, ltas, minimum_quote_output } = await this.provider.sell_token_instructions(
            token_amount,
            seller,
            mint_meta,
            slippage
        );
        if (!is_non_sol_quote || (is_non_sol_quote && !this.enable_funding)) {
            return [[instructions], ltas];
        }

        const quote_mint = mint_meta.quote_mint_pubkey;
        const { quote } = await this.get_sol_quote_from_token(minimum_quote_output, quote_mint, slippage);
        const [fund_instructions, fund_ltas] = await swap_jupiter_instructions(seller, quote);

        return [
            [instructions, fund_instructions],
            [...(ltas ?? []), ...fund_ltas]
        ];
    }

    public async buy_sell_instructions(
        sol_amount: number,
        trader: Keypair,
        mint_meta: IMintMeta,
        slippage: number
    ): Promise<[TransactionInstruction[][], TransactionInstruction[][], AddressLookupTableAccount[]?]> {
        const [quote_amount, funding_instructions, funding_ltas] = await this.prepare_buy_funding(
            sol_amount,
            trader,
            mint_meta,
            slippage
        );
        const {
            buy,
            sell,
            ltas: trade_ltas,
            minimum_quote_output
        } = await this.provider.buy_sell_instructions(quote_amount, trader, mint_meta, slippage);
        const buy_groups = [...funding_instructions, buy];
        const sell_groups = [sell];
        const ltas = [...funding_ltas, ...(trade_ltas ?? [])];

        if (this.is_non_sol_quote(mint_meta) && this.enable_funding) {
            const { quote } = await this.get_sol_quote_from_token(
                minimum_quote_output,
                mint_meta.quote_mint_pubkey,
                slippage
            );
            const [convert_instructions, convert_ltas] = await swap_jupiter_instructions(trader, quote);
            sell_groups.push(convert_instructions);
            ltas.push(...convert_ltas);
        }

        return [buy_groups, sell_groups, ltas];
    }

    public async create_token(
        mint: Keypair,
        creator: Keypair,
        token_name: string,
        token_symbol: string,
        meta_cid: string,
        sol_amount: number = 0,
        traders?: [Keypair, number][],
        bundle_tip?: number,
        priority?: PriorityLevel,
        config?: object
    ): Promise<String> {
        validate_create_token_parameters(sol_amount, traders, bundle_tip);
        let { instructions, mint_meta, ltas } = await this.provider.create_token_instructions(
            mint,
            creator,
            token_name,
            token_symbol,
            meta_cid,
            config,
            sol_amount > 0
        );
        const prepare_buy = async (buyer: Keypair, amount: number): Promise<InitialBuy> => {
            const [quote_amount, funding, funding_ltas] = await this.prepare_buy_funding(
                amount,
                buyer,
                mint_meta,
                COMMANDS_BUY_SLIPPAGE
            );
            const [buy_instructions, buy_ltas] = await this.provider.buy_token_instructions(
                quote_amount,
                buyer,
                mint_meta,
                COMMANDS_BUY_SLIPPAGE
            );
            for (const table of [...funding_ltas, ...(buy_ltas ?? [])]) {
                if (!ltas.some((existing) => existing.key.equals(table.key))) ltas.push(table);
            }
            if (traders) mint_meta = this.provider.update_mint_meta_reserves(mint_meta, quote_amount, 'buy');
            return { buyer, instructions: buy_instructions, funding };
        };

        let funding: TransactionInstruction[][] = [];
        if (sol_amount > 0) {
            const buy = await prepare_buy(creator, sol_amount);
            funding = buy.funding ?? [];
            instructions.push(...buy.instructions);
        }

        if (!traders) {
            try {
                return await retry_send_tx(
                    [...funding.flat(), ...instructions],
                    [creator, mint],
                    priority,
                    undefined,
                    false,
                    ltas,
                    funding.length ? MAX_COMPUTE_UNIT_LIMIT : this.provider.get_compute_unit_limit()
                );
            } catch (error) {
                if (!(error instanceof CompileTransactionError)) throw error;
                throw new Error(
                    'Creation and creator buy cannot fit in one transaction. Prefund the quote token or reduce the creator buy.',
                    { cause: error }
                );
            }
        }

        const buyers: InitialBuy[] = [];
        for (const [buyer, amount] of traders) buyers.push(await prepare_buy(buyer, amount));
        return this.send_create_bundle({
            instructions,
            funding,
            creator,
            mint,
            buyers,
            tip: bundle_tip!,
            priority,
            alts: ltas,
            token_program: mint_meta.token_program,
            wallet_compute_units: this.provider.get_compute_unit_limit() ?? MAX_COMPUTE_UNIT_LIMIT
        });
    }

    public async has_enough_balances(
        sol_amount: number,
        account: PublicKey,
        mint_meta: IMintMeta,
        slippage = COMMANDS_BUY_SLIPPAGE
    ): Promise<BuyFunding> {
        const sol_amount_raw = sol_to_lamports(sol_amount);
        const quote_info = await get_quote_info(mint_meta.quote_mint_pubkey);
        const [sol_balance_raw, quote_balance] = await Promise.all([
            get_balance(account, COMMITMENT),
            this.is_non_sol_quote(mint_meta)
                ? get_token_balance(account, mint_meta.quote_mint_pubkey, COMMITMENT, quote_info.token_program)
                : null
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
                    : this.enable_funding && sol_balance_raw >= sol_needed_raw
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

    private async send_create_bundle({
        instructions,
        funding = [],
        creator,
        mint,
        buyers,
        tip,
        priority,
        alts,
        token_program,
        wallet_compute_units
    }: CreateBundleOptions): Promise<String> {
        const version = global.TRANSACTION_VERSION ?? 0;
        const generated =
            version === 0
                ? await generate_trade_lta(
                      creator,
                      buyers.map(({ buyer }) => buyer),
                      mint.publicKey,
                      token_program
                  )
                : undefined;
        try {
            const tables = generated ? [generated, ...alts] : alts;
            const tip_instruction = create_tip_instruction(creator.publicKey, tip);
            const tip_account = tip_instruction.keys[1].pubkey;
            const bundle_instructions = [...funding, instructions];
            const bundle_signers = [...funding.map(() => [creator]), [creator, mint]];
            const pending: InitialBuy[] = [];
            const append_buyers = () => {
                const groups = pack_tx_groups(
                    pending,
                    (buy) => buy.instructions,
                    (buy) => buy.buyer.publicKey,
                    version,
                    tables,
                    (payer) => [create_tip_instruction(payer, tip, undefined, tip_account)],
                    Math.min(TRADE_MAX_WALLETS_PER_CREATE_TX, Math.floor(MAX_COMPUTE_UNIT_LIMIT / wallet_compute_units))
                );
                bundle_instructions.push(...groups.map((group) => group.flatMap((buy) => buy.instructions)));
                bundle_signers.push(...groups.map((group) => group.map(({ buyer }) => buyer)));
                pending.length = 0;
            };
            for (const buy of buyers) {
                if (buy.funding?.length) {
                    append_buyers();
                    bundle_instructions.push(...buy.funding);
                    bundle_signers.push(...buy.funding.map(() => [buy.buyer]));
                }
                pending.push(buy);
            }
            append_buyers();
            if (bundle_instructions.length > get_bundle_size())
                throw new Error('Initial buys do not fit in one atomic create bundle. Reduce the buyer count.');
            return await retry_send_bundle(
                bundle_instructions,
                bundle_signers,
                tip,
                priority,
                tables,
                MAX_COMPUTE_UNIT_LIMIT,
                undefined,
                { tip_account }
            );
        } finally {
            if (generated) {
                await deactivate_ltas(creator, [generated])
                    .then(() =>
                        log(`ALT ${generated.key} deactivated; reclaim its rent with close-ltas after cooldown.`)
                    )
                    .catch((error) => warn(`Could not deactivate ALT ${generated.key}: ${error}`));
            }
        }
    }

    private async prepare_buy_funding(
        sol_amount: number,
        buyer: Keypair,
        mint_meta: IMintMeta,
        slippage: number
    ): Promise<[TokenAmount, TransactionInstruction[][], AddressLookupTableAccount[]]> {
        if (!this.is_non_sol_quote(mint_meta)) return [sol_to_token_amount(sol_amount), [], []];

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
            const quote_balance_raw = BigInt(
                (await get_token_balance(buyer.publicKey, quote_mint, COMMITMENT, quote_info.token_program)).amount
            );
            const { quote_shortfall_raw, sol_needed_raw } = this.calc_quote_shortfall(
                sol_amount_raw,
                quote_balance_raw,
                quote_amount_raw,
                quote_min_out_amount
            );

            if (sol_needed_raw === 0n) return [quote_out_token_amount, [], []];

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
            return [quote_out_token_amount, [fund_instructions], fund_ltas];
        } else {
            return [quote_out_token_amount, [], []];
        }
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
