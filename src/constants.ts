import dotenv from 'dotenv';
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
dotenv.config({ path: './.env', quiet: true });

function get_env_variable(var_name: string, default_value: string = ''): any {
    const variable = process.env[var_name] || default_value;
    if (!variable) {
        console.error(`${var_name} is not set`);
        process.exit(1);
    }
    return variable;
}

// NETWORK CONSTANTS
export const HELIUS_API_KEY = get_env_variable('HELIUS_API_KEY');
export const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
export const RPC_REQUESTS_PER_SECOND = Number(get_env_variable('RPC_REQUESTS_PER_SECOND', '50'));
export const COMMITMENT = 'confirmed';

// COMMANDS CONSTANTS
export const COMMANDS_INTERVAL_MS = 50;
export const COMMANDS_SELL_SLIPPAGE = 0.1;
export const COMMANDS_BUY_SLIPPAGE = 0.05;
export const COMMANDS_DELAY_MS = 100;

// WALLET CONSTANTS
export const WALLETS_FILE = 'keys.csv';
export const WALLETS_RESCUE_DIR_PATH = '.rescue';
export const WALLETS_FILE_HEADERS = ['name', 'private_key', 'is_reserve', 'public_key', 'created_at'];

// IPFS CONSTANTS
export const IPFS = 'https://ipfs.io/ipfs/';
export const IPFS_API = 'https://uploads.pinata.cloud/v3/files';
export const IPFS_JWT = get_env_variable('PINATA_IPFS_JWT');

// TRADE COMMON CONSTANTS
export const TRADE_RAYDIUM_SWAP_TAX = 0.0025; // 0.25%
export const TRADE_TX_RETRIES = 0;
export const TRADE_RETRIES = 5;
export const TRADE_RETRY_INTERVAL_MS = 1000;
export const TRADE_MAX_SLIPPAGE = 5.0;
export const TRADE_DEFAULT_TOKEN_DECIMALS = 6;
export const TRADE_SWAP_SEED = 'swap';
export const TRADE_MAX_WALLETS_PER_CREATE_BUNDLE = 20;
export const TRADE_MAX_WALLETS_PER_CREATE_TX = 5;
export const METAPLEX_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
export const METAPLEX_META_SEED = new Uint8Array([109, 101, 116, 97, 100, 97, 116, 97]);
export const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');
export const COMPUTE_BUDGET_PROGRAM_ID = new PublicKey('ComputeBudget111111111111111111111111111111');
export const RENT_PROGRAM_ID = new PublicKey('SysvarRent111111111111111111111111111111111');
export const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
export const JUPITER_API_URL = 'https://api.jup.ag/swap/v1/';
export const JITO_MIN_TIP = 1000000 / LAMPORTS_PER_SOL;
export const JITO_BUNDLE_SIZE = 5;
export const SENDER_INTERVAL_MS = 1000 / 3;
export const PRIORITY_FEE_TTL_MS = 2000;
export const JITO_BUNDLE_INTERVAL_MS = 1000;
export const JITO_TIP_ACCOUNTS = [
    '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
    'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
    'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
    'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
    'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
    'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
    'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
    '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT'
];
export const SENDER_TIP_ACCOUNTS = [
    '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE',
    'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
    '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta',
    '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn',
    '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD',
    '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ',
    'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF',
    '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT',
    '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey',
    '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or'
];
export const JITO_ENDPOINTS = [
    'https://mainnet.block-engine.jito.wtf/api/v1',
    'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1',
    'https://dublin.mainnet.block-engine.jito.wtf/api/v1',
    'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1',
    'https://london.mainnet.block-engine.jito.wtf/api/v1',
    'https://ny.mainnet.block-engine.jito.wtf/api/v1',
    'https://slc.mainnet.block-engine.jito.wtf/api/v1',
    'https://singapore.mainnet.block-engine.jito.wtf/api/v1',
    'https://tokyo.mainnet.block-engine.jito.wtf/api/v1'
];
export const SENDER_ENDPOINTS = [
    'http://slc-sender.helius-rpc.com/fast',
    'http://ewr-sender.helius-rpc.com/fast',
    'http://lon-sender.helius-rpc.com/fast',
    'http://fra-sender.helius-rpc.com/fast',
    'http://ams-sender.helius-rpc.com/fast',
    'http://sg-sender.helius-rpc.com/fast',
    'http://tyo-sender.helius-rpc.com/fast'
];
export enum PriorityLevel {
    MIN = 'Min',
    LOW = 'Low',
    MEDIUM = 'Medium',
    HIGH = 'High',
    VERY_HIGH = 'VeryHigh',
    UNSAFE_MAX = 'UnsafeMax',
    DEFAULT = 'Default'
}
export const ACCOUNT_SUBSCRIPTION_FLUSH_MS = 50;
export const ACCOUNT_READ_CACHE_TTL_MS = 50;
export const CACHE_SIZE_MAX = 100;

