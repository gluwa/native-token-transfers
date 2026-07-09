import { Redis } from "ioredis";

import {
  DEFAULT_RETRY,
  type RetryOptions,
  isTransientRedisError,
  withRetry,
} from "../retry.js";
import type { ChainId } from "../types.js";
import {
  type Delivery,
  type Queue,
  QueueError,
  type RelayMessage,
} from "./queue.js";

export interface RedisStreamsQueueOptions {
  url: string;
  /// Key prefix for stream/group/dlq/retry keys (default "relayer").
  prefix?: string;
  /// Consumer group name (default "workers").
  group?: string;
  /// Stable per-replica consumer name (default `${hostname}:${pid}`).
  consumer?: string;
  /// Idle time after which an in-flight (unacked) message can be reclaimed.
  visibilityTimeoutMs: number;
  retry?: Partial<RetryOptions>;
  /// Inject a Redis client (tests).
  client?: Redis;
  now?: () => number;
}

function fieldsToMap(flat: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (let i = 0; i + 1 < flat.length; i += 2) {
    map[flat[i] as string] = flat[i + 1] as string;
  }
  return map;
}

/// Redis Streams queue, PARTITIONED BY SOURCE CHAIN. Each source chain gets its own stream
/// (`{prefix}:msgs:{chainId}`) and a per-partition delay set; one DLQ stream is shared.
/// A single consumer per partition (the worker's partition lock) reading one message at a
/// time gives strict FIFO within a chain.
///  - publish        → XADD to the message's source-chain stream
///  - consume        → XREADGROUP > on one partition (new messages)
///  - reclaimExpired → XAUTOCLAIM on one partition (messages idle past the timeout)
///  - ack            → XACK + XDEL
///  - nack(delayMs)  → XACK + ZADD to the partition's delay set; consume() pumps due entries
///  - deadLetter     → XADD to the DLQ stream + XACK/XDEL the original
export class RedisStreamsQueue implements Queue {
  private readonly redis: Redis;
  private readonly prefix: string;
  private readonly dlq: string;
  private readonly group: string;
  private readonly consumer: string;
  private readonly visibilityTimeoutMs: number;
  private readonly retry: RetryOptions;
  private readonly now: () => number;
  private readonly ready = new Map<ChainId, Promise<void>>();
  /// Dedicated connection per partition for the blocking XREADGROUP. A blocking command
  /// parks the WHOLE connection server-side — on a shared socket, every ack/nack/publish
  /// from other partitions would queue behind an idle partition's BLOCK window (worst case
  /// ~n_partitions × blockMs of added latency, approaching the visibility timeout).
  private readonly blocking = new Map<ChainId, Redis>();

  constructor(opts: RedisStreamsQueueOptions) {
    this.prefix = opts.prefix ?? "relayer";
    this.redis =
      opts.client ??
      new Redis(opts.url, { maxRetriesPerRequest: 3, lazyConnect: false });
    this.dlq = `${this.prefix}:dlq`;
    this.group = opts.group ?? "workers";
    this.consumer =
      opts.consumer ?? `${process.env["HOSTNAME"] ?? "host"}:${process.pid}`;
    this.visibilityTimeoutMs = opts.visibilityTimeoutMs;
    this.retry = { ...DEFAULT_RETRY, ...(opts.retry ?? {}) };
    this.now = opts.now ?? (() => Date.now());
  }

  private streamKey(partition: ChainId): string {
    return `${this.prefix}:msgs:${partition}`;
  }
  private blockingClientFor(partition: ChainId): Redis {
    let c = this.blocking.get(partition);
    if (!c) {
      // duplicate() copies the connection options; injected test clients may not have it.
      c =
        typeof this.redis.duplicate === "function"
          ? this.redis.duplicate()
          : this.redis;
      this.blocking.set(partition, c);
    }
    return c;
  }
  private retryKey(partition: ChainId): string {
    return `${this.prefix}:retry:${partition}`;
  }

