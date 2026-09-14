import { AddressLookupTableAccount, Keypair, PublicKey, TokenAmount, TransactionInstruction } from '@solana/web3.js';
import { JUPITER_API_URL } from '../constants';
import { get_ltas, validate_trade_parameters } from '../common/trade_common';

type JupiterQuote = {
    inputMint: string;
    inAmount: string;
    outputMint: string;
    outAmount: string;
    otherAmountThreshold: string;
    swapMode: 'ExactIn' | 'ExactOut';
    slippageBps: number;
    platformFee: {
        amount: string;
        feeBps: number;
    };
    priceImpactPct: string;
    routePlan: Array<{
        swapInfo: {
            ammKey: string;
            label: string;
            inputMint: string;
            outputMint: string;
            inAmount: string;
            outAmount: string;
            feeAmount: string;
            feeMint: string;
        };
        percent: number;
    }>;
    contextSlot: number;
    timeTaken: number;
};

type JupiterInstruction = {
    programId: string;
    accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
    data: string;
};

type JupiterInstructions = {
    tokenLedgerInstruction?: JupiterInstruction | null;
    setupInstructions?: JupiterInstruction[];
    otherInstructions?: JupiterInstruction[];
    swapInstruction?: JupiterInstruction | null;
    cleanupInstruction?: JupiterInstruction | null;
    addressLookupTableAddresses?: string[];
};

async function jupiter_request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const api_key = process.env.JUPITER_API_KEY;
    if (!api_key) throw new Error('JUPITER_API_KEY is required to use the Jupiter provider.');

    const response = await fetch(`${JUPITER_API_URL}${path}`, {
        ...init,
        headers: { 'x-api-key': api_key, ...init.headers }
    });
    const payload = await response.json();
    if (!response.ok || payload.error || payload.errorCode)
        throw new Error(payload.error || `Jupiter ${path} request failed with HTTP ${response.status}.`);
    return payload as T;
}

export async function quote_jupiter(
    amount: TokenAmount,
    from: PublicKey,
    to: PublicKey,
    slippage: number = 0.05,
    swap_mode: 'ExactIn' | 'ExactOut' = 'ExactIn'
): Promise<JupiterQuote> {
    validate_trade_parameters(amount, slippage);
    const params = new URLSearchParams({
        inputMint: from.toBase58(),
        outputMint: to.toBase58(),
        amount: amount.amount,
        swapMode: swap_mode,
        slippageBps: String(slippage * 10000)
    });
    return await jupiter_request<JupiterQuote>(`quote?${params.toString()}`);
}

export async function swap_jupiter_instructions(
    seller: Keypair,
    quote: JupiterQuote
): Promise<[TransactionInstruction[], AddressLookupTableAccount[]]> {
    const deserialize_instruction = (instruction: JupiterInstruction) => {
        return new TransactionInstruction({
            programId: new PublicKey(instruction.programId),
            keys: instruction.accounts.map((key: any) => ({
                pubkey: new PublicKey(key.pubkey),
                isSigner: key.isSigner,
                isWritable: key.isWritable
            })),
            data: Buffer.from(instruction.data, 'base64')
        });
    };
    const instructions_raw = await jupiter_request<JupiterInstructions>('swap-instructions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            quoteResponse: quote,
            userPublicKey: seller.publicKey.toBase58(),
            wrapAndUnwrapSol: true
        })
    });
    if (!instructions_raw.swapInstruction)
        throw new Error('Jupiter swap instructions did not include a swap instruction.');

    const lta_accounts = await get_ltas(
        (instructions_raw.addressLookupTableAddresses ?? []).map((lta) => new PublicKey(lta))
    );
    const instructions: TransactionInstruction[] = [
        ...(instructions_raw.tokenLedgerInstruction
            ? [deserialize_instruction(instructions_raw.tokenLedgerInstruction)]
            : []),
        ...(instructions_raw.setupInstructions ?? []).map(deserialize_instruction),
        ...(instructions_raw.otherInstructions ?? []).map(deserialize_instruction),
        deserialize_instruction(instructions_raw.swapInstruction),
        ...(instructions_raw.cleanupInstruction ? [deserialize_instruction(instructions_raw.cleanupInstruction)] : [])
    ];
    return [instructions, lta_accounts];
}
