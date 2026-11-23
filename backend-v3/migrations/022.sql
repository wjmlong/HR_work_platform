CREATE TABLE calendar_sync_state (
 scope text PRIMARY KEY, tenant text NOT NULL, app_id text NOT NULL, calendar_id text NOT NULL,
 enabled boolean NOT NULL DEFAULT false, activated_at timestamptz NOT NULL DEFAULT now(), sync_token text NOT NULL DEFAULT '',
 requested_at timestamptz, last_attempt_at timestamptz, last_success_at timestamptz, last_error text,
 UNIQUE(tenant,app_id,calendar_id)
);
CREATE TABLE calendar_event_links (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), scope text NOT NULL REFERENCES calendar_sync_state(scope),
 event_id text NOT NULL, interview_id uuid NOT NULL REFERENCES interviews(id), binding_actor_id uuid REFERENCES users(id),
 coordinator_open_ids jsonb NOT NULL DEFAULT '[]', local_snapshot jsonb, remote_snapshot jsonb,
 state text NOT NULL DEFAULT 'synced', revision integer NOT NULL DEFAULT 1, last_error text, updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(scope,event_id), UNIQUE(scope,interview_id)
);
CREATE TABLE calendar_sync_inbox (
 scope text NOT NULL REFERENCES calendar_sync_state(scope), event_id text NOT NULL, snapshot jsonb NOT NULL,
 state text NOT NULL DEFAULT 'pending', reason text, revision integer NOT NULL DEFAULT 1,
 excluded_attendees integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(scope,event_id)
);
CREATE TABLE calendar_sync_outbox (
 scope text NOT NULL REFERENCES calendar_sync_state(scope), interview_id uuid NOT NULL REFERENCES interviews(id),
 generation bigint NOT NULL DEFAULT 1, completed_generation bigint NOT NULL DEFAULT 0,
 operation_key uuid NOT NULL DEFAULT gen_random_uuid(), intent jsonb, intent_generation bigint,
 attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(), last_error text,
 PRIMARY KEY(scope,interview_id)
);
CREATE FUNCTION enqueue_calendar_schedule() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE iid uuid;
BEGIN
 IF current_setting('recruit.calendar_inbound',true)='on' THEN RETURN NULL; END IF;
 IF TG_TABLE_NAME='interviews' THEN
  iid=NEW.id;
  IF TG_OP='UPDATE' AND ROW(NEW.starts_at,NEW.duration_minutes,NEW.location,NEW.meeting_url,NEW.status='cancelled',NEW.deleted_at IS NOT NULL,NEW.primary_interviewer_id) IS NOT DISTINCT FROM ROW(OLD.starts_at,OLD.duration_minutes,OLD.location,OLD.meeting_url,OLD.status='cancelled',OLD.deleted_at IS NOT NULL,OLD.primary_interviewer_id) THEN RETURN NULL; END IF;
 ELSE iid=coalesce(NEW.interview_id,OLD.interview_id); END IF;
 INSERT INTO calendar_sync_outbox(scope,interview_id)
 SELECT s.scope,i.id FROM calendar_sync_state s JOIN interviews i ON i.id=iid JOIN users u ON u.id=i.created_by
 WHERE s.enabled AND s.tenant=u.tenant AND s.app_id=u.app_id AND (i.created_at>=s.activated_at OR EXISTS(SELECT 1 FROM calendar_event_links l WHERE l.scope=s.scope AND l.interview_id=i.id))
 ON CONFLICT(scope,interview_id) DO UPDATE SET generation=calendar_sync_outbox.generation+1,next_attempt_at=now();
 RETURN NULL;
END $$;
CREATE TRIGGER calendar_interview_change AFTER INSERT OR UPDATE ON interviews FOR EACH ROW EXECUTE FUNCTION enqueue_calendar_schedule();
CREATE TRIGGER calendar_attendee_change AFTER INSERT OR DELETE ON interviewers FOR EACH ROW EXECUTE FUNCTION enqueue_calendar_schedule();
ALTER TABLE interviewers ADD COLUMN temporary_access boolean NOT NULL DEFAULT false;
CREATE FUNCTION revoke_removed_calendar_participant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM interviewers WHERE interview_id=OLD.interview_id AND user_id=OLD.user_id) THEN
  UPDATE interview_access_grants SET revoked_at=now(),revoked_reason='participant_removed',updated_at=now() WHERE interview_id=OLD.interview_id AND user_id=OLD.user_id AND revoked_at IS NULL;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER calendar_participant_removed AFTER DELETE ON interviewers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION revoke_removed_calendar_participant();
