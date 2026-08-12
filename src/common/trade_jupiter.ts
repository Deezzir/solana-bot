import { AddressLookupTableAccount, PublicKey, Signer, TokenAmount, TransactionInstruction } from '@solana/web3.js';
import { PriorityLevel, JUPITER_API_URL } from '../constants';
import { send_tx, get_ltas } from './trade_common';

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

export async function swap_jupiter(
    amount: TokenAmount,
    seller: Signer,
    from: PublicKey,
    to: PublicKey,
    slippage: number = 0.05,
    priority?: PriorityLevel,
    protection_tip?: number
): Promise<String> {
    const quote = await quote_jupiter(amount, from, to, slippage);
    const [instructions, lta_accounts] = await swap_jupiter_instructions(seller, quote);
    return await send_tx(instructions, [seller], priority, protection_tip, lta_accounts);
}

export async function quote_jupiter(
    amount: TokenAmount,
    from: PublicKey,
    to: PublicKey,
    slippage: number = 0.05
): Promise<JupiterQuote> {
    const params = new URLSearchParams({
        inputMint: from.toBase58(),
        outputMint: to.toBase58(),
        amount: amount.amount,
        slippageBps: String(slippage * 10000)
    });
    return await jupiter_request<JupiterQuote>(`quote?${params.toString()}`);
}

export async function swap_jupiter_instructions(
    seller: Signer,
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
