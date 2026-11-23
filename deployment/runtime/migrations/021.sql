CREATE TABLE interview_access_grants (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 interview_id uuid NOT NULL REFERENCES interviews(id), user_id uuid NOT NULL REFERENCES users(id),
 role text NOT NULL CHECK(role IN ('interviewer','coordinator')),
 source text NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','calendar')),
 source_key text NOT NULL DEFAULT '',
 starts_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 extended_until timestamptz, revoked_at timestamptz, revoked_reason text,
 created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(interview_id,user_id,source,source_key), CHECK(expires_at>starts_at)
);
CREATE INDEX interview_access_user_idx ON interview_access_grants(user_id,interview_id) WHERE revoked_at IS NULL;
CREATE VIEW active_interview_grants AS
 SELECT g.* FROM interview_access_grants g JOIN users u ON u.id=g.user_id
 JOIN interviews i ON i.id=g.interview_id JOIN applications a ON a.id=i.application_id JOIN candidates c ON c.id=a.candidate_id
 WHERE g.revoked_at IS NULL AND g.starts_at<=now() AND g.expires_at>now()
 AND u.directory_active AND u.status IN ('active','pending') AND i.deleted_at IS NULL AND i.status<>'cancelled'
 AND a.deleted_at IS NULL AND c.deleted_at IS NULL;
CREATE FUNCTION maintain_interview_access() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status='cancelled' OR NEW.deleted_at IS NOT NULL THEN
  UPDATE interview_access_grants SET revoked_at=now(),revoked_reason='interview_unavailable',updated_at=now() WHERE interview_id=NEW.id AND revoked_at IS NULL;
 ELSIF NEW.starts_at IS DISTINCT FROM OLD.starts_at OR NEW.duration_minutes IS DISTINCT FROM OLD.duration_minutes THEN
  UPDATE interview_access_grants SET expires_at=GREATEST(NEW.starts_at+make_interval(mins=>NEW.duration_minutes)+interval '48 hours',extended_until,starts_at+interval '1 microsecond'),updated_at=now() WHERE interview_id=NEW.id AND revoked_at IS NULL;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER interview_access_schedule AFTER UPDATE OF starts_at,duration_minutes,status,deleted_at ON interviews FOR EACH ROW EXECUTE FUNCTION maintain_interview_access();
