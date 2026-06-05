import { getAddress, zeroPadValue } from "ethers";

import { type RelayerBotConfig, loadConfig } from "../src/config.js";
import { type Database } from "../src/db/pool.js";
import { TransactionsRepo } from "../src/db/transactions.js";
import { createLogger } from "../src/logger.js";
import { NoopAlerter } from "../src/alerts/alerter.js";
import { InMemoryQueue } from "../src/queue/inMemory.js";
import {
  type BroadcastRequest,
  DeferDeliveryError,
  type DestinationDeliveryModule,
  PermanentDeliveryError,
  type PrepareRequest,
  type PrepareResult,
  RetriableDeliveryError,
} from "../src/relay/interfaces.js";
import {
  handleDelivery,
  runWorker,
  type WorkerDeps,
} from "../src/roles/worker.js";
import { recordToMessage } from "../src/roles/shared.js";
import {
  AllWalletsBusyError,
  type WalletPool,
} from "../src/wallet/walletPool.js";
import { setupPgMem } from "./helpers/pgmem.js";

const RELAYER = getAddress("0x" + "33".repeat(20));
const WALLET = getAddress("0x" + "ab".repeat(20));
const logger = createLogger({}, { write: () => {} });

const PREPARED = {
  to: getAddress("0x" + "44".repeat(20)),
  callData: "0xabcdef",
  vaaHash: "0x" + "cd".repeat(32),
  gasLimit: 330_000n,
  feeOverrides: {},
};
const READY: PrepareResult = { kind: "ready", prepared: PREPARED };

function baseConfig(
  overrides: Partial<RelayerBotConfig> = {}
): RelayerBotConfig {
  const cfg = loadConfig(
    {
      RELAYER_CHAINS: JSON.stringify([{ chainId: 6, rpcUrl: "http://x" }]),
      DATABASE_URL: "postgres://x",
      REDIS_URL: "redis://x",
      WALLETS: "w1",
      RELAYER_USE_DEV_SECRETS: "true",
    },
    "worker"
  );
  return { ...cfg, ...overrides };
}

function payload(txHash: string) {
  return {
    emitterChain: 2,
    emitterAddress: zeroPadValue("0x" + "22".repeat(20), 32),
    sequence: "1",
    sourceTxHash: txHash,
    dstChain: 6,
    dstAddr: zeroPadValue("0x" + "44".repeat(20), 32),
    gasLimit: "300000",
    requestBytes: "0x9945ff10",
  };
}

function message(txHash: string) {
  return {
    transaction_hash: txHash,
    chain_id: 2,
    relayer_address: RELAYER,
    transaction_data: payload(txHash),
    retry_count: 0,
  };
}

function fakeWalletPool(
  db: Database,
  opts: { busy?: boolean } = {}
): WalletPool {
  return {
    addresses: () => [WALLET],
    reserve: async (_chainId, record) => {
      if (opts.busy) throw new AllWalletsBusyError();
      return db.transaction(async (tx) => {
        await record(tx, { address: WALLET, nonce: 1 });
        return { address: WALLET, nonce: 1, signer: {} as never };
      });
    },
    signerFor: () => ({}) as never,
  };
}

interface FakeDeliveryOpts {
  prepare?: (req: PrepareRequest) => Promise<PrepareResult>;
  broadcast?: (req: BroadcastRequest) => Promise<string>;
}
function fakeDelivery(opts: FakeDeliveryOpts = {}): DestinationDeliveryModule {
  return {
    prepare: opts.prepare ?? (async () => READY),
    broadcast: opts.broadcast ?? (async () => "0x" + "de".repeat(32)),
  };
}

interface Harness {
  db: Database;
  queue: InMemoryQueue;
  close: () => Promise<void>;
}
async function setup(): Promise<Harness> {
  const { db, close } = setupPgMem();
  return { db, queue: new InMemoryQueue(), close };
}

function deps(
  h: Harness,
  delivery: DestinationDeliveryModule,
  cfg: RelayerBotConfig,
  walletPool: WalletPool,
  now?: () => number
): WorkerDeps {
  return {
    config: cfg,
    db: h.db,
    queue: h.queue,
    walletPool,
    delivery,
    logger,
    alerter: new NoopAlerter(),
    now,
  };
}

async function enqueue(h: Harness, txHash: string) {
  await h.queue.publish(message(txHash));
  const [d] = await h.queue.consume(2, { max: 1, blockMs: 0 });
  return d!;
}

