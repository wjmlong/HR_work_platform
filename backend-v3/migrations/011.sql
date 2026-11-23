-- Rejection detail is a permanent event fact, independent of later reactivation.
ALTER TABLE application_events ADD COLUMN rejection_detail text;
-- Existing ordinary rejection events kept detail in their reason text. Retain it;
-- no historical detail is inferred for old transfers that never recorded it.
