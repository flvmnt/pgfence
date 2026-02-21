-- Fixture: TRUNCATE with CASCADE
-- Expected: CRITICAL risk — cascades to referencing tables

SET lock_timeout = '2s';
SET statement_timeout = '5min';

TRUNCATE TABLE orders CASCADE;
