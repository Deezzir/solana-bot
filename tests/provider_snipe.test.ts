import { afterAll, afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { PublicKey } from '@solana/web3.js';
import type { IMintMeta } from '../src/common/trade_common';

const original_helius_key = process.env.HELIUS_API_KEY;
const original_pinata_jwt = process.env.PINATA_IPFS_JWT;
process.env.HELIUS_API_KEY ||= 'unit-test';
process.env.PINATA_IPFS_JWT ||= 'unit-test';

const [{ RaydiumRunner }, { Runner }, { RaydiumProvider, RaydiumMintMeta }, { Provider }, constants, common] =
    await Promise.all([
        import('../src/raydium/snipe_raydium'),
        import('../src/meteora/snipe_meteora'),
        import('../src/raydium/trade_raydium'),
        import('../src/meteora/trade_meteora'),
        import('../src/constants'),
        import('../src/common/common')
    ]);

class RaydiumSniper extends RaydiumRunner {
    decode(data: Uint8Array, accounts: PublicKey[]) {
        return this.decode_create_instr(data, accounts);
    }
    initialize(mint: PublicKey, mint_meta?: IMintMeta) {
        return this.get_initial_mint_meta({ mint, mint_meta });
    }
}

class MeteoraSniper extends Runner {
    decode(data: Uint8Array, accounts: PublicKey[]) {
        return this.decode_create_instr(data, accounts);
    }
    detects(log: string) {
        return this.is_create_tx([log]);
    }
}

afterEach(() => mock.restore());
afterAll(() => {
    if (original_helius_key === undefined) delete process.env.HELIUS_API_KEY;
    else process.env.HELIUS_API_KEY = original_helius_key;
    if (original_pinata_jwt === undefined) delete process.env.PINATA_IPFS_JWT;
    else process.env.PINATA_IPFS_JWT = original_pinata_jwt;
});

function string(value: string) {
    const data = Buffer.alloc(4 + Buffer.byteLength(value));
    data.writeUInt32LE(Buffer.byteLength(value));
    data.write(value, 4);
    return data;
}

const accounts = Array.from({ length: 18 }, (_, index) => new PublicKey(new Uint8Array(32).fill(index + 1)));
const mint = accounts[6]!;

describe('provider creation-event initialization', () => {
    test('Raydium preserves quote, config and decimal units from creation accounts', () => {
        const sniper = new RaydiumSniper(new RaydiumProvider());
        const data = Buffer.concat([
            Buffer.from(constants.RAYDIUM_LAUNCHPAD_CREATE_DISCRIMINATOR),
            Buffer.from([8]),
            string('Token'),
            string('TOK'),
            string('uri')
        ]);
        expect(sniper.decode(data, accounts)?.misc).toMatchObject({
            global_config: accounts[2]!.toBase58(),
            quote_mint: accounts[7]!.toBase58(),
            token_decimals: 8,
            token_program: accounts[11]!.toBase58()
        });
        expect(sniper.decode(data, accounts.slice(0, 10))).toBeNull();
    });

    test.each([false, true])(
        'Meteora detects and decodes Token-2022=%s without accepting transfer hooks',
        (token2022) => {
            const sniper = new MeteoraSniper(new Provider());
            const data = Buffer.concat([
                Buffer.from(
                    token2022
                        ? constants.METEORA_DBC_CREATE_TOKEN_2022_DISCRIMINATOR
                        : constants.METEORA_DBC_CREATE_DISCRIMINATOR
                ),
                string('Token'),
                string('TOK'),
                string('uri')
            ]);
            const log = `Program log: Instruction: InitializeVirtualPoolWith${token2022 ? 'Token2022' : 'SplToken'}`;
            expect(sniper.detects(log)).toBeTrue();
            expect(sniper.decode(data, accounts)?.misc).toMatchObject({
                quote_mint: accounts[4]!.toBase58(),
                token_program: accounts[token2022 ? 10 : 12]!.toBase58()
            });
            expect(
                sniper.detects('Program log: Instruction: InitializeVirtualPoolWithToken2022TransferHook')
            ).toBeFalse();
            expect(sniper.decode(data, accounts.slice(0, 8))).toBeNull();
        }
    );

    test('waits for authoritative metadata when a creation event precedes confirmed account availability', async () => {
        const provider = new RaydiumProvider();
        const sniper = new RaydiumSniper(provider);
        const live = new RaydiumMintMeta({ mint: mint.toBase58() });
        const lookup = spyOn(provider, 'get_mint_meta').mockResolvedValueOnce(undefined).mockResolvedValueOnce(live);
        const defaults = spyOn(provider, 'default_mint_meta');
        spyOn(common, 'sleep').mockResolvedValue(undefined);
        expect(await sniper.initialize(mint)).toBe(live);
        expect(lookup).toHaveBeenCalledTimes(2);
        expect(defaults).not.toHaveBeenCalled();
    });

    test('reuses existing metadata and never converts provider failures into defaults', async () => {
        const provider = new RaydiumProvider();
        const sniper = new RaydiumSniper(provider);
        const live = new RaydiumMintMeta({ mint: mint.toBase58() });
        const lookup = spyOn(provider, 'get_mint_meta').mockRejectedValue(new Error('RPC unavailable'));
        expect(await sniper.initialize(mint, live)).toBe(live);
        expect(lookup).not.toHaveBeenCalled();
        await expect(sniper.initialize(mint)).rejects.toThrow('RPC unavailable');
        expect(lookup).toHaveBeenCalledTimes(1);
    });
});
