-- demo-2-create-index-blocking.sql
-- Missing CONCURRENTLY keyword.
-- This acquires a SHARE lock, completely blocking all writes (UPDATE, DELETE, INSERT) until the index finishes building.

-- Satisfy safety policies:
SET lock_timeout = '2s';
SET statement_timeout = '5min';
SET application_name = 'migrate:demo2';
SET idle_in_transaction_session_timeout = '30s';

CREATE INDEX idx_users_email_tenant ON users (tenant_id, email varchar_pattern_ops);
