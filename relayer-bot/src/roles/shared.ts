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
export const realSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));
