-- Fixture: Schema-qualified table names must not collide across schemas
-- Expected: public.shared should not suppress archive.shared

SET lock_timeout = '2s';
SET statement_timeout = '5min';

CREATE TABLE public.shared (
  id int PRIMARY KEY
);

ALTER TABLE archive.shared ADD COLUMN email TEXT NOT NULL;
