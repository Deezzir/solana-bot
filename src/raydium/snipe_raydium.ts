import {
    RAYDIUM_LAUNCHPAD_AUTHORITY,
    RAYDIUM_LAUNCHPAD_CREATE_DISCRIMINATOR,
    RAYDIUM_LAUNCHPAD_PROGRAM_ID
} from '../constants';
import * as snipe from '../common/snipe_common';
import { read_borsh_string } from '../common/struct_decoder';
import { PublicKey } from '@solana/web3.js';

export class RaydiumRunner extends snipe.SniperBase {
    protected mint_authority = RAYDIUM_LAUNCHPAD_AUTHORITY;
    protected program_id = RAYDIUM_LAUNCHPAD_PROGRAM_ID;
    protected mint_account_index = 6;

    protected is_create_tx(logs: string[]): boolean {
        return logs.some((log) => log.includes('Program log: Instruction: InitializeV2'));
    }

    protected decode_create_instr(
        data: Uint8Array,
        accounts: PublicKey[]
    ): { name: string; symbol: string; misc?: object } | null {
        if (!Buffer.from(data.subarray(0, 8)).equals(Buffer.from(RAYDIUM_LAUNCHPAD_CREATE_DISCRIMINATOR))) return null;
        const name = read_borsh_string(data, 9);
        if (!name) return null;
        const symbol = read_borsh_string(data, name[1]);
        if (!symbol) return null;
        const uri = read_borsh_string(data, symbol[1]);
        if (!uri) return null;
        if (accounts.length < 14) return null;
        return {
            name: name[0],
            symbol: symbol[0],
            misc: {
                uri: uri[0],
                token_decimals: data[8],
                global_config: accounts[2].toBase58(),
                quote_mint: accounts[7].toBase58(),
                creator: accounts[1].toBase58(),
                config: accounts[3].toBase58(),
                pool: accounts[5].toBase58(),
                base_vault: accounts[8].toBase58(),
                quote_vault: accounts[9].toBase58(),
                token_program: accounts[11]?.toBase58()
            }
        };
    }
}
