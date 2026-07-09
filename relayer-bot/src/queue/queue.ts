import type { ChainId, Hex } from "../types.js";

/// The on-the-wire message (the design doc's 5-field schema). transaction_hash is the
/// SOURCE event tx hash and chain_id is the SOURCE chain — together the idempotency key.
/// transaction_data is the persisted RelayPayload.
export interface RelayMessage {
  transaction_hash: Hex;
  chain_id: ChainId;
  relayer_address: string;
  transaction_data: unknown;
  retry_count: number;
  /// Set by the cron when retrying a STUCK (no-receipt) tx: the worker must re-broadcast
  /// on the SAME wallet + this nonce with a higher fee (replacement-by-fee), rather than
  /// allocating a fresh nonce (which would leave the stuck tx blocking the queue). Absent
  /// for fresh sends and for reverted-tx retries (those use a fresh nonce).
  replace_nonce?: number;
}

/// A pulled message plus the driver-specific handle needed to ack/nack it.
export interface Delivery {
  message: RelayMessage;
  /// Source-chain partition this came from (the stream key). ack/nack/deadLetter target it.
  partition: ChainId;
  /// Opaque per-driver receipt (Redis stream entry id, or an in-memory token).
  receiptHandle: string;
  /// How many times THIS message has been delivered to a consumer (1 on first delivery).
  deliveryAttempt: number;
}

/// Swappable message-queue abstraction, PARTITIONED BY SOURCE CHAIN for FIFO. publish()
/// routes by msg.chain_id; consume()/reclaimExpired() read one partition. A single
/// consumer per partition (enforced by the worker's partition lock) processing one message
/// at a time gives strict FIFO within a source chain while scaling across chains.
/// Redis Streams in production; in-memory in tests.
export interface Queue {
  publish(msg: RelayMessage): Promise<void>;
  /// Long-poll up to `max` messages from `partition`, in order, marking them in-flight
  /// with a visibility timeout.
  consume(
    partition: ChainId,
    opts: { max: number; blockMs: number }
  ): Promise<Delivery[]>;
  ack(d: Delivery): Promise<void>;
  /// Requeue for redelivery after `delayMs` (exponential backoff handled by the caller).
  nack(d: Delivery, opts: { delayMs: number }): Promise<void>;
  /// Reclaim a partition's messages whose visibility timeout elapsed without ack
  /// (crashed-/handed-over-consumer recovery). Distinct from consume.
  reclaimExpired(
    partition: ChainId,
    opts: { max: number }
  ): Promise<Delivery[]>;
  /// Move a poison message to the dead-letter stream/topic.
  deadLetter(d: Delivery, reason: string): Promise<void>;
  close(): Promise<void>;
}

export class QueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueError";
  }
}
