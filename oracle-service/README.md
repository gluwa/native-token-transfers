# ntt-oracle-service

Off-chain oracle that pushes ATTEST/native pricing to `PenguinBridgeExecutionQuoter`. It is the **sole writer** of on-chain prices — the contract gates `priceUpdate` / `batchPriceUpdate` behind `onlyOracleService`, and this service's signing key is that `oracleService`.

## What it does

Every `ORACLE_PUSH_INTERVAL_MS` it runs one tick:

1. **Detects the active pricing mode** from the contract's `pricingMode()` getter (falls back to `ORACLE_PRICING_MODE` for deployments that predate [SMC-1681](https://gluwa.atlassian.net/browse/SMC-1681)). Detection happens every tick because the owner can toggle modes on-chain at any time.
2. Fetches USD spot prices from **CoinGecko** (`/simple/price`) for the active mode's source token and every configured destination chain's native token, in a single request.
3. Feeds each price into a rolling **time-weighted average** over `ORACLE_TWAP_WINDOW_MS` (the "TWAP pricing data" shared by both modes; falls back to spot until the window fills). Each sample is weighted by the interval it closes, so a fresh fetch influences the push immediately.
4. Reads current gas price from each destination chain's RPC.
5. Writes `sourcePrice` + per-chain `PricingData {dstPrice, dstGasPrice, priceBuffer, baseFee}` in one `batchPriceUpdate` transaction. The receipt wait is bounded by `ORACLE_TX_WAIT_TIMEOUT_MS` so a stuck transaction can't hang the loop.

If any required price or gas read fails, the **whole tick is skipped** (logged) — the contract keeps its previous values rather than receiving partial/stale data.

### Pricing modes

The contract prices execution in the source-chain native token, **ATTEST**. `sourcePrice` is the USD price of ATTEST scaled by 1e10. The active mode selects which token's USD price is written there:

- **`twap`** — push **ATTEST/USD** (ATTEST has a direct USD market).
- **`penguinswap`** — push **CTC/USD**; the contract derives ATTEST via the on-chain ATTEST/CTC PenguinSwap pool (see SMC-1681). Used at launch when ATTEST only trades against CTC.

Both modes also push each destination chain's native-token USD price as `dstPrice`.

**Mode detection.** The service reads the contract's active mode each tick via `pricingMode() view returns (uint8)` (`0` = twap, `1` = penguinswap — the getter SMC-1681 must expose; this pins that interface). When the deployed contract doesn't have the getter yet, the service uses `ORACLE_PRICING_MODE` instead; when both are available the contract wins (a mismatch is logged at startup). After a mode toggle the new source token starts a fresh window — first push is spot, then the TWAP re-accumulates — which is the "new TWAP pricing on toggle" SMC-1681 requires.

At startup the service reads `oracleService()` and refuses to run unless it equals the signing address, then resolves the initial mode the same way a tick would and refuses to run if it can't.

## Configuration

All config is via environment variables:

| Variable                            | Required          | Default                              | Description                                                                 |
| ----------------------------------- | ----------------- | ------------------------------------ | --------------------------------------------------------------------------- |
| `ORACLE_PRIVATE_KEY`                | yes               |                                      | secp256k1 key whose address equals `oracleService`.                         |
| `ORACLE_RPC_URL`                    | yes               |                                      | Source-chain JSON-RPC URL (where the Quoter contract lives).                |
| `ORACLE_CONTRACT_ADDRESS`           | yes               |                                      | `PenguinBridgeExecutionQuoter` address.                                     |
| `ORACLE_PRICING_MODE`               | see desc.         |                                      | `twap` or `penguinswap`. Fallback for contracts without `pricingMode()`; required if the contract predates SMC-1681. |
| `ORACLE_SOURCE_TOKEN_ID_TWAP`       | if twap active    |                                      | CoinGecko id priced into `sourcePrice` in TWAP mode (ATTEST).               |
| `ORACLE_SOURCE_TOKEN_ID_PENGUINSWAP`| if penguinswap active |                                  | CoinGecko id priced into `sourcePrice` in PenguinSwap mode (CTC). At least one of the two ids must be set; set both when the contract may toggle modes. |
| `ORACLE_CHAINS`                     | yes               |                                      | JSON array of destination chains (see below).                              |
| `ORACLE_COINGECKO_BASE_URL`         | no                | `https://api.coingecko.com/api/v3`   | CoinGecko REST base. Use the pro host for a pro key.                        |
| `ORACLE_COINGECKO_API_KEY`          | no                |                                      | Sent as `x-cg-demo-api-key` (or `x-cg-pro-api-key` for the pro host).       |
| `ORACLE_PUSH_INTERVAL_MS`           | no                | `60000`                              | Interval between pushes.                                                    |
| `ORACLE_TWAP_WINDOW_MS`             | no                | `300000`                             | Rolling time-weighting window. `0` disables weighting (push spot).          |
| `ORACLE_TX_WAIT_TIMEOUT_MS`         | no                | `120000`                             | Max wait for the `batchPriceUpdate` receipt before the tick fails.          |
| `ORACLE_HEARTBEAT_FILE`             | no                |                                      | File touched after each successful push, for the container healthcheck.     |
| `ORACLE_RPC_MAX_ATTEMPTS`           | no                | `3`                                  | Total RPC/CoinGecko attempts including the first (1 disables retry).        |
| `ORACLE_RPC_INITIAL_DELAY_MS`       | no                | `200`                                | First backoff; doubles each attempt up to `MAX_DELAY_MS`.                   |
| `ORACLE_RPC_MAX_DELAY_MS`           | no                | `2000`                               | Backoff ceiling.                                                            |

