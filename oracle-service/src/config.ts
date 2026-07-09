import { SigningKey, Wallet, getAddress } from "ethers";

import { assertUint16 } from "./scaling.js";
import type { RetryOptions } from "./retry.js";

/// How the quoter derives the ATTEST↔native rate (read from `pricingMode()`; enum
/// TWAP = 0, PENGUIN_SWAP = 1 in IUSCRelayingQuoter). In BOTH modes the oracle pushes
/// CTC/USD as `sourcePrice` (the mode-independent anchor) and native/USD as `dstPrice`;
/// the modes differ in where ctcPerAttest comes from:
///  - "twap":        this service also derives ctcPerAttest = attestUsd / ctcUsd off
///                   CoinGecko and pushes it into the on-chain TWAPReader each tick.
///  - "penguinswap": the contract reads ctcPerAttest live from the ATTEST/CTC
///                   PenguinSwap pool — no reader push needed.
export type PricingMode = "twap" | "penguinswap";

/// Per-destination-chain configuration. `priceBuffer` and `baseFee` are operator-set
/// (not market-derived); `dstPrice` and `dstGasPrice` are filled in per tick from
/// CoinGecko and the chain's RPC respectively.
export interface ChainConfig {
  /// Wormhole chain id (uint16).
  chainId: number;
  /// JSON-RPC URL of the destination chain — read for current gas price.
  rpcUrl: string;
  /// CoinGecko id of the chain's native token (e.g. "ethereum", "binancecoin").
  coingeckoId: string;
  /// Per-chain upward adjustment in parts per 100,000 (the contract's
  /// BPS_DENOMINATOR); uint16, so at most 65,535 (= +65.5%).
  priceBuffer: bigint;
  /// Flat fee in CTC wei (uint256 on-chain).
  baseFee: bigint;
}

export interface OracleServiceConfig {
  /// Signing key — its address must equal USCRelayingQuoter.oracleService() (and the
  /// TWAPReader's, for TWAP mode).
  signingKey: SigningKey;
  /// Address of the signer; precomputed.
  oracleAddress: string;
  /// JSON-RPC URL of the source chain, where the Quoter contract lives.
  rpcUrl: string;
  /// Address of USCRelayingQuoter on the source chain.
  contractAddress: string;
  /// CoinGecko id of CTC — priced into the mode-independent `sourcePrice` anchor and
  /// each chain's `srcPrice` every tick. Always required.
  ctcTokenId: string;
  /// CoinGecko id of ATTEST — needed in TWAP mode to derive ctcPerAttest for the
  /// TWAPReader push. A tick that finds the contract in twap mode without this id is
  /// skipped (and startup aborts).
  attestTokenId: string | undefined;
  /// CoinGecko REST base URL.
  coingeckoBaseUrl: string;
  /// Optional CoinGecko API key (sent as x-cg-demo-api-key / x-cg-pro-api-key).
  coingeckoApiKey: string | undefined;
  /// Interval between price pushes, in milliseconds.
  pushIntervalMs: number;
  /// Rolling window over which prices are time-weighted, in milliseconds.
  twapWindowMs: number;
  /// How long to wait for a batchPriceUpdate receipt before treating the tick as
  /// failed, in milliseconds. Bounds a stuck transaction so the push loop never hangs.
  txWaitTimeoutMs: number;
  /// Destination chains to price.
  chains: ChainConfig[];
  /// File touched after each successful push, for the container healthcheck.
  heartbeatFile: string | undefined;
  /// Retry policy applied to RPC and CoinGecko reads.
  retry: RetryOptions;
}

interface RawChainConfig {
  chainId?: unknown;
  rpcUrl?: unknown;
  coingeckoId?: unknown;
  priceBuffer?: unknown;
  baseFee?: unknown;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} env var is required`);
  }
  return value;
}

function parseIntEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number
): number {
  const raw = env[name];
  // Empty/whitespace counts as unset (e.g. compose interpolating an undefined var),
  // not as 0 — Number("") === 0 would silently disable interval/window settings.
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}, got ${raw}`);
  }
  return value;
}

/// Parse an amount field (`priceBuffer`, `baseFee` in wei). Per EVM convention these
/// must be **decimal strings**: a bare JSON number loses precision in `JSON.parse` once
/// it exceeds 2^53 (a `baseFee` of 1e16 wei ≈ 0.01 CTC already does), and `JSON.parse`
/// corrupts it before we ever see it. Omitted ⇒ 0.
function parseAmountField(name: string, raw: unknown): bigint {
  if (raw === undefined || raw === null) {
    return 0n;
  }
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
    return BigInt(raw.trim());
  }
  throw new Error(
    `${name} must be a non-negative integer encoded as a string (e.g. "1000000000000000"), got ${String(raw)}`
  );
}

