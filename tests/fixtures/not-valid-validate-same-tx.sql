-- Fixture: NOT VALID + VALIDATE CONSTRAINT in same transaction
-- Expected: policy violation (error) — defeats the purpose of NOT VALID

SET lock_timeout = '2s';
SET statement_timeout = '5min';

BEGIN;
ALTER TABLE appointments ADD CONSTRAINT chk_status CHECK (status IS NOT NULL) NOT VALID;
ALTER TABLE appointments VALIDATE CONSTRAINT chk_status;
COMMIT;
