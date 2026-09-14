import { PublicKey } from '@solana/web3.js';
import * as common from '../common/common';
import * as trade from '../common/trade_common';
import {
    BONK_CONFIG,
    BONK_CONFIG_2,
    BONK_CONFIG_3,
    BONK_DEFAULT_MINT_META,
    BONK_IPFS_IMAGE_API_URL,
    BONK_IPFS_META_API_URL,
    RAYDIUM_LAUNCHPAD_API_URL,
    PROGRAM_COMPUTE_UNIT_LIMITS
} from '../constants';
import { RaydiumMintMeta, RaydiumProvider } from '../raydium/trade_raydium';
import { readFileSync } from 'fs';
import { basename } from 'path';

const BONK_COMPUTE_UNIT_LIMIT = PROGRAM_COMPUTE_UNIT_LIMITS[common.Program.Bonk];

export class BonkProvider extends RaydiumProvider {
    protected override readonly compute_unit_limit = BONK_COMPUTE_UNIT_LIMIT;
    protected override readonly mint_meta_defaults = BONK_DEFAULT_MINT_META;

    public override get_name(): string {
        return common.Program.Bonk;
    }

    protected override get_create_platform(): PublicKey {
        return BONK_CONFIG;
    }

    public override async get_random_mints(count: number): Promise<RaydiumMintMeta[]> {
        if (!Number.isSafeInteger(count) || count <= 0) return [];
        const url = new URL(`${RAYDIUM_LAUNCHPAD_API_URL}/get/list`);
        url.searchParams.set('sort', 'new');
        url.searchParams.set('size', String(Math.min(100, Math.max(20, count * 3))));
        url.searchParams.set('mintType', 'default');
        url.searchParams.set(
            'platformId',
            [BONK_CONFIG_2, BONK_CONFIG_3, BONK_CONFIG].map((config) => config.toBase58()).join(',')
        );
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
            const data = await response.json();
            if (!response.ok || !data?.success || !Array.isArray(data.data?.rows))
                throw new Error('Bonk mint discovery failed.');
            return trade.resolve_random_mints(
                data.data.rows.map((row: { mint: string }) => row.mint),
                count,
                (mint) => this.get_mint_meta(mint)
            );
        } catch (error) {
            common.error(common.red(`Failed fetching the mints: ${error}`));
            return [];
        }
    }

    public override async create_token_metadata(meta: common.IPFSMetadata, image_path: string): Promise<string> {
        const image = new File([readFileSync(image_path)], basename(image_path), { type: 'image/png' });
        const form = new FormData();
        form.append('image', image);
        const image_response = await fetch(BONK_IPFS_IMAGE_API_URL, { method: 'POST', body: form });
        if (!image_response.ok) throw new Error(`HTTP error! status: ${image_response.status}`);
        meta.image = await image_response.text();
        const meta_response = await fetch(BONK_IPFS_META_API_URL, {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify(meta)
        });
        if (!meta_response.ok) throw new Error(`HTTP error! status: ${meta_response.status}`);
        return (await meta_response.text()).split('/').slice(-1)[0];
    }
}
