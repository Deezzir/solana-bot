import {
    PUMP_CREATE_V1_DISCRIMINATOR,
    PUMP_CREATE_V2_DISCRIMINATOR,
    PUMP_MINT_AUTHORITY_ACCOUNT,
    PUMP_PROGRAM_ID,
    SOL_MINT
} from '../constants';
import * as snipe from '../common/snipe_common';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../common/token';
import { read_borsh_string } from '../common/struct_decoder';

export class Runner extends snipe.SniperBase {
    protected mint_authority = PUMP_MINT_AUTHORITY_ACCOUNT;
    protected program_id = PUMP_PROGRAM_ID;
    protected mint_account_index = 0;

    protected is_create_tx(logs: string[]): boolean {
        return logs.some((log) => log.includes('Program log: Instruction: Create'));
    }

    protected decode_create_instr(
        data: Uint8Array,
        accounts: PublicKey[]
    ): { name: string; symbol: string; misc?: object } | null {
        const prefix_v1 = Buffer.from(PUMP_CREATE_V1_DISCRIMINATOR);
        const prefix_v2 = Buffer.from(PUMP_CREATE_V2_DISCRIMINATOR);
        const data_prefix = Buffer.from(data.subarray(0, 8));
        if (!data_prefix.equals(prefix_v1) && !data_prefix.equals(prefix_v2)) return null;

        const name = read_borsh_string(data, 8);
        if (!name) return null;
        const symbol = read_borsh_string(data, name[1]);
        if (!symbol) return null;
        const uri = read_borsh_string(data, symbol[1]);
        if (!uri || uri[1] + 32 > data.length) return null;
        let offset = uri[1];
        const creator = new PublicKey(data.subarray(offset, offset + 32));
        offset += 32;

        const is_v2 = data_prefix.equals(prefix_v2);
        if (is_v2 && offset + 2 > data.length) return null;
        if (is_v2 && accounts.length > 16 && accounts.length < 20) return null;
        const quote_mint = is_v2 && accounts.length >= 20 ? accounts[16] : SOL_MINT;
        const creator_fee_bps =
            is_v2 && offset + 10 <= data.length
                ? Number(Buffer.from(data.subarray(offset + 2, offset + 10)).readBigUInt64LE())
                : 0;

        return {
            name: name[0],
            symbol: symbol[0],
            misc: {
                uri: uri[0],
                creator: creator.toBase58(),
                quote_mint: quote_mint.toBase58(),
                is_mayhem: is_v2 && data[offset] === 1,
                is_cashback: is_v2 && data[offset + 1] === 1,
                creator_fee_bps,
                is_holder_reward: is_v2 && data[offset + 10] === 1,
                token_program: (is_v2 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID).toBase58()
            }
        };
    }
}
