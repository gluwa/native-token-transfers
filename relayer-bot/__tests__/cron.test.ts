import { getAddress } from "ethers";

import { loadConfig, type RelayerBotConfig } from "../src/config.js";
import type { Database } from "../src/db/pool.js";
import { createLogger } from "../src/logger.js";
import type { Alerter } from "../src/alerts/alerter.js";
import { InMemoryQueue } from "../src/queue/inMemory.js";
import type { ReceiptInfo, ReceiptProvider } from "../src/relay/interfaces.js";
import { cronTick, type CronDeps } from "../src/roles/cron.js";
import type { TxStatus } from "../src/types.js";

const RELAYER = getAddress("0x" + "33".repeat(20));
const logger = createLogger({}, { write: () => {} });

function config(overrides: Partial<RelayerBotConfig> = {}): RelayerBotConfig {
  const cfg = loadConfig(
    {
      RELAYER_CHAINS: JSON.stringify([{ chainId: 6, rpcUrl: "http://x" }]),
      DATABASE_URL: "postgres://x",
      REDIS_URL: "redis://x",
    },
    "cron"
  );
  return { ...cfg, ...overrides };
}

interface StaleRowOpts {
  id: string;
  status?: TxStatus;
  relayTxHash?: string | null;
  updatedAt?: Date;
}
function staleRow(o: StaleRowOpts): Record<string, unknown> {
  return {
    id: o.id,
    source_chain_id: 2,
    destination_chain_id: 6,
    relayer_address: RELAYER,
    event_tx_hash: `0x${o.id}`,
    payload: { dstChain: 6 },
    status: o.status ?? "submitted",
    relay_tx_hash:
      o.relayTxHash === undefined ? "0x" + "de".repeat(32) : o.relayTxHash,
    wallet_used: "0x" + "ab".repeat(20),
    nonce_used: 1,
    retry_count: 0,
    max_retries: 2,
    error_message: null,
    created_at: new Date(),
    updated_at: o.updatedAt ?? new Date(),
  };
}

