import type { Actor, Identity } from '../identity/service.js';
import { fail, found } from '../http/errors.js';
import { DiscoveryPolicy } from './policy.js';
import { parse, z, uuid, version, pageInput } from './schema.js';
export class DiscoveryLeads {
    readonly db;
    readonly policy;
    constructor(readonly identity: Identity) { this.db = identity.db; this.policy = new DiscoveryPolicy(identity); }
    async query(a: Actor, input: unknown) {
        await this.policy.fields(a);
        const b = parse(pageInput, input), from = ' FROM discovery_subjects s WHERE EXISTS(SELECT 1 FROM discovery_publications p WHERE p.subject_id=s.id AND p.withdrawn_at IS NULL)';
        const items = (await this.db.query(`SELECT s.id,s.lead_id,s.entity_type,s.platform,s.display_name,s.profile_url,s.do_not_contact,s.version${from} ORDER BY s.display_name,s.id LIMIT $1 OFFSET $2`, [b.pageSize, (b.page - 1) * b.pageSize])).rows;
        if (items.length) {
            // Enrich only this authorized page. Keep the same redacted contact projection.
            const subjectIds = items.map(row => row.id), leadIds = [...new Set(items.map(row => row.lead_id).filter(Boolean))];
            const [publications, contacts, jobs] = await Promise.all([
                this.db.query("SELECT subject_id,published->'directions' directions FROM discovery_publications WHERE subject_id=ANY($1::uuid[]) AND withdrawn_at IS NULL", [subjectIds]),
                this.db.query("SELECT subject_id,id,data->>'type' type,CASE WHEN valid_until<=now() THEN 'needs_recheck' ELSE availability END availability,verified_at,valid_until,version FROM discovery_contacts WHERE subject_id=ANY($1::uuid[]) ORDER BY subject_id,id", [subjectIds]),
                leadIds.length ? this.db.query('SELECT r.*,j.name job_name FROM discovery_lead_jobs r LEFT JOIN jobs j ON j.id=r.job_id WHERE r.lead_id=ANY($1::uuid[]) ORDER BY r.lead_id,r.id', [leadIds]) : Promise.resolve({rows:[]}),
            ]);
            const directions = new Map<string, Set<string>>(), contactsBySubject = new Map<string, any[]>(), jobsByLead = new Map<string, any[]>();
            for (const publication of publications.rows) {
                const labels = directions.get(publication.subject_id) || new Set<string>();
                for (const label of (publication.directions || []).map((d:any) => d.label)) labels.add(label);
                directions.set(publication.subject_id, labels);
            }
            for (const {subject_id, ...contact} of contacts.rows) {
                const rows = contactsBySubject.get(subject_id) || []; rows.push(contact); contactsBySubject.set(subject_id, rows);
            }
            for (const job of jobs.rows) {
                const rows = jobsByLead.get(job.lead_id) || []; rows.push(job); jobsByLead.set(job.lead_id, rows);
            }
            for (const row of items) {
                row.directions = [...(directions.get(row.id) || [])];
                row.contacts = contactsBySubject.get(row.id) || [];
                row.jobs = jobsByLead.get(row.lead_id) || [];
            }
        }
        return {items, total:Number((await this.db.query('SELECT count(*)' + from)).rows[0].count), page:b.page, pageSize:b.pageSize, asOf:new Date().toISOString()};
    }
    async reveal(a: Actor, subjectId: string, input: unknown) { await this.policy.contact(a); const b = parse(z.object({ contactId: uuid }).strict(), input); const row = found((await this.db.query('SELECT c.*,s.do_not_contact FROM discovery_contacts c JOIN discovery_subjects s ON s.id=c.subject_id WHERE c.id=$1 AND c.subject_id=$2', [b.contactId, subjectId])).rows[0]); if (row.do_not_contact)
        fail(409, 'do_not_contact'); await this.identity.audit(this.db.sql, a.id, 'discovery.contact.reveal', row.id); return { ...row, availability: new Date(row.valid_until).getTime() <= Date.now() ? 'needs_recheck' : row.availability }; }
    async recheck(a: Actor, subjectId: string, contactId: string, input: unknown) { await this.policy.contact(a); const b = parse(z.object({ version, evidence: z.string().trim().min(1).max(10000), availability: z.enum(['entry_observed', 'value_obtained', 'invalid']), validUntil: z.iso.datetime({ offset: true }).optional() }).strict(), input); return this.db.tx(async (c) => { const r = found((await c.query('SELECT c.*,p.actor_id,s.lead_id FROM discovery_contacts c JOIN discovery_subjects s ON s.id=c.subject_id JOIN discovery_publications p ON p.id=c.publication_id WHERE c.id=$1 AND c.subject_id=$2 FOR UPDATE OF c', [contactId, subjectId])).rows[0]); if (r.actor_id !== a.id && !a.roles.some(role => ['admin', 'manager'].includes(role)))
        fail(403, 'forbidden'); if (r.version !== b.version)
        fail(409, 'version_conflict'); if (b.availability !== 'invalid') {
        if (r.data.type === 'platform_dm' ? (b.availability !== 'entry_observed' || !/(私信|发消息|message)/i.test(b.evidence)) : (b.availability !== 'value_obtained' || !b.evidence.includes(r.data.value)))
            fail(422, 'contact_evidence_required');
        if (r.data.type === 'platform_virtual_phone' && !b.validUntil)
            fail(422, 'expiry_required');
    } const now = new Date(), until = new Date(Math.min(b.validUntil ? Date.parse(b.validUntil) : Infinity, now.getTime() + 30 * 86400000)); if (until <= now)
        fail(422, 'invalid_expiry'); await c.query('UPDATE discovery_contacts SET availability=$2,verified_at=$3,valid_until=$4,verified_by=$5,version=version+1 WHERE id=$1', [contactId, b.availability, now, until, a.id]); await this.identity.audit(c, a.id, 'discovery.contact.recheck', contactId, { evidence: b.evidence, availability: b.availability }); return { id: contactId, version: b.version + 1 }; }); }
    async suppression(a: Actor, id: string, input: unknown) { this.policy.admin(a); const b = parse(z.object({ version, doNotContact: z.boolean(), reason: z.string().trim().min(1).max(2000) }).strict(), input); return this.db.tx(async (c) => { const row = found((await c.query('UPDATE discovery_subjects SET do_not_contact=$3,version=version+1 WHERE id=$1 AND version=$2 RETURNING id,version', [id, b.version, b.doNotContact])).rows[0]); await this.identity.audit(c, a.id, 'discovery.suppression', id, { reason: b.reason, doNotContact: b.doNotContact }); return row; }); }
    async followup(a: Actor, id: string, input: unknown) { const b = parse(z.object({ version, kind: z.enum(['note', 'contact', 'reply', 'resume_received', 'decline']), occurredAt: z.iso.datetime({ offset: true }), note: z.string().trim().min(1).max(2000), nextFollowupAt: z.iso.datetime({ offset: true }).optional() }).strict(), input); if (Date.parse(b.occurredAt) > Date.now() + 60000)
        fail(422, 'future_followup'); return this.db.tx(async (c) => { await c.query('SELECT id FROM discovery_lead_jobs WHERE id=$1 FOR UPDATE', [id]); const row = await this.policy.leadJob(a, id, true); if (row.version !== b.version)
        fail(409, 'version_conflict'); if (b.kind !== 'note' && (row.do_not_contact || ['declined', 'uploaded'].includes(row.state)))
        fail(409, 'lead_followup_blocked'); const transitions: Record<string, string> = { contact: 'contacted', reply: 'replied', resume_received: 'resume_received', decline: 'declined' }; if (b.kind === 'reply' && !['contacted', 'replied'].includes(row.state))
        fail(409, 'contact_record_required'); if (b.kind === 'contact' && !['uncontacted', 'contacted'].includes(row.state))
        fail(409, 'cannot_regress_followup'); await c.query('INSERT INTO discovery_followups(lead_job_id,actor_id,data) VALUES($1,$2,$3)', [id, a.id, b]); const result = (await c.query('UPDATE discovery_lead_jobs SET state=$2,version=version+1,next_followup_at=$3 WHERE id=$1 RETURNING id,state,version', [id, transitions[b.kind] || row.state, b.nextFollowupAt || null])).rows[0]; await this.identity.audit(c, a.id, 'discovery.followup', id, { kind: b.kind }); return result; }); }
    async addJob(a: Actor, subjectId: string, input: unknown) { const b = parse(z.object({ version, jobId: uuid }).strict(), input); await this.policy.fields(a); return this.db.tx(async (c) => { const s = found((await c.query('SELECT s.*,l.owner_id FROM discovery_subjects s JOIN leads l ON l.id=s.lead_id WHERE s.id=$1 FOR UPDATE OF s', [subjectId])).rows[0]); if (s.version !== b.version)
        fail(409, 'version_conflict'); if (s.owner_id !== a.id && !a.roles.some(r => ['admin', 'manager'].includes(r)))
        fail(403, 'forbidden'); if (s.do_not_contact)
        fail(409, 'do_not_contact'); if (!(await c.query('SELECT 1 FROM jobs WHERE id=$1 AND open', [b.jobId])).rowCount)
        fail(409, 'job_closed'); const row = (await c.query('INSERT INTO discovery_lead_jobs(lead_id,job_id,owner_id) VALUES($1,$2,$3) ON CONFLICT(lead_id,job_id) DO UPDATE SET lead_id=excluded.lead_id RETURNING id,state,version', [s.lead_id, b.jobId, a.id])).rows[0]; await this.identity.audit(c, a.id, 'discovery.job.link', subjectId, { jobId: b.jobId }); return row; }); }
    async metrics(a: Actor, input: unknown) { await this.policy.fields(a); const b = parse(z.object({ taskId: uuid.optional() }).strict(), input); if (b.taskId)
        await this.policy.assertTask(a, b.taskId); const args = [a.roles.includes('admin'), a.id, b.taskId || null]; const base = `FROM discovery_sources s JOIN discovery_tasks t ON t.id=s.task_id WHERE ($1::boolean OR t.owner_id=$2 OR EXISTS(SELECT 1 FROM discovery_collaborators c WHERE c.task_id=t.id AND c.user_id=$2)) AND ($3::uuid IS NULL OR t.id=$3)`; const discovered = (await this.db.query("SELECT DISTINCT s.platform,coalesce(s.native_id,s.profile_url) identity_key,(SELECT id::text FROM discovery_subjects sub WHERE sub.platform=s.platform AND sub.identity_key=coalesce(s.native_id,s.profile_url)) subject_id " + base, args)).rows; const aliases = (await this.db.query("SELECT data->'source'->>'id' source_id,data->'target'->>'id' target_id FROM discovery_merges WHERE reverted_at IS NULL")).rows; const canonical = (id: string) => { for (let n = 0; n < 10; n++) {
        const next = aliases.find(r => r.source_id === id);
        if (!next)
            break;
        id = next.target_id;
    } return id; }; const total = new Set(discovered.map(r => r.subject_id ? canonical(r.subject_id) : r.platform + ':' + r.identity_key)).size; const pending = Number((await this.db.query("SELECT count(*) " + base + " AND s.status IN('pending','reviewed','deferred')", args)).rows[0].count); const rows = (await this.db.query(`SELECT p.subject_id,sub.entity_type,sub.do_not_contact,dt.snapshot->>'contactRequirement' requirement,EXISTS(SELECT 1 FROM discovery_contacts c WHERE c.publication_id=p.id AND c.valid_until>now() AND c.availability='value_obtained' AND c.data->>'type' IN('phone','email','wechat','platform_virtual_phone')) direct,EXISTS(SELECT 1 FROM discovery_contacts c WHERE c.publication_id=p.id AND c.valid_until>now() AND c.availability='entry_observed') dm FROM discovery_publications p JOIN discovery_subjects sub ON sub.id=p.subject_id JOIN discovery_sources ds ON ds.id=p.source_id JOIN discovery_tasks dt ON dt.id=ds.task_id WHERE p.withdrawn_at IS NULL AND p.source_id IN(SELECT s.id ${base})`, args)).rows; const bySubject=new Map<string,any>();for(const row of rows){const eligible=row.requirement==='direct'?row.direct:row.requirement==='platform_dm'?row.dm:row.direct||row.dm;const old=bySubject.get(row.subject_id);bySubject.set(row.subject_id,old?{...old,direct:old.direct||row.direct,dm:old.dm||row.dm,eligible:old.eligible||eligible}:{...row,eligible});}const unique=[...bySubject.values()]; const groups = ['person', 'account', 'team', 'institution'].map(entityType => { const group = unique.filter(r => r.entity_type === entityType && !r.do_not_contact), valid = group.filter(r => r.eligible); return { entityType, published: group.length, valid: valid.length, direct: group.filter(r => r.direct).length, dmOnly: group.filter(r => r.dm && !r.direct).length, both: group.filter(r => r.dm && r.direct).length }; }); return { asOf: new Date().toISOString(), scope: '当前权限下的任务；主体去重，非唯一自然人数', denominator: total, pending, groups, rate: total ? groups.reduce((n, g) => n + g.valid, 0) / total : null }; }
}
