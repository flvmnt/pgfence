-- Fixture: Dangerous ALTER COLUMN patterns
-- Expected: HIGH/MEDIUM risk, ACCESS EXCLUSIVE lock

-- 1) Change column type (table rewrite)
ALTER TABLE appointments ALTER COLUMN status TYPE TEXT;

-- 2) SET NOT NULL (table scan + ACCESS EXCLUSIVE)
ALTER TABLE appointments ALTER COLUMN worker_id SET NOT NULL;
