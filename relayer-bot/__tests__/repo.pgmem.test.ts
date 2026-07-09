import { BlockTrackerRepo } from "../src/db/blockTracker.js";
import { type Database } from "../src/db/pool.js";
import { TransactionsRepo } from "../src/db/transactions.js";
import { setupPgMem } from "./helpers/pgmem.js";

// Always-on smoke coverage of the repo SQL against pg-mem. Rigorous semantics (jsonb,
// SKIP LOCKED, advisory locks, bigint) are covered by db.integration.test.ts on real PG.

const RELAYER = "0x" + "33".repeat(20);

function insertInput(eventTxHash: string) {
  return {
    sourceChainId: 2,
    destinationChainId: 6,
    relayerAddress: RELAYER,
    eventTxHash,
    payload: { sequence: "42", dstChain: 6 },
    maxRetries: 2,
  };
}

describe("BlockTrackerRepo (pg-mem)", () => {
  let db: Database;
  let close: () => Promise<void>;
  beforeEach(() => {
    ({ db, close } = setupPgMem());
  });
  afterEach(async () => {
    await close();
  });

  it("initializes from genesis and is idempotent", async () => {
    // The cursor is the last-scanned block (scan starts at cursor+1), so a genesis of 100
    // seeds 99 — that way block 100 itself is the first block scanned.
    expect(await BlockTrackerRepo.readOrInit(db, 2, RELAYER, 100n)).toBe(99n);
    expect(await BlockTrackerRepo.readOrInit(db, 2, RELAYER, 999n)).toBe(99n);
  });

  it("advances monotonically", async () => {
    await BlockTrackerRepo.readOrInit(db, 2, RELAYER, 100n);
    expect(await BlockTrackerRepo.advance(db, 2, RELAYER, 150n)).toBe(true);
    expect(await BlockTrackerRepo.readOrInit(db, 2, RELAYER, 0n)).toBe(150n);
    expect(await BlockTrackerRepo.advance(db, 2, RELAYER, 140n)).toBe(false);
    expect(await BlockTrackerRepo.readOrInit(db, 2, RELAYER, 0n)).toBe(150n);
  });
});

