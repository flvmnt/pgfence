BEGIN;
SET lock_timeout = '2s';
SET statement_timeout = '5min';
SET application_name = 'pgfence_test';
SET idle_in_transaction_session_timeout = '30s';

UPDATE users SET status = 'active';
COMMIT;
