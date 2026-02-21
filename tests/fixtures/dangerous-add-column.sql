-- Fixture: Dangerous ADD COLUMN patterns
-- Expected: HIGH risk, ACCESS EXCLUSIVE lock

-- 1) NOT NULL without DEFAULT (fails on non-empty table)
ALTER TABLE appointments ADD COLUMN status VARCHAR(20) NOT NULL;

-- 2) NOT NULL with DEFAULT (table rewrite for volatile default)
ALTER TABLE appointments ADD COLUMN created_at TIMESTAMP NOT NULL DEFAULT clock_timestamp();

-- 3) Backfill inside migration (should be out-of-band)
UPDATE appointments SET status = 'pending' WHERE status IS NULL;
