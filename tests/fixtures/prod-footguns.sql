SET lock_timeout = '2s';
SET statement_timeout = '5min';
SET application_name = 'migrate:prod-footguns';
SET idle_in_transaction_session_timeout = '30s';

-- cluster: table rewrite, ACCESS EXCLUSIVE
CLUSTER large_table USING idx_large_table_pk;

-- replica-identity-full: WAL amplification
ALTER TABLE events REPLICA IDENTITY FULL;

-- replica identity default: not flagged
ALTER TABLE events REPLICA IDENTITY DEFAULT;

-- replica identity using index: not flagged
ALTER TABLE events REPLICA IDENTITY USING INDEX events_unique_id_idx;

-- enable-rls: lockout risk
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;

-- disable-rls: exposure risk
ALTER TABLE customers DISABLE ROW LEVEL SECURITY;

-- inherit: validation scan under ACCESS EXCLUSIVE both
ALTER TABLE measurements_2026_05 INHERIT measurements;

-- no inherit: brief but blocking
ALTER TABLE measurements_2026_05 NO INHERIT measurements;

-- create-policy: informational; only effective when RLS enabled
CREATE POLICY tenant_isolation ON customers FOR SELECT USING (tenant_id = current_setting('app.current_tenant')::int);

-- create-enum-type: cannot remove values
CREATE TYPE order_status AS ENUM ('pending', 'paid', 'shipped', 'cancelled');
