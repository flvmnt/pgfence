SET lock_timeout = '2s';
SET statement_timeout = '5min';
SET application_name = 'migrate:20260415_add_last_seen_at_contract';
SET idle_in_transaction_session_timeout = '30s';

ALTER TABLE users ALTER COLUMN last_seen_at SET DEFAULT now();
ALTER TABLE users ADD CONSTRAINT chk_last_seen_at_nn CHECK (last_seen_at IS NOT NULL) NOT VALID;
ALTER TABLE users VALIDATE CONSTRAINT chk_last_seen_at_nn;
ALTER TABLE users ALTER COLUMN last_seen_at SET NOT NULL;
ALTER TABLE users DROP CONSTRAINT chk_last_seen_at_nn;
