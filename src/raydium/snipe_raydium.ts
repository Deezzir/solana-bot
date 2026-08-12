import {
    RAYDIUM_LAUNCHPAD_AUTHORITY,
    RAYDIUM_LAUNCHPAD_CREATE_DISCRIMINATOR,
    RAYDIUM_LAUNCHPAD_PROGRAM_ID
} from '../constants';
import * as snipe from '../common/snipe_common';
import { read_borsh_string } from '../common/struct_decoder';

export class RaydiumRunner extends snipe.SniperBase {
    protected mint_authority = RAYDIUM_LAUNCHPAD_AUTHORITY;
    protected program_id = RAYDIUM_LAUNCHPAD_PROGRAM_ID;

    protected is_create_tx(logs: string[]): boolean {
        return logs.some((log) => log.includes('Program log: Instruction: InitializeV2'));
    }

    protected decode_create_instr(data: Uint8Array): { name: string; symbol: string; misc?: object } | null {
        if (!Buffer.from(data.subarray(0, 8)).equals(Buffer.from(RAYDIUM_LAUNCHPAD_CREATE_DISCRIMINATOR))) return null;
        const name = read_borsh_string(data, 9);
        if (!name) return null;
        const symbol = read_borsh_string(data, name[1]);
        if (!symbol) return null;
        const uri = read_borsh_string(data, symbol[1]);
        if (!uri) return null;
        return { name: name[0], symbol: symbol[0], misc: { uri: uri[0], decimals: data[8] } };
    }
}
