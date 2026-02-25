SET lock_timeout = '2s';
SET statement_timeout = '5min';
SET application_name = 'migrate:alter-enum';
SET idle_in_transaction_session_timeout = '30s';

-- Basic add value
ALTER TYPE status ADD VALUE 'pending';

-- With IF NOT EXISTS
ALTER TYPE priority ADD VALUE IF NOT EXISTS 'urgent';

-- With position
ALTER TYPE status ADD VALUE 'archived' AFTER 'active';
