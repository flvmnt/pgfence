SET statement_timeout = '5min';
SET application_name = 'migrate:ordering-bad';
SET idle_in_transaction_session_timeout = '30s';

-- Dangerous statement BEFORE lock_timeout
ALTER TABLE appointments ALTER COLUMN status SET NOT NULL;
SET lock_timeout = '2s';
