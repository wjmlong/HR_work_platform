CREATE TABLE application_checklists(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),application_id uuid NOT NULL REFERENCES applications(id),
 stage text NOT NULL CHECK(stage IN ('collecting','background_check','offered','hired')),
 config_id uuid NOT NULL,template_version int NOT NULL,template_snapshot jsonb NOT NULL,
 version int NOT NULL DEFAULT 1 CHECK(version>0),legacy_collected_at timestamptz,
 history jsonb NOT NULL DEFAULT '[]',opened_by uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(application_id,stage),FOREIGN KEY(config_id,template_version) REFERENCES business_config_versions(config_id,version)
);
CREATE TABLE application_checklist_items(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),checklist_id uuid NOT NULL REFERENCES application_checklists(id),
 template_item_id text NOT NULL,item_snapshot jsonb NOT NULL,active boolean NOT NULL DEFAULT true,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done','not_applicable')),
 note text NOT NULL DEFAULT '',version int NOT NULL DEFAULT 1 CHECK(version>0),
 decided_by uuid REFERENCES users(id),decided_at timestamptz,source jsonb NOT NULL DEFAULT '{}',
 history jsonb NOT NULL DEFAULT '[]',updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(checklist_id,template_item_id),
 CHECK(status<>'not_applicable' OR length(btrim(note))>0),
 CHECK((status='pending' AND decided_by IS NULL AND decided_at IS NULL) OR (status<>'pending' AND decided_by IS NOT NULL AND decided_at IS NOT NULL))
);
CREATE INDEX checklist_application_idx ON application_checklists(application_id,stage);
CREATE INDEX checklist_items_head_idx ON application_checklist_items(checklist_id,active);
