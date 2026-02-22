-- demo-3-change-column-type.sql
-- Altering a column type often requires an ACCESS EXCLUSIVE lock and a full table rewrite.
-- Completely blocks reads and writes.

-- Satisfy safety policies:
SET lock_timeout = '2s';
SET statement_timeout = '5min';
SET application_name = 'migrate:demo3';
SET idle_in_transaction_session_timeout = '30s';

ALTER TABLE payments
ALTER COLUMN amount TYPE numeric(10, 2);
