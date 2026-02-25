SET lock_timeout = '2s';
SET statement_timeout = '5min';
SET application_name = 'migrate:001';
SET idle_in_transaction_session_timeout = '30s';

CREATE TABLE new_users (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email TEXT NOT NULL
);
