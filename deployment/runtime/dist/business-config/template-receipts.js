import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { parse } from '../http/validation.js';
import { publishRequest } from './schema.js';
import { fail, found } from '../http/errors.js';
const stable = (v) => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
export const templateHash = (v) => createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');
export class TemplateReceipts {
    identity;
    kind;
    constructor(identity, kind) {
        this.identity = identity;
        this.kind = kind;
    }
    key(id) { return this.identity.hash(this.kind + ':' + id); }
    async issue(c, a, version, scope, basis) { scope = { ...scope, schema: this.identity.db.config.schema, actorVersion: a.version }; const body = { draftId: randomUUID(), draftVersion: 1, baseVersion: version, actorId: a.id, inputHash: templateHash(scope), impactHash: templateHash(basis) }, receipt = { ...body, signature: this.identity.hash(this.kind + ':' + templateHash(body)) }; await c.query('INSERT INTO migration_receipts(source_sha256,source_revision,manifest) VALUES($1,$2,$3)', [this.key(body.draftId), this.kind + '-v1', { kind: this.kind, scope, receipt, expires: Date.now() + 1800000 }]); return receipt; }
    async read(c, a, receipt, lock = false) { const b = parse(publishRequest, receipt), { signature, ...body } = b, actual = Buffer.from(signature, 'hex'), expected = Buffer.from(this.identity.hash(this.kind + ':' + templateHash(body)), 'hex'); if (body.actorId !== a.id || actual.length !== expected.length || !timingSafeEqual(actual, expected))
        fail(409, 'template_preview_invalid'); const row = found((await c.query('SELECT manifest FROM migration_receipts WHERE source_sha256=$1' + (lock ? ' FOR UPDATE' : ''), [this.key(body.draftId)])).rows[0]), m = row.manifest; if (m.kind !== this.kind || m.scope.schema !== this.identity.db.config.schema || m.scope.actorVersion !== a.version || m.expires < Date.now() || templateHash(m.receipt) !== templateHash(b) || templateHash(m.scope) !== body.inputHash)
        fail(409, 'template_preview_stale'); return m; }
    async applied(c, receipt, manifest, result) { await c.query('UPDATE migration_receipts SET manifest=$2 WHERE source_sha256=$1', [this.key(receipt.draftId), { ...manifest, applied: result }]); }
}
//# sourceMappingURL=template-receipts.js.map