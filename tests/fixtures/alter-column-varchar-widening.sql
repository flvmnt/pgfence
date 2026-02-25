-- Safe: varchar widening (no table rewrite)
ALTER TABLE users ALTER COLUMN supabase_user_id TYPE varchar(64);

-- Safe: varchar to text (no table rewrite)
ALTER TABLE users ALTER COLUMN bio TYPE text;

-- Safe: remove varchar length constraint
ALTER TABLE users ALTER COLUMN name TYPE varchar;

-- Dangerous: text to varchar (potential truncation + rewrite)
ALTER TABLE users ALTER COLUMN email TYPE varchar(255);

-- Dangerous: cross-type change (full rewrite)
ALTER TABLE users ALTER COLUMN status TYPE integer USING status::integer;
