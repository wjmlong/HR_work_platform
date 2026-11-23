import { parse, z, uuid } from '../http/validation.js';
import { entityKind } from './schema.js';
import { ConfiguredQueryService, fieldQuerySchema } from './query.js';
import { SavedViewService } from './views.js';
export const configuredQueryRequest = z.object({ fieldQuery: fieldQuerySchema }).strict();
export const configuredExportRequest = z.object({ scope: z.enum(['filtered', 'all']), fieldQuery: fieldQuerySchema }).strict();
export function configuredExport(input) { if (!input || !Object.hasOwn(input, 'fieldQuery'))
    return null; return parse(configuredExportRequest, input); }
export function configuredRequest(input) { if (!input || !Object.hasOwn(input, 'fieldQuery'))
    return null; return parse(configuredQueryRequest, input).fieldQuery; }
export function queryRoutes(app, identity) {
    const s = new ConfiguredQueryService(identity), views = new SavedViewService(identity), kind = (p) => parse(z.object({ kind: entityKind }), p).kind, id = (p) => parse(z.object({ id: uuid }), p).id;
    app.post('/api/v4/business-config/:kind/query', req => s.query(req.actor, kind(req.params), req.body));
    app.post('/api/v4/business-config/:kind/export', async (req, reply) => { const b = parse(z.object({ scope: z.enum(['filtered', 'all']), query: fieldQuerySchema }).strict(), req.body); return reply.type('text/csv; charset=utf-8').send(await s.exportFields(req.actor, kind(req.params), b.scope, b.query)); });
    for (const [path, entity] of [['applications', 'application'], ['interviews', 'interview']])
        app.post('/api/v4/' + path + '/export', async (req, reply) => { const b = parse(z.object({ scope: z.enum(['filtered', 'all']), query: fieldQuerySchema }).strict(), req.body); return reply.type('text/csv; charset=utf-8').send(await s.exportFields(req.actor, entity, b.scope, b.query)); });
    app.post('/api/v4/jobs/query', req => s.query(req.actor, 'job', req.body));
    app.post('/api/v4/jobs/export', async (req, reply) => { const b = parse(z.object({ scope: z.enum(['filtered', 'all']), query: fieldQuerySchema }).strict(), req.body); return reply.type('text/csv; charset=utf-8').send(await s.exportFields(req.actor, 'job', b.scope, b.query)); });
    app.get('/api/v4/views', req => views.list(req.actor, parse(z.object({ entity: entityKind }).strict(), req.query).entity));
    app.post('/api/v4/views', req => views.save(req.actor, req.body));
    app.get('/api/v4/views/:id', req => views.resolve(req.actor, id(req.params)));
    app.post('/api/v4/views/:id/delete', req => views.remove(req.actor, id(req.params), req.body));
}
//# sourceMappingURL=query-routes.js.map