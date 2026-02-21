-- Fixture: CREATE INDEX CONCURRENTLY inside a transaction
-- Expected: Policy violation (CONCURRENTLY in transaction will fail)

BEGIN;
SET lock_timeout = '2s';
SET statement_timeout = '5min';
CREATE INDEX CONCURRENTLY idx_test ON appointments(status);
COMMIT;
