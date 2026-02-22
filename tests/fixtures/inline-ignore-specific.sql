-- Fixture: -- pgfence-ignore: <ruleId> (suppress specific rule)
-- Expected: drop-table suppressed, create-index-not-concurrent still flagged

SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- pgfence-ignore: drop-table
DROP TABLE old_appointments;

CREATE INDEX idx_appointments_status ON appointments(status);
