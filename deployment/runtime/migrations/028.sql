CREATE TABLE screening_batches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 job_id uuid NOT NULL REFERENCES jobs(id),
 reviewer_id uuid NOT NULL REFERENCES users(id),
 hr_id uuid NOT NULL REFERENCES users(id),
 items jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 review_message text,
 decisions jsonb,
 revision integer NOT NULL DEFAULT 0,
 review_revision integer NOT NULL DEFAULT -1,
 hr_revision integer NOT NULL DEFAULT 0,
 hr_message text,
 submitted_at timestamptz,
 notices jsonb NOT NULL DEFAULT '[]'::jsonb,
 notified_at timestamptz,
 next_attempt timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX screening_batch_delivery ON screening_batches(next_attempt) WHERE review_revision < revision OR hr_revision < revision;
