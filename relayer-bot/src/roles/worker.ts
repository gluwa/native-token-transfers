import type { Signer } from "ethers";
import type { Pool } from "pg";

import type { RelayerBotConfig } from "../config.js";
import { advisoryKey, withLeaderLock } from "../db/advisoryLock.js";
import type { Database } from "../db/pool.js";
import {
  TransactionsRepo,
  type InsertPendingInput,
} from "../db/transactions.js";
import type { Logger } from "../logger.js";
import type { Alerter } from "../alerts/alerter.js";
import { computeBackoffDelayMs } from "../queue/backoff.js";
import type { Delivery, Queue, RelayMessage } from "../queue/queue.js";
import {
  DeferDeliveryError,
  type DestinationDeliveryModule,
  PermanentDeliveryError,
  type PrepareResult,
  type RelayPayload,
} from "../relay/interfaces.js";
import type { ChainId, Hex, TransactionRecord } from "../types.js";
import { AllWalletsBusyError, type WalletPool } from "../wallet/walletPool.js";
import { realSleep, recordPayload } from "./shared.js";

export interface WorkerDeps {
  config: RelayerBotConfig;
  db: Database;
  queue: Queue;
  walletPool: WalletPool;
  delivery: DestinationDeliveryModule;
  logger: Logger;
  alerter: Alerter;
  /// Source-chain partitions this worker may own. Each is consumed by one owner at a time
  /// (the partition lock), one message at a time, in order → FIFO per source chain.
  partitions?: ChainId[];
  blockMs?: number;
  /// Delay before retrying to acquire a partition owned by another worker.
  partitionRetryMs?: number;
  heartbeat?: () => void;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /// Provided in production for the per-message + partition locks (session advisory locks).
  pool?: Pool;
  /// Test seam — run the per-message critical section under a lock. Returns false if the
  /// lock is held elsewhere (another consumer is processing this exact message).
  runUnderMessageLock?: (
    key: bigint,
    fn: () => Promise<void>
  ) => Promise<boolean>;
  /// Test seam — run the partition consumer loop while holding the partition-ownership
  /// lock. Returns false if another worker owns the partition. `fn` receives a `lockLost`
  /// probe (see withLeaderLock) so the drain loop stands down if the lock session dies.
  runUnderPartitionLock?: (
    partition: ChainId,
    fn: (lockLost?: () => boolean) => Promise<void>
  ) => Promise<boolean>;
}

function messageToInsert(
  m: RelayMessage,
  maxRetries: number
): InsertPendingInput {
  const payload = m.transaction_data as RelayPayload;
  return {
    sourceChainId: m.chain_id,
    destinationChainId: payload.dstChain,
    relayerAddress: m.relayer_address,
    eventTxHash: m.transaction_hash,
    payload,
    maxRetries,
  };
}

/// Acquire a per-message lock — keyed on (source_chain, event_tx_hash) — so a
/// visibility-timeout reclaim can't let a second consumer process the same message
/// concurrently, then process it. If the lock is held elsewhere, skip: the holder owns it
/// (and will ack it for the group).
export async function handleDelivery(
  deps: WorkerDeps,
  delivery: Delivery
): Promise<void> {
  const m = delivery.message;
  const key = advisoryKey(`msg:${m.chain_id}:${m.transaction_hash}`);
  const runLocked =
    deps.runUnderMessageLock ??
    ((k: bigint, fn: () => Promise<void>): Promise<boolean> =>
      deps.pool ? withLeaderLock(deps.pool, k, fn) : fn().then(() => true));
  const acquired = await runLocked(key, () => processDelivery(deps, delivery));
  if (!acquired) {
    deps.logger.info("worker.skip_locked", {
      chain_id: m.chain_id,
      event_tx_hash: m.transaction_hash,
    });
  }
}

