SET lock_timeout = '2s';
SET statement_timeout = '5min';
SET application_name = 'migrate:partition';
SET idle_in_transaction_session_timeout = '30s';

-- ATTACH PARTITION (ACCESS EXCLUSIVE on parent)
ALTER TABLE orders ATTACH PARTITION orders_2024 FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');

-- DETACH PARTITION (ACCESS EXCLUSIVE on parent)
ALTER TABLE orders DETACH PARTITION orders_2023;

-- DETACH PARTITION CONCURRENTLY (SHARE UPDATE EXCLUSIVE, PG14+)
ALTER TABLE orders DETACH PARTITION orders_2022 CONCURRENTLY;
