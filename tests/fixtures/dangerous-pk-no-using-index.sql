-- Fixture: ADD PRIMARY KEY without USING INDEX
-- Expected: HIGH risk, SHARE ROW EXCLUSIVE lock

SET lock_timeout = '2s';
SET statement_timeout = '5min';
SET idle_in_transaction_session_timeout = '30s';

ALTER TABLE orders ADD CONSTRAINT orders_pkey PRIMARY KEY (id);
