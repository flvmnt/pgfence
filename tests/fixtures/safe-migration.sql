-- Fixture: Safe migration patterns
-- Expected: SAFE/LOW risk

SET lock_timeout = '2s';
SET statement_timeout = '5min';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'migrate:safe_example';

-- 1) Add nullable column (instant metadata change)
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS notes TEXT;

-- 2) Add column with constant default (instant on PG11+)
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS priority INT DEFAULT 0;

-- 3) CREATE INDEX CONCURRENTLY (allows reads + writes)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_appointments_notes
  ON appointments (notes);

-- 4) Foreign key with NOT VALID (brief lock, no validation scan)
ALTER TABLE appointments
  ADD CONSTRAINT fk_appointments_service
  FOREIGN KEY (service_id) REFERENCES services(id) NOT VALID;

-- 5) Validate constraint separately (non-blocking scan)
ALTER TABLE appointments VALIDATE CONSTRAINT fk_appointments_service;

-- 6) CHECK constraint with NOT VALID
ALTER TABLE users
  ADD CONSTRAINT chk_email
  CHECK (email IS NOT NULL) NOT VALID;

ALTER TABLE users VALIDATE CONSTRAINT chk_email;
