ALTER TABLE parse_results ADD COLUMN IF NOT EXISTS human_corrections jsonb NOT NULL DEFAULT '[]';
ALTER TABLE resume_versions ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES resume_versions(id);
CREATE INDEX IF NOT EXISTS resume_parent_idx ON resume_versions(parent_id);
ALTER TABLE applications ADD COLUMN IF NOT EXISTS baseline_state text;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS baseline_at timestamptz;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS baseline_reject_reason text;
ALTER TABLE application_events ADD COLUMN IF NOT EXISTS rejection_reason text;
-- Existing eventless records have an observed current fact, not invented history.
UPDATE applications a SET baseline_state=status,baseline_at=now(),baseline_reject_reason=reject_reason WHERE baseline_at IS NULL AND NOT EXISTS(SELECT 1 FROM application_events e WHERE e.application_id=a.id);
INSERT INTO schema_migrations(version) VALUES(3) ON CONFLICT DO NOTHING;
