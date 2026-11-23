CREATE TABLE IF NOT EXISTS resume_workflow_runs (
 id uuid PRIMARY KEY,
 application_id uuid NOT NULL REFERENCES applications(id),
 resume_version_id uuid NOT NULL REFERENCES resume_versions(id),
 job_version integer NOT NULL,
 rubric_hash text NOT NULL,
 actor_id uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS resume_workflow_application ON resume_workflow_runs(application_id,created_at DESC);
