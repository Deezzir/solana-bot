import { METEORA_DBC_PROGRAM_ID, METEORA_DBC_POOL_AUTHORITY, METEORA_DBC_CREATE_DISCRIMINATOR } from '../constants';
import * as snipe from '../common/snipe_common';
import { read_borsh_string } from '../common/struct_decoder';

export class Runner extends snipe.SniperBase {
    protected mint_authority = METEORA_DBC_POOL_AUTHORITY;
    protected program_id = METEORA_DBC_PROGRAM_ID;
    protected mint_account_index = 3;

    protected is_create_tx(logs: string[]): boolean {
        return logs.some((log) => log.includes('Program log: Instruction: InitializeVirtualPoolWithSplToken'));
    }

    protected decode_create_instr(data: Uint8Array): { name: string; symbol: string; misc?: object } | null {
        const prefix = Buffer.from(METEORA_DBC_CREATE_DISCRIMINATOR);
        if (!Buffer.from(data.subarray(0, 8)).equals(prefix)) return null;
        const name = read_borsh_string(data, 8);
        if (!name) return null;
        const symbol = read_borsh_string(data, name[1]);
        if (!symbol) return null;
        return { name: name[0], symbol: symbol[0] };
    }
}
