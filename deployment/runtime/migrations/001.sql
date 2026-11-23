CREATE TABLE IF NOT EXISTS schema_migrations(version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS users(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant text NOT NULL, app_id text NOT NULL, open_id text NOT NULL,
 name text NOT NULL, roles text[] NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','disabled','rejected')),
 version int NOT NULL DEFAULT 1, directory_active boolean NOT NULL DEFAULT true, verified_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant,app_id,open_id)
);
CREATE TABLE IF NOT EXISTS sessions(token_hash text PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),csrf text NOT NULL,user_version int NOT NULL,expires_at timestamptz NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS oauth_states(state_hash text PRIMARY KEY,browser_hash text NOT NULL,verifier text NOT NULL,expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS rate_limits(key text PRIMARY KEY,started_at timestamptz NOT NULL,attempts int NOT NULL);
CREATE TABLE IF NOT EXISTS sourcing_setups(user_id uuid PRIMARY KEY REFERENCES users(id),data jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS collection_requests(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES users(id),setup jsonb NOT NULL,execution_status text NOT NULL CHECK(execution_status='not_configured'),created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS collection_requests_user_idx ON collection_requests(user_id);
CREATE TABLE IF NOT EXISTS skills(name text PRIMARY KEY,category text NOT NULL DEFAULT 'custom');
CREATE TABLE IF NOT EXISTS skill_aliases(alias text PRIMARY KEY,skill text NOT NULL REFERENCES skills(name));
CREATE INDEX IF NOT EXISTS skill_aliases_skill_idx ON skill_aliases(skill);
CREATE TABLE IF NOT EXISTS dictionary_versions(id int PRIMARY KEY DEFAULT 1,version int NOT NULL DEFAULT 1);
INSERT INTO dictionary_versions(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS leads(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL,org text NOT NULL,school text NOT NULL DEFAULT '',major text NOT NULL DEFAULT '',
 skills text[] NOT NULL DEFAULT '{}',direction text NOT NULL,contact text NOT NULL DEFAULT '',source text NOT NULL,
 line text NOT NULL CHECK(line IN ('high','focus','social')),state text NOT NULL DEFAULT 'uncontacted' CHECK(state IN ('uncontacted','contacted','replied','resume_received','uploaded','declined')),
 owner_id uuid NOT NULL REFERENCES users(id),note text NOT NULL DEFAULT '',raw text NOT NULL DEFAULT '',
 last_contacted_at timestamptz,last_followup_at timestamptz,version int NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS leads_owner_idx ON leads(owner_id);
CREATE INDEX IF NOT EXISTS leads_active_idx ON leads(line,state,created_at DESC,id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS leads_skills_idx ON leads USING gin(skills);
CREATE INDEX IF NOT EXISTS leads_school_idx ON leads(line,school,created_at DESC,id) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS lead_followups(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),lead_id uuid NOT NULL REFERENCES leads(id),actor_id uuid NOT NULL REFERENCES users(id),kind text NOT NULL CHECK(kind IN ('contact','note')),note text NOT NULL,occurred_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS lead_followups_lead_idx ON lead_followups(lead_id,occurred_at);
CREATE TABLE IF NOT EXISTS lead_events(id bigserial PRIMARY KEY,lead_id uuid NOT NULL REFERENCES leads(id),actor_id uuid NOT NULL REFERENCES users(id),kind text NOT NULL,from_state text,to_state text,reason text NOT NULL DEFAULT '',at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS lead_events_lead_idx ON lead_events(lead_id,at);
CREATE TABLE IF NOT EXISTS candidates(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),profile jsonb NOT NULL,version int NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),deleted_at timestamptz);
CREATE INDEX IF NOT EXISTS candidates_name_idx ON candidates((profile->>'name'));
CREATE INDEX IF NOT EXISTS candidates_created_idx ON candidates(created_at DESC,id) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS jobs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL,department text NOT NULL DEFAULT '',urgency text NOT NULL DEFAULT 'normal',headcount int NOT NULL DEFAULT 1 CHECK(headcount>0),open boolean NOT NULL DEFAULT true,version int NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS job_versions(job_id uuid NOT NULL REFERENCES jobs(id),version int NOT NULL,requirements jsonb NOT NULL,actor_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(job_id,version));
CREATE INDEX IF NOT EXISTS job_versions_actor_idx ON job_versions(actor_id);
CREATE TABLE IF NOT EXISTS resume_documents(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),blob_key text NOT NULL,sha256 text NOT NULL,file_name text NOT NULL,file_size int NOT NULL CHECK(file_size>0),kind text NOT NULL CHECK(kind IN ('pdf','docx','txt','paste')),owner_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS documents_sha_idx ON resume_documents(sha256);
CREATE INDEX IF NOT EXISTS documents_owner_idx ON resume_documents(owner_id);
CREATE TABLE IF NOT EXISTS tasks(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),kind text NOT NULL CHECK(kind IN ('ingest','recompute')),payload jsonb NOT NULL,state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','awaiting_duplicate_decision','succeeded','needs_text','failed','cancelled')),actor_id uuid NOT NULL REFERENCES users(id),attempts int NOT NULL DEFAULT 0,claim_token int NOT NULL DEFAULT 0,worker_id text,lease_until timestamptz,result jsonb,error_code text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS tasks_queue_idx ON tasks(state,created_at);
CREATE INDEX IF NOT EXISTS tasks_actor_idx ON tasks(actor_id);
CREATE TABLE IF NOT EXISTS parse_results(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),document_id uuid NOT NULL REFERENCES resume_documents(id),raw_bytes bytea NOT NULL,profile jsonb NOT NULL,evidence jsonb NOT NULL,parser_version text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS parse_results_document_idx ON parse_results(document_id);
CREATE TABLE IF NOT EXISTS resume_versions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),candidate_id uuid NOT NULL REFERENCES candidates(id),parse_result_id uuid NOT NULL REFERENCES parse_results(id),origin_task_id uuid UNIQUE REFERENCES tasks(id),created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS resumes_candidate_idx ON resume_versions(candidate_id,created_at);
CREATE INDEX IF NOT EXISTS resumes_parse_idx ON resume_versions(parse_result_id);
CREATE TABLE IF NOT EXISTS applications(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),candidate_id uuid NOT NULL REFERENCES candidates(id),job_id uuid NOT NULL REFERENCES jobs(id),resume_version_id uuid REFERENCES resume_versions(id),status text NOT NULL DEFAULT 'screening' CHECK(status IN ('screening','screened','interviewing','offered','hired','rejected')),source text NOT NULL DEFAULT '其他',version int NOT NULL DEFAULT 1,reject_reason text,reject_detail text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),deleted_at timestamptz);
CREATE UNIQUE INDEX IF NOT EXISTS applications_active_unique ON applications(candidate_id,job_id) WHERE status NOT IN ('hired','rejected') AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS applications_job_idx ON applications(job_id,status);
CREATE INDEX IF NOT EXISTS applications_resume_idx ON applications(resume_version_id);
CREATE INDEX IF NOT EXISTS applications_created_idx ON applications(created_at DESC,id) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS application_grants(application_id uuid NOT NULL REFERENCES applications(id),user_id uuid NOT NULL REFERENCES users(id),PRIMARY KEY(application_id,user_id));
CREATE INDEX IF NOT EXISTS application_grants_user_idx ON application_grants(user_id);
CREATE TABLE IF NOT EXISTS application_events(id bigserial PRIMARY KEY,application_id uuid NOT NULL REFERENCES applications(id),actor_id uuid NOT NULL REFERENCES users(id),from_state text,to_state text NOT NULL,reason text NOT NULL DEFAULT '',at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS application_events_app_idx ON application_events(application_id,at);
CREATE TABLE IF NOT EXISTS match_snapshots(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),application_id uuid NOT NULL REFERENCES applications(id),job_version int NOT NULL,resume_version_id uuid NOT NULL REFERENCES resume_versions(id),algorithm_version text NOT NULL,dictionary_version int NOT NULL,data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(application_id,job_version,resume_version_id,algorithm_version,dictionary_version));
CREATE INDEX IF NOT EXISTS matches_resume_idx ON match_snapshots(resume_version_id);
CREATE TABLE IF NOT EXISTS interviews(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),application_id uuid NOT NULL REFERENCES applications(id),round int NOT NULL CHECK(round>0),starts_at timestamptz NOT NULL,duration_minutes int NOT NULL CHECK(duration_minutes BETWEEN 5 AND 480),form text NOT NULL,status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','completed','cancelled')),version int NOT NULL DEFAULT 1,created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS interviews_app_idx ON interviews(application_id);
CREATE TABLE IF NOT EXISTS interviewers(interview_id uuid NOT NULL REFERENCES interviews(id),user_id uuid NOT NULL REFERENCES users(id),PRIMARY KEY(interview_id,user_id));
CREATE INDEX IF NOT EXISTS interviewers_user_idx ON interviewers(user_id);
CREATE TABLE IF NOT EXISTS evaluations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),interview_id uuid NOT NULL REFERENCES interviews(id),author_id uuid NOT NULL REFERENCES users(id),status text NOT NULL CHECK(status IN ('draft','submitted')),data jsonb NOT NULL,version int NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(interview_id,author_id));
CREATE INDEX IF NOT EXISTS evaluations_author_idx ON evaluations(author_id);
CREATE TABLE IF NOT EXISTS evaluation_versions(evaluation_id uuid NOT NULL REFERENCES evaluations(id),version int NOT NULL,data jsonb NOT NULL,status text NOT NULL,at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(evaluation_id,version));
CREATE TABLE IF NOT EXISTS question_sets(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),application_id uuid NOT NULL REFERENCES applications(id),provider text NOT NULL CHECK(provider='rules'),inputs jsonb NOT NULL,data jsonb NOT NULL,version int NOT NULL DEFAULT 1,actor_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS question_sets_app_idx ON question_sets(application_id,created_at);
CREATE TABLE IF NOT EXISTS briefs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),application_id uuid NOT NULL REFERENCES applications(id),provider text NOT NULL CHECK(provider='rules'),inputs jsonb NOT NULL,data jsonb NOT NULL,human_conclusion jsonb,version int NOT NULL DEFAULT 1,actor_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS briefs_app_idx ON briefs(application_id,created_at);
CREATE TABLE IF NOT EXISTS material_versions(kind text NOT NULL CHECK(kind IN ('questions','briefs')),material_id uuid NOT NULL,version int NOT NULL,data jsonb NOT NULL,actor_id uuid NOT NULL REFERENCES users(id),at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(kind,material_id,version));
CREATE INDEX IF NOT EXISTS material_versions_actor_idx ON material_versions(actor_id);
CREATE TABLE IF NOT EXISTS measurement_protocols(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL,definition text NOT NULL,version int NOT NULL DEFAULT 1,previous_id uuid REFERENCES measurement_protocols(id),created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS protocols_previous_idx ON measurement_protocols(previous_id);
CREATE TABLE IF NOT EXISTS screening_samples(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),resume_version_id uuid NOT NULL REFERENCES resume_versions(id),protocol_id uuid NOT NULL REFERENCES measurement_protocols(id),actor_id uuid NOT NULL REFERENCES users(id),mode text NOT NULL CHECK(mode IN ('manual','assisted')),seconds int NOT NULL CHECK(seconds BETWEEN 1 AND 86400),interrupted boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(resume_version_id,protocol_id,actor_id,mode));
CREATE INDEX IF NOT EXISTS screening_samples_protocol_idx ON screening_samples(protocol_id,mode);
CREATE TABLE IF NOT EXISTS audit_events(id bigserial PRIMARY KEY,actor_id uuid REFERENCES users(id),kind text NOT NULL,entity_id text,detail jsonb NOT NULL DEFAULT '{}',instance text NOT NULL,at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS audit_actor_idx ON audit_events(actor_id);
CREATE TABLE IF NOT EXISTS idempotency_keys(actor_id uuid NOT NULL REFERENCES users(id),key text NOT NULL,request_hash text NOT NULL,response jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(actor_id,key));
CREATE TABLE IF NOT EXISTS migration_receipts(source_sha256 text PRIMARY KEY,source_revision text NOT NULL,manifest jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS legacy_archives(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),source_sha256 text NOT NULL REFERENCES migration_receipts(source_sha256),kind text NOT NULL,source_key text NOT NULL,data_bytes bytea NOT NULL,UNIQUE(source_sha256,kind,source_key));
INSERT INTO schema_migrations(version) VALUES(1) ON CONFLICT DO NOTHING;
