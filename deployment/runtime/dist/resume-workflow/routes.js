import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { requireRole } from '../identity/service.js';
import { FileStore } from '../files/storage.js';
import { TaskService } from '../tasks/service.js';
import { fail, found } from '../http/errors.js';
import { parse, z, uuid } from '../http/validation.js';
import { decodeJSON } from '../parsing/json.js';
export function resumeWorkflowRoutes(app, id) {
    const configFile = process.env.RECRUIT_WORKFLOW_BRIDGE_CONFIG;
    async function settings() { if (!configFile)
        fail(503, 'workflow_not_configured'); const c = JSON.parse(await fs.readFile(configFile, 'utf8')); for (const value of [c.executorUrl]) {
        const u = new URL(value);
        if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname)))
            fail(503, 'workflow_secure_endpoint_required');
        if (u.username || u.password)
            fail(503, 'workflow_config_invalid');
    } return c; }
    async function call(c, url, body) { const r = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + c.token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000), redirect: 'error' }).catch(() => fail(503, 'workflow_unavailable')); if (!r.ok)
        fail(r.status === 409 ? 409 : 503, 'workflow_request_failed'); return r.json(); }
    const param = (p) => parse(z.object({ id: uuid }), p).id;
    const access = async (a, applicationId) => { requireRole(a, 'admin', 'manager', 'recruiter'); const application = await id.applicationAccess(a, applicationId, true); if (!application.resume_version_id)
        fail(409, 'resume_required'); await new TaskService(id, new FileStore(id.config.storageRoot)).raw(a, application.resume_version_id); return application; };
    app.get('/api/v4/resume-workflow/capabilities', async (req) => { requireRole(req.actor, 'admin', 'manager', 'recruiter'); if (!configFile)
        return { configured: false }; const c = await settings(); return { configured: true, rubric: JSON.parse(await fs.readFile(c.rubricFile, 'utf8')) }; });
    app.post('/api/v4/applications/:id/resume-workflow', async (req) => {
        const applicationId = param(req.params), a = await access(req.actor, applicationId), c = await settings(), b = parse(z.object({ acknowledgeDraft: z.literal(true) }).strict(), req.body);
        const row = found((await id.db.query('SELECT p.human_corrections,d.blob_key,d.kind FROM resume_versions r JOIN parse_results p ON p.id=r.parse_result_id JOIN resume_documents d ON d.id=p.document_id WHERE r.id=$1', [a.resume_version_id])).rows[0]);
        if ((decodeJSON(row.human_corrections) || []).length)
            fail(409, 'workflow_corrected_resume_requires_review');
        const job = found((await id.db.query('SELECT j.name,j.requirements_version,v.requirements FROM jobs j JOIN job_versions v ON v.job_id=j.id AND v.version=j.requirements_version WHERE j.id=$1', [a.job_id])).rows[0]);
        const rubric = JSON.parse(await fs.readFile(c.rubricFile, 'utf8'));
        if (!Array.isArray(c.jobIds) || !c.jobIds.includes(a.job_id))
            fail(409, 'workflow_job_rubric_not_bound');
        const store = new FileStore(id.config.storageRoot), bytes = await store.read(row.blob_key), dir = path.join(id.config.storageRoot, 'workflow-inputs');
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        const file = path.join(dir, row.blob_key + '.' + (row.kind === 'paste' ? 'txt' : row.kind));
        await fs.writeFile(file, row.kind === 'paste' ? JSON.parse(bytes.toString('utf8')) : bytes, { mode: 0o600 });
        const r = await call(c, c.executorUrl + '/runs', { file, jd: { title: job.name, requirements: decodeJSON(job.requirements) }, rubric, context: { applicationId, resumeVersionId: a.resume_version_id, jobVersion: job.requirements_version, actorId: req.actor.id } });
        await id.db.query('INSERT INTO resume_workflow_runs(id,application_id,resume_version_id,job_version,rubric_hash,actor_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING', [r.id, applicationId, a.resume_version_id, job.requirements_version, createHash('sha256').update(JSON.stringify(rubric)).digest('hex'), req.actor.id]);
        await call(c, c.executorUrl + '/runs/' + r.id + '/dispatch', {});
        await id.audit(id.db.sql, req.actor.id, 'resume_workflow.start', applicationId, { runId: r.id, acknowledgeDraft: b.acknowledgeDraft });
        return { id: r.id, state: r.state };
    });
    app.get('/api/v4/applications/:id/resume-workflow', async (req) => { const applicationId = param(req.params); await access(req.actor, applicationId); const c = await settings(), rows = (await id.db.query('SELECT * FROM resume_workflow_runs WHERE application_id=$1 ORDER BY created_at DESC LIMIT 10', [applicationId])).rows; const current = await id.applicationAccess(req.actor, applicationId); const job = found((await id.db.query('SELECT requirements_version FROM jobs WHERE id=$1', [current.job_id])).rows[0]); return { runs: await Promise.all(rows.map(async (row) => ({ ...await call(c, c.executorUrl + '/runs/' + row.id), stale: row.resume_version_id !== current.resume_version_id || row.job_version !== job.requirements_version }))) }; });
    app.post('/api/v4/resume-workflow/:id/review', async (req) => { const runId = param(req.params), row = found((await id.db.query('SELECT * FROM resume_workflow_runs WHERE id=$1', [runId])).rows[0]); const current = await access(req.actor, row.application_id); const job = found((await id.db.query('SELECT requirements_version FROM jobs WHERE id=$1', [current.job_id])).rows[0]); if (current.resume_version_id !== row.resume_version_id || job.requirements_version !== row.job_version)
        fail(409, 'workflow_result_stale'); const b = parse(z.object({ version: z.number().int().positive(), decision: z.enum(['acknowledged', 'needs_correction']), note: z.string().trim().min(1).max(2000) }).strict(), req.body), c = await settings(); const r = await call(c, c.executorUrl + '/runs/' + runId + '/review', { ...b, actorId: req.actor.id }); await id.audit(id.db.sql, req.actor.id, 'resume_workflow.review', row.application_id, { runId, decision: b.decision }); return r; });
}
//# sourceMappingURL=routes.js.map