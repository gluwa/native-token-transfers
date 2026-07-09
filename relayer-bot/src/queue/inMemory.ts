import type { ChainId } from "../types.js";
import type { Delivery, Queue, RelayMessage } from "./queue.js";

interface Entry {
  id: string;
  partition: ChainId;
  message: RelayMessage;
  attempts: number;
  state: "ready" | "inflight";
  /// When this entry next becomes eligible: ready entries become consumable, inflight
  /// entries become reclaimable (their visibility-timeout expiry).
  availableAt: number;
}

export interface InMemoryQueueOptions {
  visibilityTimeoutMs?: number;
  /// Test seam — defaults to Date.now.
  now?: () => number;
}

/// In-process partitioned Queue for tests. Models the visibility timeout via a
/// ready/inflight state machine on an injected clock, so timeout/backoff behavior is
/// deterministic. Messages are partitioned by source chain (message.chain_id).
export class InMemoryQueue implements Queue {
  private readonly entries = new Map<string, Entry>();
  readonly deadLettered: Array<{ message: RelayMessage; reason: string }> = [];
  private readonly visibilityTimeoutMs: number;
  private readonly now: () => number;
  private seq = 0;

  constructor(opts: InMemoryQueueOptions = {}) {
    this.visibilityTimeoutMs = opts.visibilityTimeoutMs ?? 60_000;
    this.now = opts.now ?? (() => Date.now());
  }

  async publish(msg: RelayMessage): Promise<void> {
    const id = `m${this.seq++}`;
    this.entries.set(id, {
      id,
      partition: msg.chain_id,
      message: msg,
      attempts: 0,
      state: "ready",
      availableAt: this.now(),
    });
  }

  async consume(
    partition: ChainId,
    opts: { max: number; blockMs: number }
  ): Promise<Delivery[]> {
    return this.take("ready", partition, opts.max);
  }

  async reclaimExpired(
    partition: ChainId,
    opts: { max: number }
  ): Promise<Delivery[]> {
    return this.take("inflight", partition, opts.max);
  }

  private take(
    state: "ready" | "inflight",
    partition: ChainId,
    max: number
  ): Delivery[] {
    const now = this.now();
    const out: Delivery[] = [];
    // Insertion order (Map preserves it) → FIFO within a partition.
    for (const entry of this.entries.values()) {
      if (out.length >= max) break;
      if (entry.partition !== partition) continue;
      if (entry.state !== state) continue;
      if (entry.availableAt > now) continue;
      entry.state = "inflight";
      entry.availableAt = now + this.visibilityTimeoutMs;
      entry.attempts += 1;
      out.push({
        message: entry.message,
        partition: entry.partition,
        receiptHandle: entry.id,
        deliveryAttempt: entry.attempts,
      });
    }
    return out;
  }

  async ack(d: Delivery): Promise<void> {
    this.entries.delete(d.receiptHandle);
  }

  async nack(d: Delivery, opts: { delayMs: number }): Promise<void> {
    const entry = this.entries.get(d.receiptHandle);
    if (!entry) return;
    // Re-insert under a NEW id so the message moves to the TAIL of its partition — matching
    // the Redis driver, where a nacked message is re-XADDed with a new (larger) stream id
    // and loses its original position. (Strict FIFO holds for first-attempt pickup; a
    // retried message goes to the back of its partition.)
    this.entries.delete(d.receiptHandle);
    const id = `m${this.seq++}`;
    this.entries.set(id, {
      ...entry,
      id,
      state: "ready",
      availableAt: this.now() + opts.delayMs,
    });
  }

  async deadLetter(d: Delivery, reason: string): Promise<void> {
    this.entries.delete(d.receiptHandle);
    this.deadLettered.push({ message: d.message, reason });
  }

  async close(): Promise<void> {
    this.entries.clear();
  }

  /// Test helper: number of messages still tracked (ready + inflight).
  size(): number {
    return this.entries.size;
  }
}
