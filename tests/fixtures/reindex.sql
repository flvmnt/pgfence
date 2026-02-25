SET lock_timeout = '2s';
SET statement_timeout = '5min';
SET application_name = 'migrate:reindex';
SET idle_in_transaction_session_timeout = '30s';

-- Non-concurrent REINDEX TABLE (ACCESS EXCLUSIVE)
REINDEX TABLE appointments;

-- Non-concurrent REINDEX INDEX (ACCESS EXCLUSIVE)
REINDEX INDEX idx_appointments_date;

-- Safe: REINDEX TABLE CONCURRENTLY
REINDEX TABLE CONCURRENTLY appointments;

-- Non-concurrent REINDEX SCHEMA (CRITICAL)
REINDEX SCHEMA public;
