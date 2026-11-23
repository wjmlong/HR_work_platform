ALTER TABLE interviews ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