// TRADE RAYDIUM CONSTANTS
export const RAYDIUM_LAUNCHPAD_API_URL = 'https://launch-mint-v1.raydium.io';
export const RAYDIUM_AUTHORITY = new PublicKey('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1');
export const RAYDIUM_AMM4_PROGRAM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
export const RAYDIUM_LAUNCHPAD_PROGRAM_ID = new PublicKey('LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj');
export const RAYDIUM_LAUNCHPAD_AUTHORITY = new PublicKey('WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh');
export const RAYDIUM_LAUNCHPAD_CREATE_DISCRIMINATOR = new Uint8Array([67, 153, 175, 39, 218, 16, 38, 32]);
export const RAYDIUM_LAUNCHPAD_POOL_SEED = new Uint8Array([112, 111, 111, 108]);
export const RAYDIUM_LAUNCHPAD_VAULT_SEED = new Uint8Array([112, 111, 111, 108, 95, 118, 97, 117, 108, 116]);
export const RAYDIUM_LAUNCHPAD_POOL_HEADER = new Uint8Array([247, 237, 227, 245, 215, 195, 222, 70]);
export const RAYDIUM_LAUNCHPAD_EVENT_AUTHORITY = new PublicKey('2DPAtwB8L12vrMRExbLuyGnC7n2J5LNoZQSejeQGpwkr');
export const RAYDIUM_LAUNCHPAD_GLOBAL_CONFIG = new PublicKey('6s1xP3hpbAfFoNtUNF8mfHsjr2Bd97JxFJRWLbL6aHuX');
export const RAYDIUM_LAUNCHPAD_SELL_DISCRIMINATOR = new Uint8Array([149, 39, 222, 155, 211, 124, 152, 26]);
export const RAYDIUM_LAUNCHPAD_BUY_DISCRIMINATOR = new Uint8Array([250, 234, 13, 123, 213, 156, 19, 236]);
export const RAYDIUM_CPMM_PROGRAM_ID = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
export const RAYDIUM_CPMM_POOL_STATE_HEADER = new Uint8Array([247, 237, 227, 245, 215, 195, 222, 70]);
export const RAYDIUM_CPMM_AUTHORITY = new PublicKey('GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL');
export const RAYDIUM_CPMM_CONFIG = new PublicKey('D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2');
export const RAYDIUM_CPMM_SWAP_DISCRIMINATOR = new Uint8Array([143, 190, 90, 218, 196, 30, 51, 222]);
export const RAYDIUM_LTA_ACCOUNT = new PublicKey('DiVZACwhLuhxtVDm7tXqcTBch9WrvUkraHLWwcTPEura');
export const RAYDIUM_LTA_ACCOUNT_EXTRA = new PublicKey('39TSYuyedPtTakGJdUpx7Qp9EHTuA93Yx2vGiRqyuYKD');

// MOON CONSTANTS
export const MOONSHOT_TRADE_PROGRAM_ID = new PublicKey('MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG');

// BONK CONSTANTS
export const BONK_IPFS_META_API_URL = 'https://storage.letsbonk.fun/upload/meta';
export const BONK_IPFS_IMAGE_API_URL = 'https://storage.letsbonk.fun/upload/img';
export const BONK_SWAP_TAX = 0.0125; // 1.25%
export const BONK_CONFIG = new PublicKey('FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1');
export const BONK_CONFIG_2 = new PublicKey('BuM6KDpWiTcxvrpXywWFiw45R2RNH8WURdvqoTDV1BW4');
export const BONK_CONFIG_3 = new PublicKey('8pCtbn9iatQ8493mDQax4xfEUjhoVBpUWYVQoRU18333');

