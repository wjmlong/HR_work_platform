-- Keep the queryable score separate from the lossless JSON envelope used for unusual source characters.
ALTER TABLE match_snapshots ADD COLUMN reference_score jsonb;
UPDATE match_snapshots SET reference_score=data->'score' WHERE data ? 'score';
CREATE INDEX tasks_recompute_application_idx ON tasks((payload->>'applicationId'),state) WHERE kind='recompute';
CREATE INDEX applications_candidate_history_idx ON applications(candidate_id,created_at,id);
INSERT INTO schema_migrations(version) VALUES(7);
