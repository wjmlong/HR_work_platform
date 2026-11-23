CREATE TABLE business_configs(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),key text NOT NULL UNIQUE,kind text NOT NULL,
 entity text NOT NULL,label text NOT NULL,published_version int NOT NULL DEFAULT 0,
 version int NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE business_config_versions(
 config_id uuid NOT NULL REFERENCES business_configs(id),version int NOT NULL CHECK(version>0),
 document jsonb NOT NULL,actor_id uuid REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(config_id,version)
);
CREATE TABLE business_config_drafts(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),config_id uuid NOT NULL REFERENCES business_configs(id),
 actor_id uuid NOT NULL REFERENCES users(id),base_version int NOT NULL,version int NOT NULL DEFAULT 1,
 document jsonb NOT NULL,published_version int,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX business_drafts_actor_idx ON business_config_drafts(actor_id,updated_at DESC);
CREATE TABLE custom_field_values(
 object_kind text NOT NULL,object_id uuid NOT NULL,field_id text NOT NULL,
 config_id uuid NOT NULL,definition_version int NOT NULL,value_type text NOT NULL,
 text_value text,number_value numeric,date_value date,time_value timestamptz,bool_value boolean,
 option_values text[],amount_min numeric,amount_max numeric,currency text,pay_period text,amount_metadata jsonb,
 version int NOT NULL DEFAULT 1,source jsonb NOT NULL DEFAULT '{}',actor_id uuid NOT NULL REFERENCES users(id),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(object_kind,object_id,field_id),
 FOREIGN KEY(config_id,definition_version) REFERENCES business_config_versions(config_id,version),
 CHECK(value_type IN ('text','longtext','number','date','datetime','select','multiselect','boolean','money','money_range')),
 CHECK(CASE WHEN value_type IN ('text','longtext') THEN text_value IS NOT NULL ELSE text_value IS NULL END),
 CHECK(CASE WHEN value_type='number' THEN number_value IS NOT NULL ELSE number_value IS NULL END),
 CHECK(CASE WHEN value_type='date' THEN date_value IS NOT NULL ELSE date_value IS NULL END),
 CHECK(CASE WHEN value_type='datetime' THEN time_value IS NOT NULL ELSE time_value IS NULL END),
 CHECK(CASE WHEN value_type='boolean' THEN bool_value IS NOT NULL ELSE bool_value IS NULL END),
 CHECK(CASE WHEN value_type IN ('select','multiselect') THEN option_values IS NOT NULL ELSE option_values IS NULL END),
 CHECK(CASE WHEN value_type IN ('money','money_range') THEN currency IS NOT NULL AND pay_period IN ('annual','monthly') AND amount_metadata IS NOT NULL ELSE currency IS NULL AND pay_period IS NULL AND amount_metadata IS NULL AND amount_min IS NULL AND amount_max IS NULL END),
 CHECK(amount_min IS NULL OR amount_min>=0),CHECK(amount_max IS NULL OR amount_max>=0),CHECK(amount_min IS NULL OR amount_max IS NULL OR amount_min<=amount_max)
);
CREATE INDEX custom_field_text_idx ON custom_field_values(object_kind,field_id,lower(text_value));
CREATE INDEX custom_field_number_idx ON custom_field_values(object_kind,field_id,number_value,object_id);
CREATE INDEX custom_field_date_idx ON custom_field_values(object_kind,field_id,date_value,object_id);
CREATE INDEX custom_field_options_idx ON custom_field_values USING gin(option_values);
CREATE INDEX custom_field_money_idx ON custom_field_values(object_kind,field_id,currency,pay_period,amount_min);
CREATE TABLE custom_field_value_versions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),object_kind text NOT NULL,object_id uuid NOT NULL,field_id text NOT NULL,
 version int NOT NULL,config_id uuid NOT NULL,definition_version int NOT NULL,
 value jsonb,source jsonb NOT NULL DEFAULT '{}',actor_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(object_kind,object_id,field_id,version),FOREIGN KEY(config_id,definition_version) REFERENCES business_config_versions(config_id,version)
);
CREATE TABLE business_template_bindings(
 object_kind text NOT NULL,object_id uuid NOT NULL,purpose text NOT NULL,
 config_id uuid NOT NULL,template_version int NOT NULL,dictionary_ref jsonb,version int NOT NULL DEFAULT 1,
 actor_id uuid REFERENCES users(id),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(object_kind,object_id,purpose),FOREIGN KEY(config_id,template_version) REFERENCES business_config_versions(config_id,version)
);
CREATE TABLE saved_views(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_id uuid NOT NULL REFERENCES users(id),entity text NOT NULL,
 scope text NOT NULL CHECK(scope IN ('personal','shared')),name text NOT NULL,query jsonb NOT NULL,
 version int NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX saved_views_scope_idx ON saved_views(entity,scope,owner_id);
ALTER TABLE jobs ADD COLUMN configuration_refs jsonb NOT NULL DEFAULT '{}';
ALTER TABLE job_versions ADD COLUMN configuration_refs jsonb NOT NULL DEFAULT '{}';
ALTER TABLE candidate_profile_versions ADD COLUMN configuration_refs jsonb NOT NULL DEFAULT '{}';
ALTER TABLE resume_versions ADD COLUMN configuration_refs jsonb NOT NULL DEFAULT '{}';
ALTER TABLE applications ADD COLUMN configuration_refs jsonb NOT NULL DEFAULT '{}';
ALTER TABLE interviews ADD COLUMN configuration_refs jsonb NOT NULL DEFAULT '{}';
ALTER TABLE evaluation_versions ADD COLUMN configuration_refs jsonb NOT NULL DEFAULT '{}';
ALTER TABLE leads ADD COLUMN configuration_refs jsonb NOT NULL DEFAULT '{}';
ALTER TABLE campuses ADD COLUMN configuration_refs jsonb NOT NULL DEFAULT '{}';
CREATE FUNCTION business_configuration_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'business configuration history is immutable'; END;
$$;
CREATE TRIGGER business_config_version_immutable BEFORE UPDATE OR DELETE ON business_config_versions FOR EACH ROW EXECUTE FUNCTION business_configuration_immutable();
CREATE TRIGGER business_field_version_immutable BEFORE UPDATE OR DELETE ON custom_field_value_versions FOR EACH ROW EXECUTE FUNCTION business_configuration_immutable();
