-- V4 runs only in its separately guarded database. Never silently resolve parallel legacy applications.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT true;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS transfer_from_id uuid REFERENCES applications(id);
ALTER TABLE applications ADD COLUMN IF NOT EXISTS transfer_to_id uuid REFERENCES applications(id);
ALTER TABLE applications ADD COLUMN IF NOT EXISTS collected_at timestamptz;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS term_reason text;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS term_detail text;
ALTER TABLE application_events ADD COLUMN IF NOT EXISTS opinion text NOT NULL DEFAULT '';
ALTER TABLE application_events ADD COLUMN IF NOT EXISTS term_reason text;
ALTER TABLE application_events ADD COLUMN IF NOT EXISTS term_detail text;
ALTER TABLE application_events ADD COLUMN IF NOT EXISTS cc text;
ALTER TABLE application_events ADD COLUMN IF NOT EXISTS cc_snapshot jsonb;
ALTER TABLE application_events ADD COLUMN IF NOT EXISTS from_job_id uuid REFERENCES jobs(id);
ALTER TABLE application_events ADD COLUMN IF NOT EXISTS to_job_id uuid REFERENCES jobs(id);
ALTER TABLE application_events ADD COLUMN IF NOT EXISTS interaction text NOT NULL DEFAULT 'legacy';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS level text;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=5) THEN
  IF EXISTS(SELECT 1 FROM applications WHERE deleted_at IS NULL AND is_current GROUP BY candidate_id HAVING count(*)>1) THEN
   RAISE EXCEPTION 'parallel_legacy_workflows_require_explicit_resolution';
  END IF;
  ALTER TABLE applications DROP CONSTRAINT applications_status_check;
  ALTER TABLE applications ADD CONSTRAINT applications_status_check CHECK(status IN ('screening','screened','interviewing','collecting','background_check','offered','hired','terminated','rejected'));
 END IF;
END $$;
-- 001 is intentionally idempotent and may recreate this legacy index on restart.
DROP INDEX IF EXISTS applications_active_unique;
CREATE UNIQUE INDEX IF NOT EXISTS applications_one_current ON applications(candidate_id) WHERE is_current AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS applications_current_stage ON applications(status,updated_at DESC,id) WHERE is_current AND deleted_at IS NULL;
INSERT INTO schema_migrations(version) VALUES(5) ON CONFLICT DO NOTHING;