/// Process one delivery: idempotency guard → ensure a pending row → prepare (no wallet) →
/// broadcast inside the wallet lock → record submitted/confirmed → ack. On failure,
/// classify and route to nack/dead-letter.
async function processDelivery(
  deps: WorkerDeps,
  delivery: Delivery
): Promise<void> {
  const { db, queue, walletPool, delivery: module, config } = deps;
  const m = delivery.message;
  const log = deps.logger.child({
    chain_id: m.chain_id,
    event_tx_hash: m.transaction_hash,
  });

  // Idempotency guard. Terminal states (`confirmed`, `dead_letter`) always skip —
  // otherwise a lingering replace_nonce message for a dead-lettered row would loop
  // forever (broadcast → nonce-too-low → defer → nack, never spending budget).
  // `submitted` is skipped too, UNLESS this message is an intentional resubmit (the
  // cron's stuck-retry carries replace_nonce). A `submitting` row is NEVER skipped —
  // it's a crash recovery that must resubmit its committed nonce.
  const skip = (status: string): boolean =>
    status === "confirmed" ||
    status === "dead_letter" ||
    (status === "submitted" && m.replace_nonce === undefined);

  const existing = await TransactionsRepo.findBySourceEvent(
    db,
    m.chain_id,
    m.transaction_hash
  );
  if (existing && skip(existing.status)) {
    log.info("worker.skip_idempotent", { status: existing.status });
    await queue.ack(delivery);
    return;
  }

  const rec =
    existing ??
    (await TransactionsRepo.insertPending(
      db,
      messageToInsert(m, config.maxRetries)
    ));
  if (skip(rec.status)) {
    await queue.ack(delivery);
    return;
  }

  // A replace_nonce message is an instruction to rebroadcast ONE SPECIFIC reserved nonce.
  // If the row no longer holds that nonce (it moved on to a fresh reservation, or the
  // nonce was cleared on terminalization), the message is a stale duplicate — honoring it
  // would broadcast an unreserved (wallet, nonce) pair and clobber the newer attempt's
  // record. Drop it; whatever moved the row on owns it now.
  if (m.replace_nonce !== undefined && rec.nonceUsed !== m.replace_nonce) {
    log.info("worker.skip_stale_replace", {
      replace_nonce: m.replace_nonce,
      nonce_used: rec.nonceUsed,
      status: rec.status,
    });
    await queue.ack(delivery);
    return;
  }

  const retryAttempt = rec.retryCount; // DB drives gas-bump escalation across retries

  // A row already in `submitting` (crash recovery) or carrying replace_nonce (cron
  // stuck-retry) holds a COMMITTED nonce: every failure must resubmit THAT nonce (never a
  // fresh one), so its pre-broadcast failures route to handleSubmittingFailure (which keeps
  // the nonce counted). A fresh row reserves a new nonce and routes pre-commit failures to
  // handleDeliveryFailure. (Computed before prepare so the prepare catch can route too —
  // this is the fix for prematurely dead-lettering a recovered row on a retriable prepare
  // error.)
  const resubmitNonce =
    m.replace_nonce ?? (rec.status === "submitting" ? rec.nonceUsed : null);
  const isResubmit = resubmitNonce !== null && rec.walletUsed !== null;
  const routePreCommitFailure = (err: unknown): Promise<void> =>
    isResubmit
      ? handleSubmittingFailure(deps, delivery, rec, err, log)
      : handleDeliveryFailure(deps, delivery, rec, err, log);

  // Phase 1: prepare (no wallet held) — fetch VAA, validate, isVAAConsumed, estimate gas.
  let prepared: PrepareResult;
  try {
    prepared = await module.prepare({
      destinationChainId: rec.destinationChainId,
      payload: recordPayload(rec),
      retryAttempt,
    });
  } catch (err) {
    await routePreCommitFailure(err);
    return;
  }

  if (prepared.kind === "already-consumed") {
    await TransactionsRepo.markConfirmed(db, rec.id);
    log.info("tx.transition", {
      from: rec.status,
      to: "confirmed",
      reason: "already_consumed",
    });
    await queue.ack(delivery);
    return;
  }

  // Phase 2a: secure a nonce. Resubmit reuses the committed nonce on the same wallet (no
  // new reservation, lock-free). A fresh send reserves a wallet+nonce and commits
  // `submitting` BEFORE broadcasting (the intent log), so a crash can't orphan the tx.
  const ready = prepared.prepared;
  let address: string;
  let nonce: number;
  let signer: Signer;
  try {
    if (isResubmit) {
      address = rec.walletUsed as string;
      nonce = resubmitNonce as number;
      signer = walletPool.signerFor(address, rec.destinationChainId);
    } else {
      const lease = await walletPool.reserve(
        rec.destinationChainId,
        async (tx, l) => {
          const ok = await TransactionsRepo.markSubmitting(tx, rec.id, {
            walletUsed: l.address,
            nonceUsed: l.nonce,
          });
          // 0 rows updated => the row left pending/failed/submitting concurrently (e.g. the
          // cron confirmed it from a receipt). Throw so reserve() rolls back the reservation
          // (releasing the nonce) instead of broadcasting against a stale row.
          if (!ok) {
            throw new Error(
              `markSubmitting updated no row for ${rec.id} (status changed concurrently)`
            );
          }
        }
      );
      ({ address, nonce, signer } = lease);
    }
  } catch (err) {
    // Pre-commit failure (no free wallet / unknown wallet). reserve() rolls back its tx on
    // throw, so a fresh row has no committed nonce here.
    await routePreCommitFailure(err);
    return;
  }

  // Phase 2b: broadcast (lock-free). From here the nonce is durably reserved as
  // `submitting`, so broadcast failures must resubmit THIS nonce (never a fresh one).
  let txHash: Hex;
  try {
    txHash = await module.broadcast({ prepared: ready, signer, nonce });
  } catch (err) {
    await handleSubmittingFailure(deps, delivery, rec, err, log);
    return;
  }

  const recorded = await TransactionsRepo.markSubmitted(db, rec.id, {
    relayTxHash: txHash,
    walletUsed: address,
    nonceUsed: nonce,
  });
  if (!recorded) {
    // The row was terminalized concurrently (cron confirmed or dead-lettered it) AFTER we
    // broadcast. The tx is on the wire but the canonical record doesn't point at it —
    // surface it loudly for reconciliation instead of logging a false "submitted".
    log.error("worker.submitted_record_lost", {
      relay_tx_hash: txHash,
      wallet_used: address,
      nonce,
    });
    await deps.alerter.alert("tx.submitted_record_lost", {
      chain_id: m.chain_id,
      event_tx_hash: m.transaction_hash,
      relay_tx_hash: txHash,
    });
    await queue.ack(delivery);
    return;
  }
  log.info("tx.transition", {
    from: rec.status,
    to: "submitted",
    wallet_used: address,
    relay_tx_hash: txHash,
    nonce,
    resubmit: isResubmit,
  });
  await queue.ack(delivery);
}

