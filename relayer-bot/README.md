# ntt-relayer-bot

Off-chain relayer that finalizes Wormhole NTT transfers sent through `SpecialRelayer` (the Penguin Bridge custom-execution path). It watches `ExecutionRequested` on each source chain, obtains the guardian-signed Wormhole VAA for the message, and submits `WormholeTransceiver.receiveMessage(vaa)` on the destination chain.

## What it does

1. **Listener** scans each source chain's `SpecialRelayer` for `ExecutionRequested(dstChain, dstAddr, requestBytes, relayInstructions)`. For each event it correlates the source `Wormhole Core` `LogMessagePublished` from the same transaction (matching `requestBytes == payload`) to recover the VAA identity `(emitterChain, emitterAddress, sequence)`, persists a `pending` row, and enqueues a message.
2. **Worker** consumes a message and runs delivery in two phases: **prepare** (no wallet held) fetches the VAA, validates it, runs the `isVAAConsumed` pre-flight, and estimates gas; then **broadcast** (inside the wallet lock) leases a relayer wallet, reserves a nonce, and sends `receiveMessage` on the destination — recording the row as `submitted`.
3. **Cron** reconciles `submitted` rows against on-chain receipts → `confirmed`; a reverted tx → `failed` → retry with a **fresh** nonce + gas bump; a stuck (no-receipt) tx → retry as a **replacement-by-fee on the same nonce**; budget exhausted → `dead_letter`.

### Why a VAA is required (vs. the design doc)

The destination `WormholeTransceiver.receiveMessage(bytes)` runs `parseAndVerifyVM`, so a **guardian-signed VAA is mandatory** — the `ExecutionRequested` event does not contain one. The bot resolves it via a pluggable `VaaFetcher`:

- **Wormholescan** (default, testnet/mainnet): polls `GET /v1/signed_vaa/{chain}/{emitter}/{sequence}`.
- **Dev guardian** (local/anvil): self-signs a VAA reconstructed from the source `LogMessagePublished`, mirroring [`devnet/tools/relayer.ts`](../devnet/tools/relayer.ts). Enabled by setting `RELAYER_DEV_GUARDIAN_KEY`.

The replay-protection key the bot checks (`isVAAConsumed`) is the **double-keccak of the VAA body** (`keccak256(keccak256(body))`), matching `WormholeTransceiver._verifyMessage`. The event's `dstAddr` is already the destination `WormholeTransceiver`, so no `NttManager.getTransceiver()` lookup is needed (that method does not exist on the EVM manager).

See [evm/src/SpecialRelayer/SpecialRelayer.sol](../evm/src/SpecialRelayer/SpecialRelayer.sol) and [evm/src/interfaces/IWormholeTransceiver.sol](../evm/src/interfaces/IWormholeTransceiver.sol).

## Architecture

```
                 ┌────────────┐   publish    ┌────────────┐   consume   ┌──────────┐
 source chains → │  Listener  │ ───────────▶ │   Queue    │ ──────────▶ │  Worker  │ → destination chains
                 │ (per chain)│              │  (Redis)   │             │ + wallet │
                 └─────┬──────┘              └────────────┘             │   pool   │
                       │ block_tracker, transactions (atomic)           └────┬─────┘
                       ▼                          ▲  re-enqueue on retry     │ submitted
                 ┌───────────────────────── Postgres ───────────────────────┘
                       ▲                          │
                       └────────── Cron (leader-locked) reconciles submitted → confirmed/failed/dead_letter
```

All components are stateless except Postgres and the queue. Run as workloads off one image: one listener task per source chain, worker replicas, and one or more cron replicas (a Postgres advisory leader lock makes extra cron replicas idle).

### Status lifecycle

`pending` → `submitting` (nonce + wallet reserved and committed BEFORE broadcast — the intent log) → `submitted` (tx hash recorded) → `confirmed` (cron, receipt found) · `failed` (cron, reverted; `retry_count++`) → `dead_letter` (retries exhausted). A crash in `submitting` is recovered by the cron, which resubmits the committed nonce.

### Ordering, state, nonce & gas

These are the load-bearing correctness properties:

