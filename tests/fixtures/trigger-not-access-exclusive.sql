-- Fixture: CREATE TRIGGER should NOT compound ACCESS EXCLUSIVE
-- CREATE TRIGGER takes SHARE ROW EXCLUSIVE, not ACCESS EXCLUSIVE.
-- A CREATE TRIGGER after an ACCESS EXCLUSIVE ALTER TABLE should NOT
-- trigger the wide-lock-window warning (different lock levels).

SET lock_timeout = '2s';
SET statement_timeout = '5min';

BEGIN;

-- First: ACCESS EXCLUSIVE (SET NOT NULL)
ALTER TABLE appointments ALTER COLUMN status SET NOT NULL;

-- Second: SHARE ROW EXCLUSIVE (CREATE TRIGGER) -- NOT ACCESS EXCLUSIVE
CREATE TRIGGER audit_trigger BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION audit_func();

COMMIT;