// METEORA CONSTANTS
export const METEORA_DBC_PROGRAM_ID = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN');
export const METEORA_DAMM_V2_PROGRAM_ID = new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');
export const METEORA_DBC_POOL_AUTHORITY = new PublicKey('FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM');
export const METEORA_DBC_EVENT_AUTHORITY = new PublicKey('8Ks12pbrD6PXxfty1hVQiE9sc289zgU1zHkvXhrSdriF');
export const METEORA_LTA_ACCOUNT = new PublicKey('F1geeThcTKPq5nJDpJ9Eh7gk7t4k22PKpcGjbzzPJD14');
export const METEORA_LTA_ACCOUNT_EXTRA = new PublicKey('6WgD151HNpmFfv5Hzf2NsPTVNoSC1JjeMoJ8sEFtpDKh');
export const METEORA_DAMM_V2_STATE_HEADER = new Uint8Array([241, 154, 109, 4, 17, 177, 109, 188]);
export const METEORA_DBC_VAULT_SEED = new Uint8Array([116, 111, 107, 101, 110, 95, 118, 97, 117, 108, 116]);
export const METEORA_DBC_STATE_HEADER = new Uint8Array([213, 224, 5, 209, 98, 69, 119, 92]);
export const METEORA_CONFIG_HEADER = new Uint8Array([26, 108, 14, 123, 116, 230, 129, 43]);
export const METEORA_SWAP_DISCRIMINATOR = new Uint8Array([248, 198, 158, 145, 225, 117, 135, 200]);

// PUMP CONSTANTS
export const PUMP_API_URL = 'https://frontend-api-v3.pump.fun';
export const PUMP_IPFS_API_URL = 'https://frontend-api-v3.pump.fun/ipfs/token-metadata';
export const PUMP_TOKEN_DECIMALS = 6;
export const PUMP_FEE_PERCENTAGE = 0.0125; // 1.25%
export const PUMP_SWAP_PERCENTAGE = 0.0125; // 1.25%
export const PUMP_LTA_ACCOUNT_EXTRA = new PublicKey('FNbKyKh4LjC1kSmhMahZ2gJPwt1anynVUdaCNmmuxzac');
export const PUMP_LTA_ACCOUNT = new PublicKey('J5edBug5X1G1PoUgtnBjNUpcrhpeJiRKy7TWqs5Yvuk3');
export const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
export const PUMP_FEE_PROGRAM_ID = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
export const PUMP_FEE_CONFIG = new PublicKey('8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt');
export const PUMP_AMM_FEE_CONFIG = new PublicKey('5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx');
export const PUMP_GLOBAL_ACCOUNT = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
export const PUMP_FEE_ACCOUNT = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM');
export const PUMP_EVENT_AUTHORITY_ACCOUNT = new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');
export const PUMP_MINT_AUTHORITY_ACCOUNT = new PublicKey('TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM');
export const PUMP_AMM_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
export const PUMP_AMM_GLOBAL_ACCOUNT = new PublicKey('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw');
export const PUMP_AMM_EVENT_AUTHORITY_ACCOUNT = new PublicKey('GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR');
export const PUMP_AMM_FEE_ACCOUNT = new PublicKey('62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV');
export const PUMP_AMM_FEE_TOKEN_ACCOUNT = new PublicKey('94qWNrtmfn42h3ZjUZwWvK1MEo9uVmmrBPd2hpNjYDjb');
export const PUMP_GLOBAL_VOLUME_ACCUMULATOR = new PublicKey('Hq2wp8uJ9jCPsYgNHex8RtqdvMPfVGoYwjvF1ATiwn2Y');
export const PUMP_AMM_GLOBAL_VOLUME_ACCUMULATOR = new PublicKey('C2aFPdENg4A2HQsmrd5rTw5TaYBX5Ku887cWjbFKtZpw');
export const PUMP_COLLECT_CREATOR_FEE_DISCRIMINATOR = new Uint8Array([20, 22, 86, 123, 198, 28, 219, 132]);
export const PUMP_AMM_COLLECT_CREATOR_FEE_DISCRIMINATOR = new Uint8Array([160, 57, 89, 42, 181, 139, 43, 66]);
export const PUMP_STATE_HEADER = new Uint8Array([23, 183, 248, 55, 96, 216, 172, 96]);
export const PUMP_AMM_STATE_HEADER = new Uint8Array([241, 154, 109, 4, 17, 177, 109, 188]);
export const PUMP_BONDING_SEED = new Uint8Array([98, 111, 110, 100, 105, 110, 103, 45, 99, 117, 114, 118, 101]);
export const PUMP_BONDING_SEED_2 = new Uint8Array([
    98, 111, 110, 100, 105, 110, 103, 45, 99, 117, 114, 118, 101, 45, 118, 50
]);
export const PUMP_CREATOR_VAULT_SEED = new Uint8Array([99, 114, 101, 97, 116, 111, 114, 45, 118, 97, 117, 108, 116]);
export const PUMP_USER_VOLUME_ACCUMULATOR_SEED = new Uint8Array([
    117, 115, 101, 114, 95, 118, 111, 108, 117, 109, 101, 95, 97, 99, 99, 117, 109, 117, 108, 97, 116, 111, 114
]);
export const PUMP_POOL_AUTHORITY_SEED = new Uint8Array([
    112, 111, 111, 108, 45, 97, 117, 116, 104, 111, 114, 105, 116, 121
]);
export const PUMP_AMM_POOL_SEED = new Uint8Array([112, 111, 111, 108]);
export const PUMP_AMM_POOL_SEED_2 = new Uint8Array([112, 111, 111, 108, 45, 118, 50]);
export const PUMP_AMM_CREATOR_VAULT_SEED = new Uint8Array([
    99, 114, 101, 97, 116, 111, 114, 95, 118, 97, 117, 108, 116
]);
export const PUMP_BUY_DISCRIMINATOR = new Uint8Array([102, 6, 61, 18, 1, 218, 235, 234]);
export const PUMP_SELL_DISCRIMINATOR = new Uint8Array([51, 230, 133, 164, 1, 127, 131, 173]);
export const PUMP_CREATE_V1_DISCRIMINATOR = new Uint8Array([24, 30, 200, 40, 5, 28, 7, 119]);
export const PUMP_CREATE_V2_DISCRIMINATOR = new Uint8Array([214, 144, 76, 236, 95, 139, 49, 180]);
export const PUMP_EXTEND_DISCRIMINATOR = new Uint8Array([234, 102, 194, 203, 150, 72, 62, 229]);
export const MAYHEM_PROGRAM_ID = new PublicKey('MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e');
export const MAYHEM_FEE_ACCOUNT = new PublicKey('GesfTA3X2arioaHp8bbKdjG9vJtskViWACZoYvxp4twS');
export const MAYHEM_GLOBAL_ACCOUNT = new PublicKey('13ec7XdrjF3h3YcqBTFDSReRcUFwbCnJaAQspM4j6DDJ');
export const MAYHEM_SOL_VAULT = new PublicKey('BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s');
export const MAYHEM_FEE_TOKEN_ACCOUNT = new PublicKey('C93K8DX4YsABYJtHX9awzgZW3LWzBqBVezEbbLJH4yet');
export const MAYHEM_STATE_SEED = new Uint8Array([109, 97, 121, 104, 101, 109, 45, 115, 116, 97, 116, 101]);

