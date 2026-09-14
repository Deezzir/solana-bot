import { afterAll, afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { Keypair, PublicKey, type AccountInfo, type Connection } from '@solana/web3.js';

const original_env = { HELIUS_API_KEY: process.env.HELIUS_API_KEY, PINATA_IPFS_JWT: process.env.PINATA_IPFS_JWT };
for (const name of Object.keys(original_env)) process.env[name] ||= 'unit-test';
const { Provider } = await import('../src/pump/trade_pump');
const trade = await import('../src/common/trade_common');
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } = await import('../src/common/token');
const {
    PUMP_PROGRAM_ID,
    PUMP_AMM_PROGRAM_ID,
    PUMP_EVENT_AUTHORITY_ACCOUNT,
    PUMP_AMM_EVENT_AUTHORITY_ACCOUNT,
    SOL_MINT,
    SYSTEM_PROGRAM_ID
} = await import('../src/constants');

type Reward = Awaited<ReturnType<InstanceType<typeof Provider>['get_rewards']>>[number];
const wallet = await Keypair.fromSeed(new Uint8Array(32).fill(60));
const legacy_mint = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const extension_mint = new PublicKey(new Uint8Array(32).fill(61));
const provider = new Provider();
const original_connection = global.CONNECTION;
const [creator_vault] = await PublicKey.findProgramAddress(
    [Buffer.from('creator-vault'), wallet.publicKey.toBytes()],
    PUMP_PROGRAM_ID
);
const accumulators = await Promise.all(
    [PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID].map(
        async (program) =>
            (
                await PublicKey.findProgramAddress(
                    [Buffer.from('user_volume_accumulator'), wallet.publicKey.toBytes()],
                    program
                )
            )[0]
    )
);

function account(data: Buffer, owner: PublicKey): AccountInfo<Buffer> {
    return { data, owner, executable: false, lamports: 0n, rentEpoch: 0n };
}

async function token_account(vault: PublicKey, mint: PublicKey, program: PublicKey, amount = 111n) {
    const data = Buffer.alloc(165);
    Buffer.from(mint.toBytes()).copy(data, 0);
    Buffer.from(vault.toBytes()).copy(data, 32);
    data.writeBigUInt64LE(amount, 64);
    data[108] = 1;
    return { pubkey: await trade.calc_ata(vault, mint, program), account: account(data, program) };
}

async function install_rewards(invalid_accumulator = false) {
    const mint_data = Buffer.alloc(82);
    mint_data[44] = 8;
    mint_data[45] = 1;
    // Shared Pump/AMM prefix ends at total_cashback_claimed, without stable counters.
    const accumulator_data = Buffer.alloc(90);
    Buffer.from([86, 255, 112, 14, 102, 53, 154, 250]).copy(accumulator_data);
    Buffer.from(wallet.publicKey.toBytes()).copy(accumulator_data, 8);
    accumulator_data.writeBigUInt64LE(9n, 74);
    accumulator_data.writeBigUInt64LE(4n, 82);
    const owners: PublicKey[] = [];
    global.CONNECTION = {
        getMinimumBalanceForRentExemption: async () => 0n,
        getAccountInfo: async (key: PublicKey) => {
            if (key.equals(extension_mint)) return account(mint_data, TOKEN_2022_PROGRAM_ID);
            const index = accumulators.findIndex((accumulator) => accumulator.equals(key));
            if (index < 0) return null;
            return account(
                accumulator_data,
                invalid_accumulator ? SYSTEM_PROGRAM_ID : [PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID][index]!
            );
        },
        getTokenAccountsByOwner: async (owner: PublicKey, { programId }: { programId: PublicKey }) => {
            owners.push(owner);
            const mint = programId.equals(TOKEN_PROGRAM_ID) ? legacy_mint : extension_mint;
            const valid = await token_account(owner, mint, programId);
            const empty = await token_account(owner, mint, programId, 0n);
            const noncanonical = { ...valid, pubkey: PublicKey.default };
            const wrong_owner = await token_account(wallet.publicKey, mint, programId);
            const sol = await token_account(owner, SOL_MINT, programId);
            return { context: { slot: 1 }, value: [valid, empty, noncanonical, wrong_owner, sol] };
        }
    } as unknown as Connection;
    spyOn(trade, 'get_program_accounts_v2').mockResolvedValue([]);
    return owners;
}

