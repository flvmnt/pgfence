-- Fixture: Data type best practices violations
-- Expected: LOW risk warnings for int, varchar(N), timestamp

SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- 1) integer column — should use bigint
ALTER TABLE appointments ADD COLUMN visit_count integer;

-- 2) varchar(N) — should use text
ALTER TABLE appointments ADD COLUMN nickname varchar(100);

-- 3) timestamp without time zone — should use timestamptz
ALTER TABLE appointments ADD COLUMN scheduled_at timestamp;
