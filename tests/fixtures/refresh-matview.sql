SET lock_timeout = '2s';
SET statement_timeout = '5min';
SET application_name = 'migrate:refresh-matview';
SET idle_in_transaction_session_timeout = '30s';

-- Non-concurrent refresh (ACCESS EXCLUSIVE, HIGH risk)
REFRESH MATERIALIZED VIEW order_summary;

-- Concurrent refresh (EXCLUSIVE, MEDIUM risk)
REFRESH MATERIALIZED VIEW CONCURRENTLY order_summary;

-- WITH NO DATA (brief ACCESS EXCLUSIVE)
REFRESH MATERIALIZED VIEW order_summary WITH NO DATA;