describe("handleDelivery", () => {
  it("prepares, broadcasts, records submitted, and acks", async () => {
    const h = await setup();
    try {
      const seen: BroadcastRequest[] = [];
      const delivery = fakeDelivery({
        broadcast: async (req) => {
          seen.push(req);
          return "0x" + "de".repeat(32);
        },
      });
      const d = await enqueue(h, "0xaa");
      await handleDelivery(
        deps(h, delivery, baseConfig(), fakeWalletPool(h.db)),
        d
      );
      const rec = await TransactionsRepo.findBySourceEvent(h.db, 2, "0xaa");
      expect(rec?.status).toBe("submitted");
      expect(rec?.relayTxHash).toBe("0x" + "de".repeat(32));
      expect(rec?.walletUsed).toBe(WALLET);
      expect(rec?.nonceUsed).toBe(1);
      expect(seen[0]!.nonce).toBe(1); // leased nonce passed to broadcast
      expect(h.queue.size()).toBe(0);
    } finally {
      await h.close();
    }
  });

  it("resubmits a stuck tx on the SAME wallet + nonce when replace_nonce is set", async () => {
    const h = await setup();
    try {
      // A previously-submitted tx the cron found stuck (kept `submitted`, nonce counted).
      const rec = await TransactionsRepo.insertPending(h.db, {
        sourceChainId: 2,
        destinationChainId: 6,
        relayerAddress: RELAYER,
        eventTxHash: "0x3a",
        payload: payload("0x3a"),
        maxRetries: 5,
      });
      await TransactionsRepo.markSubmitting(h.db, rec.id, {
        walletUsed: WALLET,
        nonceUsed: 5,
      });
      await TransactionsRepo.markSubmitted(h.db, rec.id, {
        relayTxHash: "0x" + "01".repeat(32),
        walletUsed: WALLET,
        nonceUsed: 5,
      });

      const seen: BroadcastRequest[] = [];
      const delivery = fakeDelivery({
        broadcast: async (req) => {
          seen.push(req);
          return "0x" + "ff".repeat(32);
        },
      });
      // signerFor (not reserve) must be used for a resubmit — assert reserve is never called.
      const pool = fakeWalletPool(h.db);
      let reserved = false;
      pool.reserve = async () => {
        reserved = true;
        throw new Error("should not reserve on a resubmit");
      };
      await h.queue.publish({ ...message("0x3a"), replace_nonce: 5 });
      const [d] = await h.queue.consume(2, { max: 1, blockMs: 0 });
      await handleDelivery(deps(h, delivery, baseConfig(), pool), d!);

      expect(reserved).toBe(false);
      expect(seen[0]!.nonce).toBe(5); // reused the stuck nonce, not a fresh one
      const after = await TransactionsRepo.findBySourceEvent(h.db, 2, "0x3a");
      expect(after?.status).toBe("submitted");
      expect(after?.relayTxHash).toBe("0x" + "ff".repeat(32)); // new replacement tx
      expect(after?.nonceUsed).toBe(5);
    } finally {
      await h.close();
    }
  });

  it("recovers a crashed `submitting` row by resubmitting its committed nonce", async () => {
    const h = await setup();
    try {
      // Simulate a crash AFTER the intent commit but BEFORE the tx hash was recorded:
      // the row is left in `submitting` with a reserved wallet + nonce, no relay_tx_hash.
      const rec = await TransactionsRepo.insertPending(h.db, {
        sourceChainId: 2,
        destinationChainId: 6,
        relayerAddress: RELAYER,
        eventTxHash: "0x4a",
        payload: payload("0x4a"),
        maxRetries: 5,
      });
      await TransactionsRepo.markSubmitting(h.db, rec.id, {
        walletUsed: WALLET,
        nonceUsed: 7,
      });

      const seen: BroadcastRequest[] = [];
      const delivery = fakeDelivery({
        broadcast: async (req) => {
          seen.push(req);
          return "0x" + "ee".repeat(32);
        },
      });
      const pool = fakeWalletPool(h.db);
      pool.reserve = async () => {
        throw new Error("recovery must resubmit, not reserve a fresh nonce");
      };
      // Reclaimed message (no replace_nonce) — the `submitting` status drives the resubmit.
      await h.queue.publish(message("0x4a"));
      const [d] = await h.queue.consume(2, { max: 1, blockMs: 0 });
      await handleDelivery(deps(h, delivery, baseConfig(), pool), d!);

      expect(seen[0]!.nonce).toBe(7); // reused the committed nonce — no orphan
      const after = await TransactionsRepo.findBySourceEvent(h.db, 2, "0x4a");
      expect(after?.status).toBe("submitted");
      expect(after?.nonceUsed).toBe(7);
      expect(after?.relayTxHash).toBe("0x" + "ee".repeat(32));
    } finally {
      await h.close();
    }
  });

  it("resubmits (does NOT dead-letter) when a recovered submitting row hits a retriable prepare error", async () => {
    const h = await setup();
    try {
      // A row crashed in `submitting` (nonce reserved, never broadcast-recorded).
      const rec = await TransactionsRepo.insertPending(h.db, {
        sourceChainId: 2,
        destinationChainId: 6,
        relayerAddress: RELAYER,
        eventTxHash: "0x4a",
        payload: payload("0x4a"),
        maxRetries: 5,
      });
      await TransactionsRepo.markSubmitting(h.db, rec.id, {
        walletUsed: WALLET,
        nonceUsed: 5,
      });
      // On recovery, prepare throws a retriable error (e.g. an undecodable estimateGas
      // revert). This must NOT prematurely dead-letter the row (regression for the
      // markFailed-excludes-submitting bug).
      const delivery = fakeDelivery({
        prepare: async () => {
          throw new RetriableDeliveryError("estimateGas reverted");
        },
      });
      await h.queue.publish(message("0x4a"));
      const [d] = await h.queue.consume(2, { max: 1, blockMs: 0 });
      await handleDelivery(
        deps(h, delivery, baseConfig({ maxRetries: 5 }), fakeWalletPool(h.db)),
        d!
      );
      const after = await TransactionsRepo.findBySourceEvent(h.db, 2, "0x4a");
      expect(after?.status).toBe("submitting"); // stays resubmittable, not dead_letter
      expect(after?.retryCount).toBe(1); // budget bumped via incrementRetry
      expect(h.queue.deadLettered).toHaveLength(0);
      expect(h.queue.size()).toBe(1); // nacked for resubmit
    } finally {
      await h.close();
    }
  });

  it("marks confirmed when prepare reports already-consumed (no broadcast)", async () => {
    const h = await setup();
    try {
      let broadcast = false;
      const delivery = fakeDelivery({
        prepare: async () => ({ kind: "already-consumed" }),
        broadcast: async () => {
          broadcast = true;
          return "0x";
        },
      });
      const d = await enqueue(h, "0xbb");
      await handleDelivery(
        deps(h, delivery, baseConfig(), fakeWalletPool(h.db)),
        d
      );
      const rec = await TransactionsRepo.findBySourceEvent(h.db, 2, "0xbb");
      expect(rec?.status).toBe("confirmed");
      expect(broadcast).toBe(false);
      expect(h.queue.size()).toBe(0);
    } finally {
      await h.close();
    }
  });

  it("skips entirely when the row is already submitted (idempotency)", async () => {
    const h = await setup();
    try {
      const rec = await TransactionsRepo.insertPending(h.db, {
        sourceChainId: 2,
        destinationChainId: 6,
        relayerAddress: RELAYER,
        eventTxHash: "0xcc",
        payload: payload("0xcc"),
        maxRetries: 2,
      });
      await TransactionsRepo.markSubmitted(h.db, rec.id, {
        relayTxHash: "0x" + "11".repeat(32),
        walletUsed: WALLET,
        nonceUsed: 0,
      });
      let prepared = false;
      const delivery = fakeDelivery({
        prepare: async () => {
          prepared = true;
          return READY;
        },
      });
      const d = await enqueue(h, "0xcc");
      await handleDelivery(
        deps(h, delivery, baseConfig(), fakeWalletPool(h.db)),
        d
      );
      expect(prepared).toBe(false);
      expect(h.queue.size()).toBe(0);
    } finally {
      await h.close();
    }
  });

  it("dead-letters a PermanentDeliveryError from prepare", async () => {
    const h = await setup();
    try {
      const delivery = fakeDelivery({
        prepare: async () => {
          throw new PermanentDeliveryError("invalid peer");
        },
      });
      const d = await enqueue(h, "0xdd");
      await handleDelivery(
        deps(h, delivery, baseConfig(), fakeWalletPool(h.db)),
        d
      );
      const rec = await TransactionsRepo.findBySourceEvent(h.db, 2, "0xdd");
      expect(rec?.status).toBe("dead_letter");
      expect(h.queue.deadLettered).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it("on a Retriable broadcast failure, keeps the nonce reserved (submitting) and re-queues", async () => {
    const h = await setup();
    try {
      const delivery = fakeDelivery({
        broadcast: async () => {
          throw new RetriableDeliveryError("low gas");
        },
      });
      const d = await enqueue(h, "0xee");
      await handleDelivery(
        deps(h, delivery, baseConfig({ maxRetries: 2 }), fakeWalletPool(h.db)),
        d
      );
      const rec = await TransactionsRepo.findBySourceEvent(h.db, 2, "0xee");
      // Stays `submitting` (NOT failed) so the reserved nonce stays counted and the
      // re-drive resubmits it rather than allocating a fresh one.
      expect(rec?.status).toBe("submitting");
      expect(rec?.retryCount).toBe(1);
      expect(rec?.nonceUsed).toBe(1);
      expect(h.queue.size()).toBe(1); // nacked
      expect(h.queue.deadLettered).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it("dead-letters a Retriable failure when the budget is exhausted", async () => {
    const h = await setup();
    try {
      const delivery = fakeDelivery({
        broadcast: async () => {
          throw new RetriableDeliveryError("low gas");
        },
      });
      const d = await enqueue(h, "0xff");
      await handleDelivery(
        deps(h, delivery, baseConfig({ maxRetries: 0 }), fakeWalletPool(h.db)),
        d
      );
      const rec = await TransactionsRepo.findBySourceEvent(h.db, 2, "0xff");
      expect(rec?.status).toBe("dead_letter");
      expect(h.queue.deadLettered).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it("backs off without spending the budget when all wallets are busy", async () => {
    const h = await setup();
    try {
      const d = await enqueue(h, "0x1a");
      await handleDelivery(
        deps(
          h,
          fakeDelivery(),
          baseConfig(),
          fakeWalletPool(h.db, { busy: true })
        ),
        d
      );
      const rec = await TransactionsRepo.findBySourceEvent(h.db, 2, "0x1a");
      expect(rec?.status).toBe("pending");
      expect(rec?.retryCount).toBe(0);
      expect(h.queue.size()).toBe(1);
    } finally {
      await h.close();
    }
  });

  it("defers a not-ready VAA without spending the retry budget", async () => {
    const h = await setup();
    try {
      const delivery = fakeDelivery({
        prepare: async () => {
          throw new DeferDeliveryError("VAA not ready");
        },
      });
      const d = await enqueue(h, "0x2a");
      await handleDelivery(
        deps(h, delivery, baseConfig(), fakeWalletPool(h.db)),
        d
      );
      const rec = await TransactionsRepo.findBySourceEvent(h.db, 2, "0x2a");
      expect(rec?.status).toBe("pending");
      expect(rec?.retryCount).toBe(0);
      expect(h.queue.size()).toBe(1);
    } finally {
      await h.close();
    }
  });

  it("dead-letters a deferred job once it ages past vaaTimeoutMs", async () => {
    const h = await setup();
    try {
      const delivery = fakeDelivery({
        prepare: async () => {
          throw new DeferDeliveryError("VAA not ready");
        },
      });
      const d = await enqueue(h, "0x2b");
      const aged = () => Date.now() + 10 * 60_000;
      await handleDelivery(
        deps(
          h,
          delivery,
          baseConfig({ vaaTimeoutMs: 1000 }),
          fakeWalletPool(h.db),
          aged
        ),
        d
      );
      const rec = await TransactionsRepo.findBySourceEvent(h.db, 2, "0x2b");
      expect(rec?.status).toBe("dead_letter");
      expect(h.queue.deadLettered).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it("skips processing when the per-message lock is held by another consumer", async () => {
    const h = await setup();
    try {
      let prepared = false;
      const delivery = fakeDelivery({
        prepare: async () => {
          prepared = true;
          return READY;
        },
      });
      const d = await enqueue(h, "0x5a");
      await handleDelivery(
        {
          ...deps(h, delivery, baseConfig(), fakeWalletPool(h.db)),
          // Lock held elsewhere → never runs the critical section.
          runUnderMessageLock: async () => false,
        },
        d
      );
      expect(prepared).toBe(false);
      expect(
        await TransactionsRepo.findBySourceEvent(h.db, 2, "0x5a")
      ).toBeNull();
      // not acked — the lock holder owns the message
      expect(h.queue.size()).toBe(1);
    } finally {
      await h.close();
    }
  });

  it("runWorker drains a partition in strict FIFO order and stops on abort", async () => {
    const h = await setup();
    try {
      await h.queue.publish(message("0xa1"));
      await h.queue.publish(message("0xa2"));
      await h.queue.publish(message("0xa3"));
      const controller = new AbortController();
      const order: string[] = [];
      const delivery = fakeDelivery({
        prepare: async (req) => {
          order.push(req.payload.sourceTxHash);
          if (order.length === 3) controller.abort();
          return READY;
        },
      });
      await runWorker(
        {
          ...deps(h, delivery, baseConfig(), fakeWalletPool(h.db)),
          partitions: [2],
          blockMs: 0,
          // own the partition without a real pg lock
          runUnderPartitionLock: (_p, fn) => fn().then(() => true),
        },
        controller.signal
      );
      expect(order).toEqual(["0xa1", "0xa2", "0xa3"]);
    } finally {
      await h.close();
    }
  });

  it("recordToMessage round-trips the idempotency fields", () => {
    const m = recordToMessage({
      id: "x",
      sourceChainId: 2,
      destinationChainId: 6,
      relayerAddress: RELAYER,
      eventTxHash: "0xabc",
      payload: payload("0xabc"),
      status: "pending",
      relayTxHash: null,
      walletUsed: null,
      nonceUsed: null,
      retryCount: 3,
      maxRetries: 5,
      errorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(m.transaction_hash).toBe("0xabc");
    expect(m.chain_id).toBe(2);
    expect(m.retry_count).toBe(3);
  });
});
