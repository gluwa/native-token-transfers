import { join } from "node:path";

import { Pool } from "pg";

import {
  advisoryKey,
  tryAcquireWalletLock,
  withLeaderLock,
} from "../src/db/advisoryLock.js";
import { BlockTrackerRepo } from "../src/db/blockTracker.js";
import { runMigrations } from "../src/db/migrate.js";
import { type Database, createPgDatabase } from "../src/db/pool.js";
import { TransactionsRepo } from "../src/db/transactions.js";

// Gated: runs only against a real Postgres (pg-mem diverges on jsonb/bigint/SKIP LOCKED).
// Start one with `docker compose up -d postgres` and set TEST_DATABASE_URL.
const url = process.env["TEST_DATABASE_URL"];
const d = url ? describe : describe.skip;
const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

const payloadFixture = {
  emitterChain: 2,
  emitterAddress: "0x" + "00".repeat(12) + "22".repeat(20),
  sequence: "42",
  sourceTxHash: "0x" + "ab".repeat(32),
  dstChain: 6,
  dstAddr: "0x" + "00".repeat(12) + "44".repeat(20),
  gasLimit: "300000",
  requestBytes: "0x9945ff10",
};

function insertInput(eventTxHash: string) {
  return {
    sourceChainId: 2,
    destinationChainId: 6,
    relayerAddress: "0x" + "33".repeat(20),
    eventTxHash,
    payload: payloadFixture,
    maxRetries: 2,
  };
}

