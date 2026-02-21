-- Fixture: ADD COLUMN with json type instead of jsonb
-- Expected: LOW risk warning — use jsonb instead

SET lock_timeout = '2s';
SET statement_timeout = '5min';

ALTER TABLE appointments ADD COLUMN metadata json;
