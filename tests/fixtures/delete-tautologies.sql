-- Fixture: DELETE tautologies should be flagged as destructive
SET lock_timeout = '2s';
SET statement_timeout = '5min';

DELETE FROM audit_log WHERE 1=1;
DELETE FROM audit_log WHERE TRUE;
DELETE FROM audit_log WHERE NOT FALSE;
