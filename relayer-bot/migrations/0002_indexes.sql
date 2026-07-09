-- Cron reconciliation scans status='submitted' AND updated_at < cutoff. A partial index
-- keeps that lookup tight as the table grows.
CREATE INDEX IF NOT EXISTS ix_transactions_submitted_updated
  ON transactions (updated_at) WHERE status = 'submitted';

-- Dead-letter counting for alerts + ops dashboards.
CREATE INDEX IF NOT EXISTS ix_transactions_status ON transactions (status);

-- Per-wallet nonce bookkeeping / lookups.
CREATE INDEX IF NOT EXISTS ix_transactions_wallet ON transactions (wallet_used);
