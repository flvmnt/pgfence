SET lock_timeout = '2s';
SET statement_timeout = '5min';
SET application_name = 'migrate:20260415_add_last_seen_at_expand';
SET idle_in_transaction_session_timeout = '30s';

ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
