CREATE TABLE interview_assistant_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 interview_id uuid NOT NULL REFERENCES interviews(id),
 owner_id uuid NOT NULL REFERENCES users(id),
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','finished','abandoned')),
 revision integer NOT NULL DEFAULT 1,
 basis jsonb NOT NULL,
 segments jsonb NOT NULL DEFAULT '[]',
 analysis jsonb,
 analysis_revision integer,
 consent_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX interview_assistant_active ON interview_assistant_sessions(interview_id) WHERE state='active';
CREATE INDEX interview_assistant_history ON interview_assistant_sessions(interview_id,created_at DESC);
CREATE TABLE interview_assistant_analyses (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 session_id uuid NOT NULL REFERENCES interview_assistant_sessions(id),
 transcript_revision integer NOT NULL,
 data jsonb NOT NULL,
 final boolean NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
