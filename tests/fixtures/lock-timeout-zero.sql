SET lock_timeout = 0;
SET statement_timeout = '5min';
SET application_name = 'migrate:test-zero';
SET idle_in_transaction_session_timeout = '30s';

ALTER TABLE users ADD COLUMN age integer;
