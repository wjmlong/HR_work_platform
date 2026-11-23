ALTER TABLE resume_documents DROP CONSTRAINT resume_documents_kind_check;
ALTER TABLE resume_documents ADD CONSTRAINT resume_documents_kind_check CHECK(kind IN ('pdf','docx','txt','paste','doc','wps','png','jpg','jpeg','webp'));
ALTER TABLE parse_results ADD COLUMN recognition jsonb;
