-- Grades are versioned business options; retain SQL shape validation while the
-- command validates active membership under the dictionary's publication lock.
ALTER TABLE jobs DROP CONSTRAINT jobs_level_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_level_check CHECK(level IS NULL OR (length(level) BETWEEN 1 AND 300 AND btrim(level)<>''));
