import { createHash } from 'node:crypto';
import { requireRole } from '../identity/service.js';
import { fail } from '../http/errors.js';
import { isGenericIntent } from '../parsing/job-match.js';
import { inboxRows, inboxJobs, inboxInputHash, enqueueInboxMatches } from './inbox-matching.js';
export async function previewInboxMaintenance(id, scope) {
    const jobs = await inboxJobs(id.db.sql), rows = await inboxRows(id.db.sql, scope.candidateIds, 300), items = [];
    for (const row of rows) {
        let repair = null;
        if (scope.repairGenericIntent && row.profile.intent && isGenericIntent(row.profile.intent)) {
            const origin = (await id.db.query(`SELECT t.id,p.id parse_result_id,p.profile parsed_profile,t.payload
    FROM resume_versions r JOIN tasks t ON t.id=r.origin_task_id JOIN parse_results p ON p.id=r.parse_result_id
    WHERE r.candidate_id=$1 AND t.kind='ingest' AND t.payload->>'newCandidatesOnly'='true' AND t.payload ? 'mailboxId'
    ORDER BY r.created_at,r.id LIMIT 1`, [row.id])).rows[0];
            const history = (await id.db.query('SELECT version,profile FROM candidate_profile_versions WHERE candidate_id=$1 ORDER BY version', [row.id])).rows;
            // An unchanged generic value in every profile revision distinguishes the original
            // import defect from any later intentional human edit (including edit-and-revert).
            if (origin && origin.payload.initialPosition === row.profile.intent && !String(origin.parsed_profile.intent || '').trim()
                && history.length === row.version && history[0]?.version === 1 && history.every(h => h.profile.intent === row.profile.intent))
                repair = { from: row.profile.intent, to: '', originTaskId: origin.id, parseResultId: origin.parse_result_id };
        }
        items.push({ candidateId: row.id, candidateVersion: row.version, resumeVersionId: row.resume_version_id, inputHash: inboxInputHash(row, jobs), repair });
    }
    const plan = { scope: { candidateIds: scope.candidateIds ? [...scope.candidateIds].sort() : null, repairGenericIntent: scope.repairGenericIntent, forceRecompute: scope.forceRecompute }, items };
    return { ...plan, previewHash: createHash('sha256').update(JSON.stringify(plan)).digest('hex') };
}
export async function applyInboxMaintenance(id, actor, scope, previewHash) {
    requireRole(actor, 'admin', 'manager', 'recruiter');
    return id.db.tx(async (sql) => {
        const initial = await previewInboxMaintenance(id, scope);
        await sql.query('SELECT id FROM candidates WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [initial.items.map(r => r.candidateId)]);
        await sql.query('SELECT id FROM jobs WHERE open ORDER BY id FOR SHARE');
        const plan = await previewInboxMaintenance(id, scope);
        if (plan.previewHash !== previewHash)
            fail(409, 'inbox_maintenance_preview_stale');
        let repaired = 0;
        for (const item of plan.items) {
            if (!item.repair)
                continue;
            const person = (await sql.query("UPDATE candidates SET profile=jsonb_set(profile,'{intent}','\"\"'::jsonb),version=version+1,updated_at=now() WHERE id=$1 AND version=$2 AND profile->>'intent'=$3 RETURNING *", [item.candidateId, item.candidateVersion, item.repair.from])).rows[0];
            if (!person)
                fail(409, 'inbox_maintenance_preview_stale');
            await id.profileVersion(sql, actor.id, person);
            await id.audit(sql, actor.id, 'inbox.intent.repair', person.id, { ...item.repair, previewHash });
            repaired++;
        }
        let queued = 0;
        if (scope.forceRecompute) {
            const jobs = await inboxJobs(sql), rows = await inboxRows(sql, plan.items.map(r => r.candidateId), 300);
            for (const row of rows) {
                if ((await sql.query("SELECT 1 FROM tasks WHERE kind='recompute' AND payload->>'purpose'='inbox_match' AND payload->>'candidateId'=$1 AND state IN ('queued','running')", [row.id])).rowCount)
                    continue;
                await sql.query("UPDATE resume_versions SET configuration_refs=configuration_refs-'inboxMatch' WHERE id=$1", [row.resume_version_id]);
                await sql.query("INSERT INTO tasks(kind,payload,actor_id) VALUES('recompute',$1,$2)", [{ purpose: 'inbox_match', candidateId: row.id, inputHash: inboxInputHash(row, jobs) }, actor.id]);
                queued++;
            }
        }
        else
            queued = await enqueueInboxMatches(id, { candidateIds: plan.items.map(r => r.candidateId), actorId: actor.id, limit: 100 });
        await id.audit(sql, actor.id, 'inbox.matching.maintenance', null, { previewHash, candidateIds: plan.items.map(r => r.candidateId), repaired, queued, forceRecompute: scope.forceRecompute });
        return { repaired, queued };
    });
}
//# sourceMappingURL=inbox-maintenance.js.map