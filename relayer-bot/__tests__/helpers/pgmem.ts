import { randomUUID } from "node:crypto";

import { DataType, newDb } from "pg-mem";

import { type Database, createPgDatabase } from "../../src/db/pool.js";

// A pg-mem-compatible schema mirroring migrations/0001 (minus CREATE EXTENSION and the
// idempotency DO-block, which pg-mem doesn't parse). pg-mem diverges from real Postgres on
// jsonb object params, bigint return types, and SKIP LOCKED — so this backs only the
// lightweight repo-logic smoke tests; db.integration.test.ts covers real semantics.
const SCHEMA = `
CREATE TABLE block_tracker (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id INTEGER NOT NULL,
  relayer_address VARCHAR(66) NOT NULL,
  last_scanned_block BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_block_tracker_chain_relayer UNIQUE (chain_id, relayer_address)
);
CREATE TYPE tx_status AS ENUM ('pending','submitting','submitted','confirmed','failed','dead_letter');
CREATE TABLE transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_chain_id INTEGER NOT NULL,
  destination_chain_id INTEGER NOT NULL,
  relayer_address VARCHAR(66) NOT NULL,
  event_tx_hash VARCHAR(66) NOT NULL,
  payload JSONB NOT NULL,
  status tx_status NOT NULL DEFAULT 'pending',
  relay_tx_hash VARCHAR(66),
  wallet_used VARCHAR(42),
  nonce_used INTEGER,
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_transactions_src_event UNIQUE (source_chain_id, event_tx_hash)
);
`;

export function setupPgMem(): { db: Database; close: () => Promise<void> } {
  const mem = newDb();
  mem.public.registerFunction({
    name: "gen_random_uuid",
    returns: DataType.uuid,
    implementation: () => randomUUID(),
    impure: true,
  });
  mem.public.none(SCHEMA);
  const adapter = mem.adapters.createPg() as { Pool: new () => unknown };
  const pool = new adapter.Pool();
  const db = createPgDatabase(pool as never);
  return {
    db,
    close: async () => {
      const p = pool as { end?: () => Promise<void> };
      if (p.end) await p.end();
    },
  };
}
