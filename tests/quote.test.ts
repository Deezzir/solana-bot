import { describe, expect, test } from 'bun:test';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { get_quote_by_mint, get_quote_by_ticker, get_quote_name_by_mint, is_quote } from '../src/quote';

const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const quotes: Array<{ ticker: string; mint: string; token_program: string; decimals: number }> = [
    {
        ticker: 'SOL',
        mint: 'So11111111111111111111111111111111111111112',
        token_program: TOKEN_PROGRAM_ID,
        decimals: 9
    },
    {
        ticker: 'USDC',
        mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        token_program: TOKEN_PROGRAM_ID,
        decimals: 6
    },
    {
        ticker: 'MU',
        mint: 'MUxEsUKSMACyw5fZf68wxf5FLnZVhtU9CwH8uNNGay1',
        token_program: TOKEN_2022_PROGRAM_ID,
        decimals: 6
    },
    {
        ticker: 'BRK.B',
        mint: 'Xs6B6zawENwAbWVi7w92rjazLuAr5Az59qgWKcNb45x',
        token_program: TOKEN_2022_PROGRAM_ID,
        decimals: 8
    }
];

describe('quote registry', () => {
    test.each(quotes)('resolves $ticker consistently by ticker and mint', (expected) => {
        const by_ticker = get_quote_by_ticker(expected.ticker.toLowerCase());
        const by_string_mint = get_quote_by_mint(expected.mint);
        const mint = new PublicKey(bs58.decode(expected.mint));
        const by_public_key = get_quote_by_mint(mint);

        expect(by_ticker).toBeDefined();
        expect(by_string_mint).toBe(by_ticker);
        expect(by_public_key).toBe(by_ticker);
        expect(get_quote_name_by_mint(expected.mint)).toBe(expected.ticker);
        expect(get_quote_name_by_mint(mint)).toBe(expected.ticker);
        expect(String(by_ticker?.mint)).toBe(expected.mint);
        expect(String(by_ticker?.token_program)).toBe(expected.token_program);
        expect(by_ticker?.decimals).toBe(expected.decimals);
    });

    test('classifies registered tickers case-insensitively', () => {
        for (const { ticker } of quotes) {
            expect(is_quote(ticker)).toBeTrue();
            expect(is_quote(ticker.toLowerCase())).toBeTrue();
        }
    });

    test('returns no registry metadata for unknown ticker and mint values', () => {
        const unknown_mint = PublicKey.default;

        expect(is_quote('NOT_A_QUOTE')).toBeFalse();
        expect(get_quote_by_ticker('NOT_A_QUOTE')).toBeUndefined();
        expect(get_quote_by_mint(unknown_mint)).toBeUndefined();
        expect(get_quote_name_by_mint(unknown_mint)).toBeUndefined();
    });
});
