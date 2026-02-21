-- Fixture: Dangerous constraint patterns
-- Expected: HIGH risk, ACCESS EXCLUSIVE lock

-- 1) Foreign key without NOT VALID (locks both tables)
ALTER TABLE appointments
  ADD CONSTRAINT fk_appointments_worker
  FOREIGN KEY (worker_id) REFERENCES workers(id);

-- 2) CHECK constraint without NOT VALID
ALTER TABLE users
  ADD CONSTRAINT chk_email_format
  CHECK (email ~ '.*@.*');

-- 3) UNIQUE constraint (full table scan)
ALTER TABLE users
  ADD CONSTRAINT uq_users_email UNIQUE (email);

-- 4) EXCLUDE constraint (ACCESS EXCLUSIVE)
ALTER TABLE reservations
  ADD CONSTRAINT excl_no_overlap
  EXCLUDE USING gist (room_id WITH =, during WITH &&);