/// Failure AFTER the nonce was committed (`submitting`/`submitted`). We must NOT allocate a
/// fresh nonce — the next attempt resubmits this one. Keep the row in its committed state
/// (so the nonce stays counted and isn't handed out twice) and re-drive, or dead-letter.
async function handleSubmittingFailure(
  deps: WorkerDeps,
  delivery: Delivery,
  rec: TransactionRecord,
  err: unknown,
  log: Logger
): Promise<void> {
  const { db, queue, config } = deps;

  if (err instanceof PermanentDeliveryError) {
    log.error("tx.transition", {
      from: rec.status,
      to: "dead_letter",
      error: err.message,
    });
    await TransactionsRepo.markDeadLetter(db, rec.id, err.message);
    await queue.deadLetter(delivery, err.message);
    return;
  }

  if (err instanceof DeferDeliveryError) {
    // nonce-too-low (the prior tx mined → the next prepare's isVAAConsumed confirms it) or
    // transient. Re-drive (resubmit the same nonce) without spending the budget. Touch the
    // row so the cron's staleness scan knows it's actively driven, not abandoned.
    await TransactionsRepo.touch(db, rec.id);
    await queue.nack(delivery, { delayMs: config.vaaPollIntervalMs });
    return;
  }

  // Retriable / unexpected: bump the budget but stay in the committed state; the re-drive
  // resubmits the same nonce with a higher fee. Dead-letter when exhausted.
  const errMsg = err instanceof Error ? err.message : String(err);
  const budget = await TransactionsRepo.incrementRetry(db, rec.id);
  if (!budget) {
    // The row left the resubmittable state concurrently (e.g. the cron confirmed it from a
    // receipt while we were broadcasting). Don't dead-letter a row that's already resolved —
    // just ack and move on.
    log.info("worker.resubmit_noop", {
      reason: "row no longer submitting/submitted",
    });
    await queue.ack(delivery);
    return;
  }
  if (budget.retryCount >= budget.maxRetries) {
    log.error("tx.transition", {
      from: rec.status,
      to: "dead_letter",
      error: errMsg,
    });
    await TransactionsRepo.markDeadLetter(db, rec.id, errMsg);
    await queue.deadLetter(delivery, errMsg);
  } else {
    log.warn("worker.resubmit_scheduled", {
      retry_count: budget.retryCount,
      error: errMsg,
    });
    await queue.nack(delivery, {
      delayMs: computeBackoffDelayMs(budget.retryCount),
    });
  }
}

