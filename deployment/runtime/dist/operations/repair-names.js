import { pathToFileURL } from 'node:url';
import { Identity, requireRole } from '../identity/service.js';
import { assertLegacySource, legacyDefinition } from '../business-config/legacy-fields.js';
import { fieldAllowed } from '../business-config/access.js';
import { fail } from '../http/errors.js';
import { decodeRaw } from '../parsing/profile.js';
import { plausibleName } from '../parsing/name.js';
import { parseResumeProfile } from '../parsing/resume.js';
import { decodeJSON } from '../parsing/json.js';
async function assertNameWriter(identity, actor) {
    const current = (await identity.db.query('SELECT * FROM users WHERE id=$1 AND directory_active FOR SHARE', [actor.id])).rows[0];
    if (!current)
        fail(403, 'forbidden');
    requireRole(current, 'admin', 'manager', 'recruiter');
    await assertLegacySource(identity, current, ['resume']);
    const def = await legacyDefinition(identity, current, 'resume'), name = def.fields.find(f => f.coreKey === 'name');
    if (!name?.active || name.visibleWhen || !fieldAllowed(name, current, 'write'))
        fail(403, 'field_forbidden:' + (name?.fieldId || 'name'));
}
export async function repairCandidateNames(identity, actor, options, resolve = parseResumeProfile) {
    requireRole(actor, 'admin', 'manager', 'recruiter');
    await assertLegacySource(identity, actor, ['resume']);
    if (options.apply)
        await assertNameWriter(identity, actor);
    const db = identity.db, rows = (await db.query(`SELECT c.id,c.version,c.profile,r.id resume_id,p.id parse_id,p.raw_bytes,p.human_corrections,
 (SELECT count(*)::int FROM candidate_profile_versions h WHERE h.candidate_id=c.id) histories,
 EXISTS(SELECT 1 FROM audit_events e WHERE e.entity_id=c.id::text AND e.kind='candidate.edit') edited
 FROM candidates c LEFT JOIN LATERAL(SELECT r.id,r.parse_result_id FROM resume_versions r WHERE r.candidate_id=c.id ORDER BY r.created_at DESC,r.id DESC LIMIT 1) r ON true
 LEFT JOIN parse_results p ON p.id=r.parse_result_id WHERE c.deleted_at IS NULL AND ($1::uuid[] IS NULL OR c.id=ANY($1::uuid[])) ORDER BY c.created_at,c.id`, [options.ids || null])).rows;
    const summary = { scanned: rows.length, eligible: 0, resolved: 0, changed: 0, rules: 0, model: 0, tokens: 0, manualSkipped: 0, concurrentSkipped: 0, unresolved: 0, errors: {} };
    for (const row of rows) {
        if (row.profile.name !== '待确认' && plausibleName(row.profile.name))
            continue;
        if (row.version !== 1 || row.histories !== 1 || row.edited || decodeJSON(row.human_corrections || []).some(x => x.field === 'name')) {
            summary.manualSkipped++;
            continue;
        }
        summary.eligible++;
        if (!row.raw_bytes) {
            summary.unresolved++;
            continue;
        }
        try {
            const parsed = await resolve(identity.config, decodeRaw(row.raw_bytes));
            summary.tokens += parsed.provenance.tokens;
            if (parsed.profile.name === '待确认' || !plausibleName(parsed.profile.name)) {
                summary.unresolved++;
                continue;
            }
            summary.resolved++;
            summary[parsed.provenance.method]++;
            if (!options.apply)
                continue;
            const changed = await db.tx(async (c) => {
                const current = (await c.query('SELECT * FROM candidates WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [row.id])).rows[0];
                if (!current || current.version !== row.version || current.profile.name !== row.profile.name)
                    return false;
                const guard = (await c.query("SELECT (SELECT count(*)::int FROM candidate_profile_versions WHERE candidate_id=$1) histories,EXISTS(SELECT 1 FROM audit_events WHERE entity_id=$1::text AND kind='candidate.edit') edited", [row.id])).rows[0];
                if (guard.histories !== 1 || guard.edited)
                    return false;
                const latest = (await c.query('SELECT r.id,p.id parse_id,p.human_corrections FROM resume_versions r JOIN parse_results p ON p.id=r.parse_result_id WHERE r.candidate_id=$1 ORDER BY r.created_at DESC,r.id DESC LIMIT 1', [row.id])).rows[0];
                if (!latest || latest.id !== row.resume_id || latest.parse_id !== row.parse_id || decodeJSON(latest.human_corrections || []).some(x => x.field === 'name'))
                    return false;
                await assertNameWriter(identity, actor);
                const person = (await c.query("UPDATE candidates SET profile=jsonb_set(profile,'{name}',to_jsonb($2::text)),version=version+1,updated_at=now() WHERE id=$1 RETURNING *", [row.id, parsed.profile.name])).rows[0];
                await identity.profileVersion(c, actor.id, person);
                await identity.audit(c, actor.id, 'candidate.name.repair', row.id, { parseResultId: row.parse_id, fromVersion: row.version, toVersion: person.version, ...parsed.provenance, parserVersion: parsed.parserVersion, evidence: parsed.evidence.filter(e => e.field === 'name').map(({ start, end, line }) => ({ start, end, line })) });
                return true;
            });
            if (changed)
                summary.changed++;
            else
                summary.concurrentSkipped++;
        }
        catch (error) {
            const message = error?.message || '', code = /^resume_model_[a-z_]+$/.test(message) ? message : 'name_repair_failed';
            summary.unresolved++;
            summary.errors[code] = (summary.errors[code] || 0) + 1;
        }
    }
    return summary;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const { loadConfig } = await import('../config.js'), { Database } = await import('../db.js'), { FeishuProvider } = await import('../identity/provider.js');
    const config = loadConfig(), db = new Database(config), actorId = process.argv.find(v => v.startsWith('--actor-id='))?.slice('--actor-id='.length);
    try {
        if (!actorId)
            throw Error('actor_id_required');
        const actor = (await db.query('SELECT * FROM users WHERE id=$1 AND tenant=$2 AND app_id=$3 AND directory_active', [actorId, config.feishu.tenant, config.feishu.appId])).rows[0];
        if (!actor)
            throw Error('actor_not_found');
        const result = await repairCandidateNames(new Identity(db, config, new FeishuProvider(config)), actor, { apply: process.argv.includes('--apply') });
        console.log(JSON.stringify({ event: 'candidate.names.repaired', ...result }));
    }
    catch {
        console.error(JSON.stringify({ event: 'candidate.names.repair_failed' }));
        process.exitCode = 1;
    }
    finally {
        await db.close();
    }
}
//# sourceMappingURL=repair-names.js.map