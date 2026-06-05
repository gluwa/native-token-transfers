-- Intent-log state: a row is set to 'submitting' (with its reserved wallet + nonce) in a
-- committed transaction BEFORE the destination tx is broadcast. If the process crashes
-- after broadcasting but before recording the tx hash, recovery resubmits that exact nonce
-- (replacement-by-fee) instead of leaving an untracked "orphan" tx that could stall the
-- wallet. ALTER TYPE ... ADD VALUE runs fine inside the migration transaction on Postgres
-- 12+ (the value just can't be used until this migration commits, which it does).
ALTER TYPE tx_status ADD VALUE IF NOT EXISTS 'submitting' AFTER 'pending';
