-- Fixture: Missing policy patterns
-- Expected: Policy violations (no lock_timeout, no statement_timeout)

-- Missing SET lock_timeout — should trigger policy violation
-- Missing SET statement_timeout — should trigger policy violation
-- Missing SET application_name — should trigger warning

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS notes TEXT;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notes ON appointments(notes);
