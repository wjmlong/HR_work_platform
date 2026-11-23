CREATE TABLE IF NOT EXISTS candidate_profile_versions(candidate_id uuid NOT NULL REFERENCES candidates(id),version int NOT NULL,profile jsonb NOT NULL,actor_id uuid REFERENCES users(id),at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(candidate_id,version));
CREATE INDEX IF NOT EXISTS candidate_profile_actor_idx ON candidate_profile_versions(actor_id);
INSERT INTO candidate_profile_versions(candidate_id,version,profile,at) SELECT id,version,profile,updated_at FROM candidates ON CONFLICT DO NOTHING;
ALTER TABLE application_events ADD COLUMN IF NOT EXISTS request_id text NOT NULL DEFAULT '';
ALTER TABLE application_events ALTER COLUMN request_id SET DEFAULT coalesce(current_setting('recruit.request_id',true),'');
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS request_id text NOT NULL DEFAULT '';
INSERT INTO schema_migrations(version) VALUES(2) ON CONFLICT DO NOTHING;
