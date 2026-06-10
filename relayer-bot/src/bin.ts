#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { JsonRpcProvider, Network, type Provider } from "ethers";
import { Pool } from "pg";

import { createAlerter } from "./alerts/alerter.js";
import { type ChainRegistry, makeChainRegistry } from "./chains.js";
import {
  type RelayerBotConfig,
  type RelayerRole,
  loadConfig,
  parseRole,
} from "./config.js";
import { runMigrations } from "./db/migrate.js";
import { createPgDatabase } from "./db/pool.js";
import { type HealthHandle, startHealthServer } from "./health.js";
import { createLogger } from "./logger.js";
import { RedisStreamsQueue } from "./queue/redisStreams.js";
import { RpcDeliveryModule } from "./relay/delivery.js";
import { RpcEventSource } from "./relay/eventSource.js";
import { RpcReceiptProvider } from "./relay/receiptProvider.js";
import {
  DevGuardianVaaFetcher,
  type VaaFetcher,
  WormholescanVaaFetcher,
} from "./relay/vaaFetcher.js";
import { runCron } from "./roles/cron.js";
import { runListener } from "./roles/listener.js";
import { runWorker } from "./roles/worker.js";
import type { ChainId } from "./types.js";
import { EnvSecretStore, KeyVaultSecretStore } from "./wallet/secretStore.js";
import { checkBalances } from "./wallet/balanceMonitor.js";
import { createPgLockWalletPool } from "./wallet/walletPool.js";

function parseRoleArg(argv: string[], env: NodeJS.ProcessEnv): RelayerRole {
  const flag = argv.find((a) => a.startsWith("--role="));
  return parseRole(flag ? flag.slice("--role=".length) : env["RELAYER_ROLE"]);
}

