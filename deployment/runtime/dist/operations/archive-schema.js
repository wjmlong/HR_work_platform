// Frozen pre-configuration archive shapes. Never derive these from current TABLES.
export const LEGACY_V4_TABLES = [
    'schema_migrations', 'users', 'sessions', 'oauth_states', 'rate_limits', 'sourcing_setups', 'collection_requests', 'campuses', 'campus_credential_grants', 'skills', 'skill_aliases', 'dictionary_versions', 'leads', 'lead_followups', 'lead_events', 'candidates', 'candidate_profile_versions', 'jobs', 'job_versions', 'job_salary_grants', 'resume_documents', 'tasks', 'parse_results', 'resume_versions', 'applications', 'application_grants', 'application_events', 'candidate_merges', 'reparse_previews', 'match_snapshots', 'interviews', 'interviewers', 'evaluations', 'evaluation_versions', 'question_sets', 'briefs', 'material_versions', 'measurement_protocols', 'screening_samples', 'audit_events', 'idempotency_keys', 'migration_receipts', 'legacy_archives',
];
export const LEGACY_V3_TABLES = LEGACY_V4_TABLES.filter(t => !['campuses', 'campus_credential_grants', 'job_salary_grants', 'candidate_merges', 'reparse_previews'].includes(t));
export const BUSINESS_TABLES = ['business_configs', 'business_config_versions', 'business_config_drafts', 'custom_field_values', 'custom_field_value_versions', 'business_template_bindings', 'saved_views'];
export const CONFIGURATION_REF_TABLES = ['jobs', 'job_versions', 'candidate_profile_versions', 'resume_versions', 'applications', 'interviews', 'evaluation_versions', 'leads', 'campuses'];
export const CONFIGURATION_V13_TABLES = [...LEGACY_V4_TABLES, ...BUSINESS_TABLES];
export const CONFIGURATION_V15_TABLES = [...CONFIGURATION_V13_TABLES, 'application_checklists', 'application_checklist_items'];
export const CONFIGURATION_V16_TABLES = [...CONFIGURATION_V15_TABLES, 'resume_workflow_runs'];
export const CONFIGURATION_V17_TABLES = [...CONFIGURATION_V16_TABLES, 'interview_assistant_sessions', 'interview_assistant_analyses'];
export const DISCOVERY_TABLES = ['discovery_tasks', 'discovery_collaborators', 'discovery_runs', 'discovery_sources', 'discovery_evidence', 'discovery_reviews', 'discovery_subjects', 'discovery_publications', 'discovery_contacts', 'discovery_lead_jobs', 'discovery_followups', 'discovery_queue', 'discovery_handoffs', 'discovery_merges', 'discovery_capabilities', 'discovery_outbox'];
export const CONFIGURATION_V20_TABLES = [...CONFIGURATION_V17_TABLES, ...DISCOVERY_TABLES];
export const CONFIGURATION_V21_TABLES = [...CONFIGURATION_V20_TABLES, 'interview_access_grants'];
export const CURRENT_TABLES = [...CONFIGURATION_V21_TABLES, 'calendar_sync_state', 'calendar_event_links', 'calendar_sync_inbox', 'calendar_sync_outbox'];
export const ARCHIVE_SCHEMA_REVISION = 22;
export const ARCHIVE_COMPATIBLE_REVISIONS = [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];
//# sourceMappingURL=archive-schema.js.map