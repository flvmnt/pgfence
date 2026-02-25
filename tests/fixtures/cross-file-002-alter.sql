SET lock_timeout = '2s';
SET statement_timeout = '5min';
SET application_name = 'migrate:002';
SET idle_in_transaction_session_timeout = '30s';

-- This index on a table created in 001 should be suppressed with cross-file state
CREATE INDEX idx_new_users_email ON new_users(email);
