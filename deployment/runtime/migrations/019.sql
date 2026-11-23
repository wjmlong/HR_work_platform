-- New intake is not talent-pool membership. Existing profiles and workflows are unchanged.
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS archive_reason text NOT NULL DEFAULT '';
-- Attendance is a fact about one interview; it does not end the application.
ALTER TABLE interviews DROP CONSTRAINT IF EXISTS interviews_status_check;
ALTER TABLE interviews ADD CONSTRAINT interviews_status_check CHECK(status IN ('pending','passed','failed','cancelled','legacy_completed','no_show'));

-- Append a new published dictionary version; never rewrite historical versions or user drafts.
DO $$
DECLARE cfg record; next_version int; doc jsonb; next_order int;
BEGIN
 SELECT c.id,c.published_version,v.document INTO cfg FROM business_configs c
 JOIN business_config_versions v ON v.config_id=c.id AND v.version=c.published_version
 WHERE c.key='dictionary.interview_statuses' FOR UPDATE OF c;
 IF FOUND AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(cfg.document->'options') item WHERE item->>'id'='no_show') THEN
  SELECT coalesce(max(version),0)+1 INTO next_version FROM business_config_versions WHERE config_id=cfg.id;
  SELECT coalesce(max((item->>'order')::int),-1)+1 INTO next_order FROM jsonb_array_elements(cfg.document->'options') item;
  doc=jsonb_set(cfg.document,'{options}',(cfg.document->'options')||jsonb_build_array(jsonb_build_object('id','no_show','label','爽约／未到场','aliases',jsonb_build_array(),'order',next_order,'active',true,'coreCode','no_show')));
  INSERT INTO business_config_versions(config_id,version,document) VALUES(cfg.id,next_version,doc);
  UPDATE business_configs SET published_version=next_version,version=version+1,updated_at=now() WHERE id=cfg.id;
 END IF;
END $$;
