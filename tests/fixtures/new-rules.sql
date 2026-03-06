SET lock_timeout = '2s';
SET statement_timeout = '5min';
SET application_name = 'migrate:new-rules';
SET idle_in_transaction_session_timeout = '30s';

-- ban-char-field
CREATE TABLE test_char (id bigint, name char(50));

-- ban-char-field variants: character(N) also triggers
CREATE TABLE test_character (id bigint, code character(10));

-- prefer-identity
CREATE TABLE test_serial (id serial PRIMARY KEY, name text);

-- prefer-identity variants
CREATE TABLE test_bigserial (id bigserial, name text);
CREATE TABLE test_smallserial (id smallserial, name text);

-- drop-database
DROP DATABASE mydb;

-- drop-database with IF EXISTS
DROP DATABASE IF EXISTS staging;

-- ban-alter-domain-add-constraint
ALTER DOMAIN email_domain ADD CONSTRAINT valid_email CHECK (VALUE ~ '@');

-- negative: ALTER DOMAIN DROP CONSTRAINT should NOT trigger
ALTER DOMAIN email_domain DROP CONSTRAINT valid_email;

-- ban-create-domain-with-constraint
CREATE DOMAIN positive_int AS integer CHECK (VALUE > 0);

-- negative: CREATE DOMAIN without constraint should NOT trigger
CREATE DOMAIN my_int AS integer;
