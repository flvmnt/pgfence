-- Fixture: SET LOGGED / SET UNLOGGED
-- Expected: HIGH risk, ACCESS EXCLUSIVE lock (full table rewrite)

SET lock_timeout = '2s';
SET statement_timeout = '5min';
SET idle_in_transaction_session_timeout = '30s';

ALTER TABLE events SET UNLOGGED;
ALTER TABLE events SET LOGGED;
