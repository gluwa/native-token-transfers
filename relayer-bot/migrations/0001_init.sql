-- Relayer bot schema: block tracking + transaction records.
-- gen_random_uuid() needs pgcrypto on older Postgres; built in on 13+.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Tracks the last scanned block per (chain, relayer) so listeners resume after a restart
-- without missing events or rescanning.
CREATE TABLE IF NOT EXISTS block_tracker (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id            INTEGER     NOT NULL,
  relayer_address     VARCHAR(66) NOT NULL,
  last_scanned_block  BIGINT      NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_block_tracker_chain_relayer UNIQUE (chain_id, relayer_address)
);

DO $$ BEGIN
  CREATE TYPE tx_status AS ENUM
    ('pending', 'submitted', 'confirmed', 'failed', 'dead_letter');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- One row per relay, from discovery through confirmation. Source of truth for execution
-- state, retry eligibility, and audit history.
CREATE TABLE IF NOT EXISTS transactions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_chain_id       INTEGER      NOT NULL,
  destination_chain_id  INTEGER      NOT NULL,
  relayer_address       VARCHAR(66)  NOT NULL,
  event_tx_hash         VARCHAR(66)  NOT NULL,
  payload               JSONB        NOT NULL,
  status                tx_status    NOT NULL DEFAULT 'pending',
  relay_tx_hash         VARCHAR(66),
  wallet_used           VARCHAR(42),
  -- The design doc spells this "nonce_usd"; corrected to nonce_used.
  nonce_used            INTEGER,
  retry_count           INTEGER      NOT NULL DEFAULT 0,
  max_retries           INTEGER      NOT NULL DEFAULT 3,
  error_message         TEXT,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- Idempotency key. The doc says UNIQUE(chain_id, event_tx_hash) but the column is
  -- source_chain_id: an event tx hash only exists on the source chain, so the correct key
  -- is (source_chain_id, event_tx_hash). Workers dedupe on this pair.
  CONSTRAINT uq_transactions_src_event UNIQUE (source_chain_id, event_tx_hash)
);
