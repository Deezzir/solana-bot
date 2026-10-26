import {
    METEORA_DBC_PROGRAM_ID,
    METEORA_DBC_POOL_AUTHORITY,
    METEORA_DBC_CREATE_DISCRIMINATOR,
    METEORA_DBC_CREATE_TOKEN_2022_DISCRIMINATOR
} from '../constants';
import * as snipe from '../common/snipe_common';
import { read_borsh_string } from '../common/struct_decoder';
import { PublicKey } from '@solana/web3.js';

export class Runner extends snipe.SniperBase {
    protected mint_authority = METEORA_DBC_POOL_AUTHORITY;
    protected program_id = METEORA_DBC_PROGRAM_ID;
    protected mint_account_index = 3;

    protected is_create_tx(logs: string[]): boolean {
        return logs.some(
            (log) =>
                log === 'Program log: Instruction: InitializeVirtualPoolWithSplToken' ||
                log === 'Program log: Instruction: InitializeVirtualPoolWithToken2022'
        );
    }

    protected decode_create_instr(
        data: Uint8Array,
        accounts: PublicKey[]
    ): { name: string; symbol: string; misc?: object } | null {
        const prefix = Buffer.from(data.subarray(0, 8));
        const token_2022 = prefix.equals(Buffer.from(METEORA_DBC_CREATE_TOKEN_2022_DISCRIMINATOR));
        if (!token_2022 && !prefix.equals(Buffer.from(METEORA_DBC_CREATE_DISCRIMINATOR))) return null;
        const name = read_borsh_string(data, 8);
        if (!name) return null;
        const symbol = read_borsh_string(data, name[1]);
        if (!symbol) return null;
        if (accounts.length < (token_2022 ? 14 : 16)) return null;
        return {
            name: name[0],
            symbol: symbol[0],
            misc: {
                config: accounts[0].toBase58(),
                quote_mint: accounts[4].toBase58(),
                token_program: accounts[token_2022 ? 10 : 12].toBase58(),
                creator: accounts[2].toBase58(),
                pool: accounts[5].toBase58(),
                base_vault: accounts[6].toBase58(),
                quote_vault: accounts[7].toBase58()
            }
        };
    }
}
