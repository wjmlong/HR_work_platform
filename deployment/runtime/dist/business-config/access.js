import { requireRole } from '../identity/service.js';
import { fail, found } from '../http/errors.js';
import { parse, z, uuid } from '../http/validation.js';
import { entityKind } from './schema.js';
const writers = ['admin', 'manager', 'recruiter'];
export const privileged = (a) => a.roles.some(r => writers.includes(r));
export const salaryField = (f) => f.access.sensitivity === 'salary' || f.coreKey === 'expectedSalary';
export function fieldAllowed(f, a, mode, salaryAllowed = false) {
    return a.status === 'active' && a.roles.some(r => f.access.read.includes(r)) && a.roles.some(r => f.access[mode].includes(r)) && (!salaryField(f) || privileged(a) || salaryAllowed);
}
export function assertFilterField(def, a, id, purpose = 'filter', salaryAllowed = false) {
    const f = def.fields.find(f => f.fieldId === id);
    if (!f || !f.active || !fieldAllowed(f, a, purpose === 'export' ? 'export' : 'read', salaryAllowed) || purpose === 'filter' && !f.searchable || purpose === 'sort' && !f.sortable)
        fail(403, 'field_query_forbidden');
    return f;
}
export async function assertObjectAccess(identity, a, ref, mode, sql) {
    parse(z.object({ kind: entityKind, id: uuid }), ref);
    requireRole(a, ...writers, 'interviewer', 'viewer');
    if (ref.kind === 'application') {
        await identity.applicationAccess(a, ref.id, mode === 'write', sql);
        return;
    }
    if (ref.kind === 'resume') {
        if (a.temporaryScope) {
            const app = await identity.applicationAccess(a, a.temporaryScope.applicationId, false, sql);
            if (mode !== 'read' || app.resume_version_id !== ref.id)
                fail(403, 'forbidden');
            return;
        }
        found((await sql.query('SELECT id FROM resume_versions WHERE id=$1', [ref.id])).rows[0]);
        if (mode === 'write') {
            requireRole(a, ...writers);
            if (!(await sql.query('SELECT 1 FROM resume_versions WHERE id=$1 AND xmin::text=pg_current_xact_id()::text', [ref.id])).rowCount)
                fail(409, 'resume_revision_required');
            return;
        }
        if (privileged(a))
            return;
        const apps = (await sql.query('SELECT DISTINCT a.id FROM applications a LEFT JOIN match_snapshots m ON m.application_id=a.id WHERE a.deleted_at IS NULL AND (a.resume_version_id=$1 OR m.resume_version_id=$1)', [ref.id])).rows;
        for (const app of apps) {
            try {
                await identity.applicationAccess(a, app.id, false, sql);
                return;
            }
            catch (e) {
                if (e.statusCode !== 403)
                    throw e;
            }
        }
        fail(403, 'forbidden');
    }
    if (ref.kind === 'job') {
        found((await sql.query('SELECT id FROM jobs WHERE id=$1', [ref.id])).rows[0]);
        if (mode === 'write') {
            requireRole(a, ...writers);
            return;
        }
        if (privileged(a) || (await sql.query('SELECT 1 FROM job_salary_grants WHERE job_id=$1 AND user_id=$2', [ref.id, a.id])).rowCount)
            return;
        const apps = (await sql.query('SELECT id FROM applications WHERE job_id=$1 AND deleted_at IS NULL', [ref.id])).rows;
        for (const app of apps) {
            try {
                await identity.applicationAccess(a, app.id, false, sql);
                return;
            }
            catch (e) {
                if (e.statusCode !== 403)
                    throw e;
            }
        }
        fail(403, 'forbidden');
    }
    if (ref.kind === 'lead' || ref.kind === 'campus') {
        requireRole(a, ...writers);
        const table = ref.kind === 'lead' ? 'leads' : 'campuses';
        found((await sql.query(`SELECT id FROM ${table} WHERE id=$1 AND deleted_at IS NULL`, [ref.id])).rows[0]);
        return;
    }
    if (ref.kind === 'interview') {
        if (a.temporaryScope) {
            await identity.interviewActor(a, ref.id, mode === 'write' ? 'coordinate' : 'read', sql);
            if (mode === 'write')
                fail(403, 'forbidden');
            return;
        }
        const row = found((await sql.query('SELECT application_id FROM interviews WHERE id=$1 AND deleted_at IS NULL', [ref.id])).rows[0]);
        if (mode === 'write')
            requireRole(a, ...writers);
        await identity.applicationAccess(a, row.application_id, mode === 'write', sql);
        return;
    }
    const e = found((await sql.query('SELECT e.*,i.application_id FROM evaluations e JOIN interviews i ON i.id=e.interview_id WHERE e.id=$1', [ref.id])).rows[0]);
    if (a.temporaryScope) {
        await identity.interviewActor(a, e.interview_id, 'read', sql);
        if (e.author_id !== a.id)
            fail(403, 'forbidden');
    }
    await identity.applicationAccess(a, e.application_id, false, sql);
    const owner = e.author_id === a.id || e.last_editor_id === a.id;
    if (e.status === 'draft' && !owner)
        fail(403, 'private_evaluation_draft');
    if (mode === 'write' && !owner && !privileged(a))
        fail(403, 'forbidden');
}
export async function hasSalaryAccess(identity, a, ref, sql) {
    if (a.temporaryScope)
        return false;
    if (privileged(a))
        return true;
    let jobId;
    if (ref.kind === 'job')
        jobId = ref.id;
    else if (ref.kind === 'application')
        jobId = (await identity.applicationAccess(a, ref.id, false, sql)).job_id;
    else if (ref.kind === 'interview' || ref.kind === 'evaluation') {
        const row = ref.kind === 'interview' ? (await sql.query('SELECT application_id FROM interviews WHERE id=$1 AND deleted_at IS NULL', [ref.id])).rows[0] : (await sql.query('SELECT i.application_id FROM evaluations e JOIN interviews i ON i.id=e.interview_id WHERE e.id=$1', [ref.id])).rows[0];
        jobId = (await identity.applicationAccess(a, row.application_id, false, sql)).job_id;
    }
    else if (ref.kind === 'resume') {
        const apps = (await sql.query('SELECT a.id FROM applications a JOIN job_salary_grants g ON g.job_id=a.job_id AND g.user_id=$2 WHERE a.resume_version_id=$1 AND a.deleted_at IS NULL', [ref.id, a.id])).rows;
        for (const app of apps) {
            try {
                await identity.applicationAccess(a, app.id, false, sql);
                return true;
            }
            catch (e) {
                if (e.statusCode !== 403)
                    throw e;
            }
        }
    }
    return !!jobId && !!(await sql.query('SELECT 1 FROM job_salary_grants WHERE job_id=$1 AND user_id=$2', [jobId, a.id])).rowCount;
}
//# sourceMappingURL=access.js.map