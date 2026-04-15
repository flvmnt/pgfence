-- Fixture: RENAME TABLE
-- Expected: HIGH risk, breaks all client references

SET lock_timeout = '2s';
SET statement_timeout = '5min';

ALTER TABLE appointments RENAME TO bookings;
