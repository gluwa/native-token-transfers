import { getAddress, zeroPadValue } from "ethers";

import type { ChainConfig } from "../src/chains.js";
import type { RelayerBotConfig } from "../src/config.js";
import { BlockTrackerRepo } from "../src/db/blockTracker.js";
import { type Database } from "../src/db/pool.js";
import { TransactionsRepo } from "../src/db/transactions.js";
import { createLogger } from "../src/logger.js";
import { NoopAlerter } from "../src/alerts/alerter.js";
import { InMemoryQueue } from "../src/queue/inMemory.js";
import type { DecodedEvent, EventSource } from "../src/relay/interfaces.js";
import {
  type ListenerDeps,
  republishPending,
  scanChainOnce,
} from "../src/roles/listener.js";
import { setupPgMem } from "./helpers/pgmem.js";

const RELAYER = getAddress("0x" + "33".repeat(20));
const CORE = getAddress("0x" + "11".repeat(20));
const logger = createLogger({}, { write: () => {} });

const CHAIN: ChainConfig = {
  chainId: 2,
  name: "src",
  rpcUrl: "http://x",
  specialRelayerAddress: RELAYER,
  coreBridgeAddress: CORE,
  confirmations: 0,
  genesisBlock: 0n,
};

const config = { scanBlockRange: 1000, maxRetries: 2 } as RelayerBotConfig;

function event(seq: string, txHash: string): DecodedEvent {
  return {
    sourceChainId: 2,
    destinationChainId: 6,
    relayerAddress: RELAYER,
    eventTxHash: txHash,
    blockNumber: 50,
    logIndex: 0,
    payload: {
      emitterChain: 2,
      emitterAddress: zeroPadValue("0x" + "22".repeat(20), 32),
      sequence: seq,
      sourceTxHash: txHash,
      dstChain: 6,
      dstAddr: zeroPadValue("0x" + "44".repeat(20), 32),
      gasLimit: "300000",
      requestBytes: "0x9945ff10",
    },
  };
}

function fakeEventSource(head: bigint, events: DecodedEvent[]): EventSource {
  return {
    latestBlock: async () => head,
    scan: async () => events,
  };
}

function makeDeps(
  db: Database,
  queue: InMemoryQueue,
  eventSource: EventSource
): ListenerDeps {
  return { config, db, queue, eventSource, logger, alerter: new NoopAlerter() };
}

describe("scanChainOnce", () => {
  let db: Database;
  let close: () => Promise<void>;
  let queue: InMemoryQueue;
  beforeEach(() => {
    ({ db, close } = setupPgMem());
    queue = new InMemoryQueue();
  });
  afterEach(async () => {
    await close();
  });

  it("inserts pending rows, advances the cursor, and enqueues messages", async () => {
    const events = [event("1", "0xaa"), event("2", "0xbb")];
    const deps = makeDeps(db, queue, fakeEventSource(100n, events));
    const res = await scanChainOnce(deps, CHAIN);
    expect(res.count).toBe(2);
    expect(res.to).toBe(100n);

    // rows persisted
    expect(
      (await TransactionsRepo.findBySourceEvent(db, 2, "0xaa"))?.status
    ).toBe("pending");
    // cursor advanced
    expect(await BlockTrackerRepo.readOrInit(db, 2, RELAYER, 0n)).toBe(100n);
    // messages enqueued
    const got = await queue.consume(2, { max: 10, blockMs: 0 });
    expect(got.map((d) => d.message.transaction_hash).sort()).toEqual([
      "0xaa",
      "0xbb",
    ]);
  });

  it("does nothing when the head is not past the cursor", async () => {
    // genesis 100 seeds the cursor at 99 (last-scanned), so a head of 99 is "not past it".
    await BlockTrackerRepo.readOrInit(db, 2, RELAYER, 100n);
    const deps = makeDeps(db, queue, fakeEventSource(99n, []));
    const res = await scanChainOnce(deps, CHAIN);
    expect(res.count).toBe(0);
    expect(queue.size()).toBe(0);
  });

  it("is idempotent across re-scans of the same event (unique constraint)", async () => {
    const events = [event("1", "0xaa")];
    // First scan from cursor 0.
    await scanChainOnce(
      makeDeps(db, queue, fakeEventSource(10n, events)),
      CHAIN
    );
    // Reset cursor to re-scan the same block range; the duplicate insert is a no-op.
    await db.query("UPDATE block_tracker SET last_scanned_block = 0");
    const res = await scanChainOnce(
      makeDeps(db, queue, fakeEventSource(10n, events)),
      CHAIN
    );
    // insertPending returns the existing row (status pending, not re-published since the
    // listener skips rows it didn't freshly insert is not modeled here; the unique
    // constraint guarantees a single DB row).
    expect(res.count).toBe(1);
    const all = await db.query("SELECT count(*)::text AS c FROM transactions");
    expect((all.rows[0] as { c: string }).c).toBe("1");
  });
});

describe("republishPending", () => {
  it("re-publishes pending rows that have no relay tx yet", async () => {
    const { db, close } = setupPgMem();
    const queue = new InMemoryQueue();
    try {
      await TransactionsRepo.insertPending(db, {
        sourceChainId: 2,
        destinationChainId: 6,
        relayerAddress: RELAYER,
        eventTxHash: "0xcc",
        payload: { dstChain: 6 },
        maxRetries: 2,
      });
      const n = await republishPending(
        makeDeps(db, queue, fakeEventSource(0n, []))
      );
      expect(n).toBe(1);
      expect(queue.size()).toBe(1);
    } finally {
      await close();
    }
  });

  it("pages through a backlog larger than the batch size", async () => {
    const { db, close } = setupPgMem();
    const queue = new InMemoryQueue();
    try {
      for (let i = 0; i < 5; i++) {
        await TransactionsRepo.insertPending(db, {
          sourceChainId: 2,
          destinationChainId: 6,
          relayerAddress: RELAYER,
          eventTxHash: `0xdd${i}`,
          payload: { dstChain: 6 },
          maxRetries: 2,
        });
      }
      // batchSize 2 forces three keyset pages (2 + 2 + 1) — all five must be republished.
      const n = await republishPending(
        makeDeps(db, queue, fakeEventSource(0n, [])),
        2
      );
      expect(n).toBe(5);
      expect(queue.size()).toBe(5);
    } finally {
      await close();
    }
  });
});
