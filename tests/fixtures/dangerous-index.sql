-- Fixture: Dangerous index patterns
-- Expected: MEDIUM risk, SHARE lock (blocks writes)

-- 1) CREATE INDEX without CONCURRENTLY
CREATE INDEX idx_appointments_status ON appointments(status);

-- 2) CREATE UNIQUE INDEX without CONCURRENTLY
CREATE UNIQUE INDEX idx_users_email ON users(email);

-- 3) DROP INDEX without CONCURRENTLY
DROP INDEX idx_old_index;
