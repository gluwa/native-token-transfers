import type { Pool } from "pg";

import type { RelayerBotConfig } from "../config.js";
import { withLeaderLock } from "../db/advisoryLock.js";
import type { Database } from "../db/pool.js";
import { TransactionsRepo } from "../db/transactions.js";
import type { Logger } from "../logger.js";
import type { Alerter } from "../alerts/alerter.js";
import type { Queue } from "../queue/queue.js";
import type { ReceiptProvider } from "../relay/interfaces.js";
import type { TransactionRecord } from "../types.js";
import { realSleep, recordToMessage } from "./shared.js";

const LEADER_LOCK_KEY = 776_130_002;
const BATCH = 100;

export interface CronDeps {
  config: RelayerBotConfig;
  db: Database;
  queue: Queue;
  receipts: ReceiptProvider;
  logger: Logger;
  alerter: Alerter;
  /// Provided in production for the leader lock. Optional when runUnderLeaderLock is
  /// injected (tests).
  pool?: Pool;
  /// Test seam — run a critical section under the leader lock. Defaults to a session-scoped
  /// pg advisory lock on `pool`.
  runUnderLeaderLock?: (fn: () => Promise<void>) => Promise<boolean>;
  heartbeat?: () => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/// REVERTED tx (mined): the nonce was consumed on-chain, so retry with a FRESH nonce.
/// markFailed → re-publish (no replace_nonce); the chain's pending nonce protects against
/// reuse of the consumed one. Dead-letter when the budget is exhausted.
async function retryFresh(
  deps: CronDeps,
  rec: TransactionRecord,
  reason: string
): Promise<void> {
  const failure = await TransactionsRepo.markFailed(deps.db, rec.id, reason);
  if (!failure || failure.retryCount >= failure.maxRetries) {
    await TransactionsRepo.markDeadLetter(deps.db, rec.id, reason);
    deps.logger.warn("tx.transition", {
      from: rec.status,
      to: "dead_letter",
      event_tx_hash: rec.eventTxHash,
      reason,
    });
    return;
  }
  await deps.queue.publish(
    recordToMessage({ ...rec, retryCount: failure.retryCount })
  );
  deps.logger.info("tx.transition", {
    from: rec.status,
    to: "failed",
    event_tx_hash: rec.eventTxHash,
    retry_count: failure.retryCount,
    reason,
  });
}

/// STUCK tx (no receipt) or a crashed `submitting` row: the nonce is NOT consumed, so
/// resubmit it (replacement-by-fee on the same wallet+nonce). incrementRetry keeps the row
/// in its committed state so the nonce stays counted (never handed out fresh). Dead-letter
/// when the budget is exhausted.
async function resubmit(
  deps: CronDeps,
  rec: TransactionRecord,
  reason: string
): Promise<void> {
  if (rec.nonceUsed === null || rec.walletUsed === null) {
    // Nothing to resubmit against — fall back to a fresh send.
    await retryFresh(deps, rec, reason);
    return;
  }
  const budget = await TransactionsRepo.incrementRetry(deps.db, rec.id);
  if (!budget) {
    // Row left the resubmittable state concurrently (e.g. confirmed elsewhere) — skip.
    return;
  }
  if (budget.retryCount >= budget.maxRetries) {
    await TransactionsRepo.markDeadLetter(deps.db, rec.id, reason);
    deps.logger.warn("tx.transition", {
      from: rec.status,
      to: "dead_letter",
      event_tx_hash: rec.eventTxHash,
      reason,
    });
    return;
  }
  const msg = recordToMessage({ ...rec, retryCount: budget.retryCount });
  msg.replace_nonce = rec.nonceUsed;
  await deps.queue.publish(msg);
  deps.logger.info("tx.resubmit", {
    from: rec.status,
    event_tx_hash: rec.eventTxHash,
    retry_count: budget.retryCount,
    nonce: rec.nonceUsed,
    reason,
  });
}

/// One cron pass: under the leader lock, reconcile stale `submitted` rows against on-chain
/// receipts and recover stale `submitting` rows (crashed mid-broadcast); then raise a
/// dead-letter-accumulation alert if over threshold.
export async function cronTick(deps: CronDeps): Promise<void> {
  const { db, receipts, logger, config } = deps;
  const now = deps.now ?? (() => Date.now());

  const runLocked =
    deps.runUnderLeaderLock ??
    ((fn: () => Promise<void>) => {
      if (!deps.pool) {
        throw new Error("cron requires a pool or runUnderLeaderLock");
      }
      return withLeaderLock(deps.pool, LEADER_LOCK_KEY, fn);
    });

  const acquired = await runLocked(async () => {
    const cutoff = new Date(now() - config.submittedTimeoutMin * 60_000);

    // Recover rows that committed `submitting` but never reached `submitted` — a worker
    // crashed between the intent commit and recording the tx hash. Resubmit the reserved
    // nonce (it either sends the tx for the first time or replaces an in-flight one).
    const submitting = await TransactionsRepo.selectStaleByStatus(
      db,
      "submitting",
      cutoff,
      BATCH
    );
    for (const rec of submitting) {
      await resubmit(deps, rec, "submitting recovery: no tx hash recorded");
    }

    const stale = await TransactionsRepo.selectStaleByStatus(
      db,
      "submitted",
      cutoff,
      BATCH
    );
    for (const rec of stale) {
      if (!rec.relayTxHash) {
        await resubmit(deps, rec, "submitted without a relay tx hash");
        continue;
      }
      const receipt = await receipts.getReceipt(
        rec.destinationChainId,
        rec.relayTxHash
      );
      if (receipt === null) {
        // Not mined yet. If it's been far longer than the timeout, the tx is stuck/dropped
        // → replace it on the same nonce with a higher fee.
        const ageMs = now() - rec.updatedAt.getTime();
        if (ageMs > 2 * config.submittedTimeoutMin * 60_000) {
          await resubmit(deps, rec, "submitted timeout: no receipt");
        }
        continue;
      }
      if (receipt.status === 1) {
        await TransactionsRepo.markConfirmed(db, rec.id);
        logger.info("tx.transition", {
          from: "submitted",
          to: "confirmed",
          event_tx_hash: rec.eventTxHash,
          relay_tx_hash: rec.relayTxHash,
        });
      } else {
        // Mined + reverted → the nonce was consumed; retry with a fresh nonce.
        await retryFresh(deps, rec, "destination tx reverted");
      }
    }
  });

  if (!acquired) {
    logger.info("cron.skipped_not_leader", {});
    return;
  }

  const deadLetters = await TransactionsRepo.countByStatus(db, "dead_letter");
  if (deadLetters >= config.deadLetterAlertThreshold) {
    await deps.alerter.alert("dead_letter.accumulation", {
      count: deadLetters,
    });
  }
}

export async function runCron(
  deps: CronDeps,
  signal: AbortSignal
): Promise<void> {
  const sleep = deps.sleep ?? realSleep;
  while (!signal.aborted) {
    try {
      await cronTick(deps);
      deps.heartbeat?.();
    } catch (err) {
      deps.logger.error("cron.tick_failed", { error: String(err) });
      await deps.alerter.alert("cron.failure", { error: String(err) });
    }
    await sleep(deps.config.cronIntervalMin * 60_000);
  }
}