  private ensureGroup(partition: ChainId): Promise<void> {
    let p = this.ready.get(partition);
    if (!p) {
      p = (async () => {
        try {
          // Start the group at 0, not $: normally MKSTREAM creates the stream empty so
          // they're equivalent, but if the group is ever recreated against a stream that
          // already has entries (group deleted operationally, partial restore), $ would
          // make every existing entry permanently invisible to the group.
          await this.redis.xgroup(
            "CREATE",
            this.streamKey(partition),
            this.group,
            "0",
            "MKSTREAM"
          );
        } catch (err) {
          if (!String(err).includes("BUSYGROUP")) {
            throw new QueueError(
              `failed to create consumer group for partition ${partition}: ${String(err)}`
            );
          }
        }
      })().catch((err: unknown) => {
        // Don't cache a failed creation (e.g. a transient connection error on first
        // contact) — otherwise this partition is permanently broken until restart. Drop it
        // so the next call retries.
        this.ready.delete(partition);
        throw err;
      });
      this.ready.set(partition, p);
    }
    return p;
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, this.retry, undefined, isTransientRedisError);
  }

  private encode(msg: RelayMessage): string {
    return JSON.stringify(msg);
  }
  private decode(json: string | undefined): RelayMessage {
    if (!json) throw new QueueError("stream entry missing data field");
    return JSON.parse(json) as RelayMessage;
  }

  async publish(msg: RelayMessage): Promise<void> {
    const partition = msg.chain_id;
    await this.ensureGroup(partition);
    await this.run(() =>
      this.redis.xadd(this.streamKey(partition), "*", "data", this.encode(msg))
    );
  }

  /// Move any due delay-set entries for this partition back onto its stream.
  private async pumpDelayed(partition: ChainId): Promise<void> {
    const key = this.retryKey(partition);
    const due = (await this.run(() =>
      this.redis.zrangebyscore(key, "-inf", this.now(), "LIMIT", 0, 100)
    )) as string[];
    for (const member of due) {
      // XADD BEFORE ZREM: at-least-once. A crash between the two leaves the member in the
      // delay set, so the next pump re-injects it (a duplicate, deduped by the per-message
      // lock + DB idempotency). The reverse order (ZREM then XADD) would PERMANENTLY LOSE
      // the message on a crash in the gap.
      await this.run(() =>
        this.redis.xadd(this.streamKey(partition), "*", "data", member)
      );
      await this.run(() => this.redis.zrem(key, member));
    }
  }

  async consume(
    partition: ChainId,
    opts: { max: number; blockMs: number }
  ): Promise<Delivery[]> {
    await this.ensureGroup(partition);
    await this.pumpDelayed(partition);
    const blocking = this.blockingClientFor(partition);
    const res = (await this.run(() =>
      blocking.xreadgroup(
        "GROUP",
        this.group,
        this.consumer,
        "COUNT",
        opts.max,
        "BLOCK",
        opts.blockMs,
        "STREAMS",
        this.streamKey(partition),
        ">"
      )
    )) as Array<[string, Array<[string, string[]]>]> | null;
    if (!res || res.length === 0) return [];
    const entries = res[0]?.[1] ?? [];
    return entries.map(([id, flat]) => this.toDelivery(partition, id, flat, 1));
  }

  async reclaimExpired(
    partition: ChainId,
    opts: { max: number }
  ): Promise<Delivery[]> {
    await this.ensureGroup(partition);
    const res = (await this.run(() =>
      this.redis.xautoclaim(
        this.streamKey(partition),
        this.group,
        this.consumer,
        this.visibilityTimeoutMs,
        "0",
        "COUNT",
        opts.max
      )
    )) as [string, Array<[string, string[]]>, string[]];
    const entries = res[1] ?? [];
    // XAUTOCLAIM doesn't return the delivery counter; mark as a redelivery (>=2).
    return entries.map(([id, flat]) => this.toDelivery(partition, id, flat, 2));
  }

  private toDelivery(
    partition: ChainId,
    id: string,
    flat: string[],
    deliveryAttempt: number
  ): Delivery {
    const fields = fieldsToMap(flat);
    return {
      message: this.decode(fields["data"]),
      partition,
      receiptHandle: id,
      deliveryAttempt,
    };
  }

  async ack(d: Delivery): Promise<void> {
    const stream = this.streamKey(d.partition);
    await this.run(async () => {
      await this.redis.xack(stream, this.group, d.receiptHandle);
      await this.redis.xdel(stream, d.receiptHandle);
    });
  }

  async nack(d: Delivery, opts: { delayMs: number }): Promise<void> {
    const stream = this.streamKey(d.partition);
    const readyAt = this.now() + opts.delayMs;
    await this.run(async () => {
      await this.redis.zadd(
        this.retryKey(d.partition),
        readyAt,
        this.encode(d.message)
      );
      await this.redis.xack(stream, this.group, d.receiptHandle);
      await this.redis.xdel(stream, d.receiptHandle);
    });
  }

  async deadLetter(d: Delivery, reason: string): Promise<void> {
    const stream = this.streamKey(d.partition);
    await this.run(async () => {
      await this.redis.xadd(
        this.dlq,
        "*",
        "data",
        this.encode(d.message),
        "reason",
        reason,
        "orig_id",
        d.receiptHandle
      );
      await this.redis.xack(stream, this.group, d.receiptHandle);
      await this.redis.xdel(stream, d.receiptHandle);
    });
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.blocking.values()]
        .filter((c) => c !== this.redis)
        .map((c) => c.quit().catch(() => undefined))
    );
    this.blocking.clear();
    await this.redis.quit();
  }
}