/// Walk up from the executed entry script to the package root (the dir with package.json),
/// then migrations beside it. Uses process.argv[1] (the entry path) rather than
/// import.meta.url so the file also compiles under the CommonJS build. Handles both dev
/// (relayer-bot/src/...) and built (/app/dist/esm/...) layouts.
function resolveMigrationsDir(): string {
  let dir = dirname(process.argv[1] ?? process.cwd());
  for (let i = 0; i < 6; i++) {
    if (
      existsSync(join(dir, "migrations")) &&
      existsSync(join(dir, "package.json"))
    ) {
      return join(dir, "migrations");
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("could not locate the migrations directory");
}

function makeProviders(config: RelayerBotConfig): Map<ChainId, Provider> {
  const providers = new Map<ChainId, Provider>();
  for (const chain of config.chains) {
    const provider = chain.evmChainId
      ? new JsonRpcProvider(chain.rpcUrl, Network.from(chain.evmChainId), {
          staticNetwork: true,
        })
      : new JsonRpcProvider(chain.rpcUrl);
    providers.set(chain.chainId, provider);
  }
  return providers;
}

function makeQueue(config: RelayerBotConfig): RedisStreamsQueue {
  return new RedisStreamsQueue({
    url: config.redisUrl,
    visibilityTimeoutMs: config.queueVisibilityTimeoutMs,
  });
}

function makeVaaFetcher(
  config: RelayerBotConfig,
  registry: ChainRegistry,
  providers: Map<ChainId, Provider>,
  env: NodeJS.ProcessEnv
): VaaFetcher {
  const devKey = env["RELAYER_DEV_GUARDIAN_KEY"];
  if (devKey) {
    return new DevGuardianVaaFetcher({
      guardianKey: devKey,
      sourceProviderFor: (id) => {
        const p = providers.get(id);
        if (!p) throw new Error(`no provider for chain ${id}`);
        return p;
      },
      coreAddressFor: (id) => {
        const core = registry.require(id).coreBridgeAddress;
        if (!core) throw new Error(`chain ${id} has no coreBridgeAddress`);
        return core;
      },
      retry: config.rpcRetry,
    });
  }
  return new WormholescanVaaFetcher({
    baseUrl: config.wormholescanUrl,
    retry: config.rpcRetry,
  });
}

/// Verify RPC connectivity for every chain before running, so we fail loudly rather than
/// silently misbehaving (the quoter-service `assertAuthorized` pattern).
async function checkRpc(
  providers: Map<ChainId, Provider>,
  logger: ReturnType<typeof createLogger>
): Promise<void> {
  await Promise.all(
    [...providers].map(async ([chainId, provider]) => {
      const block = await provider.getBlockNumber();
      logger.info("startup.rpc_ok", { chain_id: chainId, head: block });
    })
  );
}

async function main(): Promise<void> {
  const env = process.env;
  const role = parseRoleArg(process.argv.slice(2), env);
  const config = loadConfig(env, role);
  const logger = createLogger({ role });

  const pool = new Pool({ connectionString: config.databaseUrl });
  const db = createPgDatabase(pool);

  try {
    await db.query("SELECT 1");
  } catch (err) {
    logger.error("startup.db_check_failed", { error: String(err) });
    await pool.end();
    process.exit(1);
  }

  // migrate role: run and exit.
  if (role === "migrate") {
    try {
      const ran = await runMigrations(pool, resolveMigrationsDir());
      logger.info("migrate.done", { applied: ran.join(",") || "(none)" });
      await pool.end();
      process.exit(0);
    } catch (err) {
      logger.error("migrate.failed", { error: String(err) });
      await pool.end();
      process.exit(1);
    }
  }

  // All long-running roles self-heal the schema, then verify RPC connectivity.
  await runMigrations(pool, resolveMigrationsDir());
  const providers = makeProviders(config);
  try {
    await checkRpc(providers, logger);
  } catch (err) {
    logger.error("startup.rpc_check_failed", { error: String(err) });
    process.exit(1);
  }

  const registry = makeChainRegistry(config.chains);
  const alerter = createAlerter(config.slackWebhookUrl, logger);
  const queue = makeQueue(config);
  const controller = new AbortController();
  const health: HealthHandle = startHealthServer({
    host: config.healthHost,
    port: config.healthPort,
    role,
    logger,
    maxHeartbeatAgeMs: config.cronIntervalMin * 60_000 * 3,
  });

  const cleanup: Array<() => Promise<void>> = [
    () => health.close(),
    () => queue.close(),
    () => db.close(),
    async () => {
      for (const p of providers.values()) {
        (p as { destroy?: () => void }).destroy?.();
      }
    },
  ];

  // Signal the run loop to wind down; it finishes the in-flight delivery and returns, then
  // we tear down resources (below). A safety net force-exits if the loop hangs.
  const shutdown = (signal: string): void => {
    logger.info("shutdown.signal", { signal });
    controller.abort();
    setTimeout(() => {
      logger.error("shutdown.forced", {
        reason: "run loop did not exit in time",
      });
      process.exit(1);
    }, 30_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  try {
    await runRole(role, {
      config,
      db,
      pool,
      queue,
      registry,
      providers,
      alerter,
      logger,
      health,
      env,
      signal: controller.signal,
    });
  } finally {
    // The run loop has wound down (in-flight work settled) — now close resources.
    for (const fn of cleanup) {
      try {
        await fn();
      } catch (err) {
        logger.error("shutdown.cleanup_error", { error: String(err) });
      }
    }
  }
  process.exit(0);
}

interface RunRoleDeps {
  config: RelayerBotConfig;
  db: ReturnType<typeof createPgDatabase>;
  pool: Pool;
  queue: RedisStreamsQueue;
  registry: ChainRegistry;
  providers: Map<ChainId, Provider>;
  alerter: ReturnType<typeof createAlerter>;
  logger: ReturnType<typeof createLogger>;
  health: HealthHandle;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}

async function runRole(role: RelayerRole, deps: RunRoleDeps): Promise<void> {
  const {
    config,
    db,
    pool,
    queue,
    registry,
    providers,
    alerter,
    logger,
    health,
    env,
    signal,
  } = deps;

  if (role === "listener") {
    const eventSource = new RpcEventSource({
      registry,
      providers,
      retry: config.rpcRetry,
      logger,
    });
    await runListener(
      {
        config,
        db,
        queue,
        eventSource,
        logger,
        alerter,
        heartbeat: health.heartbeat,
      },
      signal
    );
  } else if (role === "worker") {
    const secretStore = config.useDevSecrets
      ? new EnvSecretStore(env)
      : new KeyVaultSecretStore(config.keyVaultUrl as string);
    const walletPool = await createPgLockWalletPool({
      db,
      secretStore,
      walletNames: config.walletSecretNames,
      providers,
      logger,
    });
    const vaaFetcher = makeVaaFetcher(config, registry, providers, env);
    const delivery = new RpcDeliveryModule({
      registry,
      providers,
      vaaFetcher,
      delivery: config.delivery,
      retry: config.rpcRetry,
    });
    await checkBalances({
      addresses: walletPool.addresses(),
      providers,
      minBalanceWei: config.walletMinBalanceWei,
      alerter,
      logger,
    });
    await runWorker(
      {
        config,
        db,
        pool,
        queue,
        walletPool,
        delivery,
        logger,
        alerter,
        // Own every source-chain partition; each is drained FIFO, partitions run in
        // parallel. Other replicas stand by and take over a partition on failover.
        partitions: config.chains
          .filter((c) => c.specialRelayerAddress)
          .map((c) => c.chainId),
        heartbeat: health.heartbeat,
      },
      signal
    );
  } else {
    // cron
    const receipts = new RpcReceiptProvider({
      providers,
      retry: config.rpcRetry,
    });
    await runCron(
      {
        config,
        db,
        pool,
        queue,
        receipts,
        logger,
        alerter,
        heartbeat: health.heartbeat,
      },
      signal
    );
  }
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
