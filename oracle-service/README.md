# ntt-oracle-service

Off-chain oracle that pushes ATTEST/native pricing to `USCRelayingQuoter` (the SMC-1681 quoter in the usc-write-ability-research repo). It is the **sole writer** of on-chain prices — the quoter gates `priceUpdate` / `batchPriceUpdate` behind `onlyOracle`, the `TWAPReader` gates `update()` the same way, and this service's signing key is the registered `oracleService` on both.

## What it does

Every `ORACLE_PUSH_INTERVAL_MS` it runs one tick:

1. **Reads the current pricing mode** from the quoter's `pricingMode()` getter. This happens every tick because the mode can be toggled on-chain at any time (via `setPricingMode`, itself an `onlyOracle` call); if the read fails the tick is skipped.
2. Fetches USD spot prices from **CoinGecko** (`/simple/price`) in a single request: **CTC** (always), **ATTEST** (twap mode only), and every configured destination chain's native token.
3. Feeds each price into a rolling **time-weighted average** over `ORACLE_TWAP_WINDOW_MS` (falls back to spot until the window fills). The off-chain USD window is process-local, so a fresh instance starts from spot; the security-critical ATTEST/CTC TWAP lives in the on-chain `TWAPReader`.
4. Reads current gas price from each destination chain's RPC.
5. **When the quoter uses `TWAPReader`:** pushes a spot `ctcPerAttest` observation (the latest fetched `attestUsd / ctcUsd`, 1e18 fixed point) via `update()` — the reader performs the ATTEST/CTC time weighting on-chain, so this observation deliberately bypasses the service's rolling USD averages. This is required in `twap` mode and in `penguinswap` mode when the ATTEST/CTC pool path is unset, because the quoter falls back to its reader in that case. The reader address is re-read from the quoter each tick, so an owner-side `setTWAPReader()` rotation needs no restart.
6. Writes `sourcePrice` (**CTC/USD ×1e10** — the mode-independent anchor) + per-chain `PricingData {baseFee, dstGasPrice, dstPrice, srcPrice, priceBuffer}` in one `batchPriceUpdate` transaction. `srcPrice` carries the same CTC/USD value per chain. Receipt waits are bounded by `ORACLE_TX_WAIT_TIMEOUT_MS` so a stuck transaction can't hang the loop.

All reads (prices + gas) complete **before** anything is pushed: if any read fails, the whole tick is skipped (logged) and the contract keeps its previous values rather than receiving partial/stale data. In twap mode the reader push precedes the batch push; a spot observation is valid on its own, so a batch failure after it does no harm.

### Pricing modes

The quoter derives the ATTEST↔native conversion rate (`getAttestPerNative`) from three legs: CTC/USD (`sourcePrice`), native/USD (`dstPrice`), and ATTEST/CTC (`ctcPerAttest`). The active mode — `pricingMode() view returns (uint8)` (`0` = twap, `1` = penguinswap) — selects **where ctcPerAttest comes from**:

- **`twap`** — this service derives it off CoinGecko (`attestUsd / ctcUsd`) and accumulates it into the on-chain `TWAPReader`; the quoter reads the time-weighted average back via `twapReader.read()`. Requires `ORACLE_ATTEST_TOKEN_ID`.
- **`penguinswap`** — when an ATTEST/CTC PenguinSwap (Uniswap-V3) path is configured, the quoter reads it live and this service needs no ATTEST feed. If that path is empty, the contract explicitly falls back to `TWAPReader`; the service detects this and keeps the reader fed, requiring `ORACLE_ATTEST_TOKEN_ID`.

