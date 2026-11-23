import { SearchService, searchInput } from './search.js';
import { discoveryExport } from './export.js';
import { DiscoveryMerge } from './merge.js';
import { DiscoveryCapabilities } from './capabilities.js';
import { createHash } from 'node:crypto';
import { RecruitingHandoff } from './handoff.js';
import { SourceService } from './sources.js';
import { DiscoveryReviews, previewInput, publishInput } from './reviews.js';
import { DiscoveryLeads } from './leads.js';
import { discoveryModelStatus } from './model.js';
import { fail } from '../http/errors.js';
import type { FastifyInstance } from 'fastify';
import type { Identity } from '../identity/service.js';
import { DiscoveryTasks } from './tasks.js';
import { parse, z, uuid, version, taskInput, pageInput, actionInput, sourcesInput, reviewInput, ensureLegacyRelations } from './schema.js';
export function discoveryRoutes(app: FastifyInstance, id: Identity) {
    const merge = new DiscoveryMerge(id), capabilities = new DiscoveryCapabilities(id), handoff = new RecruitingHandoff(id);
    const sources = new SourceService(id), reviews = new DiscoveryReviews(id), leads = new DiscoveryLeads(id);
    const s = new DiscoveryTasks(id), base = '/api/v4/sourcing';
    app.addHook('onReady', async () => { await ensureLegacyRelations(id.db); });
    const param = (p: unknown) => parse(z.object({ id: uuid }), p).id;
    const json = (v: z.ZodType) => { const r = z.toJSONSchema(v, { target: 'draft-7', io: 'input' }); delete r.$schema; return r; };
    const schema = (body?: z.ZodType, params?: boolean) => ({ ...(body ? { body: json(body) } : {}), ...(params ? { params: json(z.object({ id: uuid })) } : {}) });
    app.get(base + '/capabilities', req => capabilities.list(req.actor));
    app.post(base + '/tasks', { schema: schema(taskInput) }, req => s.create(req.actor, req.body));
    app.post(base + '/tasks/query', { schema: schema(pageInput) }, req => s.query(req.actor, req.body));
    app.get(base + '/tasks/:id', { schema: schema(undefined, true) }, req => s.get(req.actor, param(req.params)));
    app.post(base + '/tasks/:id/actions', { schema: schema(actionInput, true), preHandler: async (req) => { await s.policy.assertTask(req.actor, param(req.params)); } }, req => s.action(req.actor, param(req.params), req.body));
    app.get('/api/v4/admin/sourcing/capabilities', req => { s.policy.admin(req.actor); return capabilities.list(req.actor); });
    app.put('/api/v4/admin/sourcing/capabilities', { preHandler: async (req) => { s.policy.admin(req.actor); } }, req => capabilities.update(req.actor, req.body));
    app.post(base + '/tasks/:id/search', { schema: schema(searchInput,true), preHandler: async req => { await s.policy.assertTask(req.actor,param(req.params)); await s.policy.fields(req.actor); } }, async(req,reply)=>{reply.code(202);return new SearchService(id).enqueue(req.actor,param(req.params),req.body);});
    app.post(base + '/tasks/:id/fetch', { preHandler: async (req) => { await s.policy.assertTask(req.actor, param(req.params)); await s.policy.fields(req.actor); } }, async (req, reply) => { reply.code(202); return sources.fetch(req.actor, param(req.params), req.body); });
    app.get(base + '/merges/preview', req => merge.preview(req.actor, req.query));
    app.post(base + '/merges', { preHandler: async (req) => { s.policy.admin(req.actor); await s.policy.fields(req.actor); } }, req => merge.merge(req.actor, req.body));
    app.post(base + '/merges/:id/revert', { preHandler: async (req) => { s.policy.admin(req.actor); await s.policy.fields(req.actor); } }, req => merge.revert(req.actor, param(req.params)));
    app.post(base + '/export', async (req, reply) => { const csv = await discoveryExport(id, req.actor, req.body); reply.type('text/csv; charset=utf-8').header('content-disposition', 'attachment; filename=talent-sourcing.csv'); return csv; });
    app.get(base + '/model-status', async (req) => { s.policy.writer(req.actor); return discoveryModelStatus(id.config); });
    app.post(base + '/tasks/:id/sources', { schema: schema(sourcesInput, true), preHandler: async (req) => { await s.policy.assertTask(req.actor, param(req.params)); await s.policy.fields(req.actor); } }, req => sources.submit(req.actor, param(req.params), req.body));
    app.post(base + '/results/query', { schema: schema(pageInput) }, req => sources.query(req.actor, req.body));
    app.get(base + '/results/:id', req => sources.get(req.actor, param(req.params)));
    app.get(base + '/results/:id/evidence', req => sources.get(req.actor, param(req.params)));
    const sourceGuard = async (req: any) => { await s.policy.source(req.actor, param(req.params)); await s.policy.fields(req.actor); };
    app.post(base + '/results/:id/extractions', { schema: schema(z.object({ version }).strict(), true), preHandler: sourceGuard }, async (req, reply) => { if (!discoveryModelStatus(id.config).configured)
        fail(503, 'model_not_configured'); reply.code(202); return sources.enqueue(req.actor, param(req.params), req.body); });
    app.post(base + '/results/:id/reviews', { schema: schema(reviewInput, true), preHandler: sourceGuard }, req => reviews.review(req.actor, param(req.params), req.body));
    // Preview is a read operation. It is intentionally GET so private material never enters command receipts.
    app.get(base + '/results/:id/publish-preview', req => reviews.preview(req.actor, param(req.params), { version: Number((req.query as any).version), reviewId: (req.query as any).reviewId }));
    app.post(base + '/results/:id/publications', { schema: schema(publishInput, true), preHandler: sourceGuard }, req => reviews.publish(req.actor, param(req.params), req.body));
    app.post(base + '/results/:id/dispositions', { preHandler: sourceGuard }, req => reviews.disposition(req.actor, param(req.params), req.body));
    app.post(base + '/pool/query', req => leads.query(req.actor, req.body));
    app.get(base + '/leads/:id/provenance', req => reviews.provenance(req.actor, param(req.params)));
    app.post(base + '/subjects/:id/contacts/reveal', req => leads.reveal(req.actor, param(req.params), req.body));
    app.post(base + '/subjects/:id/contacts/:contactId/rechecks', { preHandler: async (req) => { await s.policy.contact(req.actor); } }, req => leads.recheck(req.actor, param(req.params), parse(uuid, (req.params as any).contactId), req.body));
    app.post(base + '/subjects/:id/suppression', { preHandler: async (req) => { s.policy.admin(req.actor); } }, req => leads.suppression(req.actor, param(req.params), req.body));
    app.post(base + '/subjects/:id/jobs', { preHandler: async (req) => { await s.policy.fields(req.actor); } }, req => leads.addJob(req.actor, param(req.params), req.body));
    app.post(base + '/lead-jobs/:id/followups', { preHandler: async (req) => { await s.policy.leadJob(req.actor, param(req.params), true); } }, req => leads.followup(req.actor, param(req.params), req.body));
    app.post(base + '/metrics', req => leads.metrics(req.actor, req.body));
    app.get(base + '/lead-jobs/:id/handoff-preview', req => handoff.preview(req.actor, param(req.params)));
    app.post(base + '/handoffs', { preValidation: async (req) => { let data: Buffer | undefined, name = ''; const fields: Record<string, string> = {}; for await (const p of req.parts()) {
            if (p.type === 'file') {
                if (data)
                    fail(422, 'one_file_required');
                data = await p.toBuffer();
                name = p.filename;
                if (p.file.truncated)
                    fail(413, 'file_too_large');
            }
            else if (typeof p.value === 'string' && ['leadJobId', 'version', 'previewToken'].includes(p.fieldname))
                fields[p.fieldname] = p.value;
            else
                fail(422, 'invalid_input');
        } if (!data)
            fail(422, 'file_required'); const body = { leadJobId: parse(uuid, fields.leadJobId), version: parse(version, Number(fields.version)), previewToken: parse(z.string().min(1).max(2000), fields.previewToken), name, sha256: createHash('sha256').update(data).digest('hex') }; req.body = body; (req as any).discoveryFile = data; }, preHandler: async (req) => { await s.policy.fields(req.actor); await s.policy.leadJob(req.actor, (req.body as any).leadJobId, true); } }, req => handoff.accept(req.actor, { ...(req.body as any), data: (req as any).discoveryFile }));
    app.get(base + '/handoffs/:id', req => handoff.reconcile(req.actor, param(req.params)));
    app.post(base + '/handoffs/:id/confirm', { preHandler: async (req) => { const h = await id.db.query('SELECT lead_job_id FROM discovery_handoffs WHERE id=$1', [param(req.params)]); if (!h.rows[0])
            fail(404, 'not_found'); await s.policy.leadJob(req.actor, h.rows[0].lead_job_id, true); } }, req => handoff.confirm(req.actor, param(req.params), parse(z.object({ version }).strict(), req.body).version));
    app.put(base + '/tasks/:id/collaborators', { preHandler: async (req) => { const t = await s.policy.assertTask(req.actor, param(req.params), 'write'); if (t.owner_id !== req.actor.id)
            s.policy.admin(req.actor); } }, async (req) => {
        const taskId = param(req.params), b = parse(z.object({ version, userIds: z.array(uuid).max(50) }).strict(), req.body);
        return id.db.tx(async (c) => { const t = (await c.query('SELECT version FROM discovery_tasks WHERE id=$1 FOR UPDATE', [taskId])).rows[0]; if (t.version !== b.version)
            fail(409, 'version_conflict'); await c.query('DELETE FROM discovery_collaborators WHERE task_id=$1', [taskId]); for (const u of new Set(b.userIds)) {
            if (!(await c.query("SELECT 1 FROM users WHERE id=$1 AND status='active' AND directory_active AND roles&&ARRAY['admin','manager','recruiter']::text[]", [u])).rowCount)
                fail(422, 'collaborator_invalid');
            await c.query('INSERT INTO discovery_collaborators(task_id,user_id) VALUES($1,$2)', [taskId, u]);
        } await c.query('UPDATE discovery_tasks SET version=version+1 WHERE id=$1', [taskId]); await id.audit(c, req.actor.id, 'discovery.collaborators', taskId); return { id: taskId, version: b.version + 1 }; });
    });
}