async function handleDeliveryFailure(
  deps: WorkerDeps,
  delivery: Delivery,
  rec: TransactionRecord,
  err: unknown,
  log: Logger
): Promise<void> {
  const { db, queue, config } = deps;
  const now = deps.now ?? (() => Date.now());
  const recId = rec.id;
  const createdAt = rec.createdAt;
  const fromStatus = rec.status;

  if (err instanceof AllWalletsBusyError) {
    log.warn("worker.wallets_busy", {});
    // Back off WITHOUT spending the retry budget. Touch so the cron's lost-message sweep
    // doesn't republish a row whose message is alive in the delay set.
    await TransactionsRepo.touch(db, recId);
    await queue.nack(delivery, {
      delayMs: computeBackoffDelayMs(delivery.deliveryAttempt),
    });
    return;
  }

  if (err instanceof DeferDeliveryError) {
    const ageMs = now() - createdAt.getTime();
    if (ageMs > config.vaaTimeoutMs) {
      const reason = `defer timeout after ${ageMs}ms: ${err.message}`;
      log.error("tx.transition", {
        from: fromStatus,
        to: "dead_letter",
        error: reason,
      });
      await TransactionsRepo.markFailed(db, recId, reason);
      await TransactionsRepo.markDeadLetter(db, recId, reason);
      await queue.deadLetter(delivery, reason);
    } else {
      // Not a failure — try again soon without spending the retry budget. Touch so the
      // cron knows this row is actively driven (its message lives in the delay set).
      await TransactionsRepo.touch(db, recId);
      await queue.nack(delivery, { delayMs: config.vaaPollIntervalMs });
    }
    return;
  }

  if (err instanceof PermanentDeliveryError) {
    log.error("tx.transition", {
      from: fromStatus,
      to: "dead_letter",
      error: err.message,
    });
    await TransactionsRepo.markFailed(db, recId, err.message);
    await TransactionsRepo.markDeadLetter(db, recId, err.message);
    await queue.deadLetter(delivery, err.message);
    return;
  }

  // RetriableDeliveryError or anything unexpected → failed; retry with backoff (the DB
  // retry_count, read on redelivery, raises the gas bump) or dead-letter when exhausted.
  const errMsg = err instanceof Error ? err.message : String(err);
  const failure = await TransactionsRepo.markFailed(db, recId, errMsg);
  if (!failure || failure.retryCount >= failure.maxRetries) {
    log.error("tx.transition", {
      from: fromStatus,
      to: "dead_letter",
      error: errMsg,
    });
    await TransactionsRepo.markDeadLetter(db, recId, errMsg);
    await queue.deadLetter(delivery, errMsg);
  } else {
    log.warn("tx.transition", {
      from: fromStatus,
      to: "failed",
      retry_count: failure.retryCount,
      error: errMsg,
    });
    await queue.nack(delivery, {
      delayMs: computeBackoffDelayMs(failure.retryCount),
    });
  }
}

