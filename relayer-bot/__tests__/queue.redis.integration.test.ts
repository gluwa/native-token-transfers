import { Redis } from "ioredis";

import { RedisStreamsQueue } from "../src/queue/redisStreams.js";
import type { RelayMessage } from "../src/queue/queue.js";

// Gated: runs only against a real Redis. Start one with `docker compose up -d redis` and
// set REDIS_URL.
const url = process.env["REDIS_URL"];
const d = url ? describe : describe.skip;

function msg(hash: string): RelayMessage {
  return {
    transaction_hash: hash,
    chain_id: 2,
    relayer_address: "0x" + "33".repeat(20),
    transaction_data: { seq: hash },
    retry_count: 0,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

d("RedisStreamsQueue (real Redis)", () => {
  // Unique prefix per run so concurrent runs / leftovers don't collide.
  const prefix = `relayertest:${process.pid}:${Date.now()}`;
  let q: RedisStreamsQueue;
  let admin: Redis;

  beforeAll(() => {
    admin = new Redis(url as string);
    q = new RedisStreamsQueue({
      url: url as string,
      prefix,
      visibilityTimeoutMs: 100,
    });
  });

  afterAll(async () => {
    const keys = await admin.keys(`${prefix}:*`);
    if (keys.length) await admin.del(...keys);
    await admin.quit();
    await q.close();
  });

  it("publishes, consumes, and acks", async () => {
    await q.publish(msg("0x1"));
    const got = await q.consume(2, { max: 10, blockMs: 100 });
    expect(got.map((d) => d.message.transaction_hash)).toContain("0x1");
    for (const dlv of got) await q.ack(dlv);
    // nothing left to reclaim
    await sleep(150);
    expect(await q.reclaimExpired(2, { max: 10 })).toEqual([]);
  });

  it("reclaims an unacked message after the visibility timeout", async () => {
    await q.publish(msg("0x2"));
    const first = await q.consume(2, { max: 10, blockMs: 100 });
    expect(first.length).toBeGreaterThan(0);
    // do not ack; wait past the 100ms visibility timeout
    await sleep(200);
    const reclaimed = await q.reclaimExpired(2, { max: 10 });
    expect(reclaimed.map((d) => d.message.transaction_hash)).toContain("0x2");
    for (const dlv of reclaimed) await q.ack(dlv);
  });

  it("nack requeues via the delay set and consume pumps it back", async () => {
    await q.publish(msg("0x3"));
    const [d1] = await q.consume(2, { max: 1, blockMs: 100 });
    await q.nack(d1!, { delayMs: 50 });
    await sleep(80);
    const redelivered = await q.consume(2, { max: 10, blockMs: 100 });
    expect(redelivered.map((d) => d.message.transaction_hash)).toContain("0x3");
    for (const dlv of redelivered) await q.ack(dlv);
  });

  it("dead-letters a poison message to the DLQ stream", async () => {
    await q.publish(msg("0x4"));
    const [d1] = await q.consume(2, { max: 1, blockMs: 100 });
    await q.deadLetter(d1!, "poison");
    const dlqLen = await admin.xlen(`${prefix}:dlq`);
    expect(dlqLen).toBeGreaterThan(0);
  });
});