- **FIFO per source chain.** The queue is **partitioned by source chain** (one Redis stream per chain). Each partition is owned by a single worker at a time (a Postgres advisory partition lock) and drained **one message at a time, in stream order** — strict FIFO within a chain, while partitions run in parallel for throughput. Extra worker replicas take over a partition on owner failure. (FIFO applies to *first-attempt pickup*; a retried/nacked message is re-queued at the tail of its partition, so retries are best-effort order — acceptable since each NTT transfer is independently replay-protected.)
- **DB ↔ on-chain state.** The system is at-least-once with the **on-chain replay guard as the source of truth**: every send is gated by the `isVAAConsumed` pre-flight (and a `TransferAlreadyCompleted`-revert catch), so a duplicate can never double-deliver. A **per-`(source_chain, event_tx_hash)` advisory lock** prevents two consumers processing the same message during a visibility-timeout reclaim race. An **intent log** closes the crash-between-broadcast-and-DB-commit gap: the wallet + nonce are committed as `submitting` *before* the tx is broadcast, so a crash leaves a tracked record (no untracked "orphan" tx). The cron recovers stale `submitting` rows by resubmitting the committed nonce.
- **Nonce management.** Each nonce is reserved and committed (`submitting`) under the per-wallet advisory lock *before* broadcasting; the next nonce is `max(DB max committed + 1, chain pending nonce)`, where "committed" counts `submitting`/`submitted`/`confirmed` so a reserved-but-unbroadcast nonce is never handed out twice. A **stuck** tx (or a crashed `submitting` row) is resubmitted as a **replacement-by-fee on the same wallet + nonce**; a **reverted** (mined) tx is retried with a fresh nonce (the chain's pending nonce protects the consumed one).
- **Gas.** `prepare` runs `eth_estimateGas` and uses `max(quoted gasLimit + buffer, estimate + buffer)`; fees are EIP-1559 (legacy fallback), bumped per retry, and deferred above `RELAYER_MAX_GAS_PRICE_WEI`.

## Configuration

All config is via environment variables. The role is set with `--role=<role>` (or `RELAYER_ROLE`).

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `RELAYER_ROLE` / `--role` | yes | | `listener`, `worker`, `cron`, or `migrate`. |
| `RELAYER_CHAINS` | yes¹ | | JSON array of chain configs (below). |
| `DATABASE_URL` | yes | | Postgres connection string. |
| `REDIS_URL` | yes¹ | | Redis connection string. |
| `WALLETS` | yes² | | Comma-separated Key Vault secret **names** holding relayer keys. |
| `AZURE_KEY_VAULT_URL` | yes² | | Key Vault URL. Not required if `RELAYER_USE_DEV_SECRETS=true`. |
| `RELAYER_USE_DEV_SECRETS` | no | `false` | Read keys from `RELAYER_WALLET_<name>` env vars (dev/tests only). |
| `WORMHOLESCAN_URL` | no | `https://api.wormholescan.io` | VAA source (use the testnet host on testnet). |
| `RELAYER_DEV_GUARDIAN_KEY` | no | | If set, self-sign VAAs with this dev guardian key instead of Wormholescan. Requires `RELAYER_USE_DEV_SECRETS=true` (refused otherwise). |
| `SLACK_WEBHOOK_URL` | no | | Slack incoming webhook for alerts (alerts log-only if unset). |
| `SCAN_BLOCK_RANGE` | no | `200` | Max blocks scanned per `getLogs` range. (Legacy alias: `SCAN_INTERVAL_MS` — a block count despite the name.) |
| `RELAYER_SCAN_LOOP_DELAY_MS` | no | `2000` | Sleep between scan iterations. |
| `QUEUE_VISIBILITY_TIMEOUT_MS` | no | `60000` | In-flight message visibility timeout. |
| `WALLET_MIN_BALANCE` | no | `0.05` | Low-balance alert threshold, in ETH. |
| `MAX_RETRIES` | no | `2` | Business retries before dead-letter. |
| `RELAYER_RETRY_ADDITIONAL_GAS_LIMIT` | no | `10` | Extra gas-limit percent applied on retries. |
| `RELAYER_GAS_LIMIT_BUFFER_BPS` | no | `1000` | Gas-limit buffer over the signed limit (bps). |
| `RELAYER_GAS_PRICE_BUMP_BPS` | no | `1500` | Per-retry fee bump (bps). |
| `RELAYER_MAX_GAS_PRICE_WEI` | yes² | `0` (off) | Fee ceiling; above it, delivery defers. Required (> 0) for a production worker; only dev workers (`RELAYER_USE_DEV_SECRETS=true`) may leave it off. |
| `SUBMITTED_TIMEOUT_MIN` | no | `5` | Minutes before the cron re-checks a submitted tx. |
| `CRON_INTERVAL_MIN` | no | `2` | Cron run interval. |
| `RELAYER_VAA_TIMEOUT_MS` | no | `1800000` | Give up fetching a VAA after this, then dead-letter. |
| `RELAYER_VAA_POLL_INTERVAL_MS` | no | `5000` | Delay between VAA polls/requeues. |
| `DEAD_LETTER_ALERT_THRESHOLD` | no | `1` | Dead-letter count that triggers an alert. |
| `RELAYER_HEALTH_HOST` / `RELAYER_HEALTH_PORT` | no | `127.0.0.1` / `8080` | Health server bind. |
| `RELAYER_RPC_MAX_ATTEMPTS` / `_INITIAL_DELAY_MS` / `_MAX_DELAY_MS` | no | `3` / `200` / `2000` | RPC retry policy (transport errors only, ±25% jitter). |

¹ Not required for the `migrate` role. ² Worker role only.

`RELAYER_CHAINS` entry:

```json
{
  "chainId": 2,                       // Wormhole chain id (uint16)
  "name": "ethereum",
  "rpcUrl": "https://...",
  "specialRelayerAddress": "0x...",   // source role: SpecialRelayer to scan
  "coreBridgeAddress": "0x...",       // source role: Wormhole Core (for correlation)
  "expectedTransceiver": "0x...",     // optional: assert dstAddr matches before delivering
  "confirmations": 15,                // blocks behind head treated as final
  "genesisBlock": "19000000",         // start block if no cursor exists
  "evmChainId": 1                     // optional: static-network provider
}
```

## Roles

```bash
node dist/esm/bin.js --role=migrate     # apply migrations and exit
node dist/esm/bin.js --role=listener    # one process; scans all configured source chains
node dist/esm/bin.js --role=worker      # scale to N replicas
node dist/esm/bin.js --role=cron        # run 1+ replicas; only the leader acts
```

Each role exposes `GET /health` on `RELAYER_HEALTH_PORT` for liveness/readiness probes.

## Development

```bash
# from the repo root
npm install --workspace=relayer-bot

# unit tests (no external services needed; db/redis/anvil tests auto-skip)
npm test --workspace=relayer-bot
npm run typecheck --workspace=relayer-bot
npm run build --workspace=relayer-bot

# run a role locally (tsx, no build)
npm run dev:worker --workspace=relayer-bot
```

### Integration tests

Some tests are gated on real services and skip when absent:

```bash
docker compose -f relayer-bot/docker-compose.yml up -d
export TEST_DATABASE_URL=postgres://relayer:relayer@localhost:5432/relayer
export REDIS_URL=redis://localhost:6379
npm test --workspace=relayer-bot
```

- `db.integration.test.ts` — migrations, repos, idempotency, status transitions, `FOR UPDATE SKIP LOCKED`, advisory locks (needs `TEST_DATABASE_URL`).
- `queue.redis.integration.test.ts` — Redis Streams consumer groups, `XAUTOCLAIM` visibility-timeout reclaim, the delay-set retry pump, DLQ routing (needs `REDIS_URL`).

Always-on tests cover VAA byte layout + the double-keccak hash (golden vectors), correlation, the Wormholescan/dev-guardian fetchers, delivery revert classification + gas math, the in-memory queue + backoff, the wallet-pool nonce strategy, config validation, the alerter, repo logic (pg-mem), and the full listener→queue→worker pipeline composition.

### Manual end-to-end (testnet)

1. Deploy/point at a `SpecialRelayer` + `PenguinBridgeExecutionQuoter` and run the [quoter-service](../quoter-service).
2. Run `--role=migrate`, then `--role=listener`, `--role=worker`, `--role=cron` with `RELAYER_CHAINS` for the source + destination chains and `WORMHOLESCAN_URL=https://api.testnet.wormholescan.io`.
3. Send a transfer via `SpecialRelayer.requestExecution`; watch the `transactions` row move `pending → submitted → confirmed` and the transfer complete on the destination.

## Requirements

PostgreSQL **≥ 12** (the `0003` migration uses `ALTER TYPE … ADD VALUE` for the `submitting` status, which can only run inside a transaction on PG 12+; tested on PG 16) and Redis **≥ 6.2** (the queue uses `XAUTOCLAIM`).

## Deployment (Docker / Azure)

One image serves all roles; the role is supplied via container args.

```bash
# build from the repo root (the workspace tsconfigs extend ../tsconfig.*.json)
docker build -t ntt-relayer-bot:latest -f relayer-bot/Dockerfile .

docker run --rm ntt-relayer-bot:latest --role=worker   # + env vars
```

Deploy as three Azure Container Apps / K8s Deployments off the one image (`--role=listener|worker|cron`), with managed identity for Key Vault. The `migrate` role runs as a one-shot job before rollout. A Docker `HEALTHCHECK` polls `/health`.

Wallet gas balances are monitored against `WALLET_MIN_BALANCE`; balances are also covered by [gluwa/Contract-Utilities](https://github.com/gluwa/Contract-Utilities/tree/main/apps/wallet-balance-monitor) (not a dependency).
