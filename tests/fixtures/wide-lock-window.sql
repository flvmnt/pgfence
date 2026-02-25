SET lock_timeout = '2s';
SET statement_timeout = '5min';
SET application_name = 'migrate:wide-lock';
SET idle_in_transaction_session_timeout = '30s';

BEGIN;

-- ACCESS EXCLUSIVE on users
ALTER TABLE users ALTER COLUMN email TYPE TEXT;

-- ACCESS EXCLUSIVE on orders — different table, wide lock window!
ALTER TABLE orders ALTER COLUMN status TYPE TEXT;

COMMIT;
