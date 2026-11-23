-- Sending is an explicit human action; restoring these receipts never dispatches mail.
CREATE TABLE mailbox_reply_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 actor_id uuid NOT NULL REFERENCES users(id),
 actor_version integer NOT NULL,
 request_key text NOT NULL,
 request_hash text NOT NULL,
 delivery_hash text NOT NULL UNIQUE,
 mailbox_id text NOT NULL,
 message_key text NOT NULL,
 source_hash text NOT NULL,
 template_id text NOT NULL CHECK (template_id IN ('advance','decline')),
 template_version text NOT NULL,
 test_mode boolean NOT NULL CHECK (test_mode),
 recipient text NOT NULL CHECK (recipient='recruiting-operator@example.invalid'),
 message_id text NOT NULL UNIQUE,
 snapshot jsonb NOT NULL,
 state text NOT NULL CHECK (state IN ('sending','sent','failed','unknown')),
 error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 sent_at timestamptz,
 UNIQUE(actor_id,request_key)
);
CREATE INDEX mailbox_reply_source ON mailbox_reply_receipts(mailbox_id,message_key,created_at DESC);
