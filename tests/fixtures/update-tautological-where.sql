BEGIN;
SET lock_timeout = '2s';
SET statement_timeout = '5min';
SET application_name = 'migrate:update-tautology';
SET idle_in_transaction_session_timeout = '30s';

UPDATE users SET status = 'active' WHERE 1 = 1;
COMMIT;
