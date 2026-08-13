# Solana Bot

## Quick Start

1. Open the terminal and clone the repo

    ```shell
    git clone https://github.com/Deezzir/solana-bott.git
    ```

2. Install Bun if you haven't already, and install the dependencies

    See the [Bun installation guide](https://bun.sh/docs/installation).

    ```shell
    cd solana-bot && bun install
    ```

3. Create a `.env` file in the root directory and add the following

    ```shell
    HELIUS_API_KEY=
    ```

4. Run the project

    ```shell
    > alias bot="bun run src/bot.js"
    > bot -h
     Solana Bot

    Usage: bot [options] [command]

    Solana Bot CLI

    Options:
      -V, --version                                                  output the version number
      -k, --keys <path>                                              Path to the CSV file with the wallets (default: keys.csv)
      -g, --program <type>                                           specify program (choices: "pump", "meteora", "raydium", "bonk", "jupiter", default: pump)
      --no-colors                                                    Disable colored output
      -h, --help                                                     display help for command

    Commands:
      snipe|sn [options]                                             Start the snipe bot
      volume|v [options]                                             Start the volume bot
      generate|g [options] <file_path>                               Generate the wallets
      balance|b                                                      Get the balance of the wallets
      token-balance|tb <mint>                                        Get the token balance of the wallets
      warmup|w [options]                                             Warmup the wallets with the tokens
      clean|cl                                                       Clean the wallets by closing zero balance token accounts
      claim-rewards [options]                                        Claim trader/dev rewards for the wallets
      token-burn|tburn [options] <mint> <burner_index>               Burn the tokens by mint from a wallet
      collect|c [options] <receiver>                                 Collect all the SOL from the wallets to the provided address
      token-collect|tc [options] <mint> <receiver>                   Collect all tokens by mint from the wallets to the provided address
      fund|f [options] <amount> <sender_index>                       Fund the wallets with SOL using the provided wallet
      token-distribute|td [options] <mint> <percent> <sender_index>  Distribute the token by the mint from the sender to the wallets
      buy-token-once|bto [options] <amount> <mint> <buyer_index>     Buy the token once with the provided amount
      sell-token-once|sto [options] <mint> <seller_index>            Sell the token once with the provided amount
      buy-token|bt [options] <mint>                                  Buy the token by the mint from the wallets
      sell-token|st [options] <mint>                                 Sell all the token by the mint from the wallets
      wallet-pnl|pnl <address>                                       Get the PNL of the wallet
      transfer|tr <amount> <receiver> <sender_index>                 Transfer SOL from the specified wallet to the receiver
      transfer-token|tt <mint> <amount> <receiver> <sender_index>    Transfer the token from the specified wallet to the receiver
      create-metadata|cm <json_path> <image_path>                    Upload the metadata of the token using the provided JSON file and image
      promote|pr <count> <cid> <creator_index>                       Create promotion tokens using the provided wallet
      create-token|ct [options] <cid> <creator_index>                Create a token
      create-lta|clta <authority_index>                              Create a Address Lookup Table Account
      extend-lta|elta <authority_index> <lta> <address_file>         Extend the Address Lookup Table Account
      deactivate-ltas|dltas <authority_index>                        Deactivate the Address Lookup Table Accounts by the provided authority
      close-ltas|cltas <authority_index>                             Close the Address Lookup Table Accounts by the provided authority
      drop|dr [options] <mint> <drop_index>                          Execute token airdrop/presale
      benchmark|bh [options] <requests>                              Benchmark the RPC connection
      convert-key|ck <json_path>                                     Convert the private key from JSON file to base58 string
      help [command]                                                 display help for command
    ```

> ⚠️ Help is available for each command. Use `bot <command> -h` to see the options for that command.

## Snipe config (JSON)

The `snipe` subcommand optionally accepts a JSON config with the following fields:

### Required fields

- `thread_cnt` (`number`) – Number of threads (≤ `keys_cnt`)
- `min_buy` (`number`) – Minimum buy amount in SOL (e.g., 0.1)
- Token must be identified via:
  - `mint` (`string`, valid pubkey) **OR**
  - `token_name` (`string`) **AND** `token_ticker` (`string`)

> ⚠️ `mint` and `token_name/token_ticker` are **mutually exclusive**

### Optional fields

| Field            | Type      | Default               | Notes                                       |
| ---------------- | --------- | --------------------- | ------------------------------------------- |
| `trade_interval` | `number`  | `0`                   | Required if `is_buy_once = false`           |
| `mcap_threshold` | `number`  | `Infinity`            | Must be ≥ `SNIPE_MIN_MCAP`                  |
| `start_interval` | `number`  | `0`                   | Must be ≥ 0                                 |
| `spend_limit`    | `number`  | `Infinity`            | Must be ≥ 0                                 |
| `max_buy`        | `number`  | `Infinity`            | Must be ≥ `min_buy`                         |
| `is_buy_once`    | `boolean` | `false`               | If `true`, `trade_interval` must not be set |
| `sell_slippage`  | `number`  | `SNIPE_SELL_SLIPPAGE` | 0.0 – `TRADE_MAX_SLIPPAGE`                  |
| `buy_slippage`   | `number`  | `SNIPE_BUY_SLIPPAGE`  | 0.0 – `TRADE_MAX_SLIPPAGE`                  |
| `priority_level` | `string`  | `Default`             | See **Priority Levels** below               |
| `protection_tip` | `number`  | `undefined`           | Must be ≥ 0.0                               |

---

### Priority Levels

```ts
export enum PriorityLevel {
    MIN = 'Min',
    LOW = 'Low',
    MEDIUM = 'Medium',
    HIGH = 'High',
    VERY_HIGH = 'VeryHigh',
    UNSAFE_MAX = 'UnsafeMax',
    DEFAULT = 'Default'
}
```

Set `priority_level` to control transaction fees.

---

### Example Config

```json
{
    "thread_cnt": 3,
    "spend_limit": 100,
    "start_buy": 10,
    "mint": "So11111111111111111111111111111111111111112",
    "is_buy_once": false,
    "trade_interval": 5,
    "priority_level": "MEDIUM"
}
```

## Token Metadata Config (JSON)

The `create-metadata` subcommand accepts a JSON config with the following fields:

```json
{
    "name": "string",
    "symbol": "string",
    "description": "string",
    "image": "string | undefined",
    "showName": "boolean | undefined",
    "createdOn": "string | undefined",
    "twitter": "string | undefined",
    "telegram": "string | undefined",
    "website": "string | undefined"
}
```

### Required fields

- `name` (`string`) – Name of the token
- `symbol` (`string`) – Symbol of the token
- `description` (`string`) – Description of the token

> ⚠️ `image` is optional, because it will be uploaded separately using the `create-metadata` command and populated in the metadata JSON file uploaded to IPFS, check the `image_path` argument in the command.
