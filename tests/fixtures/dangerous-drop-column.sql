-- Fixture: DROP COLUMN patterns
-- Expected: HIGH risk, ACCESS EXCLUSIVE lock

ALTER TABLE appointments DROP COLUMN legacy_status;