afterEach(() => {
    mock.restore();
    if (original_connection === undefined) delete (global as { CONNECTION?: Connection }).CONNECTION;
    else global.CONNECTION = original_connection;
});
afterAll(() => {
    for (const [name, value] of Object.entries(original_env)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
});

describe('Pump quote reward discovery', () => {
    test('discovers both token programs from canonical vault ATAs and accepts short AMM accumulators', async () => {
        const owners = await install_rewards();
        const assets = await provider.get_rewards(wallet);
        const non_sol = assets.filter((asset) => !asset.mint.equals(SOL_MINT));
        expect(non_sol).toHaveLength(6);
        for (const vault of [creator_vault, ...accumulators]) {
            expect(owners.filter((owner) => owner.equals(vault))).toHaveLength(2);
            const rewards = non_sol.filter((asset) => asset.vault.equals(vault));
            expect(
                rewards.map((asset) => [asset.mint, asset.raw_amount, asset.decimals, asset.quote_token_program])
            ).toEqual([
                [legacy_mint, 111n, 6, TOKEN_PROGRAM_ID],
                [extension_mint, 111n, 8, TOKEN_2022_PROGRAM_ID]
            ]);
        }
        expect(assets.filter((asset) => asset.mint.equals(SOL_MINT)).map((asset) => asset.raw_amount)).toEqual([
            5n,
            5n
        ]);
    });

    test('ignores accumulators owned by an unrelated program', async () => {
        await install_rewards(true);
        const assets = await provider.get_rewards(wallet);
        expect(assets).toHaveLength(2);
        expect(assets.every((asset) => asset.source === 'creator_reward')).toBeTrue();
    });
});

describe('Pump quote reward claims', () => {
    test.each([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID])(
        'builds bonding creator v2 claims with quote program %s',
        async (program) => {
            await install_rewards();
            const mint = program.equals(TOKEN_PROGRAM_ID) ? legacy_mint : extension_mint;
            const asset: Reward = {
                mint,
                raw_amount: 111n,
                decimals: 6,
                source: 'creator_reward',
                vault: creator_vault,
                vault_ata: await trade.calc_ata(creator_vault, mint, program),
                curve: 'v1',
                quote_token_program: program
            };
            const instructions = await provider.claim_rewards_instructions(wallet, [asset]);
            expect(instructions).toHaveLength(2);
            expect(instructions[0]!.programId).toEqual(ASSOCIATED_TOKEN_PROGRAM_ID);
            expect([...instructions[0]!.data]).toEqual([1]);
            const claim = instructions[1]!;
            expect([...claim.data]).toEqual([207, 17, 138, 242, 4, 34, 19, 56]);
            expect(claim.programId).toEqual(PUMP_PROGRAM_ID);
            expect(claim.keys.map((key) => key.pubkey)).toEqual([
                wallet.publicKey,
                await trade.calc_ata(wallet.publicKey, mint, program),
                creator_vault,
                asset.vault_ata,
                mint,
                program,
                ASSOCIATED_TOKEN_PROGRAM_ID,
                SYSTEM_PROGRAM_ID,
                PUMP_EVENT_AUTHORITY_ACCOUNT,
                PUMP_PROGRAM_ID
            ]);
            expect(claim.keys.map((key) => key.isWritable)).toEqual([
                true,
                true,
                true,
                true,
                false,
                false,
                false,
                false,
                false,
                false
            ]);
            expect(claim.keys.every((key) => !key.isSigner)).toBeTrue();
        }
    );

    test.each([
        [PUMP_PROGRAM_ID, TOKEN_PROGRAM_ID],
        [PUMP_PROGRAM_ID, TOKEN_2022_PROGRAM_ID],
        [PUMP_AMM_PROGRAM_ID, TOKEN_PROGRAM_ID],
        [PUMP_AMM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]
    ])('builds quote cashback for program %s with token program %s', async (program, token_program) => {
        await install_rewards();
        const bonding = program.equals(PUMP_PROGRAM_ID);
        const mint = token_program.equals(TOKEN_PROGRAM_ID) ? legacy_mint : extension_mint;
        const accumulator = accumulators[bonding ? 0 : 1]!;
        const vault_ata = await trade.calc_ata(accumulator, mint, token_program);
        const asset: Reward = {
            mint,
            raw_amount: 111n,
            decimals: 6,
            source: 'cashback_reward',
            vault: accumulator,
            vault_ata,
            curve: bonding ? 'v1' : 'v2',
            claim: 'cashback',
            program,
            accumulator
        };
        const instructions = await provider.claim_rewards_instructions(wallet, [asset]);
        expect(instructions).toHaveLength(3);
        expect(instructions.slice(0, 2).map((ix) => [...ix.data])).toEqual([[1], [1]]);
        const claim = instructions[2]!;
        expect(claim.programId).toEqual(program);
        expect([...claim.data]).toEqual(
            bonding ? [122, 243, 204, 65, 94, 116, 29, 55] : [37, 58, 35, 126, 190, 53, 228, 197]
        );
        expect(claim.keys.map((key) => key.pubkey)).toEqual([
            wallet.publicKey,
            accumulator,
            mint,
            token_program,
            ...(bonding ? [ASSOCIATED_TOKEN_PROGRAM_ID] : []),
            vault_ata,
            await trade.calc_ata(wallet.publicKey, mint, token_program),
            SYSTEM_PROGRAM_ID,
            bonding ? PUMP_EVENT_AUTHORITY_ACCOUNT : PUMP_AMM_EVENT_AUTHORITY_ACCOUNT,
            program
        ]);
    });

    test('unwraps SOL AMM cashback but keeps non-SOL ATAs open', async () => {
        await install_rewards();
        const assets = await provider.get_rewards(wallet);
        const sol_cashback = assets.find(
            (asset) => asset.mint.equals(SOL_MINT) && asset.program?.equals(PUMP_AMM_PROGRAM_ID)
        )!;
        const instructions = await provider.claim_rewards_instructions(wallet, [sol_cashback]);
        expect(instructions).toHaveLength(4);
        expect(instructions[3]!.programId).toEqual(TOKEN_PROGRAM_ID);
        expect([...instructions[3]!.data]).toEqual([9]);
    });
});
