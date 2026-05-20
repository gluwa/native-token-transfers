# ntt-quoter-service

Off-chain HTTP service that produces signed execution quotes for `SpecialRelayer`.

## What it does

In order to use `SpecialRelayer`, the relayer requires a `signedQuoteBytes` blob that proves the quoted fee came from an authorized quoter. This service:

1. Reads the current required payment from `PenguinBridgeExecutionQuoter.requestQuote` on-chain.
2. Packs the fee plus quoter address, payee, source/destination chain ids, and an expiry into the 100-byte body layout that `SpecialRelayer._parseSignedQuote` expects.
3. Signs `keccak256(body)` with the configured quoter key (registered in `PenguinBridgeExecutionQuoter.authorizedQuoters`).
4. Returns the 165-byte `signedQuoteBytes` payload, which the user passes directly to `SpecialRelayer.requestDelivery`.

At startup the service calls `isAuthorizedQuoter` on the configured contract and verifies that the signing key is registered before running.

See [evm/src/SpecialRelayer/SpecialRelayer.sol](../evm/src/SpecialRelayer/SpecialRelayer.sol) for the on-chain verifier and [evm/src/SpecialRelayer/PenguinBridgeExecutionQuoter.sol](../evm/src/SpecialRelayer/PenguinBridgeExecutionQuoter.sol) for the pricing source.

## Configuration

All config is via environment variables:

| Variable                      | Required | Default     | Description                                                            |
| ----------------------------- | -------- | ----------- | ---------------------------------------------------------------------- |
| `QUOTER_PRIVATE_KEY`          | yes      |             | secp256k1 key whose address is registered in `authorizedQuoters`.      |
| `QUOTER_RPC_URL`              | yes      |             | Source-chain JSON-RPC URL.                                             |
| `QUOTER_CONTRACT_ADDRESS`     | yes      |             | `PenguinBridgeExecutionQuoter` address.                                |
| `QUOTER_SRC_CHAIN`            | yes      |             | Wormhole chain id of the source chain (uint16).                        |
| `QUOTER_PAYEE_ADDRESS`        | yes      |             | 20- or 32-byte hex address that receives the fee (encoded as bytes32). |
| `QUOTER_VALIDITY_SECONDS`     | no       | `120`       | Quote validity window in seconds. Capped at 3600 (1 hour).             |
| `QUOTER_HOST`                 | no       | `127.0.0.1` | HTTP bind host.                                                        |
| `QUOTER_PORT`                 | no       | `3000`      | HTTP bind port.                                                        |
| `QUOTER_RPC_MAX_ATTEMPTS`     | no       | `3`         | Total RPC attempts including the first try (1 disables retry).         |
| `QUOTER_RPC_INITIAL_DELAY_MS` | no       | `200`       | First backoff delay; doubles each attempt up to `MAX_DELAY_MS`.        |
| `QUOTER_RPC_MAX_DELAY_MS`     | no       | `2000`      | Backoff ceiling.                                                       |

RPC retry only kicks in for transport-layer failures (`NETWORK_ERROR`, `SERVER_ERROR`, `TIMEOUT`). Contract reverts (`CALL_EXCEPTION`) are not retried. Backoff is exponential with ±25% jitter so concurrent failures don't retry in lockstep against a recovering node.

## HTTP API

### `POST /quote`

Request:

```json
{
  "dstChain": 5,
  "dstAddr": "0x000...",
  "msgValue": "1000000000000000000",
  "gasLimit": "300000"
}
```

- `dstChain` — Wormhole chain id of the destination (uint16).
- `dstAddr` — Destination NTT Manager address, 20 or 32 bytes hex. 20-byte input is left-padded to bytes32.
- `msgValue` — Value to forward on the destination chain, in destination native wei. Number or numeric string.
- `gasLimit` — Destination-side gas limit. Number or numeric string.

Response (200):

```json
{
  "signedQuoteBytes": "0x...",
  "requiredPayment": "...",
  "expiryTime": "...",
  "srcChain": 2,
  "dstChain": 5,
  "quoterAddress": "0x...",
  "payeeAddress": "0x..."
}
```

Error responses use `{"error": "..."}` with status `400` (bad input), `502` (upstream RPC failure after retries are exhausted), or `500` (unexpected).

### `GET /health`

Returns `{"status": "ok"}` for liveness probes.

## Development

```bash
# from the repo root
npm install --workspace=quoter-service

# run unit + integration tests (anvil-based integration auto-skips if anvil isn't installed)
npm test --workspace=quoter-service

# typecheck
npm run typecheck --workspace=quoter-service

# build
npm run build --workspace=quoter-service

# run locally (env vars required)
npm run dev --workspace=quoter-service
```

## Deployment (Docker / Azure)

A multi-stage Dockerfile is included. The runtime image is `node:20-alpine` and runs as a non-root user. Build from the repo root (the workspace's tsconfigs extend the root tsconfigs, so the build context must include both):

```bash
docker build -t ntt-quoter-service:latest -f quoter-service/Dockerfile .
```

Run with env vars:

```bash
docker run --rm -p 3000:3000 \
  -e QUOTER_PRIVATE_KEY=0x... \
  -e QUOTER_RPC_URL=https://... \
  -e QUOTER_CONTRACT_ADDRESS=0x... \
  -e QUOTER_SRC_CHAIN=2 \
  -e QUOTER_PAYEE_ADDRESS=0x... \
  ntt-quoter-service:latest
```

The image defaults `QUOTER_HOST=0.0.0.0` and `QUOTER_PORT=3000` so it works under Azure Container Apps / AKS without extra config. A Docker `HEALTHCHECK` polls `/health`.

## Tests

- `signedQuote.test.ts` — byte-offset checks, ecrecover parity with `SpecialRelayer`, golden-vector regression check, decode round-trip, malformed input.
- `retry.test.ts` — retry classifier + exponential backoff math.
- `quoter.test.ts` — mock JSON-RPC server validates contract calldata, exercises retry on `HTTP 503`, asserts no retry on `CALL_EXCEPTION`, covers the `isAuthorizedQuoter` startup check.
- `server.test.ts` — HTTP layer (200/400/502/404), BigInt-aware JSON, body size cap.
- `config.test.ts` — env validation, payee normalization, retry config bounds.
- `anvil.integration.test.ts` — spawns `anvil`, deploys both contracts from foundry artifacts, signs a real quote via the service, and asserts `SpecialRelayer.requestDelivery` accepts it and forwards the fee to the payee. Auto-skips when `anvil` or the foundry artifacts (under `evm/out/`) aren't present.
