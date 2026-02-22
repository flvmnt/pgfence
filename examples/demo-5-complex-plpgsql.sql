-- demo-5-complex-plpgsql.sql
-- pgfence safely parses DO blocks and procedures but cannot statically analyze
-- the dynamic SQL inside them. It flags them as unanalyzable so you know exactly
-- what code requires manual review.

-- Satisfy safety policies:
SET lock_timeout = '2s';
SET statement_timeout = '5min';
SET application_name = 'migrate:demo5';
SET idle_in_transaction_session_timeout = '30s';

DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
        EXECUTE 'GRANT SELECT ON TABLE ' || quote_ident(r.tablename) || ' TO read_only_user';
    END LOOP;
END;
$$;
