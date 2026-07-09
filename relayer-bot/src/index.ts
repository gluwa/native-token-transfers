export { loadConfig, parseRole } from "./config.js";
export type {
  RelayerBotConfig,
  RelayerRole,
  DeliveryConfig,
} from "./config.js";

export { makeChainRegistry, UnknownChainError } from "./chains.js";
export type { ChainConfig, ChainRegistry } from "./chains.js";

export { createLogger } from "./logger.js";
export type { Logger, LogFields, LogLevel } from "./logger.js";

export type { ChainId, Hex, TxStatus, TransactionRecord } from "./types.js";

export {
  SPECIAL_RELAYER_ABI,
  CORE_ABI,
  WORMHOLE_TRANSCEIVER_ABI,
  TRANSCEIVER_ERROR_ABI,
  EXECUTION_REQUESTED_TOPIC,
  LOG_MESSAGE_PUBLISHED_TOPIC,
  decodeTransceiverError,
  specialRelayerInterface,
  coreInterface,
  wormholeTransceiverInterface,
  transceiverErrorInterface,
} from "./abi.js";

export {
  DEFAULT_RETRY,
  isTransientRpcError,
  isTransientRedisError,
  withRetry,
} from "./retry.js";
export type { RetryOptions } from "./retry.js";

// ── relay core ──
export {
  encodeVaaBody,
  vaaBodyDoubleHash,
  packSignedVaa,
  parseSignedVaa,
  toUniversalAddress,
} from "./relay/vaa.js";
export type {
  VaaBodyFields,
  ParsedVaa,
  GuardianSignature,
} from "./relay/vaa.js";

export {
  DeferDeliveryError,
  RetriableDeliveryError,
  PermanentDeliveryError,
  vaaIdFromPayload,
} from "./relay/interfaces.js";
export type {
  VaaId,
  RelayPayload,
  DecodedEvent,
  EventSource,
  PrepareRequest,
  PreparedDelivery,
  PrepareResult,
  BroadcastRequest,
  DestinationDeliveryModule,
  ReceiptProvider,
} from "./relay/interfaces.js";

export {
  correlate,
  CorrelationError,
  ReceiptNotReadyError,
} from "./relay/correlator.js";
export type { ParsedExecutionRequested } from "./relay/correlator.js";

export {
  WormholescanVaaFetcher,
  DevGuardianVaaFetcher,
} from "./relay/vaaFetcher.js";
export type {
  VaaFetcher,
  WormholescanVaaFetcherOptions,
  DevGuardianVaaFetcherOptions,
} from "./relay/vaaFetcher.js";

export { RpcEventSource } from "./relay/eventSource.js";
export type { RpcEventSourceOptions } from "./relay/eventSource.js";

export { RpcDeliveryModule } from "./relay/delivery.js";
export type { RpcDeliveryModuleOptions } from "./relay/delivery.js";

// ── persistence ──
export { createPool, createPgDatabase } from "./db/pool.js";
export type { Database, Tx, Queryable, QueryResult } from "./db/pool.js";
export { runMigrations } from "./db/migrate.js";
export { TransactionsRepo } from "./db/transactions.js";
export type { InsertPendingInput } from "./db/transactions.js";
export { BlockTrackerRepo } from "./db/blockTracker.js";
export {
  advisoryKey,
  tryAcquireWalletLock,
  withLeaderLock,
} from "./db/advisoryLock.js";

// ── queue ──
export { QueueError } from "./queue/queue.js";
export type { Queue, RelayMessage, Delivery } from "./queue/queue.js";
export { InMemoryQueue } from "./queue/inMemory.js";
export type { InMemoryQueueOptions } from "./queue/inMemory.js";
export { RedisStreamsQueue } from "./queue/redisStreams.js";
export type { RedisStreamsQueueOptions } from "./queue/redisStreams.js";
export { computeBackoffDelayMs } from "./queue/backoff.js";
export type { BackoffOptions } from "./queue/backoff.js";

// ── wallet ──
export { KeyVaultSecretStore, EnvSecretStore } from "./wallet/secretStore.js";
export type { SecretStore } from "./wallet/secretStore.js";
export {
  createPgLockWalletPool,
  AllWalletsBusyError,
  UnknownWalletError,
} from "./wallet/walletPool.js";
export type {
  WalletPool,
  Lease,
  CreatePgLockWalletPoolOptions,
} from "./wallet/walletPool.js";
export { checkBalances } from "./wallet/balanceMonitor.js";
export type { BalanceMonitorOptions } from "./wallet/balanceMonitor.js";

// ── alerts ──
export { SlackAlerter, NoopAlerter, createAlerter } from "./alerts/alerter.js";
export type { Alerter, SlackAlerterOptions } from "./alerts/alerter.js";

// ── health ──
export { startHealthServer } from "./health.js";
export type { HealthHandle, StartHealthServerOptions } from "./health.js";

// ── receipt provider ──
export { RpcReceiptProvider } from "./relay/receiptProvider.js";
export type { RpcReceiptProviderOptions } from "./relay/receiptProvider.js";

// ── roles ──
export {
  runListener,
  scanChainOnce,
  republishPending,
} from "./roles/listener.js";
export type { ListenerDeps, ScanResult } from "./roles/listener.js";
export { runWorker, handleDelivery } from "./roles/worker.js";
export type { WorkerDeps } from "./roles/worker.js";
export { runCron, cronTick } from "./roles/cron.js";
export type { CronDeps } from "./roles/cron.js";
export { recordToMessage, recordPayload } from "./roles/shared.js";