`ORACLE_CHAINS` is a JSON array, one entry per destination chain:

```json
[
  { "chainId": 2, "rpcUrl": "https://eth-rpc", "coingeckoId": "ethereum", "priceBuffer": 500, "baseFee": "1000000000000000" },
  { "chainId": 4, "rpcUrl": "https://bsc-rpc", "coingeckoId": "binancecoin", "priceBuffer": 500, "baseFee": "1000000000000000" }
]
```

- `chainId` — Wormhole chain id (uint16).
- `rpcUrl` — destination-chain RPC, read for current gas price.
- `coingeckoId` — CoinGecko id of the native token.
- `priceBuffer` — per-chain upward adjustment in basis points (uint64).
- `baseFee` — flat fee in source-chain native wei (uint64; number or string).

Retry only kicks in for transient failures (RPC `NETWORK_ERROR`/`SERVER_ERROR`/`TIMEOUT`, CoinGecko 5xx/429, transport errors). Contract reverts and CoinGecko 4xx are not retried. The `batchPriceUpdate` send itself is **not** retried within a tick — a transient failure simply skips to the next interval, which overwrites prices anyway, so there is no double-submission risk. Waiting for the receipt is bounded by `ORACLE_TX_WAIT_TIMEOUT_MS` so a transaction stuck in the mempool fails the tick instead of freezing the loop; the next tick reuses the stuck transaction's nonce (replacing it at current gas) rather than queueing behind it. Note that mode detection deliberately does **not** fall back to `ORACLE_PRICING_MODE` on a transient RPC failure — the tick is skipped rather than priced under a guessed mode.

## Development

```bash
# from the repo root
npm install --workspace=oracle-service

# unit tests (anvil-based integration auto-skips if anvil / evm/out artifacts aren't present)
npm test --workspace=oracle-service

# typecheck / build
npm run typecheck --workspace=oracle-service
npm run build --workspace=oracle-service

# run locally (env vars required)
npm run dev --workspace=oracle-service
```

## Deployment (Docker / Azure)

Multi-stage Dockerfile; runtime is `node:20-alpine` as a non-root user. Build from the repo root (the workspace's tsconfigs extend the root tsconfigs):

```bash
docker build -t ntt-oracle-service:latest -f oracle-service/Dockerfile .
```

There is no HTTP server. The Docker `HEALTHCHECK` checks that `ORACLE_HEARTBEAT_FILE` was touched within the last 3 push intervals, so set `ORACLE_HEARTBEAT_FILE` (defaulted to `/tmp/oracle-heartbeat` in the image) when relying on it.

## Tests

- `scaling.test.ts` — USD→uint64 1e10 scaling, rounding, range guards.
- `config.test.ts` — env validation, mode + `ORACLE_CHAINS` parsing, retry bounds, empty-env handling.
- `priceSource.test.ts` — CoinGecko client against a mock HTTP server (retry on 5xx/429, no retry on 4xx, missing-id rejection) and the TWAP windowing math.
- `oracle.test.ts` — mock JSON-RPC: `batchPriceUpdate` calldata, `oracleService` auth check, `pricingMode()` detection (mapping, missing-getter fallback, transient-vs-permanent errors), gas-price read, transient retry.
- `runner.test.ts` — single tick with stubs: mode detection vs fallback, correct `sourcePrice` token per mode, `PricingData` assembly, skip-on-missing-price.
- `anvil.integration.test.ts` — spawns `anvil`, deploys `PenguinBridgeExecutionQuoter`, sets the oracle, runs one tick, and asserts the on-chain `sourcePrice` / `pricingData` match; also asserts the bounded receipt wait times out against a non-mining node. Auto-skips when `anvil` or `evm/out` artifacts aren't present.
