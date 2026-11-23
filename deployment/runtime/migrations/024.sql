-- Transport receipts are application/tenant bound. They are not reusable in a copied environment.
CREATE TABLE feishu_interview_confirmations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 interview_id uuid NOT NULL REFERENCES interviews(id), interview_version integer NOT NULL,
 user_id uuid NOT NULL REFERENCES users(id), tenant text NOT NULL, app_id text NOT NULL, user_open_id text NOT NULL,
 requested_by uuid NOT NULL REFERENCES users(id),
 delivery text NOT NULL DEFAULT 'queued' CHECK(delivery IN ('queued','sending','sent','failed')),
 message_id text, attempts integer NOT NULL DEFAULT 0, last_attempt_at timestamptz, last_error text,
 decision text NOT NULL DEFAULT 'pending' CHECK(decision IN ('pending','accepted','declined')),
 reason text NOT NULL DEFAULT '' CHECK(length(reason)<=500), responded_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(interview_id,interview_version,user_id,tenant,app_id)
);
CREATE INDEX feishu_interview_confirmations_interview_idx ON feishu_interview_confirmations(interview_id,user_id,interview_version DESC);
CREATE TABLE feishu_interview_callback_receipts (
 tenant text NOT NULL, app_id text NOT NULL, event_id text NOT NULL,
 confirmation_id uuid NOT NULL REFERENCES feishu_interview_confirmations(id),
 fingerprint text NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant,app_id,event_id)
);
