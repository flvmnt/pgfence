-- Fixture: ADD COLUMN with GENERATED ALWAYS AS ... STORED
-- Expected: HIGH risk — causes full table rewrite

SET lock_timeout = '2s';
SET statement_timeout = '5min';

ALTER TABLE appointments ADD COLUMN full_name text GENERATED ALWAYS AS (first_name || ' ' || last_name) STORED;
