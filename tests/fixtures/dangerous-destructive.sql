-- Fixture: Destructive operation patterns
-- Expected: CRITICAL risk

-- 1) DROP TABLE
DROP TABLE old_appointments;

-- 2) TRUNCATE
TRUNCATE notifications;

-- 3) DELETE without WHERE
DELETE FROM audit_log;

-- 4) VACUUM FULL (ACCESS EXCLUSIVE)
VACUUM FULL appointments;
