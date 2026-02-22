-- demo-1-add-column-constant-default.sql
-- On Postgres 11+, adding a column with a constant DEFAULT is metadata-only and safe.
-- pgfence correctly identifies this as LOW risk, whereas older tools might flag it as a severe downtime risk.

-- Satisfy safety policies:
SET lock_timeout = '2s';
SET statement_timeout = '5min';
SET application_name = 'migrate:demo1';
SET idle_in_transaction_session_timeout = '30s';

ALTER TABLE subscriptions
ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT true;
