import { createHash } from 'node:crypto';
import path from 'node:path';
import { sourceFieldAccess, matchingReadAccess } from '../business-config/bindings.js';
import { decodeRaw } from '../parsing/profile.js';
import { explicitInboxDecision, isGenericIntent, INBOX_MATCH_VERSION, MODEL_JOB_FIELDS } from '../parsing/job-match.js';
import { fail } from '../http/errors.js';
import { candidateLifecycleSql } from './lifecycle.js';
import { MailboxArchive } from '../mailbox/archive.js';
const stable = (value) => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
const hash = (value) => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const professionalFields = ['skills', 'summary', 'companies', 'experienceYears', 'firstEmployment', 'major'];
function professionalProfile(profile) { return Object.fromEntries(professionalFields.filter(k => profile?.[k] !== undefined && profile[k] !== null && profile[k] !== '' && (!Array.isArray(profile[k]) || profile[k].length)).map(k => [k, profile[k]])); }
function corrections(row) { return Array.isArray(row.human_corrections) ? row.human_corrections.filter((item) => item.actorId && item.source !== 'legacy_import') : []; }
export function professionalConstraints(row) { return { currentProfile: professionalProfile(row.profile), resumeProfile: professionalProfile(row.parsed_profile), corrections: corrections(row).filter(item => professionalFields.includes(item.field)).map(({ field, value, at }) => ({ field, value, at })) }; }
export function inboxJobsHash(jobs) { return hash(jobs.map(j => ({ id: j.id, name: j.name, version: j.version, requirementsVersion: j.requirements_version, department: j.department, requirements: j.requirements })).sort((a, b) => a.id.localeCompare(b.id))); }
export function inboxInputHash(row, jobs) { return hash({ algorithm: INBOX_MATCH_VERSION, candidateId: row.id, candidateVersion: row.version, profile: row.profile, resumeVersionId: row.resume_version_id, parseResultId: row.parse_result_id, professionalConstraints: professionalConstraints(row), intentCorrections: corrections(row).filter(item => item.field === 'intent'), body: row.body, subject: row.subject, mailboxId: row.mailbox_id, messageKey: row.message_key, jobsHash: inboxJobsHash(jobs) }); }
export async function inboxJobs(sql) { return (await sql.query('SELECT j.*,v.requirements FROM jobs j JOIN job_versions v ON v.job_id=j.id AND v.version=j.requirements_version WHERE j.open ORDER BY j.id')).rows; }
export async function inboxRows(sql, ids, limit = 300, staleJobsHash) {
    return (await sql.query(`SELECT c.id,c.version,c.profile,c.created_at,r.id resume_version_id,r.parse_result_id,r.configuration_refs->'inboxMatch' inbox_match,
   p.raw_bytes,p.profile parsed_profile,p.evidence,p.parser_version,p.human_corrections,p.created_at parse_created_at,
   coalesce(t.payload->>'mailBody',t.payload->>'initialDescription','') body,coalesce(t.payload->>'mailSubject','') subject,
   t.payload->>'mailboxId' mailbox_id,t.payload->>'mailMessageKey' message_key,t.payload ? 'mailBody' body_complete,
   (NOT EXISTS(SELECT 1 FROM resume_versions ir JOIN tasks it ON it.id=ir.origin_task_id WHERE ir.candidate_id=c.id AND it.payload->>'newCandidatesOnly'='true')
     OR EXISTS(SELECT 1 FROM candidate_profile_versions h JOIN candidate_profile_versions prev ON prev.candidate_id=h.candidate_id AND prev.version=h.version-1
       WHERE h.candidate_id=c.id AND h.actor_id IS NOT NULL AND h.profile->>'intent'=c.profile->>'intent' AND h.profile->>'intent' IS DISTINCT FROM prev.profile->>'intent')) intent_confirmed,
   (SELECT max(h.at) FROM candidate_profile_versions h JOIN candidate_profile_versions prev ON prev.candidate_id=h.candidate_id AND prev.version=h.version-1
      WHERE h.candidate_id=c.id AND h.actor_id IS NOT NULL AND h.profile->>'intent'=c.profile->>'intent' AND h.profile->>'intent' IS DISTINCT FROM prev.profile->>'intent') intent_confirmed_at
  FROM candidates c
  JOIN LATERAL (SELECT * FROM resume_versions WHERE candidate_id=c.id ORDER BY created_at DESC,id DESC LIMIT 1) r ON true
  JOIN parse_results p ON p.id=r.parse_result_id LEFT JOIN tasks t ON t.id=coalesce(r.origin_task_id,
    (SELECT ir.origin_task_id FROM resume_versions ir JOIN parse_results ip ON ip.id=ir.parse_result_id WHERE ir.candidate_id=c.id AND ip.document_id=p.document_id AND ir.origin_task_id IS NOT NULL ORDER BY ir.created_at DESC,ir.id DESC LIMIT 1))
  WHERE c.deleted_at IS NULL AND (${candidateLifecycleSql})='inbox'
   AND ($1::uuid[] IS NULL OR c.id=ANY($1::uuid[]))
   AND ($3::text IS NULL OR r.configuration_refs->'inboxMatch' IS NULL
     OR coalesce(r.configuration_refs->'inboxMatch'->>'algorithm','')<>$4
     OR coalesce(r.configuration_refs->'inboxMatch'->>'jobsHash','')<>$3
     OR coalesce(r.configuration_refs->'inboxMatch'->>'candidateVersion','')<>c.version::text
     OR coalesce(r.configuration_refs->'inboxMatch'->>'parseResultId','')<>r.parse_result_id::text
     OR coalesce(r.configuration_refs->'inboxMatch'->>'resumeVersionId','')<>r.id::text)
  ORDER BY c.created_at DESC,c.id LIMIT $2`, [ids || null, limit, staleJobsHash || null, INBOX_MATCH_VERSION])).rows;
}
export function inboxSource(row) {
    let intent = isGenericIntent(String(row.profile?.intent || '')) ? '' : String(row.profile.intent), intentConfirmed = row.intent_confirmed === true && !!(intent || row.intent_confirmed_at);
    const corrected = corrections(row).filter(item => item.field === 'intent').sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    if (corrected && (!intentConfirmed || Date.parse(corrected.at) > new Date(row.intent_confirmed_at || row.created_at || 0).getTime())) {
        intent = isGenericIntent(String(corrected.value || '')) ? '' : String(corrected.value);
        intentConfirmed = true;
    }
    return { intent, body: row.body || '', resume: decodeRaw(row.raw_bytes), intentConfirmed, professionalConstraints: professionalConstraints(row) };
}
export async function fullInboxSource(id, row) {
    const source = inboxSource(row);
    // Older imports retained only the first 4,000 body characters. Read the immutable
    // archived message only in the worker; list queries never perform N file reads.
    if (!row.body_complete && row.mailbox_id && row.message_key) {
        try {
            source.body = (await new MailboxArchive(path.join(path.dirname(id.config.storageRoot), 'mailboxes')).message(row.mailbox_id, row.message_key)).body;
        }
        catch {
            if (source.body.length >= 4000)
                throw Error('inbox_source_unavailable');
        }
    }
    return source;
}
export function currentInboxDecision(row, jobs) {
    const inputHash = inboxInputHash(row, jobs), saved = row.inbox_match;
    if (saved?.algorithm === INBOX_MATCH_VERSION && saved.inputHash === inputHash)
        return { ...saved.decision, inputHash, generatedAt: saved.generatedAt };
    // Exact, declared intent is deterministic and can be read without waiting for AI.
    const direct = !row.body_complete && row.mailbox_id ? null : explicitInboxDecision(inboxSource(row), jobs);
    return { ...(direct || { kind: 'pending', jobId: null, reason: 'matching_pending', evidence: [] }), inputHash };
}
export async function projectInboxDecision(id, actor, row, jobs, sql = id.db.sql, cache = new Map()) {
    const result = currentInboxDecision(row, jobs), resume = { id: row.resume_version_id, profile: row.parsed_profile }, fields = await sourceFieldAccess(id, actor, { kind: 'resume', id: resume.id }, row.profile, sql);
    const pending = { kind: 'pending', jobId: null, reason: 'pending', label: '岗位待确认', intent: fields.keys.has('intent') ? inboxSource(row).intent : '' };
    if (!fields.keys.has('intent'))
        return pending;
    if (result.kind === 'pending')
        return { ...pending, reason: result.reason };
    const job = jobs.find(j => j.id === result.jobId);
    if (!job)
        return pending;
    const jobFields = await sourceFieldAccess(id, actor, { kind: 'job', id: job.id }, job, sql);
    if (!jobFields.keys.has('name') || !(await matchingReadAccess(id, actor, job, resume, sql, cache)).allowed)
        return pending;
    // A model considered full source material. A later partial-field grant cannot reveal
    // an inference about hidden content, even if the stored result has no raw quote.
    if (result.model && (!fields.full || !MODEL_JOB_FIELDS.every(key => jobFields.keys.has(key))))
        return pending;
    return { kind: result.kind, jobId: job.id, jobName: job.name, label: result.kind === 'recommended' ? 'AI推荐' : '明确意向', intent: pending.intent, reason: result.reason, inputHash: result.inputHash, resumeVersionId: resume.id, generatedAt: result.generatedAt,
        evidence: fields.full && MODEL_JOB_FIELDS.every(key => jobFields.keys.has(key)) ? result.evidence : [], matchBasis: result.kind === 'recommended' ? 'AI依据来信与简历中的专业经历推荐' : '明确求职意向匹配在招岗位' };
}
export async function inboxMatchesFor(id, actor, ids, sql = id.db.sql) {
    const result = new Map();
    if (!ids.length)
        return result;
    const jobs = await inboxJobs(sql), rows = await inboxRows(sql, ids, ids.length), cache = new Map();
    for (const row of rows)
        result.set(row.id, await projectInboxDecision(id, actor, row, jobs, sql, cache));
    return result;
}
// Invoked by the existing minute worker refresh, never by a page read. Bounded queue
// batches and the advisory gate deduplicate workers; a failed fingerprint is terminal.
export async function enqueueInboxMatches(id, options = {}) {
    return id.db.tx(async (sql) => {
        await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['inbox-matching:' + id.db.config.schema]);
        const writer = options.actorId ? { id: options.actorId } : (await sql.query("SELECT id FROM users WHERE status='active' AND directory_active AND roles&&ARRAY['admin','manager','recruiter']::text[] ORDER BY created_at,id LIMIT 1")).rows[0];
        if (!writer)
            return 0;
        const jobs = await inboxJobs(sql), rows = await inboxRows(sql, options.candidateIds, 300, inboxJobsHash(jobs));
        let queued = 0;
        for (const row of rows) {
            const inputHash = inboxInputHash(row, jobs);
            if ((await sql.query("SELECT 1 FROM tasks WHERE kind='recompute' AND payload->>'purpose'='inbox_match' AND payload->>'candidateId'=$1 AND (payload->>'inputHash'=$2 OR state IN ('queued','running')) LIMIT 1", [row.id, inputHash])).rowCount)
                continue;
            await sql.query("INSERT INTO tasks(kind,payload,actor_id) VALUES('recompute',$1,$2)", [{ purpose: 'inbox_match', candidateId: row.id, inputHash }, writer.id]);
            if (++queued >= Math.min(options.limit || 25, 100))
                break;
        }
        return queued;
    });
}
export async function saveInboxDecision(sql, row, jobs, decision) {
    const saved = { algorithm: INBOX_MATCH_VERSION, inputHash: inboxInputHash(row, jobs), jobsHash: inboxJobsHash(jobs), candidateVersion: row.version, resumeVersionId: row.resume_version_id, parseResultId: row.parse_result_id, decision, generatedAt: new Date().toISOString() };
    await sql.query("UPDATE resume_versions SET configuration_refs=jsonb_set(configuration_refs,'{inboxMatch}',$2::jsonb,true) WHERE id=$1", [row.resume_version_id, saved]);
    return saved;
}
export async function assertInboxAdoption(id, actor, sql, input) {
    if (!input.inboxMatchHash)
        return;
    const rows = await inboxRows(sql, [input.candidateId], 1), jobs = await inboxJobs(sql), row = rows[0];
    if (!row)
        fail(409, 'inbox_match_stale');
    const result = await projectInboxDecision(id, actor, row, jobs, sql);
    if (result.kind === 'pending' || !('inputHash' in result) || result.inputHash !== input.inboxMatchHash || result.jobId !== input.jobId || row.resume_version_id !== input.resumeVersionId)
        fail(409, 'inbox_match_stale');
}
//# sourceMappingURL=inbox-matching.js.map