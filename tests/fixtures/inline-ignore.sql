-- Fixture: Inline ignore directive
-- Expected: DROP TABLE warning suppressed, CREATE INDEX still flagged

SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- pgfence: ignore drop-table
DROP TABLE old_appointments;

CREATE INDEX idx_appointments_status ON appointments(status);
