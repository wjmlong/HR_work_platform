import { z, uuid, version, parse } from '../http/validation.js';
import type { Database } from '../db.js';
const short = z.string().trim().min(1).max(300), stamp = z.iso.datetime({ offset: true });
export const publicUrl = z.string().max(2048).refine(v => { try {
    const u = new URL(v);
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && ![...u.searchParams.keys()].some(k => /token|secret|password|authorization|signature|xsec|cookie|session|code$/i.test(k));
}
catch {
    return false;
} }, 'public URL without credentials required');
export const platforms = z.enum(['douyin', 'xiaohongshu', 'zhihu', 'zhaopin', 'liepin', 'competition', 'research', 'campus', 'other']);
export const limitsInput = z.object({ pagesPerSource: z.number().int().min(1).max(20).default(20), pages: z.number().int().min(1).max(100).default(100), minutes: z.number().int().min(1).max(30).default(30), calls: z.number().int().min(1).max(50).default(50), tokens: z.number().int().min(1000).max(100000).default(100000) }).strict();
export const taskInput = z.object({ name: short, jobId: uuid, ownerId: uuid.optional(), sources: z.array(platforms).min(1).max(9).refine(v => new Set(v).size === v.length), keywords: z.array(short).max(30).default([]), contactRequirement: z.enum(['any', 'direct', 'platform_dm']).default('any'), limits: limitsInput.default({ pagesPerSource: 20, pages: 100, minutes: 30, calls: 50, tokens: 100000 }) }).strict();
export const evidenceInput = z.object({ id: short, text: z.string().trim().min(1).max(10000), sourceUrl: publicUrl, capturedAt: stamp, publishedAt: stamp.optional() }).strict();
export const sourceInput = z.object({ platform: platforms, nativeId: short.optional(), profileUrl: publicUrl, displayName: short, entityType: z.enum(['person', 'account', 'team', 'institution']), accessMethod: z.enum(['public_fetch', 'browser_assisted', 'manual_import', 'authorized_import']), externalModelAllowed: z.boolean().default(false), evidence: z.array(evidenceInput).min(1).max(100) }).strict().refine(v => new Set(v.evidence.map(e => e.id)).size === v.evidence.length, 'unique evidence ids').refine(v => Buffer.byteLength(JSON.stringify(v), 'utf8') <= 100 * 1024, 'source exceeds 100KB');
export const contactInput = z.object({ type: z.enum(['phone', 'email', 'wechat', 'platform_dm', 'platform_virtual_phone', 'other']), value: z.string().trim().min(1).max(500).optional(), entryUrl: publicUrl.optional(), evidenceIds: z.array(short).min(1).max(20), observedAt: stamp, validUntil: stamp.optional(), purpose: short, limitations: z.array(short).max(20).default([]) }).strict().superRefine((v, c) => { if (v.type === 'platform_dm' ? !v.entryUrl : !v.value)
    c.addIssue({ code: 'custom', message: 'contact evidence and value/entry required' }); if (v.type === 'email' && !z.email().safeParse(v.value).success)
    c.addIssue({ code: 'custom', message: 'invalid email' }); if (new Date(v.observedAt).getTime() > Date.now() + 60000)
    c.addIssue({ code: 'custom', message: 'future observation' }); if (v.validUntil && v.validUntil <= v.observedAt)
    c.addIssue({ code: 'custom', message: 'invalid expiry' }); });
export const directionInput = z.object({ label: short, evidenceIds: z.array(short).min(1).max(20) }).strict();
export const reviewInput = z.object({ version, entityConfirmed: z.literal(true), directionConfirmed: z.literal(true), contactConfirmed: z.literal(true), directions: z.array(directionInput).min(1).max(20), contacts: z.array(contactInput).min(1).max(20), publishFields: z.array(z.enum(['displayName', 'directions', 'contacts', 'evidence'])).min(1).max(4) }).strict();
export const pageInput = z.object({ page: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(100).default(25), taskId: uuid.optional(), state: short.optional() }).strict();
export const actionInput = z.object({ version, action: z.enum(['start', 'pause', 'resume', 'cancel', 'close', 'retry']) }).strict();
export const sourcesInput = z.object({ version, items: z.array(sourceInput).min(1).max(20) }).strict();
export const handoffInput = z.object({ leadJobId: uuid, version, previewToken: z.string().min(1).max(2000) }).strict();
export type SourceInput = z.infer<typeof sourceInput>;
export type ReviewInput = z.infer<typeof reviewInput>;
export type ContactInput = z.infer<typeof contactInput>;
export async function ensureLegacyRelations(db: Database) { await db.query("INSERT INTO discovery_lead_jobs(lead_id,owner_id,state) SELECT id,owner_id,state FROM leads WHERE deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM discovery_lead_jobs j WHERE j.lead_id=leads.id) ON CONFLICT DO NOTHING"); }
export { parse, z, uuid, version };
