SET lock_timeout = '2s';
SET statement_timeout = '5min';
ALTER TABLE appointments RENAME COLUMN status TO appointment_status;
