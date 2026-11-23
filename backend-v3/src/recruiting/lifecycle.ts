/** Lifecycle is a view over recruitment history, never a replacement for a person's profile. */
export const terminalStates = ['hired', 'terminated', 'rejected', 'hired_other'] as const;
const terminalSql = "('hired','terminated','rejected','hired_other')";
export const activeCandidateSql = `EXISTS(SELECT 1 FROM applications workflow WHERE workflow.candidate_id=c.id AND workflow.is_current AND workflow.deleted_at IS NULL AND workflow.status NOT IN ${terminalSql})`;
export const archivedCandidateSql = `(c.archived_at IS NOT NULL OR EXISTS(SELECT 1 FROM applications history WHERE history.candidate_id=c.id AND history.deleted_at IS NULL AND history.status IN ${terminalSql}))`;
export const candidateLifecycleSql = `CASE WHEN ${activeCandidateSql} THEN 'active' WHEN ${archivedCandidateSql} THEN 'archive' ELSE 'inbox' END`;
