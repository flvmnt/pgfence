ALTER TABLE users ADD COLUMN last_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp();
CREATE INDEX idx_users_last_seen_at ON users (last_seen_at);
