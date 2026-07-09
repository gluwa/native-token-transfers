import type { Pool } from "pg";

import type { RelayerBotConfig } from "../config.js";
import { withLeaderLock } from "../db/advisoryLock.js";
import type { Database } from "../db/pool.js";
import { TransactionsRepo } from "../db/transactions.js";
import type { Logger } from "../logger.js";
import type { Alerter } from "../alerts/alerter.js";
import type { Queue } from "../queue/queue.js";
import type { ReceiptInfo, ReceiptProvider } from "../relay/interfaces.js";
import type { TransactionRecord } from "../types.js";
import { realSleep, recordToMessage } from "./shared.js";

const LEADER_LOCK_KEY = 776_130_002;
const BATCH = 100;

/// A tx that ran out of gas consumes (essentially) its whole gas limit, so a near-full
/// gasUsed/gasLimit ratio is the out-of-gas signal — worth a gas-bumped fresh retry. A
/// revert that left gas on the table is deterministic (bad calldata, a require) and retrying
/// can't help. When the receipt didn't carry both figures we can't tell, so we retry (the
/// historical behavior) rather than risk dead-lettering a recoverable delivery.
const OUT_OF_GAS_RATIO = 95n; // percent

function revertedLikelyOutOfGas(receipt: ReceiptInfo): boolean {
  if (receipt.gasUsed === undefined || receipt.gasLimit === undefined) {
    return true;
  }
  if (receipt.gasLimit <= 0n) return true;
  return receipt.gasUsed * 100n >= receipt.gasLimit * OUT_OF_GAS_RATIO;
}

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
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
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

    // Re-drive rows whose queue message was lost. `pending` and `failed` rows live ONLY in
    // Redis between attempts (the worker nacks into a delay set; the listener publishes
    // after commit) — a Redis restart/failover, a crash between cron's markFailed and its
    // publish, or a listener publish failure after the scan cursor advanced would otherwise
    // strand them forever, since nothing else ever looks at these statuses. The worker's
    // nack backoff caps at ~60s, so a row untouched for the full staleness window has no
    // live message; republishing is safe regardless (per-message lock + idempotency guard).
    for (const status of ["pending", "failed"] as const) {
      const lost = await TransactionsRepo.selectStaleByStatus(
        db,
        status,
        cutoff,
        BATCH
      );
      let republished = 0;
      for (const rec of lost) {
        // A pending row with a relay tx is mid-transition elsewhere — leave it. A failed
        // row's relay_tx_hash is the OLD reverted tx, not an in-flight one; republish it.
        if (status === "pending" && rec.relayTxHash) continue;
        await deps.queue.publish(recordToMessage(rec));
        republished += 1;
      }
      if (republished > 0) {
        logger.info("cron.republished_lost", { status, count: republished });
      }
    }

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
        // Not mined. This row is already older than submittedTimeoutMin (the stale cutoff),
        // so propagation delay is ruled out: if the node has no record of the tx, it was
        // silently dropped before the mempool — the reserved nonce was never consumed, so
        // resubmit it (same nonce) right away rather than waiting out the stuck-tx timeout. A
        // tx the node still knows (pending in the mempool) is only replaced once it's clearly
        // stuck (far past the timeout) to avoid needless fee bumps on a tx about to mine.
        const known = receipts.isTxKnown
          ? await receipts.isTxKnown(rec.destinationChainId, rec.relayTxHash)
          : true;
        if (!known) {
          await resubmit(deps, rec, "submitted tx dropped before mempool");
          continue;
        }
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
      } else if (revertedLikelyOutOfGas(receipt)) {
        // Mined + reverted, gas ~exhausted → likely under-estimated; the nonce was consumed,
        // so retry with a fresh nonce (the retry path bumps the gas limit).
        await retryFresh(
          deps,
          rec,
          "destination tx reverted (likely out of gas)"
        );
      } else {
        // Mined + reverted well under the gas limit → a deterministic revert; retrying with
        // the same calldata can't help, so dead-letter immediately and stop burning retries.
        const reason = "destination tx reverted (deterministic, not gas)";
        await TransactionsRepo.markDeadLetter(db, rec.id, reason);
        logger.warn("tx.transition", {
          from: "submitted",
          to: "dead_letter",
          event_tx_hash: rec.eventTxHash,
          relay_tx_hash: rec.relayTxHash,
          reason,
        });
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
    await sleep(deps.config.cronIntervalMin * 60_000, signal);
  }
}
