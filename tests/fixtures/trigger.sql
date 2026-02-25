SET lock_timeout = '2s';
SET statement_timeout = '5min';
SET application_name = 'migrate:trigger';
SET idle_in_transaction_session_timeout = '30s';

-- CREATE TRIGGER (ACCESS EXCLUSIVE)
CREATE TRIGGER audit_trigger BEFORE INSERT ON appointments FOR EACH ROW EXECUTE FUNCTION audit_func();

-- DROP TRIGGER (ACCESS EXCLUSIVE)
DROP TRIGGER audit_trigger ON appointments;

-- ENABLE TRIGGER (SHARE ROW EXCLUSIVE)
ALTER TABLE appointments ENABLE TRIGGER audit_trigger;

-- DISABLE TRIGGER (SHARE ROW EXCLUSIVE)
ALTER TABLE appointments DISABLE TRIGGER audit_trigger;
