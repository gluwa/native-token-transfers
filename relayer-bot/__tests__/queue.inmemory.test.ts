import { computeBackoffDelayMs } from "../src/queue/backoff.js";
import { InMemoryQueue } from "../src/queue/inMemory.js";
import type { RelayMessage } from "../src/queue/queue.js";

function msg(hash: string): RelayMessage {
  return {
    transaction_hash: hash,
    chain_id: 2,
    relayer_address: "0x" + "33".repeat(20),
    transaction_data: { foo: "bar" },
    retry_count: 0,
  };
}

describe("InMemoryQueue", () => {
  it("publishes then consumes, and ack removes", async () => {
    const q = new InMemoryQueue();
    await q.publish(msg("0x1"));
    await q.publish(msg("0x2"));
    const got = await q.consume(2, { max: 10, blockMs: 0 });
    expect(got).toHaveLength(2);
    expect(got[0]!.deliveryAttempt).toBe(1);
    await q.ack(got[0]!);
    expect(q.size()).toBe(1);
  });

  it("hides in-flight messages until the visibility timeout, then reclaims them", async () => {
    let t = 1000;
    const q = new InMemoryQueue({ visibilityTimeoutMs: 5000, now: () => t });
    await q.publish(msg("0x1"));
    const first = await q.consume(2, { max: 10, blockMs: 0 });
    expect(first).toHaveLength(1);

    // Still in-flight: not consumable, not yet reclaimable.
    expect(await q.consume(2, { max: 10, blockMs: 0 })).toEqual([]);
    expect(await q.reclaimExpired(2, { max: 10 })).toEqual([]);

    // After the visibility timeout, reclaimExpired returns it as a redelivery.
    t += 5001;
    const reclaimed = await q.reclaimExpired(2, { max: 10 });
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]!.deliveryAttempt).toBe(2);
  });

  it("nack requeues after the delay", async () => {
    let t = 1000;
    const q = new InMemoryQueue({ now: () => t });
    await q.publish(msg("0x1"));
    const [d] = await q.consume(2, { max: 1, blockMs: 0 });
    await q.nack(d!, { delayMs: 3000 });
    expect(await q.consume(2, { max: 10, blockMs: 0 })).toEqual([]); // not yet due
    t += 3001;
    const redelivered = await q.consume(2, { max: 10, blockMs: 0 });
    expect(redelivered).toHaveLength(1);
  });

  it("deadLetter removes the message and records it", async () => {
    const q = new InMemoryQueue();
    await q.publish(msg("0x1"));
    const [d] = await q.consume(2, { max: 1, blockMs: 0 });
    await q.deadLetter(d!, "poison");
    expect(q.size()).toBe(0);
    expect(q.deadLettered).toEqual([{ message: d!.message, reason: "poison" }]);
  });

  it("preserves FIFO order within a partition", async () => {
    const q = new InMemoryQueue();
    await q.publish(msg("0x1"));
    await q.publish(msg("0x2"));
    await q.publish(msg("0x3"));
    const order: string[] = [];
    for (let i = 0; i < 3; i++) {
      const [d] = await q.consume(2, { max: 1, blockMs: 0 });
      order.push(d!.message.transaction_hash);
      await q.ack(d!);
    }
    expect(order).toEqual(["0x1", "0x2", "0x3"]);
  });

  it("isolates partitions by source chain", async () => {
    const q = new InMemoryQueue();
    await q.publish(msg("0x1")); // chain 2
    await q.publish({ ...msg("0x9"), chain_id: 6 });
    const got2 = await q.consume(2, { max: 10, blockMs: 0 });
    expect(got2.map((d) => d.message.transaction_hash)).toEqual(["0x1"]);
    expect(got2[0]!.partition).toBe(2);
    const got6 = await q.consume(6, { max: 10, blockMs: 0 });
    expect(got6.map((d) => d.message.transaction_hash)).toEqual(["0x9"]);
  });
});

describe("computeBackoffDelayMs", () => {
  const noJitter = () => 1;
  it("grows exponentially from the base", () => {
    expect(computeBackoffDelayMs(0, { baseMs: 1000, jitter: noJitter })).toBe(
      1000
    );
    expect(computeBackoffDelayMs(1, { baseMs: 1000, jitter: noJitter })).toBe(
      2000
    );
    expect(computeBackoffDelayMs(3, { baseMs: 1000, jitter: noJitter })).toBe(
      8000
    );
  });
  it("caps at maxMs", () => {
    expect(
      computeBackoffDelayMs(20, {
        baseMs: 1000,
        maxMs: 60000,
        jitter: noJitter,
      })
    ).toBe(60000);
  });
  it("applies the jitter factor", () => {
    expect(computeBackoffDelayMs(0, { baseMs: 1000, jitter: () => 1.25 })).toBe(
      1250
    );
  });
});
