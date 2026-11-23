import { requireRole } from '../identity/service.js';
import { fail, found } from '../http/errors.js';
import { legacyDefinition, legacyKeys, assertLegacySource } from '../business-config/legacy-fields.js';
export class DiscoveryPolicy {
    identity;
    constructor(identity) {
        this.identity = identity;
    }
    writer(a) { requireRole(a, 'admin', 'manager', 'recruiter'); }
    admin(a) { requireRole(a, 'admin', 'manager'); }
    async assertTask(a, id, mode = 'read') {
        this.writer(a);
        const row = found((await this.identity.db.query('SELECT * FROM discovery_tasks WHERE id=$1', [id])).rows[0]);
        if (!a.roles.includes('admin') && row.owner_id !== a.id && !(await this.identity.db.query('SELECT 1 FROM discovery_collaborators WHERE task_id=$1 AND user_id=$2', [id, a.id])).rowCount)
            fail(403, 'forbidden');
        if (mode === 'write' && ['cancelled', 'completed'].includes(row.state))
            fail(409, 'discovery_task_closed');
        return row;
    }
    async source(a, id, write = false) { const r = found((await this.identity.db.query('SELECT * FROM discovery_sources WHERE id=$1', [id])).rows[0]); await this.assertTask(a, r.task_id, write ? 'write' : 'read'); return r; }
    async fields(a) { this.writer(a); await assertLegacySource(this.identity, a, ['lead']); }
    async contact(a) {
        this.writer(a);
        const d = await legacyDefinition(this.identity, a, 'lead');
        if (!legacyKeys(d, a).has('contact'))
            fail(403, 'field_query_forbidden');
    }
    async leadJob(a, id, write = false) {
        this.writer(a);
        const r = found((await this.identity.db.query('SELECT j.*,s.do_not_contact FROM discovery_lead_jobs j LEFT JOIN discovery_subjects s ON s.lead_id=j.lead_id WHERE j.id=$1', [id])).rows[0]);
        if (write && r.owner_id !== a.id && !a.roles.some(x => ['admin', 'manager'].includes(x)))
            fail(403, 'forbidden');
        return r;
    }
}
//# sourceMappingURL=policy.js.map