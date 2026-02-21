-- Fixture: Best practices violations in CREATE TABLE
-- Expected: LOW risk warnings fire even on new tables (appliesToNewTables)

SET lock_timeout = '2s';
SET statement_timeout = '5min';

CREATE TABLE events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  counter integer,
  label varchar(200),
  happened_at timestamp
);
