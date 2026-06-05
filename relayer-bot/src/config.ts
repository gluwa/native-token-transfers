import { getAddress, parseEther } from "ethers";

import type { ChainConfig } from "./chains.js";
import type { RetryOptions } from "./retry.js";

export type RelayerRole = "listener" | "worker" | "cron" | "migrate";

const ROLES: readonly RelayerRole[] = ["listener", "worker", "cron", "migrate"];

export interface DeliveryConfig {
  /// Extra gas limit over the signed gasLimit, in basis points (1000 = +10%). Covers the
  /// transceiver→NttManager→token overhead beyond the inner call the quoter priced.
  gasLimitBufferBps: number;
  /// Extra gas limit (absolute), as a percent of the signed gasLimit, applied on retries.
  /// The doc's RETRY_ADDITIONAL_GAS_LIMIT.
  retryAdditionalGasPct: number;
  /// Per-attempt fee bump, in basis points (1500 = +15% per retry).
  gasPriceBumpBps: number;
  /// Hard ceiling on the effective max fee per gas (wei). 0n disables the ceiling.
  /// Above it, delivery defers rather than overpaying during a gas spike.
  maxGasPriceWei: bigint;
}

export interface RelayerBotConfig {
  role: RelayerRole;
  /// Chains the bot operates on (source and/or destination). Parsed from RELAYER_CHAINS.
  chains: ChainConfig[];
  /// Azure Key Vault secret *names* (not raw keys) for the delivery wallet pool. With
  /// useDevSecrets, these name RELAYER_WALLET_<name> env vars instead.
  walletSecretNames: string[];
  /// Read wallet keys from env (EnvSecretStore) instead of Key Vault. Dev/test only.
  useDevSecrets: boolean;
  /// Max block span per getLogs scan (the doc's SCAN_INTERVAL_MS, which is really a block
  /// count despite the name).
  scanBlockRange: number;
  /// Sleep between scan iterations, ms (the real loop delay; see SCAN_INTERVAL_MS note).
  scanLoopDelayMs: number;
  /// Queue visibility timeout (ms): an unacked in-flight message becomes visible again
  /// after this, so a crashed worker's message is reprocessed.
  queueVisibilityTimeoutMs: number;
  /// Alert threshold for a relayer wallet's gas balance (wei).
  walletMinBalanceWei: bigint;
  /// Max business retries before a relay is dead-lettered.
  maxRetries: number;
  /// Cron: rows in `submitted` older than this are re-checked against on-chain receipts.
  submittedTimeoutMin: number;
  /// Cron run interval (minutes).
  cronIntervalMin: number;
  /// VAA fetch: give up after this long and dead-letter (ms).
  vaaTimeoutMs: number;
  /// VAA fetch: delay between Wormholescan polls / requeues when the VAA isn't ready (ms).
  vaaPollIntervalMs: number;
  /// Dead-letter count above which the cron raises an alert.
  deadLetterAlertThreshold: number;
  databaseUrl: string;
  redisUrl: string;
  keyVaultUrl: string | undefined;
  wormholescanUrl: string;
  slackWebhookUrl: string | undefined;
  healthHost: string;
  healthPort: number;
  rpcRetry: RetryOptions;
  delivery: DeliveryConfig;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} env var is required`);
  }
  return value;
}

function parseIntInRange(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: string,
  min: number,
  max: number
): number {
  const value = Number(env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `${name} must be an integer in [${min}, ${max}], got ${env[name]}`
    );
  }
  return value;
}

function parseCsv(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

interface RawChain {
  chainId: number;
  name?: string;
  rpcUrl: string;
  specialRelayerAddress?: string;
  coreBridgeAddress?: string;
  expectedTransceiver?: string;
  confirmations?: number;
  genesisBlock?: string | number;
  evmChainId?: number;
}

function parseChains(raw: string): ChainConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("RELAYER_CHAINS must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("RELAYER_CHAINS must be a non-empty JSON array");
  }
  return parsed.map((entry, i): ChainConfig => {
    const c = entry as RawChain;
    if (!Number.isInteger(c.chainId) || c.chainId < 0 || c.chainId > 0xffff) {
      throw new Error(`RELAYER_CHAINS[${i}].chainId must be a uint16`);
    }
    if (typeof c.rpcUrl !== "string" || c.rpcUrl.length === 0) {
      throw new Error(`RELAYER_CHAINS[${i}].rpcUrl is required`);
    }
    const confirmations = c.confirmations ?? 1;
    if (!Number.isInteger(confirmations) || confirmations < 0) {
      throw new Error(`RELAYER_CHAINS[${i}].confirmations must be >= 0`);
    }
    let genesisBlock: bigint;
    try {
      genesisBlock = BigInt(c.genesisBlock ?? 0);
    } catch {
      throw new Error(`RELAYER_CHAINS[${i}].genesisBlock must be an integer`);
    }
    if (genesisBlock < 0n) {
      throw new Error(`RELAYER_CHAINS[${i}].genesisBlock must be >= 0`);
    }
    // Address fields are checksum-validated by makeChainRegistry; we only pass them through
    // here, but validate shape early for a clearer error.
    for (const [key, val] of [
      ["specialRelayerAddress", c.specialRelayerAddress],
      ["coreBridgeAddress", c.coreBridgeAddress],
      ["expectedTransceiver", c.expectedTransceiver],
    ] as const) {
      if (val !== undefined) {
        try {
          getAddress(val);
        } catch {
          throw new Error(`RELAYER_CHAINS[${i}].${key} is not a valid address`);
        }
      }
    }
    return {
      chainId: c.chainId,
      name: c.name ?? `chain-${c.chainId}`,
      rpcUrl: c.rpcUrl,
      specialRelayerAddress: c.specialRelayerAddress,
      coreBridgeAddress: c.coreBridgeAddress,
      expectedTransceiver: c.expectedTransceiver,
      confirmations,
      genesisBlock,
      evmChainId: c.evmChainId,
    };
  });
}

function loadRpcRetry(env: NodeJS.ProcessEnv): RetryOptions {
  const maxAttempts = parseIntInRange(
    env,
    "RELAYER_RPC_MAX_ATTEMPTS",
    "3",
    1,
    20
  );
  const initialDelayMs = parseIntInRange(
    env,
    "RELAYER_RPC_INITIAL_DELAY_MS",
    "200",
    0,
    60_000
  );
  const maxDelayMs = Number(env["RELAYER_RPC_MAX_DELAY_MS"] ?? "2000");
  if (!Number.isInteger(maxDelayMs) || maxDelayMs < initialDelayMs) {
    throw new Error(
      `RELAYER_RPC_MAX_DELAY_MS must be an integer >= RELAYER_RPC_INITIAL_DELAY_MS, got ${maxDelayMs}`
    );
  }
  return { maxAttempts, initialDelayMs, maxDelayMs };
}

function loadDelivery(env: NodeJS.ProcessEnv): DeliveryConfig {
  const maxGasPriceRaw = env["RELAYER_MAX_GAS_PRICE_WEI"];
  let maxGasPriceWei = 0n;
  if (maxGasPriceRaw && maxGasPriceRaw.length > 0) {
    try {
      maxGasPriceWei = BigInt(maxGasPriceRaw);
    } catch {
      throw new Error("RELAYER_MAX_GAS_PRICE_WEI must be an integer (wei)");
    }
    if (maxGasPriceWei < 0n) {
      throw new Error("RELAYER_MAX_GAS_PRICE_WEI must be >= 0");
    }
  }
  return {
    gasLimitBufferBps: parseIntInRange(
      env,
      "RELAYER_GAS_LIMIT_BUFFER_BPS",
      "1000",
      0,
      100_000
    ),
    retryAdditionalGasPct: parseIntInRange(
      env,
      "RELAYER_RETRY_ADDITIONAL_GAS_LIMIT",
      "10",
      0,
      1000
    ),
    gasPriceBumpBps: parseIntInRange(
      env,
      "RELAYER_GAS_PRICE_BUMP_BPS",
      "1500",
      0,
      100_000
    ),
    maxGasPriceWei,
  };
}

/// Whether a role uses a given dependency. Lets us validate only what the role needs, so a
/// listener doesn't require Key Vault config and a migrate job needs only the database.
function roleNeeds(role: RelayerRole): {
  chains: boolean;
  redis: boolean;
  wallets: boolean;
} {
  switch (role) {
    case "migrate":
      return { chains: false, redis: false, wallets: false };
    case "listener":
      return { chains: true, redis: true, wallets: false };
    case "cron":
      return { chains: true, redis: true, wallets: false };
    case "worker":
      return { chains: true, redis: true, wallets: true };
  }
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  role: RelayerRole = parseRole(env["RELAYER_ROLE"])
): RelayerBotConfig {
  const needs = roleNeeds(role);

  const chains = needs.chains
    ? parseChains(required(env, "RELAYER_CHAINS"))
    : [];

  const useDevSecrets =
    (env["RELAYER_USE_DEV_SECRETS"] ?? "false").toLowerCase() === "true";

  const walletSecretNames = needs.wallets
    ? parseCsv(required(env, "WALLETS"))
    : parseCsv(env["WALLETS"] ?? "");
  if (needs.wallets && walletSecretNames.length === 0) {
    throw new Error("WALLETS must list at least one secret name");
  }

  const keyVaultRaw = env["AZURE_KEY_VAULT_URL"];
  if (needs.wallets && !useDevSecrets && !keyVaultRaw) {
    throw new Error(
      "AZURE_KEY_VAULT_URL is required for the worker role unless RELAYER_USE_DEV_SECRETS=true"
    );
  }

  const walletMinBalanceWei = parseEther(env["WALLET_MIN_BALANCE"] ?? "0.05");
  if (walletMinBalanceWei <= 0n) {
    throw new Error("WALLET_MIN_BALANCE must be > 0");
  }

  return {
    role,
    chains,
    walletSecretNames,
    useDevSecrets,
    scanBlockRange: parseIntInRange(
      env,
      "SCAN_INTERVAL_MS",
      "200",
      1,
      1_000_000
    ),
    scanLoopDelayMs: parseIntInRange(
      env,
      "RELAYER_SCAN_LOOP_DELAY_MS",
      "2000",
      0,
      600_000
    ),
    queueVisibilityTimeoutMs: parseIntInRange(
      env,
      "QUEUE_VISIBILITY_TIMEOUT_MS",
      "60000",
      1000,
      3_600_000
    ),
    walletMinBalanceWei,
    maxRetries: parseIntInRange(env, "MAX_RETRIES", "2", 0, 100),
    submittedTimeoutMin: parseIntInRange(
      env,
      "SUBMITTED_TIMEOUT_MIN",
      "5",
      1,
      1440
    ),
    cronIntervalMin: parseIntInRange(env, "CRON_INTERVAL_MIN", "2", 1, 1440),
    vaaTimeoutMs: parseIntInRange(
      env,
      "RELAYER_VAA_TIMEOUT_MS",
      "1800000",
      1000,
      86_400_000
    ),
    vaaPollIntervalMs: parseIntInRange(
      env,
      "RELAYER_VAA_POLL_INTERVAL_MS",
      "5000",
      100,
      600_000
    ),
    deadLetterAlertThreshold: parseIntInRange(
      env,
      "DEAD_LETTER_ALERT_THRESHOLD",
      "1",
      1,
      1_000_000
    ),
    databaseUrl: required(env, "DATABASE_URL"),
    redisUrl: needs.redis
      ? required(env, "REDIS_URL")
      : (env["REDIS_URL"] ?? ""),
    keyVaultUrl: keyVaultRaw,
    wormholescanUrl: env["WORMHOLESCAN_URL"] ?? "https://api.wormholescan.io",
    slackWebhookUrl: env["SLACK_WEBHOOK_URL"],
    healthHost: env["RELAYER_HEALTH_HOST"] ?? "127.0.0.1",
    healthPort: parseIntInRange(env, "RELAYER_HEALTH_PORT", "8080", 0, 0xffff),
    rpcRetry: loadRpcRetry(env),
    delivery: loadDelivery(env),
  };
}

export function parseRole(raw: string | undefined): RelayerRole {
  if (!raw) {
    throw new Error(
      `role is required (set --role or RELAYER_ROLE to one of ${ROLES.join(", ")})`
    );
  }
  if (!ROLES.includes(raw as RelayerRole)) {
    throw new Error(
      `invalid role "${raw}"; must be one of ${ROLES.join(", ")}`
    );
  }
  return raw as RelayerRole;
}
