CREATE TABLE campuses(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school text NOT NULL,school_key text NOT NULL UNIQUE,
 city text NOT NULL DEFAULT '',region text NOT NULL DEFAULT '',tier text NOT NULL DEFAULT '',url text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'unregistered' CHECK(status IN ('unregistered','registered','published','renewal','invalid')),
 last_post date,note text NOT NULL DEFAULT '',account_cipher jsonb,password_cipher jsonb,
 version int NOT NULL DEFAULT 1,created_by uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),deleted_at timestamptz
);
CREATE INDEX campuses_active_filter ON campuses(region,status,tier,school,id) WHERE deleted_at IS NULL;
CREATE TABLE campus_credential_grants(
 user_id uuid PRIMARY KEY REFERENCES users(id),can_read boolean NOT NULL DEFAULT false,can_write boolean NOT NULL DEFAULT false,can_export boolean NOT NULL DEFAULT false,
 granted_by uuid NOT NULL REFERENCES users(id),updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX campuses_order ON campuses(school,id) WHERE deleted_at IS NULL;