function parseChains(raw: string): ChainConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("ORACLE_CHAINS must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("ORACLE_CHAINS must be a non-empty JSON array");
  }
  const seen = new Set<number>();
  return parsed.map((item, i) => {
    if (typeof item !== "object" || item === null) {
      throw new Error(`ORACLE_CHAINS[${i}] must be an object`);
    }
    const c = item as RawChainConfig;
    const chainId = c.chainId;
    if (
      typeof chainId !== "number" ||
      !Number.isInteger(chainId) ||
      chainId < 0 ||
      chainId > 0xffff
    ) {
      throw new Error(`ORACLE_CHAINS[${i}].chainId must be a uint16`);
    }
    if (seen.has(chainId)) {
      throw new Error(`ORACLE_CHAINS has duplicate chainId ${chainId}`);
    }
    seen.add(chainId);
    if (typeof c.rpcUrl !== "string" || c.rpcUrl.length === 0) {
      throw new Error(`ORACLE_CHAINS[${i}].rpcUrl must be a non-empty string`);
    }
    if (typeof c.coingeckoId !== "string" || c.coingeckoId.length === 0) {
      throw new Error(
        `ORACLE_CHAINS[${i}].coingeckoId must be a non-empty string`
      );
    }
    return {
      chainId,
      rpcUrl: c.rpcUrl,
      coingeckoId: c.coingeckoId,
      // uint16 on-chain (PricingData.priceBuffer) — reject anything larger here
      // rather than letting the ABI encoder throw mid-tick.
      priceBuffer: assertUint16(
        parseAmountField(`ORACLE_CHAINS[${i}].priceBuffer`, c.priceBuffer),
        `ORACLE_CHAINS[${i}].priceBuffer`
      ),
      baseFee: parseAmountField(`ORACLE_CHAINS[${i}].baseFee`, c.baseFee),
    };
  });
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env
): OracleServiceConfig {
  const wallet = new Wallet(required(env, "ORACLE_PRIVATE_KEY"));

  // CTC is priced every tick regardless of mode (sourcePrice anchor + per-chain
  // srcPrice). ATTEST is only needed while the contract is in twap mode — the mode is
  // read from the contract each tick, so leaving it unset simply means twap-mode ticks
  // are skipped (and startup aborts if twap is the active mode).
  const ctcTokenId = required(env, "ORACLE_CTC_TOKEN_ID");
  const attestTokenId = env["ORACLE_ATTEST_TOKEN_ID"] || undefined;

  // Floor of 15s: anything faster hammers CoinGecko (429s on the free tier) and sends
  // a tx per tick — a mistyped value like "150" should fail loudly, not DoS ourselves.
  const pushIntervalMs = parseIntEnv(
    env,
    "ORACLE_PUSH_INTERVAL_MS",
    60_000,
    15_000
  );
  // 0 is valid: it disables time-weighting (every push is spot).
  const twapWindowMs = parseIntEnv(env, "ORACLE_TWAP_WINDOW_MS", 300_000, 0);
  const txWaitTimeoutMs = parseIntEnv(
    env,
    "ORACLE_TX_WAIT_TIMEOUT_MS",
    120_000,
    1
  );

  const maxAttempts = parseIntEnv(env, "ORACLE_RPC_MAX_ATTEMPTS", 3, 1);
  const initialDelayMs = parseIntEnv(
    env,
    "ORACLE_RPC_INITIAL_DELAY_MS",
    200,
    0
  );
  const maxDelayMs = parseIntEnv(env, "ORACLE_RPC_MAX_DELAY_MS", 2_000, 0);
  if (maxDelayMs < initialDelayMs) {
    throw new Error(
      `ORACLE_RPC_MAX_DELAY_MS must be >= ORACLE_RPC_INITIAL_DELAY_MS`
    );
  }

  return {
    signingKey: wallet.signingKey,
    oracleAddress: getAddress(wallet.address),
    rpcUrl: required(env, "ORACLE_RPC_URL"),
    contractAddress: getAddress(required(env, "ORACLE_CONTRACT_ADDRESS")),
    ctcTokenId,
    attestTokenId,
    coingeckoBaseUrl:
      env["ORACLE_COINGECKO_BASE_URL"] ?? "https://api.coingecko.com/api/v3",
    coingeckoApiKey: env["ORACLE_COINGECKO_API_KEY"] || undefined,
    pushIntervalMs,
    twapWindowMs,
    txWaitTimeoutMs,
    chains: parseChains(required(env, "ORACLE_CHAINS")),
    heartbeatFile: env["ORACLE_HEARTBEAT_FILE"] || undefined,
    retry: { maxAttempts, initialDelayMs, maxDelayMs },
  };
}
