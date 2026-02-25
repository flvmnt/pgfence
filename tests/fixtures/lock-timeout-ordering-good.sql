SET lock_timeout = '2s';
SET statement_timeout = '5min';
SET application_name = 'migrate:ordering-good';
SET idle_in_transaction_session_timeout = '30s';

-- lock_timeout is set BEFORE any dangerous statement
ALTER TABLE appointments ALTER COLUMN status SET NOT NULL;
