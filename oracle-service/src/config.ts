import { SigningKey, Wallet, getAddress } from "ethers";

import { assertUint64 } from "./scaling.js";
import type { RetryOptions } from "./retry.js";

/// Which token's USD price is written into the contract's `sourcePrice`.
///  - "twap":        ATTEST/USD (ATTEST has a direct USD market).
///  - "penguinswap": CTC/USD; the contract derives ATTEST via the on-chain ATTEST/CTC
///                   pool (see SMC-1681). Used at launch when ATTEST only trades vs CTC.
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
  /// Per-chain upward adjustment in basis points (uint64).
  priceBuffer: bigint;
  /// Flat fee in source-chain native wei (uint64).
  baseFee: bigint;
}

export interface OracleServiceConfig {
  /// Signing key — its address must equal PenguinBridgeExecutionQuoter.oracleService().
  signingKey: SigningKey;
  /// Address of the signer; precomputed.
  oracleAddress: string;
  /// JSON-RPC URL of the source chain, where the Quoter contract lives.
  rpcUrl: string;
  /// Address of PenguinBridgeExecutionQuoter on the source chain.
  contractAddress: string;
  /// Pricing mode used when the contract does not expose `pricingMode()` (pre-SMC-1681
  /// deployments). When the getter exists, the contract's mode always wins.
  fallbackMode: PricingMode | undefined;
  /// CoinGecko id priced into `sourcePrice`, per mode. Only the active mode's id is
  /// needed — e.g. at launch ATTEST has no USD market, so only the penguinswap id
  /// (CTC) exists.
  sourceTokenIds: Partial<Record<PricingMode, string>>;
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

function parseUint64Field(name: string, raw: unknown): bigint {
  if (typeof raw === "number") {
    if (!Number.isInteger(raw)) {
      throw new Error(`${name} must be an integer, got ${raw}`);
    }
    return assertUint64(BigInt(raw), name);
  }
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
    return assertUint64(BigInt(raw.trim()), name);
  }
  throw new Error(`${name} must be a non-negative integer, got ${String(raw)}`);
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
      priceBuffer: parseUint64Field(
        `ORACLE_CHAINS[${i}].priceBuffer`,
        c.priceBuffer ?? 0
      ),
      baseFee: parseUint64Field(`ORACLE_CHAINS[${i}].baseFee`, c.baseFee ?? 0),
    };
  });
}

function parseMode(raw: string): PricingMode {
  if (raw === "twap" || raw === "penguinswap") {
    return raw;
  }
  throw new Error(
    `ORACLE_PRICING_MODE must be "twap" or "penguinswap", got ${raw}`
  );
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env
): OracleServiceConfig {
  const wallet = new Wallet(required(env, "ORACLE_PRIVATE_KEY"));

  const rawMode = env["ORACLE_PRICING_MODE"];
  const fallbackMode =
    rawMode === undefined || rawMode.trim() === ""
      ? undefined
      : parseMode(rawMode.trim());
  const sourceTokenIds: Partial<Record<PricingMode, string>> = {};
  const twapId = env["ORACLE_SOURCE_TOKEN_ID_TWAP"];
  if (twapId) sourceTokenIds.twap = twapId;
  const penguinswapId = env["ORACLE_SOURCE_TOKEN_ID_PENGUINSWAP"];
  if (penguinswapId) sourceTokenIds.penguinswap = penguinswapId;
  if (!sourceTokenIds.twap && !sourceTokenIds.penguinswap) {
    throw new Error(
      "at least one of ORACLE_SOURCE_TOKEN_ID_TWAP / ORACLE_SOURCE_TOKEN_ID_PENGUINSWAP is required"
    );
  }
  if (fallbackMode && !sourceTokenIds[fallbackMode]) {
    throw new Error(
      `ORACLE_SOURCE_TOKEN_ID_${fallbackMode.toUpperCase()} is required when ORACLE_PRICING_MODE=${fallbackMode}`
    );
  }

  const pushIntervalMs = parseIntEnv(env, "ORACLE_PUSH_INTERVAL_MS", 60_000, 1);
  const twapWindowMs = parseIntEnv(env, "ORACLE_TWAP_WINDOW_MS", 300_000, 0);
  const txWaitTimeoutMs = parseIntEnv(
    env,
    "ORACLE_TX_WAIT_TIMEOUT_MS",
    120_000,
    1
  );

  const maxAttempts = parseIntEnv(env, "ORACLE_RPC_MAX_ATTEMPTS", 3, 1);
  const initialDelayMs = parseIntEnv(env, "ORACLE_RPC_INITIAL_DELAY_MS", 200, 0);
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
    fallbackMode,
    sourceTokenIds,
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