// SNIPE CONSTANTS
export const SNIPE_BUY_SLIPPAGE = 0.85;
export const SNIPE_SELL_SLIPPAGE = 0.5;
export const SNIPE_MIN_BUY_THRESHOLD = 0.00001;
export const SNIPE_MIN_BUY = 0.005;
export const SNIPE_TRADE_BATCH = 1;
export const SNIPE_META_POLL_INTERVAL_MS = 1000;
export const SNIPE_MIN_MCAP = 5000;
export const SNIPE_RETRIES = 5;
export const SNIPE_RETRY_INTERVAL_MS = 100;

// TRANSFER CONSTANTS
export const TRANSFER_INTERVAL_MS: number = 1000;
export const TRANSFER_MAX_DEPTH: number = 23;
export const TRANSFER_MAX_WALLETS_PER_TX: number = 7;

// DROP CONSTANTS
export const DROP_RECORDS_PER_ITERATION = 10;
export const DROP_AIRDROP_CSV = 'airdropusers.csv';
export const DROP_PRESALE_CSV = 'presaleusers.csv';

// VOLUME CONSTANTS
export const VOLUME_MAX_WALLETS_PER_EXEC = 20;
export const VOLUME_TRADE_SLIPPAGE = 0.9;
export const VOLUME_MAX_WALLETS_PER_TRADE_BUNDLE = 10;
export const VOLUME_MAX_WALLETS_PER_TRADE_TX = 2;
export const VOLUME_MAX_WALLETS_PER_COLLECT_TX = 10;
export const VOLUME_MAX_WALLETS_PER_FUND_TX = 20;

// WALLET PNL CONSTANTS
export const PNL_BATCH_SIZE = 50;
export const PNL_BATCH_DELAY_MS = 0;
