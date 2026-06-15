# ntt-oracle-service

Off-chain oracle that pushes ATTEST/native pricing to `PenguinBridgeExecutionQuoter`. It is the **sole writer** of on-chain prices — the contract gates `priceUpdate` / `batchPriceUpdate` behind `onlyOracleService`, and this service's signing key is that `oracleService`.

## What it does

Every `ORACLE_PUSH_INTERVAL_MS` it runs one tick:

1. **Reads the current pricing mode** from the contract's `pricingMode()` getter. This happens every tick because the owner can toggle modes on-chain at any time; if the read fails the tick is skipped.
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

The mode is read every tick from the contract's `pricingMode() view returns (uint8)` getter (`0` = twap, `1` = penguinswap), so an on-chain toggle takes effect on the next tick. The contract is the single source of truth — there is no env override. If the read fails (a transient RPC error, or a contract that doesn't expose the getter) the error is surfaced: the tick is skipped at runtime, and at startup the service refuses to boot. After a toggle the new source token starts a fresh window — first push is spot, then the TWAP re-accumulates.

At startup the service reads `oracleService()` and refuses to run unless it equals the signing address, then reads `pricingMode()` once the same way a tick would and refuses to run if it can't (e.g. the contract isn't the expected quoter).

## Prerequisites

Before the service can push a single price, the following must be true:

1. **`PenguinBridgeExecutionQuoter` is deployed** on the source chain and its address is `ORACLE_CONTRACT_ADDRESS`.
2. **The contract owner has called `setOracleService(<oracle address>)`** with the address of `ORACLE_PRIVATE_KEY`. The service reads `oracleService()` at boot and exits non-zero if it doesn't match (pushing prices the contract would reject is worse than failing loudly).
3. **The oracle wallet is funded with source-chain native token.** Every tick sends a `batchPriceUpdate` transaction, so the signing key needs gas. This is *not* checked at startup — an unfunded key simply skips every tick (logged), and the heartbeat goes stale.
4. **Reachable RPCs**: the source-chain RPC (`ORACLE_RPC_URL`) plus **each destination chain's RPC** (`ORACLE_CHAINS[].rpcUrl`, read every tick for gas price).
5. **The deployed quoter exposes `pricingMode()`** (the contract-side SMC-1681 work). The service reads it at boot and refuses to run otherwise — there is no env fallback.
6. **Valid CoinGecko ids** for the source token of any mode the contract may be in, plus every destination chain's native token. At launch the contract is in `penguinswap` mode, so set `ORACLE_SOURCE_TOKEN_ID_PENGUINSWAP=<ctc coingecko id>`. CoinGecko's free tier works without a key.

## Configuration

All config is via environment variables:

