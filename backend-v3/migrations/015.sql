ALTER TABLE applications DROP CONSTRAINT applications_status_check;
ALTER TABLE applications ADD CONSTRAINT applications_status_check CHECK(status IN ('screening','screened','interviewing','collecting','background_check','offered','hired','terminated','rejected','hired_other','on_hold','reserve'));
ALTER TABLE users ADD COLUMN dashboard_preferences jsonb DEFAULT '{"version":1,"widgets":[{"metric":"stages","chart":"bar"},{"metric":"openings","chart":"donut"},{"metric":"funnel","chart":"funnel"}]}';
ALTER TABLE jobs ADD COLUMN question_bank jsonb;