In **both** modes this service pushes CTC/USD as `sourcePrice`/`srcPrice` and native/USD as `dstPrice`. The quoter is the single source of truth for the mode — there is no env override. If the mode read fails (a transient RPC error, or a contract that doesn't expose the getter) the error is surfaced: the tick is skipped at runtime, and at startup the service refuses to boot. Mode toggles go through `setPricingMode(newMode, newSourcePrice)` — an `onlyOracle` call that re-anchors the CTC/USD price atomically (it rejects a zero price).

At startup the service reads the quoter's `oracleService()` and refuses to run unless it equals the signing address, then resolves the active ATTEST/CTC source once the same way a tick would. If that source is `TWAPReader` (TWAP mode or an empty PenguinSwap path), it additionally verifies the reader is configured and registers this key as **its** `oracleService` too.

## Prerequisites

Before the service can push a single price, the following must be true:

1. **`USCRelayingQuoter` is deployed** on the source chain and its address is `ORACLE_CONTRACT_ADDRESS`.
2. **The quoter's `oracleService` is this key** — its constructor takes it, or the owner calls `setOracleService(<oracle address>)`. The service reads `oracleService()` at boot and exits non-zero on mismatch (pushing prices the contract would reject is worse than failing loudly).
3. **Whenever `TWAPReader` is active, its `oracleService` is ALSO this key.** The reader is a separate contract with its own oracle gate (constructor arg or `setOracleService`). It is active in TWAP mode and as the PenguinSwap fallback when no ATTEST/CTC path is configured.
4. **The oracle wallet is funded with source-chain native token.** Every tick sends one `batchPriceUpdate` (plus one `TWAPReader.update()` whenever the reader is active), so the signing key needs gas. This is _not_ checked at startup — an unfunded key simply skips every tick (logged), and the heartbeat goes stale.
5. **Reachable RPCs**: the source-chain RPC (`ORACLE_RPC_URL`) plus **each destination chain's RPC** (`ORACLE_CHAINS[].rpcUrl`, read every tick for gas price).
6. **Valid CoinGecko ids**: CTC (`ORACLE_CTC_TOKEN_ID`, always) and every destination chain's native token; plus ATTEST (`ORACLE_ATTEST_TOKEN_ID`) if the contract may be in twap mode. At launch ATTEST has no USD market, so the contract runs in `penguinswap` mode and the ATTEST id can be omitted. CoinGecko's free tier works without a key.

## Configuration

All config is via environment variables:

| Variable                      | Required                | Default                            | Description                                                                                               |
| ----------------------------- | ----------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `ORACLE_PRIVATE_KEY`          | yes                     |                                    | secp256k1 key whose address equals `oracleService` (quoter + TWAPReader).                                 |
| `ORACLE_RPC_URL`              | yes                     |                                    | Source-chain JSON-RPC URL (where the Quoter contract lives).                                              |
| `ORACLE_CONTRACT_ADDRESS`     | yes                     |                                    | `USCRelayingQuoter` address. Must expose `pricingMode()`.                                                 |
| `ORACLE_CTC_TOKEN_ID`         | yes                     |                                    | CoinGecko id of CTC — the `sourcePrice`/`srcPrice` anchor in both modes.                                  |
| `ORACLE_ATTEST_TOKEN_ID`      | if TWAPReader reachable |                                    | CoinGecko id of ATTEST — required in TWAP mode and in PenguinSwap mode when its ATTEST/CTC path is unset. |
| `ORACLE_CHAINS`               | yes                     |                                    | JSON array of destination chains (see below).                                                             |
| `ORACLE_COINGECKO_BASE_URL`   | no                      | `https://api.coingecko.com/api/v3` | CoinGecko REST base. Use the pro host for a pro key.                                                      |
| `ORACLE_COINGECKO_API_KEY`    | no                      |                                    | Sent as `x-cg-demo-api-key` (or `x-cg-pro-api-key` for the pro host).                                     |
| `ORACLE_PUSH_INTERVAL_MS`     | no                      | `60000`                            | Interval between pushes. Minimum `15000` (15s).                                                           |
| `ORACLE_TWAP_WINDOW_MS`       | no                      | `300000`                           | Rolling time-weighting window. `0` disables weighting (push spot).                                        |
| `ORACLE_TX_WAIT_TIMEOUT_MS`   | no                      | `120000`                           | Max wait per receipt before the tick fails.                                                               |
| `ORACLE_HEARTBEAT_FILE`       | no                      |                                    | File touched after each successful push, for the container healthcheck.                                   |
| `ORACLE_RPC_MAX_ATTEMPTS`     | no                      | `3`                                | Total RPC/CoinGecko attempts including the first (1 disables retry).                                      |
| `ORACLE_RPC_INITIAL_DELAY_MS` | no                      | `200`                              | First backoff; doubles each attempt up to `MAX_DELAY_MS`.                                                 |
| `ORACLE_RPC_MAX_DELAY_MS`     | no                      | `2000`                             | Backoff ceiling.                                                                                          |

`ORACLE_CHAINS` is a JSON array, one entry per destination chain:

```json
[
  {
    "chainId": 2,
    "rpcUrl": "https://eth-rpc",
    "coingeckoId": "ethereum",
    "priceBuffer": "50",
    "baseFee": "1000000000000000"
  },
  {
    "chainId": 4,
    "rpcUrl": "https://bsc-rpc",
    "coingeckoId": "binancecoin",
    "priceBuffer": "50",
    "baseFee": "1000000000000000"
  }
]
```

- `chainId` — Wormhole chain id (non-zero uint16); a JSON number.
- `rpcUrl` — destination-chain RPC, read for current gas price.
- `coingeckoId` — CoinGecko id of the native token.
- `priceBuffer` — per-chain upward adjustment in **basis points** (the contract's `BPS_DENOMINATOR = 10_000`, so `"50"` = +0.5%). uint16 on-chain, max `65535` (+655.35%). **Decimal string**; omit for 0.
- `baseFee` — flat fee in **CTC wei** (uint256 — values above uint64 like 100 CTC = 1e20 are fine). **Decimal string** (wei values exceed JS's safe integer range — a bare number would lose precision); omit for 0.

Retry only kicks in for transient failures (RPC `NETWORK_ERROR`/`SERVER_ERROR`/`TIMEOUT`, CoinGecko 5xx/429, transport errors). Contract reverts and CoinGecko 4xx are not retried. The tick's sends (`TWAPReader.update`, `batchPriceUpdate`) are **not** retried within a tick — a transient failure simply skips to the next interval, which overwrites prices anyway, so there is no double-submission risk. Waiting for a receipt is bounded by `ORACLE_TX_WAIT_TIMEOUT_MS` so a transaction stuck in the mempool fails the tick instead of freezing the loop; a running instance reuses that tx's nonce with fees bumped ≥12.5%. A fresh instance never replaces an unknown pending transaction because its fee is unavailable; it logs and waits for that transaction to mine or drop. The per-tick `pricingMode()` read is covered by the same retry policy; if it still fails, the tick is skipped rather than priced under a guessed mode.

## Development

```bash
# from the repo root
npm install --workspace=oracle-service

# unit tests + anvil-based integration (integration auto-skips if anvil isn't installed)
npm test --workspace=oracle-service

# typecheck / build
npm run typecheck --workspace=oracle-service
npm run build --workspace=oracle-service

# run locally (env vars required)
npm run dev --workspace=oracle-service
```

The integration tests deploy the **real** `USCRelayingQuoter` + `TWAPReader` bytecode, vendored from the usc-write-ability-research repo into `__tests__/fixtures/` (trimmed hardhat artifacts). When those contracts change, recompile there (`npx hardhat compile`) and re-vendor the `abi`/`bytecode` fields.

## Deployment (Docker / Azure)

Multi-stage Dockerfile; runtime is `node:20-alpine` as a non-root user. Build from the repo root (the workspace's tsconfigs extend the root tsconfigs):

```bash
docker build -t ntt-oracle-service:latest -f oracle-service/Dockerfile .
```

> **Note on `oracle-service/package-lock.json`:** npm workspaces resolve dependencies from the **repo-root** lockfile; the nested lockfile here exists only so the Docker build can `npm ci` with the workspace directory as its install root. The two can drift silently — when bumping this workspace's dependencies, regenerate the nested lockfile (`cd oracle-service && npm install --package-lock-only`) so the image ships the same versions the repo tests against.

### Runtime model

This is a **background worker**: it opens no socket, exposes no port, and serves no HTTP endpoint. It runs a push loop and must be deployed accordingly:

- **No ingress / no port mapping.** There is nothing to route traffic to.
- **Keep one execution alive.** For Azure Container Apps, set `minReplicas: 1`; a scale-to-zero service stops the timer and stops publishing prices. If scale-to-zero is required, deploy this as a scheduled Container Apps Job instead, with one non-overlapping execution per interval.
- **No HTTP health probe.** A liveness/readiness probe that hits an HTTP endpoint will always fail and restart-loop the container.
- **Liveness is the heartbeat file.** The runner touches `ORACLE_HEARTBEAT_FILE` (defaulted to `/tmp/oracle-heartbeat` in the image) after every successful push. The Docker `HEALTHCHECK` checks it's fresh (missing or older than `3 × push interval + one receipt-wait timeout` ⇒ unhealthy).
- **The Dockerfile `HEALTHCHECK` only applies under plain Docker / docker-compose.** Azure Container Apps and Kubernetes ignore it and use their own probe config. To get the same self-healing there, configure an **exec/command probe** running the equivalent staleness check, e.g.:

  ```
  node -e "const fs=require('fs');const f=process.env.ORACLE_HEARTBEAT_FILE;const m=3*Number(process.env.ORACLE_PUSH_INTERVAL_MS||60000)+Number(process.env.ORACLE_TX_WAIT_TIMEOUT_MS||120000);process.exit(Date.now()-fs.statSync(f).mtimeMs>m?1:0)"
  ```

  Otherwise the container won't auto-restart on a wedged loop, it'll just stop pushing.

## Tests

- `scaling.test.ts` — USD→uint64 1e10 scaling, rounding, range guards, uint16 guard, the ctcPerAttest wad ratio.
- `config.test.ts` — env validation, `ORACLE_CHAINS` parsing (string-only amounts, uint16 priceBuffer, uint256 baseFee), CTC/ATTEST token ids, interval floor, retry bounds.
- `priceSource.test.ts` — CoinGecko client against a mock HTTP server (retry on 5xx/429, no retry on 4xx, missing-id rejection) and the TWAP windowing math.
- `oracle.test.ts` — mock JSON-RPC: `batchPriceUpdate` calldata in the real `PricingData` layout, `oracleService` auth check, `pricingMode()` mapping + clear error when the getter is absent + transient retry, unset-TWAPReader error, gas-price read.
- `runner.test.ts` — single tick with stubs: per-tick source detection (including PenguinSwap's TWAPReader fallback) and CTC anchor + per-chain `srcPrice`.
- `anvil.integration.test.ts` — spawns `anvil`, deploys the **real** `USCRelayingQuoter` + `TWAPReader` (vendored bytecode), runs full `runTick`s in both modes and asserts on-chain `sourcePrice` / `pricingData` / reader state — including that the quoter derives the expected `getAttestUsdPrice()` from the pushed legs; asserts a clear error from `pricingMode()` against a contract without the getter; asserts the bounded receipt wait times out against a non-mining node and that the follow-up push replaces the stuck tx with bumped fees. Auto-skips when `anvil` isn't installed.