type Budget = { retry_count: number; max_retries: number };
interface FakeDb {
  db: Database;
  confirmed: string[];
  failed: string[];
  incremented: string[];
  deadLettered: string[];
}
function fakeDb(opts: {
  staleSubmitted?: Record<string, unknown>[];
  staleSubmitting?: Record<string, unknown>[];
  stalePending?: Record<string, unknown>[];
  staleFailed?: Record<string, unknown>[];
  failResult?: Budget;
  incrementResult?: Budget | null;
  deadLetterCount?: number;
}): FakeDb {
  const confirmed: string[] = [];
  const failed: string[] = [];
  const incremented: string[] = [];
  const deadLettered: string[] = [];
  const db: Database = {
    query: (async (sql: string, params?: unknown[]) => {
      if (sql.includes("SKIP LOCKED")) {
        const status = params![0] as string;
        const byStatus: Record<string, Record<string, unknown>[] | undefined> =
          {
            submitting: opts.staleSubmitting,
            submitted: opts.staleSubmitted,
            pending: opts.stalePending,
            failed: opts.staleFailed,
          };
        const rows = byStatus[status] ?? [];
        return { rows, rowCount: rows.length };
      }
      if (sql.includes("SET status = 'confirmed'")) {
        confirmed.push(params![0] as string);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("SET status = 'failed'")) {
        failed.push(params![0] as string);
        return {
          rows: [opts.failResult ?? { retry_count: 1, max_retries: 2 }],
          rowCount: 1,
        };
      }
      if (sql.includes("SET status = 'dead_letter'")) {
        deadLettered.push(params![0] as string);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("retry_count = retry_count + 1")) {
        // incrementRetry (keeps the row in submitting/submitted)
        incremented.push(params![0] as string);
        const r =
          opts.incrementResult === undefined
            ? { retry_count: 1, max_retries: 2 }
            : opts.incrementResult;
        return { rows: r ? [r] : [], rowCount: r ? 1 : 0 };
      }
      if (sql.includes("count(*)")) {
        return {
          rows: [{ c: String(opts.deadLetterCount ?? 0) }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }) as Database["query"],
    transaction: async (fn) => fn(db),
    close: async () => {},
  };
  return { db, confirmed, failed, incremented, deadLettered };
}

function fakeReceipts(
  result: ReceiptInfo | null,
  known?: boolean
): ReceiptProvider {
  return {
    getReceipt: async () => result,
    ...(known === undefined ? {} : { isTxKnown: async () => known }),
  };
}

function spyAlerter(): { alerter: Alerter; events: string[] } {
  const events: string[] = [];
  return {
    events,
    alerter: { alert: async (event) => void events.push(event) },
  };
}

function deps(
  fdb: FakeDb,
  receipts: ReceiptProvider,
  cfg: RelayerBotConfig,
  alerter: Alerter,
  queue = new InMemoryQueue(),
  now?: () => number
): { cron: CronDeps; queue: InMemoryQueue } {
  return {
    queue,
    cron: {
      config: cfg,
      db: fdb.db,
      queue,
      receipts,
      logger,
      alerter,
      runUnderLeaderLock: async (fn) => {
        await fn();
        return true;
      },
      now,
    },
  };
}

describe("cronTick", () => {
  it("confirms a submitted row when the receipt succeeded", async () => {
    const fdb = fakeDb({ staleSubmitted: [staleRow({ id: "1" })] });
    const { alerter } = spyAlerter();
    const { cron } = deps(
      fdb,
      fakeReceipts({ status: 1, blockNumber: 10 }),
      config(),
      alerter
    );
    await cronTick(cron);
    expect(fdb.confirmed).toEqual(["1"]);
    expect(fdb.failed).toEqual([]);
  });

  it("retries a reverted tx with a FRESH nonce (markFailed, no replace_nonce)", async () => {
    const fdb = fakeDb({
      staleSubmitted: [staleRow({ id: "2" })],
      failResult: { retry_count: 1, max_retries: 2 },
    });
    const { alerter } = spyAlerter();
    const { cron, queue } = deps(
      fdb,
      fakeReceipts({ status: 0, blockNumber: 10 }),
      config(),
      alerter
    );
    await cronTick(cron);
    expect(fdb.failed).toEqual(["2"]);
    expect(fdb.incremented).toEqual([]);
    const [d] = await queue.consume(2, { max: 1, blockMs: 0 });
    expect(d!.message.replace_nonce).toBeUndefined();
  });

  it("retries an out-of-gas revert (gasUsed ~= gasLimit) with a fresh nonce", async () => {
    const fdb = fakeDb({
      staleSubmitted: [staleRow({ id: "G" })],
      failResult: { retry_count: 1, max_retries: 2 },
    });
    const { alerter } = spyAlerter();
    const { cron, queue } = deps(
      fdb,
      fakeReceipts({
        status: 0,
        blockNumber: 10,
        gasUsed: 99_000n,
        gasLimit: 100_000n,
      }),
      config(),
      alerter
    );
    await cronTick(cron);
    expect(fdb.failed).toEqual(["G"]); // retryFresh → markFailed
    expect(fdb.deadLettered).toEqual([]);
    const [d] = await queue.consume(2, { max: 1, blockMs: 0 });
    expect(d!.message.replace_nonce).toBeUndefined();
  });

  it("dead-letters a deterministic revert (gas left on the table) without retrying", async () => {
    const fdb = fakeDb({ staleSubmitted: [staleRow({ id: "D" })] });
    const { alerter } = spyAlerter();
    const { cron, queue } = deps(
      fdb,
      fakeReceipts({
        status: 0,
        blockNumber: 10,
        gasUsed: 30_000n,
        gasLimit: 100_000n,
      }),
      config(),
      alerter
    );
    await cronTick(cron);
    expect(fdb.deadLettered).toEqual(["D"]);
    expect(fdb.failed).toEqual([]); // no retry budget spent
    expect(queue.size()).toBe(0);
  });

  it("dead-letters a reverted tx when the budget is exhausted", async () => {
    const fdb = fakeDb({
      staleSubmitted: [staleRow({ id: "3" })],
      failResult: { retry_count: 2, max_retries: 2 },
    });
    const { alerter } = spyAlerter();
    const { cron, queue } = deps(
      fdb,
      fakeReceipts({ status: 0, blockNumber: 10 }),
      config(),
      alerter
    );
    await cronTick(cron);
    expect(fdb.deadLettered).toEqual(["3"]);
    expect(queue.size()).toBe(0);
  });

  it("resubmits a stuck (no-receipt) tx on the same nonce (incrementRetry, replace_nonce)", async () => {
    const fdb = fakeDb({
      staleSubmitted: [
        staleRow({ id: "9", updatedAt: new Date(Date.now() - 20 * 60_000) }),
      ],
      incrementResult: { retry_count: 1, max_retries: 3 },
    });
    const { alerter } = spyAlerter();
    const { cron, queue } = deps(fdb, fakeReceipts(null), config(), alerter);
    await cronTick(cron);
    expect(fdb.incremented).toEqual(["9"]);
    expect(fdb.failed).toEqual([]); // NOT markFailed — nonce stays counted
    const [d] = await queue.consume(2, { max: 1, blockMs: 0 });
    expect(d!.message.replace_nonce).toBe(1);
  });

  it("resubmits a dropped tx immediately (unknown to the node, before the stuck timeout)", async () => {
    // Freshly updated row (not past the 2× stuck timeout) — only the dropped-tx detection
    // can trigger a resubmit here.
    const fdb = fakeDb({
      staleSubmitted: [staleRow({ id: "X", updatedAt: new Date() })],
      incrementResult: { retry_count: 1, max_retries: 3 },
    });
    const { alerter } = spyAlerter();
    const { cron, queue } = deps(
      fdb,
      fakeReceipts(null, false), // no receipt + node has no record of the tx => dropped
      config(),
      alerter
    );
    await cronTick(cron);
    expect(fdb.incremented).toEqual(["X"]); // resubmit (same nonce), nonce stays counted
    expect(fdb.failed).toEqual([]);
    const [d] = await queue.consume(2, { max: 1, blockMs: 0 });
    expect(d!.message.replace_nonce).toBe(1);
  });

  it("leaves a still-pending tx alone until the stuck timeout (known to the node)", async () => {
    const fdb = fakeDb({
      staleSubmitted: [staleRow({ id: "P", updatedAt: new Date() })],
      incrementResult: { retry_count: 1, max_retries: 3 },
    });
    const { alerter } = spyAlerter();
    const { cron, queue } = deps(
      fdb,
      fakeReceipts(null, true), // no receipt but still in the mempool => wait, don't replace
      config(),
      alerter
    );
    await cronTick(cron);
    expect(fdb.incremented).toEqual([]);
    expect(fdb.failed).toEqual([]);
    expect(queue.size()).toBe(0);
  });

  it("recovers a crashed `submitting` row by resubmitting its nonce", async () => {
    const fdb = fakeDb({
      staleSubmitting: [
        staleRow({
          id: "S",
          status: "submitting",
          relayTxHash: null,
          updatedAt: new Date(Date.now() - 20 * 60_000),
        }),
      ],
      incrementResult: { retry_count: 1, max_retries: 3 },
    });
    const { alerter } = spyAlerter();
    const { cron, queue } = deps(fdb, fakeReceipts(null), config(), alerter);
    await cronTick(cron);
    expect(fdb.incremented).toEqual(["S"]);
    const [d] = await queue.consume(2, { max: 1, blockMs: 0 });
    expect(d!.message.replace_nonce).toBe(1);
  });

  it("republishes stale pending and failed rows whose queue message was lost", async () => {
    const fdb = fakeDb({
      stalePending: [
        staleRow({ id: "P1", status: "pending", relayTxHash: null }),
      ],
      staleFailed: [staleRow({ id: "F1", status: "failed" })],
    });
    const { alerter } = spyAlerter();
    const { cron, queue } = deps(fdb, fakeReceipts(null), config(), alerter);
    await cronTick(cron);
    // Both republished as plain messages (no replace_nonce — the worker drives the retry).
    const got = await queue.consume(2, { max: 10, blockMs: 0 });
    expect(got).toHaveLength(2);
    for (const d of got) expect(d.message.replace_nonce).toBeUndefined();
    // No budget spent and no state transitions — this is recovery, not a retry decision.
    expect(fdb.failed).toEqual([]);
    expect(fdb.incremented).toEqual([]);
  });

  it("does not republish a pending row that already has a relay tx hash", async () => {
    const fdb = fakeDb({
      stalePending: [staleRow({ id: "P2", status: "pending" })], // relayTxHash set by default
    });
    const { alerter } = spyAlerter();
    const { cron, queue } = deps(fdb, fakeReceipts(null), config(), alerter);
    await cronTick(cron);
    expect(queue.size()).toBe(0);
  });

  it("leaves a fresh not-yet-mined tx alone", async () => {
    const fdb = fakeDb({
      staleSubmitted: [staleRow({ id: "4", updatedAt: new Date() })],
    });
    const { alerter } = spyAlerter();
    const { cron, queue } = deps(fdb, fakeReceipts(null), config(), alerter);
    await cronTick(cron);
    expect(fdb.failed).toEqual([]);
    expect(fdb.incremented).toEqual([]);
    expect(queue.size()).toBe(0);
  });

  it("dead-letters a stuck tx when the resubmit budget is exhausted", async () => {
    const fdb = fakeDb({
      staleSubmitted: [
        staleRow({ id: "7", updatedAt: new Date(Date.now() - 20 * 60_000) }),
      ],
      incrementResult: { retry_count: 2, max_retries: 2 },
    });
    const { alerter } = spyAlerter();
    const { cron, queue } = deps(fdb, fakeReceipts(null), config(), alerter);
    await cronTick(cron);
    expect(fdb.deadLettered).toEqual(["7"]);
    expect(queue.size()).toBe(0);
  });

  it("alerts when dead-letter accumulation crosses the threshold", async () => {
    const fdb = fakeDb({ deadLetterCount: 3 });
    const spy = spyAlerter();
    const { cron } = deps(
      fdb,
      fakeReceipts(null),
      config({ deadLetterAlertThreshold: 2 }),
      spy.alerter
    );
    await cronTick(cron);
    expect(spy.events).toContain("dead_letter.accumulation");
  });

  it("does not alert below the threshold", async () => {
    const fdb = fakeDb({ deadLetterCount: 1 });
    const spy = spyAlerter();
    const { cron } = deps(
      fdb,
      fakeReceipts(null),
      config({ deadLetterAlertThreshold: 2 }),
      spy.alerter
    );
    await cronTick(cron);
    expect(spy.events).toEqual([]);
  });
});
