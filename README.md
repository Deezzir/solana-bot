# Solana Bot

[![npm version](https://img.shields.io/npm/v/solana-bot)](https://www.npmjs.com/package/solana-bot)

CLI for token trading, creation, sniping, volume, wallet transfers and reward claims. Program providers support Pump, Meteora DBC/DAMM v2, Raydium LaunchLab/CPMM, Bonk and Jupiter. Available operations depend on the selected provider.

## Quick Start

1. Open the terminal and clone the repo

    ```shell
    git clone https://github.com/Deezzir/solana-bot.git
    ```

2. Install Bun if you haven't already, and install the dependencies

    See the [Bun installation guide](https://bun.sh/docs/installation).

    ```shell
    cd solana-bot && bun install
    ```

3. Create a `.env` file in the root directory and add the following

    ```shell
    HELIUS_API_KEY=
    PINATA_IPFS_JWT=
    # Required for Jupiter trades and SOL-to-quote valuation/funding:
    JUPITER_API_KEY=
    ```

4. Run the project

    ```shell
    > alias bot="bun run src/bot.ts"
    > bot -h
    Solana Bot

    Usage: bot [options] [command]

    Solana Bot CLI

    Options:
      -v, --version                                                  output the version number
      -k, --keys <path>                                              Path to the CSV file with the wallets (default: keys.csv)
      -g, --program <type>                                           specify program (choices: "pump", "meteora", "raydium", "bonk", "jupiter", default: pump)
      -rl, --relay <provider>                                        transaction relay (choices: "sender", "jito", default: sender)
      --no-colors                                                    Disable colored output
      --v1                                                           Use v1 transactions; require verified cluster activation
      --funding                                                      Enable quote-token funding and SOL conversion
      -h, --help                                                     display help for command

    Commands:
      snipe|sn [options]                                             Start the snipe bot
      volume|v [options]                                             Start the volume bot
      generate|g [options] <file_path>                               Generate the wallets
      balance|b [options]                                            Get the balance of the wallets
      token-balance|tb [options] <mint>                              Get the token balance of the wallets
      warmup|w [options]                                             Warmup the wallets with the tokens
      clean|cl [options]                                             Clean the wallets by closing zero balance token accounts
      claim-rewards|cf [options]                                     Claim trader/dev rewards for the wallets
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
      get-sender-endpoint|gse                                        Find the Sender endpoint with the lowest latency
      convert-key|ck <json_path>                                     Convert the private key from JSON file to base58 string
      help [command]                                                 display help for command
    ```

> ⚠️ Help is available for each command. Use `bot <command> -h` to see the options for that command.

## Run with bunx

Bun can install and run the CLI without cloning the repository:

```shell
bunx solana-bot balance
bunx solana-bot generate keys.csv --help
bunx solana-bot --version
```

Run from the directory containing your `.env` and wallet CSV. The installed npm release may lag changes on feature branches.

## Wallets

Generate a wallet CSV with `bot generate keys.csv --help`, or use `--keys <path>` to select an existing file. Its columns are:

```csv
name,private_key,is_reserve,public_key,created_at
```

Private keys are base58-encoded secret keys, and each public key must match its private key. A reserve wallet is selected with `is_reserve=true`; commands identify wallets by their loaded numeric indices. Recovery wallets generated by funding and volume operations are saved under `.rescue/`.

## Quote tokens and funding

Buy amounts, including creator and initial-buyer amounts, are expressed as **SOL-denominated budgets**. Providers build trades in the pool's actual quote-token units. The quote mint is resolved from pool metadata; Jupiter is used to value non-SOL buy budgets even when funding is disabled.

- **Default (funding disabled):** non-SOL buys spend quote tokens already held by the wallet. Sells return the pool's quote token.
- **`--funding`:** buys use existing quote tokens first and swap SOL through Jupiter to cover a shortfall. Non-SOL sells convert a conservative minimum of their quote proceeds back to SOL. Quote-token leftovers may remain in the wallet.
- Keep SOL available for network fees, tips and account rent. Slippage and exact-output buy limits also affect the amount required.

```shell
bot --program pump --funding buy-token-once 0.1 <TOKEN_MINT> 1
bot --program raydium --funding sell-token-once <TOKEN_MINT> 1
```

Funding and the corresponding trade execute atomically. With a protection tip, a funded single-wallet trade uses a bundle; otherwise, funding and trade must fit in one transaction. Oversized combinations require prefunding or a bundle-capable command. Bundle capacity counts transactions, including funding/conversion, rather than wallets.

The sniper uses its own `funding` config field, described below. Set it in the sniper config or interactive prompt rather than relying on the global flag.

CLI `--slippage` is a percentage (`5` means 5%); JSON sniper slippage fields are fractions (`0.05` means 5%).

## Transaction relays

Protected transactions and bundles use Sender by default. Select Jito with `--relay jito`. The current bundle limits are four transactions for Sender and five for Jito; the configured minimum tip is 0.001 SOL. MEV protection requires a protection tip. See each command's help for `--bundle`, `--protection-tip` and `--mev` support.

## Transaction versions

Outbound transactions default to **v0**. Add the global `--v1` option to select v1 for the command, including its workers, retries, bundles, transfers, and account cleanup:

```shell
bot --v1 clean
bot --v1 --program pump snipe --help
```

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
| `mcap_threshold` | `number`  | `Infinity`            | USD market cap; must be ≥ `SNIPE_MIN_MCAP` |
| `start_interval` | `number`  | `0`                   | Must be ≥ 0                                 |
| `spend_limit`    | `number`  | `Infinity`            | SOL-denominated; must be ≥ `min_buy`       |
| `max_buy`        | `number`  | `min_buy`             | Must be ≥ `min_buy`                         |
| `is_buy_once`    | `boolean` | `false`               | If `true`, `trade_interval` must not be set |
| `sell_slippage`  | `number`  | `SNIPE_SELL_SLIPPAGE` | 0.0 – `TRADE_MAX_SLIPPAGE`                  |
| `buy_slippage`   | `number`  | `SNIPE_BUY_SLIPPAGE`  | 0.0 – `TRADE_MAX_SLIPPAGE`                  |
| `priority_level` | `string`  | `Default`             | See **Priority Levels** below               |
| `protection_tip` | `number`  | `undefined`           | Must be ≥ 0.0                               |
| `mev_protect`    | `boolean` | `false`               | Requires a positive protection tip         |
| `funding`        | `boolean` | `false`               | Fund quote shortfalls and convert sell proceeds to SOL |

The initial snipe attempt prioritizes latency and may use SOL-default metadata. For a non-SOL quote it can fail until asynchronous metadata refresh resolves the actual pool.

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
    "min_buy": 0.01,
    "max_buy": 0.02,
    "start_interval": 10,
    "mint": "<TOKEN_MINT>",
    "is_buy_once": false,
    "trade_interval": 5,
    "priority_level": "Medium",
    "funding": true
}
```

## Volume config (JSON)

The `volume` subcommand optionally accepts a JSON config with the following fields:

- `Fast` – Generates and funds new wallets each execution for atomic buy/sell cycles.
- `Bump` – Generates and funds one wallet, then reuses it for atomic buy/sell cycles.
- `Natural` – Uses existing non-reserve wallets from `keys.csv` (or `--keys`), with separate buys and delayed sells.

Fast and Bump require a reserve wallet. Natural uses existing balances without funding or collecting wallets.

For non-SOL pools, Fast/Bump's newly generated wallets need `--funding` to acquire the quote token. Natural can use prefunded quote tokens or `--funding`. Each atomic wallet cycle stays within one bundle; a cycle that cannot fit is rejected. Final collection moves SOL, so residual quote tokens may require a separate token collection. Cost estimates do not guarantee recovery of all funds as SOL.

### Required fields

- `mint` (`string`, valid pubkey) – Token mint address
- `executions` (`number`) – Positive integer; execution count for Fast, bump count for Bump, buy-round count for Natural
- `min_sol_amount` (`number`) – Minimum SOL amount (> 0)
- `max_sol_amount` (`number`) – Maximum SOL amount (≥ `min_sol_amount`)
- `bundle_tip` (`number`) – **Fast/Bump only**; tip in SOL, currently ≥ 0.001. Omit for Natural

SOL amounts are per-wallet funding budgets for Fast and buy amounts for Bump/Natural. Set equal bounds for a fixed amount.

### Optional fields

| Field        | Type     | Default                | Notes                                                                    |
| ------------ | -------- | ---------------------- | ------------------------------------------------------------------------ |
| `type`       | `string` | `Fast`                 | `Fast`, `Bump`, or `Natural`                                              |
| `wallet_cnt` | `number` | `1`; `3` for Natural   | Integer 1–20; Fast: count per execution; Natural: subset cap; Bump: 1      |
| `delay`      | `number` | `0`; `5` for Natural   | Base delay in seconds; ≥ 0, strictly > 0 for Natural                       |
| `hold_min`   | `number` | `15`                   | Natural only; minimum holding time in seconds (> 0)                       |
| `hold_max`   | `number` | `60`                   | Natural only; maximum holding time in seconds (≥ `hold_min`)              |

### Example Config

```json
{
    "type": "Natural",
    "mint": "<TOKEN_MINT>",
    "wallet_cnt": 3,
    "min_sol_amount": 0.01,
    "max_sol_amount": 0.05,
    "executions": 20,
    "delay": 5,
    "hold_min": 15,
    "hold_max": 60
}
```

## Token creation

Upload metadata first with `create-metadata`, then pass the resulting CID to `create-token`. Pump, Meteora, Raydium and Bonk support creation; Jupiter does not. Creator and additional-wallet buy amounts remain SOL-denominated, including for non-SOL quote pools.

```shell
bot --program pump --funding create-token <CID> 0 --amount 0.1 --config create.json
```

`--config` accepts provider-specific JSON:

| Provider | Fields |
| --- | --- |
| Pump | `version` (`1` or `2`, default `2`), `is_mayhem`, `is_cashback`, `quote_mint` (mint address, default SOL). Non-SOL quotes require v2 without mayhem and must be allowed by Pump's on-chain quote configuration. |
| Meteora | `config` (DBC config account address, required). The quote mint and token programs come from that account; creation requires DAMM v2 migration and a linear or exponential fee scheduler. |
| Raydium / Bonk | `global_config`, `quote_mint`, `fundraising`. Non-SOL creation requires `fundraising` as a raw quote-unit integer string. If provided, the quote mint must match the global config. |

For example, a Pump USDC creation config:

```json
{
    "version": 2,
    "quote_mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "is_cashback": true
}
```

For additional initial buyers, select wallets with `--from`/`--to` or `--list`, provide `--min` and `--max` buy amounts, and set `--bundle <tip>`. Creation, creator buy and initial buys must fit in one atomic bundle, including quote-funding transactions. Without additional buyers, creation and the optional creator buy use one transaction.

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
