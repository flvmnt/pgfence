SET lock_timeout = '5min';
SET statement_timeout = '2h';
SET application_name = 'migrate:too-long';
SET idle_in_transaction_session_timeout = '30s';

ALTER TABLE appointments ADD COLUMN notes TEXT;
