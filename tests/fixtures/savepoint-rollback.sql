SET lock_timeout = '2s';
SET statement_timeout = '5min';
SET application_name = 'migrate:savepoint-test';
SET idle_in_transaction_session_timeout = '30s';

BEGIN;

ALTER TABLE users ALTER COLUMN email SET NOT NULL;

SAVEPOINT sp1;

ALTER TABLE users ADD COLUMN phone TEXT;

ROLLBACK TO SAVEPOINT sp1;

-- After rollback, ADD COLUMN phone is undone
-- But ALTER COLUMN email SET NOT NULL is still in effect

COMMIT;
