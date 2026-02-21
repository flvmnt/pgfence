-- Fixture: ADD COLUMN with serial type instead of IDENTITY
-- Expected: MEDIUM risk warning — use GENERATED ALWAYS AS IDENTITY

SET lock_timeout = '2s';
SET statement_timeout = '5min';

ALTER TABLE appointments ADD COLUMN legacy_id serial;
