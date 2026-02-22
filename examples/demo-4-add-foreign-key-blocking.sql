-- demo-4-add-foreign-key-blocking.sql
-- Missing NOT VALID validation.
-- This requires a full table scan and an ACCESS EXCLUSIVE lock, blocking writes.

-- Satisfy safety policies:
SET lock_timeout = '2s';
SET statement_timeout = '5min';
SET application_name = 'migrate:demo4';
SET idle_in_transaction_session_timeout = '30s';

ALTER TABLE orders
ADD CONSTRAINT fk_orders_users
FOREIGN KEY (user_id) REFERENCES users(id);