d("db (real Postgres)", () => {
  let pool: Pool;
  let db: Database;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    db = createPgDatabase(pool);
    await runMigrations(pool, MIGRATIONS_DIR);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE transactions, block_tracker");
  });

  describe("runMigrations", () => {
    it("is idempotent on a second run", async () => {
      const ran = await runMigrations(pool, MIGRATIONS_DIR);
      expect(ran).toEqual([]); // nothing new to apply
    });
  });

  describe("TransactionsRepo", () => {
    it("inserts a pending row and round-trips the jsonb payload", async () => {
      const rec = await TransactionsRepo.insertPending(db, insertInput("0x01"));
      expect(rec.status).toBe("pending");
      expect(rec.retryCount).toBe(0);
      expect(rec.maxRetries).toBe(2);
      expect(rec.payload).toEqual(payloadFixture);
      expect(rec.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("is idempotent on (source_chain_id, event_tx_hash)", async () => {
      const a = await TransactionsRepo.insertPending(db, insertInput("0xdup"));
      const b = await TransactionsRepo.insertPending(db, insertInput("0xdup"));
      expect(b.id).toBe(a.id);
      const found = await TransactionsRepo.findBySourceEvent(db, 2, "0xdup");
      expect(found?.id).toBe(a.id);
    });

    it("enforces the pending → submitted → confirmed lifecycle", async () => {
      const rec = await TransactionsRepo.insertPending(db, insertInput("0x02"));
      expect(
        await TransactionsRepo.markSubmitted(db, rec.id, {
          relayTxHash: "0x" + "de".repeat(32),
          walletUsed: "0x" + "ab".repeat(20),
          nonceUsed: 5,
        })
      ).toBe(true);
      // A second submit from `submitted` is allowed and updates the hash on the SAME
      // nonce: this is the replacement-by-fee resubmit path (cron/worker re-broadcast a
      // stuck tx and record the new hash). See markSubmitted + worker.ts isResubmit.
      expect(
        await TransactionsRepo.markSubmitted(db, rec.id, {
          relayTxHash: "0x" + "ee".repeat(32),
          walletUsed: "0x" + "ab".repeat(20),
          nonceUsed: 5,
        })
      ).toBe(true);
      expect(await TransactionsRepo.markConfirmed(db, rec.id)).toBe(true);
      const found = await TransactionsRepo.findBySourceEvent(db, 2, "0x02");
      expect(found?.status).toBe("confirmed");
      expect(found?.nonceUsed).toBe(5);
      expect(found?.relayTxHash).toBe("0x" + "ee".repeat(32));
    });

    it("increments retry_count on failure and reports the budget", async () => {
      const rec = await TransactionsRepo.insertPending(db, insertInput("0x03"));
      const r1 = await TransactionsRepo.markFailed(db, rec.id, "boom");
      expect(r1).toEqual({ retryCount: 1, maxRetries: 2 });
      const r2 = await TransactionsRepo.markFailed(db, rec.id, "boom again");
      expect(r2?.retryCount).toBe(2);
      expect(
        await TransactionsRepo.markDeadLetter(db, rec.id, "exhausted")
      ).toBe(true);
      expect(await TransactionsRepo.countByStatus(db, "dead_letter")).toBe(1);
    });

    it("selectStaleByStatus returns only old rows in the given status", async () => {
      const fresh = await TransactionsRepo.insertPending(
        db,
        insertInput("0x04")
      );
      await TransactionsRepo.markSubmitted(db, fresh.id, {
        relayTxHash: "0x" + "de".repeat(32),
        walletUsed: "0x" + "ab".repeat(20),
        nonceUsed: 1,
      });
      // Backdate updated_at so it qualifies as stale.
      await db.query(
        "UPDATE transactions SET updated_at = now() - interval '1 hour' WHERE id = $1",
        [fresh.id]
      );
      const stale = await TransactionsRepo.selectStaleByStatus(
        db,
        "submitted",
        new Date(Date.now() - 60_000),
        10
      );
      expect(stale.map((r: { id: string }) => r.id)).toContain(fresh.id);
      // A different status doesn't match.
      expect(
        await TransactionsRepo.selectStaleByStatus(
          db,
          "submitting",
          new Date(Date.now() - 60_000),
          10
        )
      ).toEqual([]);
    });

    it("intent log: markSubmitting reserves a nonce, then markSubmitted records the hash", async () => {
      const rec = await TransactionsRepo.insertPending(db, insertInput("0x06"));
      expect(
        await TransactionsRepo.markSubmitting(db, rec.id, {
          walletUsed: "0x" + "ab".repeat(20),
          nonceUsed: 9,
        })
      ).toBe(true);
      let found = await TransactionsRepo.findBySourceEvent(db, 2, "0x06");
      expect(found?.status).toBe("submitting");
      expect(found?.nonceUsed).toBe(9);
      expect(found?.relayTxHash).toBeNull();

      // incrementRetry keeps the row in `submitting` (nonce stays counted).
      const budget = await TransactionsRepo.incrementRetry(db, rec.id);
      expect(budget).toEqual({ retryCount: 1, maxRetries: 2 });
      found = await TransactionsRepo.findBySourceEvent(db, 2, "0x06");
      expect(found?.status).toBe("submitting");

      // Then the hash is recorded → submitted (same nonce).
      expect(
        await TransactionsRepo.markSubmitted(db, rec.id, {
          relayTxHash: "0x" + "ab".repeat(32),
          walletUsed: "0x" + "ab".repeat(20),
          nonceUsed: 9,
        })
      ).toBe(true);
      found = await TransactionsRepo.findBySourceEvent(db, 2, "0x06");
      expect(found?.status).toBe("submitted");
      expect(found?.nonceUsed).toBe(9);
    });
  });

  describe("BlockTrackerRepo", () => {
    it("initializes from genesis then advances monotonically", async () => {
      const relayer = "0x" + "33".repeat(20);
      // cursor = last-scanned block (scan starts at cursor+1), so genesis 100 seeds 99 and
      // block 100 is the first scanned.
      expect(await BlockTrackerRepo.readOrInit(db, 2, relayer, 100n)).toBe(99n);
      // re-init keeps the existing value
      expect(await BlockTrackerRepo.readOrInit(db, 2, relayer, 999n)).toBe(99n);
      expect(await BlockTrackerRepo.advance(db, 2, relayer, 150n)).toBe(true);
      expect(await BlockTrackerRepo.readOrInit(db, 2, relayer, 0n)).toBe(150n);
      // backward advance is rejected
      expect(await BlockTrackerRepo.advance(db, 2, relayer, 140n)).toBe(false);
      expect(await BlockTrackerRepo.readOrInit(db, 2, relayer, 0n)).toBe(150n);
    });
  });

  describe("advisory locks", () => {
    it("wallet xact lock is exclusive within concurrent transactions", async () => {
      const key = advisoryKey("0x" + "ab".repeat(20));
      // Hold the lock in one transaction and try to grab it in another concurrently.
      let secondAcquired: boolean | undefined;
      await db.transaction(async (tx1) => {
        expect(await tryAcquireWalletLock(tx1, key)).toBe(true);
        await db.transaction(async (tx2) => {
          secondAcquired = await tryAcquireWalletLock(tx2, key);
        });
      });
      expect(secondAcquired).toBe(false);
      // After both transactions end, the lock is free again.
      await db.transaction(async (tx3) => {
        expect(await tryAcquireWalletLock(tx3, key)).toBe(true);
      });
    });

    it("leader lock lets only one holder run at a time", async () => {
      let inner = false;
      const got = await withLeaderLock(pool, 424242, async () => {
        const second = await withLeaderLock(pool, 424242, async () => {
          inner = true;
        });
        expect(second).toBe(false);
      });
      expect(got).toBe(true);
      expect(inner).toBe(false);
    });
  });
});
