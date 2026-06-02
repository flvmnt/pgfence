-- ============================================================================
-- Try pgfence in 30 seconds.
--
-- This migration looks normal. It hides four production-grade footguns
-- that pgfence will catch:
--
--   1. ADD COLUMN with NOT NULL + volatile DEFAULT
--      ACCESS EXCLUSIVE lock for the duration of a full table rewrite.
--   2. ADD CONSTRAINT FOREIGN KEY without NOT VALID
--      SHARE ROW EXCLUSIVE on both tables, full table scan to validate.
--   3. CREATE INDEX without CONCURRENTLY
--      SHARE lock blocks all writes for the duration of the build.
--   4. Missing SET lock_timeout
--      Policy violation: any of the above can sit in lock queue forever.
--
-- Run:
--
--   npm install -g @flvmnt/pgfence
--   pgfence analyze examples/try-this/dangerous-migration.sql
--
-- Or without installing:
--
--   npx @flvmnt/pgfence analyze examples/try-this/dangerous-migration.sql
--
-- pgfence will print a table of risk levels, the lock mode each statement
-- acquires, what it blocks, and the safe rewrite for each one.
-- ============================================================================

ALTER TABLE users
  ADD COLUMN last_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp();

ALTER TABLE sessions
  ADD CONSTRAINT fk_sessions_user
  FOREIGN KEY (user_id) REFERENCES users(id);

CREATE INDEX idx_users_last_seen_at ON users (last_seen_at);
