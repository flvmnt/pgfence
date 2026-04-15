WITH batch AS (
  SELECT ctid
  FROM users
  WHERE last_seen_at IS NULL
  LIMIT 1000
  FOR UPDATE SKIP LOCKED
)
UPDATE users u
SET last_seen_at = now()
FROM batch
WHERE u.ctid = batch.ctid;
