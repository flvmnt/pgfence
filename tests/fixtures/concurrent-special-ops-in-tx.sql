BEGIN;
SET lock_timeout = '2s';
SET statement_timeout = '5min';
SET application_name = 'migrate:concurrent-special';
SET idle_in_transaction_session_timeout = '30s';

DROP INDEX CONCURRENTLY IF EXISTS idx_users_email;
REINDEX TABLE CONCURRENTLY appointments;
ALTER TABLE orders DETACH PARTITION orders_2022 CONCURRENTLY;
COMMIT;
