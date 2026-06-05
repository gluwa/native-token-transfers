import type { ChainId, Hex, TransactionRecord, TxStatus } from "../types.js";
import type { Queryable } from "./pool.js";

interface Row {
  id: string;
  source_chain_id: number;
  destination_chain_id: number;
  relayer_address: string;
  event_tx_hash: string;
  payload: unknown;
  status: TxStatus;
  relay_tx_hash: string | null;
  wallet_used: string | null;
  nonce_used: number | null;
  retry_count: number;
  max_retries: number;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
}

function rowToRecord(r: Row): TransactionRecord {
  return {
    id: r.id,
    sourceChainId: r.source_chain_id,
    destinationChainId: r.destination_chain_id,
    relayerAddress: r.relayer_address,
    eventTxHash: r.event_tx_hash,
    payload: r.payload,
    status: r.status,
    relayTxHash: r.relay_tx_hash,
    walletUsed: r.wallet_used,
    nonceUsed: r.nonce_used,
    retryCount: r.retry_count,
    maxRetries: r.max_retries,
    errorMessage: r.error_message,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface InsertPendingInput {
  sourceChainId: ChainId;
  destinationChainId: ChainId;
  relayerAddress: string;
  eventTxHash: Hex;
  payload: unknown;
  maxRetries: number;
}

export const TransactionsRepo = {
  async findBySourceEvent(
    db: Queryable,
    sourceChainId: ChainId,
    eventTxHash: Hex
  ): Promise<TransactionRecord | null> {
    const res = await db.query<Row>(
      "SELECT * FROM transactions WHERE source_chain_id = $1 AND event_tx_hash = $2",
      [sourceChainId, eventTxHash]
    );
    const row = res.rows[0];
    return row ? rowToRecord(row) : null;
  },

  /// Insert a pending row, or return the existing one if a row for (source_chain_id,
  /// event_tx_hash) already exists (idempotency: a racing worker / re-scan).
  async insertPending(
    db: Queryable,
    input: InsertPendingInput
  ): Promise<TransactionRecord> {
    const res = await db.query<Row>(
      `INSERT INTO transactions
         (source_chain_id, destination_chain_id, relayer_address, event_tx_hash,
          payload, status, retry_count, max_retries)
       VALUES ($1, $2, $3, $4, $5, 'pending', 0, $6)
       ON CONFLICT (source_chain_id, event_tx_hash) DO NOTHING
       RETURNING *`,
      [
        input.sourceChainId,
        input.destinationChainId,
        input.relayerAddress,
        input.eventTxHash,
        input.payload,
        input.maxRetries,
      ]
    );
    const inserted = res.rows[0];
    if (inserted) return rowToRecord(inserted);
    // Conflict: the row already exists; return it.
    const existing = await this.findBySourceEvent(
      db,
      input.sourceChainId,
      input.eventTxHash
    );
    if (!existing) {
      throw new Error(
        `insertPending conflict but no existing row for ${input.sourceChainId}/${input.eventTxHash}`
      );
    }
    return existing;
  },

  /// Intent log: reserve a wallet + nonce and commit `submitting` BEFORE broadcasting, so a
  /// crash-after-broadcast leaves a tracked record (recovery resubmits this exact nonce).
  /// Fires from pending/failed (fresh) or submitting (re-reserve is a no-op-ish overwrite).
  async markSubmitting(
    db: Queryable,
    id: string,
    fields: { walletUsed: string; nonceUsed: number }
  ): Promise<boolean> {
    const res = await db.query(
      `UPDATE transactions
         SET status = 'submitting', wallet_used = $2, nonce_used = $3,
             updated_at = now()
       WHERE id = $1 AND status IN ('pending', 'failed', 'submitting')`,
      [id, fields.walletUsed, fields.nonceUsed]
    );
    return (res.rowCount ?? 0) > 0;
  },

  /// → submitted. Fires from submitting (normal) or submitted (a replacement resubmit
  /// updating the hash). wallet_used/nonce_used were set by markSubmitting; re-set here for
  /// safety. Returns false if the row was already advanced past these states.
  async markSubmitted(
    db: Queryable,
    id: string,
    fields: { relayTxHash: Hex; walletUsed: string; nonceUsed: number }
  ): Promise<boolean> {
    const res = await db.query(
      `UPDATE transactions
         SET status = 'submitted', relay_tx_hash = $2, wallet_used = $3,
             nonce_used = $4, updated_at = now()
       WHERE id = $1 AND status IN ('pending', 'failed', 'submitting', 'submitted')`,
      [id, fields.relayTxHash, fields.walletUsed, fields.nonceUsed]
    );
    return (res.rowCount ?? 0) > 0;
  },

  /// → confirmed. Allowed from any non-terminal state (worker found it already on-chain, or
  /// cron found a receipt).
  async markConfirmed(db: Queryable, id: string): Promise<boolean> {
    const res = await db.query(
      `UPDATE transactions SET status = 'confirmed', updated_at = now()
       WHERE id = $1 AND status IN ('pending', 'submitting', 'submitted', 'failed')`,
      [id]
    );
    return (res.rowCount ?? 0) > 0;
  },

  /// Bump retry_count WITHOUT leaving the submitting state — used when a broadcast of an
  /// already-reserved nonce fails and we'll resubmit the same nonce (with a bigger fee).
  /// Returns the new budget so the caller can dead-letter when exhausted.
  async incrementRetry(
    db: Queryable,
    id: string
  ): Promise<{ retryCount: number; maxRetries: number } | null> {
    const res = await db.query<{ retry_count: number; max_retries: number }>(
      `UPDATE transactions
         SET retry_count = retry_count + 1, updated_at = now()
       WHERE id = $1 AND status IN ('submitting', 'submitted')
       RETURNING retry_count, max_retries`,
      [id]
    );
    const row = res.rows[0];
    return row
      ? { retryCount: row.retry_count, maxRetries: row.max_retries }
      : null;
  },

  /// → failed, incrementing retry_count. Returns the new retry_count + max_retries so the
  /// caller can decide whether to requeue or dead-letter.
  async markFailed(
    db: Queryable,
    id: string,
    errorMessage: string
  ): Promise<{ retryCount: number; maxRetries: number } | null> {
    const res = await db.query<{ retry_count: number; max_retries: number }>(
      `UPDATE transactions
         SET status = 'failed', error_message = $2,
             retry_count = retry_count + 1, updated_at = now()
       WHERE id = $1 AND status IN ('pending', 'submitted', 'failed')
       RETURNING retry_count, max_retries`,
      [id, errorMessage]
    );
    const row = res.rows[0];
    return row
      ? { retryCount: row.retry_count, maxRetries: row.max_retries }
      : null;
  },

  async markDeadLetter(
    db: Queryable,
    id: string,
    errorMessage: string
  ): Promise<boolean> {
    // `confirmed` is terminal and must NEVER be clobbered: the cron can confirm a row from
    // an on-chain receipt while a worker is concurrently resubmitting it (they hold
    // disjoint locks), and the worker's failure path must not turn that success into a
    // dead_letter.
    const res = await db.query(
      `UPDATE transactions SET status = 'dead_letter', error_message = $2, updated_at = now()
       WHERE id = $1 AND status NOT IN ('confirmed', 'dead_letter')`,
      [id, errorMessage]
    );
    return (res.rowCount ?? 0) > 0;
  },

  /// Rows in `status` not touched since `olderThan` — claimed with FOR UPDATE SKIP LOCKED
  /// so only one cron instance processes each. Used to reconcile stale `submitted` rows
  /// (receipt check) and recover stale `submitting` rows (crashed mid-broadcast). (Real
  /// Postgres; SKIP LOCKED is unsupported by pg-mem.)
  async selectStaleByStatus(
    db: Queryable,
    status: TxStatus,
    olderThan: Date,
    limit: number
  ): Promise<TransactionRecord[]> {
    const res = await db.query<Row>(
      `SELECT * FROM transactions
         WHERE status = $1 AND updated_at < $2
         ORDER BY updated_at, id
         LIMIT $3
         FOR UPDATE SKIP LOCKED`,
      [status, olderThan, limit]
    );
    return res.rows.map(rowToRecord);
  },

  /// Rows currently in `status` (oldest first). Used by the listener's startup sweep to
  /// re-publish pending rows whose queue message may have been lost on a crash.
  async selectByStatus(
    db: Queryable,
    status: TxStatus,
    limit: number
  ): Promise<TransactionRecord[]> {
    const res = await db.query<Row>(
      `SELECT * FROM transactions WHERE status = $1 ORDER BY created_at LIMIT $2`,
      [status, limit]
    );
    return res.rows.map(rowToRecord);
  },

  async countByStatus(db: Queryable, status: TxStatus): Promise<number> {
    const res = await db.query<{ c: string }>(
      "SELECT count(*)::text AS c FROM transactions WHERE status = $1",
      [status]
    );
    return Number(res.rows[0]?.c ?? "0");
  },
};
