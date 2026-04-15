-- Fixture: Newly-created table becomes visible again after DML
-- Expected: ALTER after INSERT should be checked

SET lock_timeout = '2s';
SET statement_timeout = '5min';

CREATE TABLE fresh_table (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL
);

INSERT INTO fresh_table (name) VALUES ('alice');

ALTER TABLE fresh_table ADD COLUMN email TEXT NOT NULL;
