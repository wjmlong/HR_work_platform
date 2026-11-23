ALTER TABLE candidates ADD COLUMN merged_into_id uuid REFERENCES candidates(id);
ALTER TABLE candidates ADD CONSTRAINT candidates_merge_not_self CHECK(merged_into_id IS NULL OR merged_into_id<>id);
CREATE INDEX candidates_merge_target ON candidates(merged_into_id) WHERE merged_into_id IS NOT NULL;
CREATE TABLE candidate_merges(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),source_id uuid NOT NULL REFERENCES candidates(id),target_id uuid NOT NULL REFERENCES candidates(id),
 keep_application_id uuid REFERENCES applications(id),actor_id uuid NOT NULL REFERENCES users(id),source_snapshot jsonb NOT NULL,target_snapshot jsonb NOT NULL,manifest jsonb NOT NULL,at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE reparse_previews(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),actor_id uuid NOT NULL REFERENCES users(id),hash text NOT NULL,payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes',applied_at timestamptz
);
