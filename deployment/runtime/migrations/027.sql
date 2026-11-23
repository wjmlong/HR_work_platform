-- 岗位筛选授权：用人部门在限定时间、限定岗位上完成初筛（待筛选 → 初筛通过）。
-- 到期与撤销都靠视图判定，不依赖后台任务；不会改变永久角色。
CREATE TABLE job_screening_grants(
  job_id uuid NOT NULL REFERENCES jobs(id),
  user_id uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(job_id,user_id)
);
CREATE INDEX job_screening_grants_user_idx ON job_screening_grants(user_id) WHERE revoked_at IS NULL;
CREATE VIEW active_job_screening_grants AS
 SELECT g.job_id,g.user_id,g.expires_at,g.created_by,g.created_at
 FROM job_screening_grants g
 JOIN users u ON u.id=g.user_id
 JOIN jobs j ON j.id=g.job_id
 WHERE g.revoked_at IS NULL AND g.expires_at>now() AND u.directory_active AND u.status IN ('active','pending');
