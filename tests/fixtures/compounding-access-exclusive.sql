-- Fixture: Multiple ACCESS EXCLUSIVE statements in same transaction
-- Expected: policy warning — compounding danger

SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- First dangerous statement: SET NOT NULL (ACCESS EXCLUSIVE, full scan)
ALTER TABLE appointments ALTER COLUMN status SET NOT NULL;

-- Second dangerous statement: ALTER COLUMN TYPE (ACCESS EXCLUSIVE, table rewrite)
ALTER TABLE appointments ALTER COLUMN notes TYPE VARCHAR(500);
