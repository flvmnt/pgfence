BEGIN;
SET lock_timeout = '2s';
SET statement_timeout = '5min';
SET application_name = 'migrate:test';
SET idle_in_transaction_session_timeout = '30s';
ALTER TABLE appointments ALTER COLUMN status DROP NOT NULL;
-- Missing COMMIT intentionally
