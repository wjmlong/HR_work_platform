CREATE TABLE discovery_tasks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, job_id uuid NOT NULL REFERENCES jobs(id),
 owner_id uuid NOT NULL REFERENCES users(id), created_by uuid NOT NULL REFERENCES users(id),
 snapshot jsonb NOT NULL, state text NOT NULL DEFAULT 'draft' CHECK(state IN('draft','running','paused','review','completed','cancelled')),
 version int NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE discovery_collaborators(task_id uuid REFERENCES discovery_tasks(id),user_id uuid REFERENCES users(id),PRIMARY KEY(task_id,user_id));
CREATE TABLE discovery_runs(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),task_id uuid NOT NULL REFERENCES discovery_tasks(id),
 state text NOT NULL DEFAULT 'running',limits jsonb NOT NULL, pages int NOT NULL DEFAULT 0,calls int NOT NULL DEFAULT 0,tokens int NOT NULL DEFAULT 0,reserved_tokens int NOT NULL DEFAULT 0,
 active_seconds double precision NOT NULL DEFAULT 0,active_since timestamptz, created_at timestamptz NOT NULL DEFAULT now(),ended_at timestamptz,
 CHECK(pages>=0 AND calls>=0 AND tokens>=0 AND reserved_tokens>=0)
);
CREATE UNIQUE INDEX discovery_single_run ON discovery_runs(task_id) WHERE ended_at IS NULL;
CREATE TABLE discovery_sources(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),task_id uuid NOT NULL REFERENCES discovery_tasks(id),platform text NOT NULL,
 native_id text,profile_url text NOT NULL,display_name text NOT NULL,entity_type text NOT NULL CHECK(entity_type IN('person','account','team','institution')),
 data jsonb NOT NULL,content_hash text NOT NULL,access_method text NOT NULL,submitted_by uuid NOT NULL REFERENCES users(id),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','reviewed','published','deferred','rejected')),
 draft jsonb,version int NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(task_id,content_hash)
);
CREATE TABLE discovery_evidence(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),source_id uuid NOT NULL REFERENCES discovery_sources(id),segment_id text NOT NULL,data jsonb NOT NULL,UNIQUE(source_id,segment_id));
CREATE TABLE discovery_reviews(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),source_id uuid NOT NULL REFERENCES discovery_sources(id),source_version int NOT NULL,data jsonb NOT NULL,actor_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE discovery_subjects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),entity_type text NOT NULL,platform text NOT NULL,identity_key text NOT NULL,display_name text NOT NULL,profile_url text NOT NULL,lead_id uuid REFERENCES leads(id),do_not_contact boolean NOT NULL DEFAULT false,version int NOT NULL DEFAULT 1,UNIQUE(platform,identity_key));
CREATE TABLE discovery_publications(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),subject_id uuid NOT NULL REFERENCES discovery_subjects(id),source_id uuid NOT NULL REFERENCES discovery_sources(id),review_id uuid NOT NULL REFERENCES discovery_reviews(id),published jsonb NOT NULL,actor_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),withdrawn_at timestamptz,UNIQUE(source_id));
CREATE TABLE discovery_contacts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),subject_id uuid NOT NULL REFERENCES discovery_subjects(id),publication_id uuid NOT NULL REFERENCES discovery_publications(id),data jsonb NOT NULL,availability text NOT NULL,verified_at timestamptz NOT NULL,valid_until timestamptz NOT NULL,version int NOT NULL DEFAULT 1,verified_by uuid NOT NULL REFERENCES users(id));
CREATE TABLE discovery_lead_jobs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),lead_id uuid NOT NULL REFERENCES leads(id),job_id uuid REFERENCES jobs(id),owner_id uuid NOT NULL REFERENCES users(id),state text NOT NULL DEFAULT 'uncontacted' CHECK(state IN('uncontacted','contacted','replied','resume_received','uploaded','declined')),version int NOT NULL DEFAULT 1,next_followup_at timestamptz,candidate_id uuid REFERENCES candidates(id),application_id uuid REFERENCES applications(id),resume_version_id uuid REFERENCES resume_versions(id),UNIQUE NULLS NOT DISTINCT(lead_id,job_id));
INSERT INTO discovery_lead_jobs(lead_id,owner_id,state) SELECT id,owner_id,state FROM leads;
CREATE TABLE discovery_followups(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),lead_job_id uuid NOT NULL REFERENCES discovery_lead_jobs(id),actor_id uuid NOT NULL REFERENCES users(id),data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE discovery_queue(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),run_id uuid NOT NULL REFERENCES discovery_runs(id),source_id uuid REFERENCES discovery_sources(id),kind text NOT NULL CHECK(kind IN('extract','fetch')),input jsonb NOT NULL DEFAULT '{}',state text NOT NULL DEFAULT 'queued' CHECK(state IN('queued','running','completed','failed','cancelled')),attempts int NOT NULL DEFAULT 0,claim_token int NOT NULL DEFAULT 0,worker_id text,lease_until timestamptz,available_at timestamptz NOT NULL DEFAULT now(),error_code text,reserved_tokens int NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX discovery_one_extraction ON discovery_queue(source_id) WHERE kind='extract' AND state IN('queued','running');
CREATE TABLE discovery_handoffs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),lead_job_id uuid NOT NULL REFERENCES discovery_lead_jobs(id),upload_task_id uuid REFERENCES tasks(id),file_hash text NOT NULL,state text NOT NULL DEFAULT 'accepted',confirmed_at timestamptz,version int NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(lead_job_id,file_hash));
CREATE TABLE discovery_merges(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),actor_id uuid NOT NULL REFERENCES users(id),data jsonb NOT NULL,reverted_at timestamptz,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE discovery_capabilities(platform text PRIMARY KEY,data jsonb NOT NULL,version int NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE discovery_outbox(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),kind text NOT NULL,aggregate_id uuid NOT NULL,data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),processed_at timestamptz);
CREATE INDEX discovery_tasks_owner ON discovery_tasks(owner_id,created_at DESC,id);
CREATE INDEX discovery_sources_task ON discovery_sources(task_id,created_at DESC,id);
CREATE INDEX discovery_queue_claim ON discovery_queue(state,available_at,created_at);
CREATE INDEX discovery_contacts_subject ON discovery_contacts(subject_id,valid_until);
