SET lock_timeout = '2s';
SET statement_timeout = '5min';
SET application_name = 'migrate:drop-idx';
SET idle_in_transaction_session_timeout = '30s';

DROP INDEX CONCURRENTLY IF EXISTS idx_users_email;
