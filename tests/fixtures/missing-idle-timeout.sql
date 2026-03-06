-- Fixture: Missing idle_in_transaction_session_timeout
-- Expected: policy violation for missing-idle-timeout

SET lock_timeout = '2s';
SET statement_timeout = '5min';

ALTER TABLE users ADD COLUMN IF NOT EXISTS notes TEXT;
