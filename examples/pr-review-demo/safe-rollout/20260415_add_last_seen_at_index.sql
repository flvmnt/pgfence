CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_last_seen_at
ON users (last_seen_at);
