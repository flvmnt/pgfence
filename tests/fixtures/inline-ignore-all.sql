-- Fixture: Bare -- pgfence-ignore (suppress all checks)
-- Expected: DROP TABLE warning suppressed entirely, no checks from that statement

SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- pgfence-ignore
DROP TABLE old_appointments;

CREATE INDEX idx_appointments_status ON appointments(status);
