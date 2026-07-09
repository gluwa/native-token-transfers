import type { RelayMessage } from "../queue/queue.js";
import type { RelayPayload } from "../relay/interfaces.js";
import type { TransactionRecord } from "../types.js";

/// Build the doc's 5-field queue message from a persisted row. transaction_hash is the
/// source event hash; chain_id is the source chain (both idempotency components).
export function recordToMessage(rec: TransactionRecord): RelayMessage {
  return {
    transaction_hash: rec.eventTxHash,
    chain_id: rec.sourceChainId,
    relayer_address: rec.relayerAddress,
    transaction_data: rec.payload,
    retry_count: rec.retryCount,
  };
}

export function recordPayload(rec: TransactionRecord): RelayPayload {
  return rec.payload as RelayPayload;
}

export const noopSleep = (): Promise<void> => Promise.resolve();

/// Sleep that wakes early on abort. The role loops spend most of their lives inside these
/// sleeps (the cron sleeps minutes between ticks) — a non-abortable sleep turns every
/// SIGTERM into the 30s force-exit path, skipping cleanup and exiting non-zero.
export const realSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
