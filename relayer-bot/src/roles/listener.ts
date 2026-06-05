import type { ChainConfig } from "../chains.js";
import type { RelayerBotConfig } from "../config.js";
import { BlockTrackerRepo } from "../db/blockTracker.js";
import type { Database } from "../db/pool.js";
import { TransactionsRepo } from "../db/transactions.js";
import type { Logger } from "../logger.js";
import type { Alerter } from "../alerts/alerter.js";
import type { Queue } from "../queue/queue.js";
import type { EventSource } from "../relay/interfaces.js";
import { realSleep, recordToMessage } from "./shared.js";

export interface ListenerDeps {
  config: RelayerBotConfig;
  db: Database;
  queue: Queue;
  eventSource: EventSource;
  logger: Logger;
  alerter: Alerter;
  heartbeat?: () => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface ScanResult {
  from: bigint;
  to: bigint;
  count: number;
}

/// One scan tick for a single chain: read cursor → scan [cursor+1, min(cursor+range, head)]
/// → insert pending rows + advance the cursor atomically → publish (after commit).
export async function scanChainOnce(
  deps: ListenerDeps,
  chain: ChainConfig
): Promise<ScanResult> {
  const { db, queue, eventSource, logger, config } = deps;
  const relayer = chain.specialRelayerAddress;
  if (!relayer) {
    throw new Error(`chain ${chain.chainId} has no specialRelayerAddress`);
  }

  const cursor = await BlockTrackerRepo.readOrInit(
    db,
    chain.chainId,
    relayer,
    chain.genesisBlock
  );
  const head = await eventSource.latestBlock(chain.chainId);
  if (head <= cursor) return { from: cursor, to: cursor, count: 0 };

  const from = cursor + 1n;
  const span = BigInt(config.scanBlockRange);
  const to = head < cursor + span ? head : cursor + span;

  const events = await eventSource.scan({
    chainId: chain.chainId,
    relayerAddress: relayer,
    fromBlock: from,
    toBlock: to,
  });

  // Insert all rows + advance the cursor in ONE transaction so a crash never advances past
  // un-recorded events.
  const inserted = await db.transaction(async (tx) => {
    const recs = [];
    for (const ev of events) {
      recs.push(
        await TransactionsRepo.insertPending(tx, {
          sourceChainId: ev.sourceChainId,
          destinationChainId: ev.destinationChainId,
          relayerAddress: ev.relayerAddress,
          eventTxHash: ev.eventTxHash,
          payload: ev.payload,
          maxRetries: config.maxRetries,
        })
      );
    }
    await BlockTrackerRepo.advance(tx, chain.chainId, relayer, to);
    return recs;
  });

  // Publish after commit. A crash here leaves rows as 'pending'; the startup sweep
  // (republishPending) recovers them, and the worker's idempotency guard dedupes.
  for (const rec of inserted) {
    if (rec.status !== "pending") continue; // already processed (idempotent insert)
    await queue.publish(recordToMessage(rec));
    logger.info("event.enqueued", {
      chain_id: chain.chainId,
      event_tx_hash: rec.eventTxHash,
      destination_chain_id: rec.destinationChainId,
    });
  }

  return { from, to, count: inserted.length };
}

/// Startup sweep: re-publish any pending rows with no relay tx yet (their queue message
/// may have been lost if the listener crashed between commit and publish).
export async function republishPending(
  deps: ListenerDeps,
  limit = 500
): Promise<number> {
  const pending = await TransactionsRepo.selectByStatus(
    deps.db,
    "pending",
    limit
  );
  for (const rec of pending) {
    if (rec.relayTxHash) continue;
    await deps.queue.publish(recordToMessage(rec));
  }
  if (pending.length > 0) {
    deps.logger.info("listener.republished_pending", { count: pending.length });
  }
  return pending.length;
}

/// Long-running listener: one scan loop per source chain, each isolated so one chain's
/// RPC failures don't stall the others.
export async function runListener(
  deps: ListenerDeps,
  signal: AbortSignal
): Promise<void> {
  const sleep = deps.sleep ?? realSleep;
  await republishPending(deps);

  const sources = deps.config.chains.filter((c) => c.specialRelayerAddress);
  if (sources.length === 0) {
    deps.logger.warn("listener.no_source_chains", {});
  }

  await Promise.all(
    sources.map(async (chain) => {
      const log = deps.logger.child({
        role: "listener",
        chain_id: chain.chainId,
      });
      while (!signal.aborted) {
        try {
          const res = await scanChainOnce(deps, chain);
          if (res.count > 0) {
            log.info("listener.scanned", {
              from: res.from,
              to: res.to,
              count: res.count,
            });
          }
          deps.heartbeat?.();
        } catch (err) {
          log.error("listener.scan_error", { error: String(err) });
        }
        await sleep(deps.config.scanLoopDelayMs);
      }
    })
  );
}