| Variable                            | Required          | Default                              | Description                                                                 |
| ----------------------------------- | ----------------- | ------------------------------------ | --------------------------------------------------------------------------- |
| `ORACLE_PRIVATE_KEY`                | yes               |                                      | secp256k1 key whose address equals `oracleService`.                         |
| `ORACLE_RPC_URL`                    | yes               |                                      | Source-chain JSON-RPC URL (where the Quoter contract lives).                |
| `ORACLE_CONTRACT_ADDRESS`           | yes               |                                      | `PenguinBridgeExecutionQuoter` address. Must expose `pricingMode()`.        |
| `ORACLE_SOURCE_TOKEN_ID_TWAP`       | if twap reachable |                                      | CoinGecko id priced into `sourcePrice` in TWAP mode (ATTEST).               |
| `ORACLE_SOURCE_TOKEN_ID_PENGUINSWAP`| if penguinswap reachable |                               | CoinGecko id priced into `sourcePrice` in PenguinSwap mode (CTC). At least one of the two ids must be set; set both if the contract may be toggled to either mode. |
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
  { "chainId": 2, "rpcUrl": "https://eth-rpc", "coingeckoId": "ethereum", "priceBuffer": "500", "baseFee": "1000000000000000" },
  { "chainId": 4, "rpcUrl": "https://bsc-rpc", "coingeckoId": "binancecoin", "priceBuffer": "500", "baseFee": "1000000000000000" }
]
```

- `chainId` — Wormhole chain id (uint16); a JSON number.
- `rpcUrl` — destination-chain RPC, read for current gas price.
- `coingeckoId` — CoinGecko id of the native token.
- `priceBuffer` — per-chain upward adjustment in basis points (uint64). **Decimal string**; omit for 0.
- `baseFee` — flat fee in source-chain native wei (uint64). **Decimal string** (wei values exceed JS's safe integer range — a bare number would lose precision); omit for 0.

Retry only kicks in for transient failures (RPC `NETWORK_ERROR`/`SERVER_ERROR`/`TIMEOUT`, CoinGecko 5xx/429, transport errors). Contract reverts and CoinGecko 4xx are not retried. The `batchPriceUpdate` send itself is **not** retried within a tick — a transient failure simply skips to the next interval, which overwrites prices anyway, so there is no double-submission risk. Waiting for the receipt is bounded by `ORACLE_TX_WAIT_TIMEOUT_MS` so a transaction stuck in the mempool fails the tick instead of freezing the loop; the next tick reuses the stuck transaction's nonce (replacing it at current gas) rather than queueing behind it. The per-tick `pricingMode()` read is covered by the same retry policy; if it still fails, the tick is skipped rather than priced under a guessed mode.

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

### Runtime model

This is a **background worker**: it opens no socket, exposes no port, and serves no HTTP endpoint. It runs a push loop and must be deployed accordingly:

- **No ingress / no port mapping.** There is nothing to route traffic to.
- **No HTTP health probe.** A liveness/readiness probe that hits an HTTP endpoint will always fail and restart-loop the container.
- **Liveness is the heartbeat file.** The runner touches `ORACLE_HEARTBEAT_FILE` (defaulted to `/tmp/oracle-heartbeat` in the image) after every successful push. The Docker `HEALTHCHECK` checks it's fresh (missing or older than `3 × push interval + one receipt-wait timeout` ⇒ unhealthy).
- **The Dockerfile `HEALTHCHECK` only applies under plain Docker / docker-compose.** Azure Container Apps and Kubernetes ignore it and use their own probe config. To get the same self-healing there, configure an **exec/command probe** running the equivalent staleness check, e.g.:

  ```
  node -e "const fs=require('fs');const f=process.env.ORACLE_HEARTBEAT_FILE;const m=3*Number(process.env.ORACLE_PUSH_INTERVAL_MS||60000)+Number(process.env.ORACLE_TX_WAIT_TIMEOUT_MS||120000);process.exit(Date.now()-fs.statSync(f).mtimeMs>m?1:0)"
  ```

  Otherwise the container won't auto-restart on a wedged loop, it'll just stop pushing.

## Tests

- `scaling.test.ts` — USD→uint64 1e10 scaling, rounding, range guards.
- `config.test.ts` — env validation, `ORACLE_CHAINS` parsing (string-only amounts), source-token-id requirement, retry bounds, empty-env handling.
- `priceSource.test.ts` — CoinGecko client against a mock HTTP server (retry on 5xx/429, no retry on 4xx, missing-id rejection) and the TWAP windowing math.
- `oracle.test.ts` — mock JSON-RPC: `batchPriceUpdate` calldata, `oracleService` auth check, `pricingMode()` mapping + clear error when the getter is absent + transient retry, gas-price read.
- `runner.test.ts` — single tick with stubs: per-tick mode read (incl. on-chain toggle), correct `sourcePrice` token per mode, `PricingData` assembly, skip on mode-read/price/gas failure; `readActiveMode` behavior.
- `anvil.integration.test.ts` — spawns `anvil`, deploys `PenguinBridgeExecutionQuoter`, sets the oracle, pushes prices via the real contract and asserts on-chain `sourcePrice` / `pricingData`; asserts a clear error from `pricingMode()` against a contract without the getter; asserts the bounded receipt wait times out against a non-mining node. Auto-skips when `anvil` or `evm/out` artifacts aren't present.
