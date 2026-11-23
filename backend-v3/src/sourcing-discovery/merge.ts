import type { Actor, Identity } from '../identity/service.js';
import { fail, found } from '../http/errors.js';
import { DiscoveryPolicy } from './policy.js';
import { signedToken } from './reviews.js';
import { parse, z, uuid } from './schema.js';
const pair = z.object({ sourceId: uuid, targetId: uuid }).strict();
export class DiscoveryMerge {
    readonly policy;
    readonly db;
    constructor(readonly identity: Identity) { this.db = identity.db; this.policy = new DiscoveryPolicy(identity); }
    async snapshot(a: Actor, input: unknown) { this.policy.admin(a); await this.policy.fields(a); const b = parse(pair, input); if (b.sourceId === b.targetId)
        fail(422, 'merge_same_subject'); const subjects = (await this.db.query('SELECT * FROM discovery_subjects WHERE id=ANY($1::uuid[]) ORDER BY id', [[b.sourceId, b.targetId]])).rows, source = found(subjects.find(s => s.id === b.sourceId)), target = found(subjects.find(s => s.id === b.targetId)); if ((await this.db.query("SELECT 1 FROM discovery_merges WHERE reverted_at IS NULL AND data->'source'->>'id'=ANY($1::text[])", [[source.id, target.id]])).rowCount) fail(409, 'merge_target_redirected');
        if (target.lead_id && !(await this.db.query('SELECT 1 FROM leads WHERE id=$1 AND deleted_at IS NULL',[target.lead_id])).rowCount) fail(409,'merge_lead_deleted');
        if (source.entity_type !== target.entity_type)
        fail(409, 'merge_entity_type_conflict'); if (!!source.lead_id !== !!target.lead_id)
        fail(409, 'merge_lead_conflict'); const jobs = (await this.db.query('SELECT * FROM discovery_lead_jobs WHERE lead_id=ANY($1::uuid[]) ORDER BY id', [[source.lead_id, target.lead_id].filter(Boolean)])).rows; const mapped = new Set(jobs.map(j => j.candidate_id).filter(Boolean)); if (mapped.size > 1)
        fail(409, 'merge_candidate_conflict'); const sourceJobs = jobs.filter(j => j.lead_id === source.lead_id), targetJobs = jobs.filter(j => j.lead_id === target.lead_id); if (sourceJobs.some(s => targetJobs.some(t => s.job_id === t.job_id)))
        fail(409, 'merge_job_conflict'); const publications = (await this.db.query('SELECT id,subject_id FROM discovery_publications WHERE subject_id=ANY($1::uuid[]) ORDER BY id', [[source.id, target.id]])).rows; if (!publications.some(p => p.subject_id === source.id))
        fail(409, 'merge_source_empty'); const contacts = (await this.db.query('SELECT id,subject_id,version FROM discovery_contacts WHERE subject_id=ANY($1::uuid[]) ORDER BY id', [[source.id, target.id]])).rows; const sourceLead = source.lead_id ? (await this.db.query('SELECT id,version,deleted_at FROM leads WHERE id=$1', [source.lead_id])).rows[0] : null; if (sourceLead?.deleted_at)
        fail(409, 'merge_lead_deleted'); const value = { source, target, jobs, publications, contacts, sourceLead }; return { ...value, previewToken: signedToken(this.identity.config.secret, { a: a.id, ...value }) }; }
    async preview(a: Actor, input: unknown) { const s = await this.snapshot(a, input); return { sourceId: s.source.id, targetId: s.target.id, sourceName: s.source.display_name, targetName: s.target.display_name, previewToken: s.previewToken, notice: '仅人工确认同一主体后合并；保留来源、联系人和岗位记录，不新建或删除候选人。不可联系标记会保留。' }; }
    async merge(a: Actor, input: unknown) { const b = parse(pair.extend({ previewToken: z.string().min(1).max(2000), reason: z.string().trim().min(5).max(2000) }).strict(), input); return this.db.tx(async (c) => { await c.query('SELECT pg_advisory_xact_lock(hashtext(current_schema()),18002)'); await c.query('SELECT id FROM discovery_subjects WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[b.sourceId, b.targetId]]); await c.query('SELECT id FROM discovery_lead_jobs WHERE lead_id IN(SELECT lead_id FROM discovery_subjects WHERE id=ANY($1::uuid[])) ORDER BY id FOR UPDATE', [[b.sourceId, b.targetId]]); const s = await this.snapshot(a, { sourceId: b.sourceId, targetId: b.targetId }); if (s.previewToken !== b.previewToken)
        fail(409, 'preview_stale'); await c.query('UPDATE discovery_publications SET subject_id=$2 WHERE subject_id=$1', [b.sourceId, b.targetId]); await c.query('UPDATE discovery_contacts SET subject_id=$2 WHERE subject_id=$1', [b.sourceId, b.targetId]); if (s.source.lead_id) {
        await c.query('UPDATE discovery_lead_jobs SET lead_id=$2,version=version+1 WHERE lead_id=$1', [s.source.lead_id, s.target.lead_id]);
        await c.query('UPDATE leads SET deleted_at=now(),version=version+1 WHERE id=$1', [s.source.lead_id]);
    } await c.query('UPDATE discovery_subjects SET version=version+1,do_not_contact=do_not_contact OR $2 WHERE id=ANY($1::uuid[])', [[b.sourceId, b.targetId], s.source.do_not_contact || s.target.do_not_contact]); const row = (await c.query('INSERT INTO discovery_merges(actor_id,data) VALUES($1,$2) RETURNING id', [a.id, { ...s, reason: b.reason }])).rows[0]; await this.identity.audit(c, a.id, 'discovery.merge', row.id); return { id: row.id, targetId: b.targetId }; }); }
    async revert(a: Actor, id: string) { this.policy.admin(a); await this.policy.fields(a); return this.db.tx(async (c) => { await c.query('SELECT pg_advisory_xact_lock(hashtext(current_schema()),18002)'); const row = found((await c.query('SELECT * FROM discovery_merges WHERE id=$1 FOR UPDATE', [id])).rows[0]); if (row.reverted_at)
        fail(409, 'merge_already_reverted'); const s = row.data; const subjects = (await c.query('SELECT * FROM discovery_subjects WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[s.source.id, s.target.id]])).rows; if (subjects.some(r => r.version !== (r.id === s.source.id ? s.source.version : s.target.version) + 1))
        fail(409, 'merge_changed'); const contacts = (await c.query('SELECT id,version FROM discovery_contacts WHERE subject_id=$1 ORDER BY id FOR UPDATE', [s.target.id])).rows; if (contacts.length !== s.contacts.length || contacts.some(r => !s.contacts.some((old: any) => old.id === r.id && old.version === r.version)))
        fail(409, 'merge_changed'); const pubs = (await c.query('SELECT id FROM discovery_publications WHERE subject_id=$1 ORDER BY id FOR UPDATE', [s.target.id])).rows; if (pubs.length !== s.publications.length || pubs.some(r => !s.publications.some((old: any) => old.id === r.id)))
        fail(409, 'merge_changed'); for (const old of s.jobs) {
        const r = found((await c.query('SELECT * FROM discovery_lead_jobs WHERE id=$1 FOR UPDATE', [old.id])).rows[0]);
        if (r.version !== old.version + (old.lead_id === s.source.lead_id ? 1 : 0) || r.candidate_id !== old.candidate_id || r.application_id !== old.application_id)
            fail(409, 'merge_changed');
    } if (s.sourceLead) {
        const lead = found((await c.query('SELECT version FROM leads WHERE id=$1 FOR UPDATE', [s.sourceLead.id])).rows[0]);
        if (lead.version !== s.sourceLead.version + 1)
            fail(409, 'merge_changed');
        await c.query('UPDATE leads SET deleted_at=NULL,version=version+1 WHERE id=$1', [s.sourceLead.id]);
        await c.query('UPDATE discovery_lead_jobs SET lead_id=$1,version=version+1 WHERE id=ANY($2::uuid[])', [s.source.lead_id, s.jobs.filter((j: any) => j.lead_id === s.source.lead_id).map((j: any) => j.id)]);
    } await c.query('UPDATE discovery_publications SET subject_id=$1 WHERE id=ANY($2::uuid[])', [s.source.id, s.publications.filter((p: any) => p.subject_id === s.source.id).map((p: any) => p.id)]); await c.query('UPDATE discovery_contacts SET subject_id=$1 WHERE id=ANY($2::uuid[])', [s.source.id, s.contacts.filter((p: any) => p.subject_id === s.source.id).map((p: any) => p.id)]); await c.query('UPDATE discovery_subjects SET version=version+1 WHERE id=ANY($1::uuid[])', [[s.source.id, s.target.id]]); await c.query('UPDATE discovery_merges SET reverted_at=now() WHERE id=$1', [id]); await this.identity.audit(c, a.id, 'discovery.merge.revert', id); return { id, reverted: true }; }); }
}
