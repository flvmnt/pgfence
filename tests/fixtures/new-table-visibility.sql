-- Fixture: Operations on a newly-created table should not trigger warnings
-- Expected: no checks flagged — the table was just created, no data or readers exist

SET lock_timeout = '2s';
SET statement_timeout = '5min';

CREATE TABLE fresh_table (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE INDEX idx_fresh_name ON fresh_table(name);

ALTER TABLE fresh_table ADD CONSTRAINT uq_fresh_name UNIQUE (name);