/// Drain ONE partition while we own it: reclaim handed-over in-flight messages, then pull
/// fresh ones — ONE at a time, in stream order, each processed to completion before the
/// next. This is the FIFO guarantee per source chain. consume() long-polls so an idle
/// partition doesn't spin.
async function drainPartition(
  deps: WorkerDeps,
  partition: ChainId,
  blockMs: number,
  signal: AbortSignal,
  lockLost?: () => boolean
): Promise<void> {
  const handle = async (d: Delivery): Promise<void> => {
    try {
      await handleDelivery(deps, d);
    } catch (err) {
      deps.logger.error("worker.handle_error", {
        chain_id: partition,
        event_tx_hash: d.message.transaction_hash,
        error: String(err),
      });
    }
  };
  // Stand down if the partition-lock session died: Postgres freed the lock, so another
  // worker may already own this partition — continuing would break FIFO with two owners.
  const lost = (): boolean => lockLost?.() ?? false;
  while (!signal.aborted && !lost()) {
    for (const d of await deps.queue.reclaimExpired(partition, { max: 1 })) {
      await handle(d);
    }
    if (signal.aborted || lost()) break;
    for (const d of await deps.queue.consume(partition, { max: 1, blockMs })) {
      await handle(d);
    }
    deps.heartbeat?.();
  }
  if (lost()) {
    deps.logger.warn("worker.partition_lock_lost", { chain_id: partition });
  }
}

/// Long-running worker: own each source-chain partition (one owner at a time via the
/// partition lock) and drain it sequentially. Partitions run concurrently with each other,
/// so throughput scales across chains while staying FIFO within a chain. A partition owned
/// by another worker is retried later (failover when that worker dies).
export async function runWorker(
  deps: WorkerDeps,
  signal: AbortSignal
): Promise<void> {
  const blockMs = deps.blockMs ?? 5000;
  const retryMs = deps.partitionRetryMs ?? 5000;
  const sleep = deps.sleep ?? realSleep;
  const partitions = deps.partitions ?? [];
  if (partitions.length === 0) {
    deps.logger.warn("worker.no_partitions", {});
    return;
  }

  const runUnderPartitionLock =
    deps.runUnderPartitionLock ??
    ((
      partition: ChainId,
      fn: (lockLost?: () => boolean) => Promise<void>
    ): Promise<boolean> =>
      deps.pool
        ? withLeaderLock(deps.pool, advisoryKey(`partition:${partition}`), fn)
        : fn().then(() => true));

  await Promise.all(
    partitions.map(async (partition) => {
      const log = deps.logger.child({ role: "worker", chain_id: partition });
      while (!signal.aborted) {
        let owned = false;
        let errored = false;
        try {
          owned = await runUnderPartitionLock(partition, (lockLost) =>
            drainPartition(deps, partition, blockMs, signal, lockLost)
          );
        } catch (err) {
          errored = true;
          log.error("worker.partition_error", { error: String(err) });
        }
        if (!owned || errored) {
          if (signal.aborted) break;
          // Standby (another worker owns the partition) is healthy — heartbeat. A thrown
          // error (e.g. the DB is unreachable) is NOT: skipping the heartbeat lets /health
          // go stale instead of reporting green while we can't relay anything.
          if (!errored) deps.heartbeat?.();
          await sleep(retryMs, signal);
        }
      }
    })
  );
}
