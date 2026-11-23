import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Actor, Identity } from '../identity/service.js';
import { fail, found } from '../http/errors.js';
import { loadDefinition } from '../business-config/fields.js';
import { ConfiguredEntities } from '../business-config/entities.js';
import { DiscoveryPolicy } from './policy.js';
import { parse, z, uuid, version, reviewInput, type ReviewInput } from './schema.js';
export const previewInput = z.object({ version, reviewId: uuid }).strict();
export const publishInput = previewInput.extend({ previewToken: z.string().min(1).max(2000),customFields:z.record(z.string().max(100),z.unknown()).optional(),definitionVersion:version.optional(),definitionRevision:z.string().max(200).optional() }).strict();
export function signedToken(secret: string, value: unknown) { return createHmac('sha256', secret).update(JSON.stringify(value)).digest('base64url'); }
function validToken(a: string, b: string) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
function contactValid(c: ReviewInput['contacts'][number]) { const expires = Math.min(c.validUntil ? Date.parse(c.validUntil) : Infinity, Date.parse(c.observedAt) + 30 * 86400000); return c.type !== 'other' && expires > Date.now() && (c.type !== 'platform_virtual_phone' || !!c.validUntil); }
export class DiscoveryReviews {
    readonly db;
    readonly policy;
    constructor(readonly identity: Identity) { this.db = identity.db; this.policy = new DiscoveryPolicy(identity); }
    async review(a: Actor, id: string, input: unknown) {
        const b = parse(reviewInput, input);
        await this.policy.fields(a);
        await this.policy.contact(a);
        return this.db.tx(async (c) => {
            await c.query('SELECT id FROM discovery_sources WHERE id=$1 FOR UPDATE', [id]);
            const s = await this.policy.source(a, id, true);
            if (s.version !== b.version)
                fail(409, 'version_conflict');
            if (!['pending', 'reviewed'].includes(s.status))
                fail(409, 'discovery_review_closed');
            const evidence = new Map<string, string>(s.data.evidence.map((e: any) => [e.id, e.text]));
            for (const d of [...b.directions, ...b.contacts])
                if (d.evidenceIds.some(e => !evidence.has(e)))
                    fail(422, 'evidence_not_found');
            for (const contact of b.contacts) {
                const text = contact.evidenceIds.map(e => evidence.get(e)).join('\n');
                if (contact.type === 'platform_dm') {
                    if (!/(私信|发消息|发私信|message|direct message)/i.test(text))
                        fail(422, 'dm_entry_unobserved');
                    if (new URL(contact.entryUrl!).hostname !== new URL(s.profile_url).hostname)
                        fail(422, 'contact_subject_mismatch');
                }
                else if (contact.value && !text.includes(contact.value))
                    fail(422, 'contact_value_not_in_evidence');
                if (/(?:客服|投诉|举报|customer service)/i.test(text) && ['person', 'account'].includes(s.entity_type))
                    fail(422, 'contact_owner_unverified');
            }
            const task = await this.policy.assertTask(a, s.task_id);
            const eligible = b.contacts.some(contact => contactValid(contact) && (task.snapshot.contactRequirement === 'any' || (task.snapshot.contactRequirement === 'platform_dm' ? contact.type === 'platform_dm' : contact.type !== 'platform_dm')));
            if (!eligible)
                fail(422, 'contact_requirement_unmet');
            if (!['displayName', 'directions', 'contacts'].every(f => b.publishFields.includes(f as any)))
                fail(422, 'required_publication_fields');
            const r = (await c.query('INSERT INTO discovery_reviews(source_id,source_version,data,actor_id) VALUES($1,$2,$3,$4) RETURNING id', [id, b.version, b, a.id])).rows[0];
            await c.query("UPDATE discovery_sources SET status='reviewed',version=version+1 WHERE id=$1", [id]);
            await this.identity.audit(c, a.id, 'discovery.review', id);
            return { reviewId: r.id, resultId: id, version: b.version + 1, eligible };
        });
    }
    async snapshot(a: Actor, id: string, input: unknown) { const b = parse(previewInput, input); await this.policy.fields(a); await this.policy.contact(a); const s = await this.policy.source(a, id, true); if (s.version !== b.version || s.status !== 'reviewed')
        fail(409, 'version_conflict'); const r = found((await this.db.query('SELECT * FROM discovery_reviews WHERE id=$1 AND source_id=$2 AND source_version=$3', [b.reviewId, id, b.version - 1])).rows[0]); const task = await this.policy.assertTask(a, s.task_id); let existing = (await this.db.query('SELECT * FROM discovery_subjects WHERE platform=$1 AND identity_key=$2', [s.platform, s.native_id || s.profile_url])).rows[0]; for (let depth = 0; existing && depth < 10; depth++) {
        const merged = (await this.db.query("SELECT data->'target'->>'id' target_id FROM discovery_merges WHERE data->'source'->>'id'=$1 AND reverted_at IS NULL ORDER BY created_at DESC LIMIT 1", [existing.id])).rows[0];
        if (!merged)
            break;
        existing = found((await this.db.query('SELECT * FROM discovery_subjects WHERE id=$1', [merged.target_id])).rows[0]);
        if (depth === 9)
            fail(409, 'merge_chain_limit');
    } if (existing?.do_not_contact)
        fail(409, 'do_not_contact'); const def = await loadDefinition(this.identity, 'lead', this.db.sql, a); const payload = { definitionVersion: def.ref.version, definitionRevision: def.aclRevision, sourceId: id, version: b.version, reviewId: r.id, taskVersion: task.version, userId: a.id, roles: [...a.roles].sort(), subjectVersion: existing?.version || 0 }; return { s, r, task, existing, def, token: signedToken(this.identity.config.secret, payload) }; }
    async preview(a: Actor, id: string, input: unknown) { const x = await this.snapshot(a, id, input); return { previewToken: x.token, fields: x.r.data.publishFields, entityType: x.s.entity_type, displayName: x.s.display_name, directions: x.r.data.directions, contactTypes: x.r.data.contacts.map((c: any) => c.type), duplicate: !!x.existing, scope: '工作台有线索权限的用户；原始全文仍保留在任务内', requiresResume: false }; }
    async publish(a: Actor, id: string, input: unknown) {
        const b = parse(publishInput, input);
        return this.db.tx(async (c) => {
            await c.query('SELECT id FROM discovery_tasks WHERE id=(SELECT task_id FROM discovery_sources WHERE id=$1) FOR UPDATE', [id]);
            await c.query('SELECT id FROM discovery_sources WHERE id=$1 FOR UPDATE', [id]);
            await c.query('SELECT pg_advisory_xact_lock(hashtext(current_schema()),18002)');
            const x = await this.snapshot(a, id, { version: b.version, reviewId: b.reviewId });
            if((b.definitionVersion!==undefined&&b.definitionVersion!==x.def.ref.version)||(b.definitionRevision!==undefined&&b.definitionRevision!==x.def.aclRevision))fail(409,'configuration_changed');
            if (!validToken(b.previewToken, x.token))
                fail(409, 'preview_stale');
            const review = x.r.data as ReviewInput;
            if (!review.contacts.some(contact => contactValid(contact) && (x.task.snapshot.contactRequirement === 'any' || (x.task.snapshot.contactRequirement === 'platform_dm' ? contact.type === 'platform_dm' : contact.type !== 'platform_dm'))))
                fail(409, 'contacts_expired');
            let subject = x.existing;
            if (!subject)
                subject = (await c.query('INSERT INTO discovery_subjects(entity_type,platform,identity_key,display_name,profile_url) VALUES($1,$2,$3,$4,$5) RETURNING *', [x.s.entity_type, x.s.platform, x.s.native_id || x.s.profile_url, x.s.display_name, x.s.profile_url])).rows[0];
            if (subject.entity_type !== x.s.entity_type)
                fail(409, 'entity_conflict');
            let leadId = subject.lead_id, leadJobId = null;
            if (['person', 'account'].includes(subject.entity_type)) {
                if (!leadId) {
                    const lead = await new ConfiguredEntities(this.identity).write(a, 'lead', null, { definitionVersion: x.def.ref.version, definitionRevision: x.def.aclRevision, customFields:b.customFields||{}, name: x.s.display_name, org: '待核实', direction: review.directions.map(d => d.label).join('、'), contact: '', source: '其他', line: 'social', ownerId: x.task.owner_id });
                    leadId = lead.id;
                    await c.query('UPDATE discovery_subjects SET lead_id=$2,version=version+1 WHERE id=$1', [subject.id, leadId]);
                }
                else {
                    const lead = found((await c.query('SELECT owner_id FROM leads WHERE id=$1 AND deleted_at IS NULL', [leadId])).rows[0]);
                    if (lead.owner_id !== a.id && !a.roles.some(r => ['admin', 'manager'].includes(r)))
                        fail(403, 'target_lead_forbidden');
                }
                leadJobId = (await c.query('INSERT INTO discovery_lead_jobs(lead_id,job_id,owner_id) VALUES($1,$2,$3) ON CONFLICT(lead_id,job_id) DO UPDATE SET lead_id=excluded.lead_id RETURNING id', [leadId, x.task.job_id, x.task.owner_id])).rows[0].id;
            }
            const published: any = { displayName: x.s.display_name, directions: review.directions, contactTypes: review.contacts.map(c => c.type), profileUrl: x.s.profile_url, entityType: x.s.entity_type };
            if (review.publishFields.includes('evidence'))
                published.evidence = x.s.data.evidence.filter((e: any) => review.directions.some(d => d.evidenceIds.includes(e.id)));
            const pub = (await c.query('INSERT INTO discovery_publications(subject_id,source_id,review_id,published,actor_id) VALUES($1,$2,$3,$4,$5) RETURNING id', [subject.id, id, x.r.id, published, a.id])).rows[0];
            for (const contact of review.contacts) {
                const until = new Date(Math.min(Date.parse(contact.validUntil || '9999-01-01'), Date.parse(contact.observedAt) + 30 * 86400000));
                await c.query('INSERT INTO discovery_contacts(subject_id,publication_id,data,availability,verified_at,valid_until,verified_by) VALUES($1,$2,$3,$4,$5,$6,$7)', [subject.id, pub.id, contact, contactValid(contact) ? (contact.type === 'platform_dm' ? 'entry_observed' : 'value_obtained') : 'needs_recheck', contact.observedAt, until, a.id]);
            }
            await c.query("UPDATE discovery_sources SET status='published',version=version+1 WHERE id=$1", [id]);
            await c.query('INSERT INTO discovery_outbox(kind,aggregate_id,data) VALUES($1,$2,$3)', ['sourcing.published', subject.id, { leadId, leadJobId, publicationId: pub.id }]);
            await this.identity.audit(c, a.id, 'discovery.publish', id, { subjectId: subject.id });
            return { subjectId: subject.id, leadId, leadJobId, version: b.version + 1 };
        });
    }
    async provenance(a: Actor, leadId: string) { await this.policy.fields(a); const items = (await this.db.query('SELECT p.id,p.published,p.created_at,s.id subject_id,s.do_not_contact,s.version FROM discovery_publications p JOIN discovery_subjects s ON s.id=p.subject_id WHERE s.lead_id=$1 AND p.withdrawn_at IS NULL ORDER BY p.created_at', [leadId])).rows; for (const row of items)
        delete row.published.evidence; return { items }; }
    async disposition(a: Actor, id: string, input: unknown) { const b = parse(z.object({ version, decision: z.enum(['defer', 'reject']), reason: z.string().trim().min(1).max(2000) }).strict(), input); return this.db.tx(async (c) => { await c.query('SELECT id FROM discovery_sources WHERE id=$1 FOR UPDATE', [id]); const s = await this.policy.source(a, id, true); if (s.version !== b.version || s.status === 'published')
        fail(409, 'version_conflict'); await c.query('UPDATE discovery_sources SET status=$2,version=version+1 WHERE id=$1', [id, b.decision === 'defer' ? 'deferred' : 'rejected']); await this.identity.audit(c, a.id, 'discovery.' + b.decision, id, { reason: b.reason }); return { id, version: b.version + 1 }; }); }
}