describe("TransactionsRepo (pg-mem)", () => {
  let db: Database;
  let close: () => Promise<void>;
  beforeEach(() => {
    ({ db, close } = setupPgMem());
  });
  afterEach(async () => {
    await close();
  });

  it("inserts pending and dedupes on (source_chain_id, event_tx_hash)", async () => {
    const a = await TransactionsRepo.insertPending(db, insertInput("0xaa"));
    expect(a.status).toBe("pending");
    const b = await TransactionsRepo.insertPending(db, insertInput("0xaa"));
    expect(b.id).toBe(a.id);
  });

  it("transitions pending → submitting → submitted → confirmed", async () => {
    const W = "0x" + "ab".repeat(20);
    const HASH = "0x" + "de".repeat(32);
    const HASH2 = "0x" + "ee".repeat(32);
    const rec = await TransactionsRepo.insertPending(db, insertInput("0xbb"));

    // intent log: reserve a nonce as `submitting` before broadcasting
    expect(
      await TransactionsRepo.markSubmitting(db, rec.id, {
        walletUsed: W,
        nonceUsed: 5,
      })
    ).toBe(true);
    expect(
      (await TransactionsRepo.findBySourceEvent(db, 2, "0xbb"))?.status
    ).toBe("submitting");

    expect(
      await TransactionsRepo.markSubmitted(db, rec.id, {
        relayTxHash: HASH,
        walletUsed: W,
        nonceUsed: 5,
      })
    ).toBe(true);

    // a resubmit (replacement) updates the hash but stays submitted on the same nonce
    expect(
      await TransactionsRepo.markSubmitted(db, rec.id, {
        relayTxHash: HASH2,
        walletUsed: W,
        nonceUsed: 5,
      })
    ).toBe(true);

    expect(await TransactionsRepo.markConfirmed(db, rec.id)).toBe(true);
    const found = await TransactionsRepo.findBySourceEvent(db, 2, "0xbb");
    expect(found?.status).toBe("confirmed");
    expect(found?.relayTxHash).toBe(HASH2);
    expect(found?.nonceUsed).toBe(5);

    // confirmed is terminal — further transitions are no-ops
    expect(await TransactionsRepo.markConfirmed(db, rec.id)).toBe(false);
    expect(
      await TransactionsRepo.markSubmitted(db, rec.id, {
        relayTxHash: HASH,
        walletUsed: W,
        nonceUsed: 9,
      })
    ).toBe(false);
  });

  it("markDeadLetter never clobbers a confirmed row", async () => {
    const W = "0x" + "ab".repeat(20);
    const rec = await TransactionsRepo.insertPending(db, insertInput("0xdd"));
    await TransactionsRepo.markSubmitting(db, rec.id, {
      walletUsed: W,
      nonceUsed: 1,
    });
    await TransactionsRepo.markSubmitted(db, rec.id, {
      relayTxHash: "0x" + "de".repeat(32),
      walletUsed: W,
      nonceUsed: 1,
    });
    expect(await TransactionsRepo.markConfirmed(db, rec.id)).toBe(true);
    // A concurrent worker failure path must NOT turn the success into a dead_letter.
    expect(
      await TransactionsRepo.markDeadLetter(db, rec.id, "late failure")
    ).toBe(false);
    expect(
      (await TransactionsRepo.findBySourceEvent(db, 2, "0xdd"))?.status
    ).toBe("confirmed");
  });

  it("clears a never-broadcast nonce when confirming (already-consumed path)", async () => {
    const W = "0x" + "ab".repeat(20);
    // Crash window: `submitting` committed (nonce reserved) but never broadcast — no
    // relay_tx_hash. Someone else delivers the VAA; the worker confirms via isVAAConsumed.
    const rec = await TransactionsRepo.insertPending(db, insertInput("0xe1"));
    await TransactionsRepo.markSubmitting(db, rec.id, {
      walletUsed: W,
      nonceUsed: 7,
    });
    expect(await TransactionsRepo.markConfirmed(db, rec.id)).toBe(true);
    const found = await TransactionsRepo.findBySourceEvent(db, 2, "0xe1");
    expect(found?.status).toBe("confirmed");
    // The nonce never reached the chain; keeping it would wedge the wallet (the max()
    // scan counts confirmed rows and every later tx gaps behind the phantom nonce).
    expect(found?.nonceUsed).toBeNull();
  });

  it("keeps the nonce when confirming a row whose tx was broadcast", async () => {
    const W = "0x" + "ab".repeat(20);
    const rec = await TransactionsRepo.insertPending(db, insertInput("0xe2"));
    await TransactionsRepo.markSubmitting(db, rec.id, {
      walletUsed: W,
      nonceUsed: 7,
    });
    await TransactionsRepo.markSubmitted(db, rec.id, {
      relayTxHash: "0x" + "de".repeat(32),
      walletUsed: W,
      nonceUsed: 7,
    });
    expect(await TransactionsRepo.markConfirmed(db, rec.id)).toBe(true);
    // Broadcast happened — the tx will consume the nonce on-chain; keep it counted.
    expect(
      (await TransactionsRepo.findBySourceEvent(db, 2, "0xe2"))?.nonceUsed
    ).toBe(7);
  });

  it("clears a never-broadcast nonce when dead-lettering", async () => {
    const W = "0x" + "ab".repeat(20);
    const rec = await TransactionsRepo.insertPending(db, insertInput("0xe3"));
    await TransactionsRepo.markSubmitting(db, rec.id, {
      walletUsed: W,
      nonceUsed: 9,
    });
    expect(await TransactionsRepo.markDeadLetter(db, rec.id, "gave up")).toBe(
      true
    );
    const found = await TransactionsRepo.findBySourceEvent(db, 2, "0xe3");
    expect(found?.status).toBe("dead_letter");
    expect(found?.nonceUsed).toBeNull(); // releases the nonce for gap-fill
  });

  it("touch bumps updated_at without changing state", async () => {
    const rec = await TransactionsRepo.insertPending(db, insertInput("0xe4"));
    await db.query("UPDATE transactions SET updated_at = '2020-01-01'");
    await TransactionsRepo.touch(db, rec.id);
    const found = await TransactionsRepo.findBySourceEvent(db, 2, "0xe4");
    expect(found?.status).toBe("pending");
    expect(found!.updatedAt.getFullYear()).toBeGreaterThan(2020);
  });

  it("counts failures and dead-letters", async () => {
    const rec = await TransactionsRepo.insertPending(db, insertInput("0xcc"));
    expect(
      (await TransactionsRepo.markFailed(db, rec.id, "x"))?.retryCount
    ).toBe(1);
    expect(await TransactionsRepo.markDeadLetter(db, rec.id, "done")).toBe(
      true
    );
    expect(await TransactionsRepo.countByStatus(db, "dead_letter")).toBe(1);
  });
});
