import { requireRole } from '../identity/service.js';
import { z, parse, uuid, version } from '../http/validation.js';
import { fail, found } from '../http/errors.js';
import { entityKind } from './schema.js';
import { fieldQuerySchema, ConfiguredQueryService } from './query.js';
import { assertFilterField, fieldAllowed } from './access.js';
export const viewRequest = z.object({ id: uuid.optional(), version: version.optional(), entity: entityKind, name: z.string().trim().min(1).max(200), scope: z.enum(['personal', 'shared']), query: fieldQuerySchema }).strict();
export class SavedViewService {
    identity;
    query;
    constructor(identity) {
        this.identity = identity;
        this.query = new ConfiguredQueryService(identity);
    }
    async save(a, input) {
        const b = parse(viewRequest, input);
        if (b.scope === 'shared')
            requireRole(a, 'admin', 'manager');
        await this.query.validate(a, b.entity, b.query);
        return this.identity.db.tx(async (c) => { let row; if (b.id) {
            const old = found((await c.query('SELECT * FROM saved_views WHERE id=$1 FOR UPDATE', [b.id])).rows[0]);
            if (old.entity !== b.entity)
                fail(422, 'view_entity_immutable');
            if (old.owner_id !== a.id)
                fail(403, 'forbidden');
            if (old.version !== b.version)
                fail(409, 'version_conflict');
            row = (await c.query('UPDATE saved_views SET name=$2,scope=$3,query=$4,version=version+1,updated_at=now() WHERE id=$1 RETURNING *', [b.id, b.name, b.scope, b.query])).rows[0];
        }
        else
            row = (await c.query('INSERT INTO saved_views(owner_id,entity,scope,name,query) VALUES($1,$2,$3,$4,$5) RETURNING *', [a.id, b.entity, b.scope, b.name, b.query])).rows[0]; await this.identity.audit(c, a.id, 'view.save', row.id, { entity: b.entity, scope: b.scope }); return { id: row.id, version: row.version, name: row.name, scope: row.scope, entity: row.entity }; });
    }
    async resolve(a, id) {
        parse(uuid, id);
        requireRole(a, 'admin', 'manager', 'recruiter', 'interviewer', 'viewer');
        const row = (await this.identity.db.query("SELECT * FROM saved_views WHERE id=$1 AND (owner_id=$2 OR scope='shared')", [id, a.id])).rows[0];
        if (!row)
            fail(403, 'forbidden');
        const def = await this.query.definition(a, row.entity), query = { ...row.query, definitionVersion: def.ref.version, ...(row.query.definitionRevision ? { definitionRevision: def.aclRevision } : {}) };
        try {
            await this.query.validate(a, row.entity, query);
        }
        catch {
            fail(409, 'view_invalid');
        }
        return query;
    }
    async list(a, entity) { const kind = parse(entityKind, entity); requireRole(a, 'admin', 'manager', 'recruiter', 'interviewer', 'viewer'); const rows = (await this.identity.db.query("SELECT id,version,name,scope,entity,owner_id FROM saved_views WHERE entity=$1 AND (owner_id=$2 OR scope='shared') ORDER BY scope,name,id", [kind, a.id])).rows; return Promise.all(rows.map(async (r) => { try {
        await this.resolve(a, r.id);
        return { ...r, valid: true };
    }
    catch {
        return { ...r, valid: false, problems: await this.problems(a, kind, r.id) };
    } })); }
    async problems(a, kind, id) {
        const stored = (await this.identity.db.query('SELECT query FROM saved_views WHERE id=$1', [id])).rows[0]?.query, def = await this.query.definition(a, kind), problems = [];
        const uses = [['column', (stored?.columns || []).map((fieldId) => ({ fieldId }))], ['filter', stored?.filters || []], ['sort', stored?.sort || []], ['facet', (stored?.facets || []).map((fieldId) => ({ fieldId }))]];
        for (const [location, items] of uses)
            for (const item of items) {
                const f = def.fields.find(f => f.fieldId === item.fieldId);
                try {
                    if (location === 'column') {
                        if (!f || !f.active || !fieldAllowed(f, a, 'read', true))
                            throw Error();
                    }
                    else
                        assertFilterField(def, a, item.fieldId, location === 'sort' ? 'sort' : 'filter', true);
                }
                catch {
                    problems.push({ location, label: f && fieldAllowed(f, a, 'read', true) ? f.label : '不可用字段', reason: f && !f.active ? '字段已停用' : '当前无权使用或定义已失效' });
                }
            }
        return problems;
    }
    async remove(a, id, input) { requireRole(a, 'admin', 'manager', 'recruiter', 'interviewer', 'viewer'); const b = parse(z.object({ version }).strict(), input); const row = (await this.identity.db.query('DELETE FROM saved_views WHERE id=$1 AND owner_id=$2 AND version=$3 RETURNING id', [id, a.id, b.version])).rows[0]; if (!row)
        fail(409, 'version_conflict'); return { id }; }
}
//# sourceMappingURL=views.js.map