import { matchInboxContent } from '../parsing/job-match.js';
import { requestResumeJson } from '../parsing/resume-model.js';
import { enqueueInboxMatches, inboxRows, inboxJobs, inboxInputHash, fullInboxSource, saveInboxDecision } from '../recruiting/inbox-matching.js';
import { extractFile } from "../files/extract.js";
import { parseProfile, encodeRaw, decodeRaw } from "../parsing/profile.js";
import { parseFullResume as parseResumeProfile } from '../parsing/full-resume.js';
import { isClearlyNonResume } from '../parsing/document.js';
import { recognizeDocument } from '../parsing/recognition.js';
import { Dictionary } from "../dictionary/service.js";
import { TaskService } from "./service.js";
import { fail, found } from "../http/errors.js";
import { encodeJSON } from "../parsing/json.js";
import { captureMatchInputs, loadMatchingTemplate, loadDictionarySnapshot, matchInputCurrent, matchInputsSchema, currentMatchSql, queueMatch, pinnedParsed, PINNED_COMPAT_ALGORITHM } from '../business-config/bindings.js';
import { compareConfiguredProfile } from '../business-config/match-template.js';
export class Worker {
    identity;
    store;
    workerId;
    onProcessingError;
    inboxModel;
    db;
    tasks;
    constructor(identity, store, workerId, onProcessingError, inboxModel = requestResumeJson) {
        this.identity = identity;
        this.store = store;
        this.workerId = workerId;
        this.onProcessingError = onProcessingError;
        this.inboxModel = inboxModel;
        this.db = identity.db;
        this.tasks = new TaskService(identity, store);
    }
    async claim() {
        return this.db.tx(async (c) => {
            await c.query("UPDATE tasks SET state='failed',error_code='retry_limit',updated_at=now() WHERE state='running' AND lease_until<now() AND attempts>=3");
            const task = (await c.query("SELECT * FROM tasks WHERE state='queued' OR (state='running' AND lease_until<now() AND attempts<3) ORDER BY CASE WHEN payload->>'purpose'='inbox_match' THEN 1 ELSE 0 END,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0];
            if (!task)
                return null;
            return (await c.query("UPDATE tasks SET state='running',attempts=attempts+1,claim_token=claim_token+1,worker_id=$2,lease_until=now()+interval '30 seconds',updated_at=now() WHERE id=$1 RETURNING *", [task.id, this.workerId])).rows[0];
        });
    }
    async heartbeat(task) {
        return !!(await this.db.query("UPDATE tasks SET lease_until=now()+interval '30 seconds' WHERE id=$1 AND claim_token=$2 AND worker_id=$3 AND state='running' AND lease_until>now()", [task.id, task.claim_token, this.workerId])).rowCount;
    }
    async valid(c, task) {
        const row = (await c.query("SELECT * FROM tasks WHERE id=$1 AND claim_token=$2 AND worker_id=$3 AND state='running' AND lease_until>clock_timestamp() FOR UPDATE", [task.id, task.claim_token, this.workerId])).rows[0];
        if (!row)
            return null;
        const user = (await c.query("SELECT * FROM users WHERE id=$1 FOR SHARE", [
            task.actor_id,
        ])).rows[0];
        if (!user ||
            user.status !== "active" ||
            !user.directory_active ||
            !user.roles.some((r) => ["admin", "manager", "recruiter"].includes(r)))
            fail(403, "membership_changed");
        return row;
    }
    async actor(task) {
        const a = found((await this.db.query("SELECT * FROM users WHERE id=$1 AND status='active' AND directory_active", [task.actor_id])).rows[0]);
        if (!a.roles.some((r) => ["admin", "manager", "recruiter"].includes(r)))
            fail(403, "membership_changed");
        return { ...a, csrf: "" };
    }
    async once() {
        const task = await this.claim();
        if (!task)
            return false;
        const timer = setInterval(() => this.heartbeat(task).catch(() => { }), 10000);
        try {
            await this.process(task);
        }
        finally {
            clearInterval(timer);
        }
        return true;
    }
    async process(task) {
        try {
            const a = await this.actor(task);
            if (task.kind === 'recompute' && task.payload.purpose === 'inbox_match') {
                const rows = await inboxRows(this.db.sql, [task.payload.candidateId], 1), jobs = await inboxJobs(this.db.sql), row = rows[0];
                // Never keep a transaction or row lock across a model request.
                let decision = null;
                if (row && inboxInputHash(row, jobs) === task.payload.inputHash) {
                    try {
                        decision = await matchInboxContent(this.identity.config, await fullInboxSource(this.identity, row), jobs, this.inboxModel);
                    }
                    catch {
                        decision = { kind: 'pending', jobId: null, reason: 'source_unavailable', evidence: [] };
                    }
                }
                return await this.db.tx(async (c) => {
                    if (!(await this.valid(c, task)))
                        return false;
                    const current = (await inboxRows(c, [task.payload.candidateId], 1))[0], currentJobs = await inboxJobs(c);
                    const fresh = !!(decision && current && inboxInputHash(current, currentJobs) === task.payload.inputHash);
                    if (fresh)
                        await saveInboxDecision(c, current, currentJobs, decision);
                    await c.query("UPDATE tasks SET state='succeeded',result=$2,lease_until=NULL,updated_at=now() WHERE id=$1", [task.id, { candidateId: task.payload.candidateId, matched: fresh && decision?.kind !== 'pending', stale: !fresh }]);
                    return true;
                });
            }
            if (task.kind === "recompute")
                return await this.db.tx(async (c) => {
                    if (!(await this.valid(c, task)))
                        return false;
                    const fixed = matchInputsSchema.safeParse(task.payload);
                    if (!fixed.success)
                        fail(409, 'legacy_unpinned_task');
                    const result = await this.recompute(c, task.payload.applicationId, fixed.data);
                    await c.query("UPDATE tasks SET state='succeeded',result=$3,lease_until=NULL,updated_at=now() WHERE id=$1 AND claim_token=$2", [task.id, task.claim_token, result]);
                    return true;
                });
            const doc = found((await this.db.query("SELECT * FROM resume_documents WHERE id=$1", [
                task.payload.documentId,
            ])).rows[0]);
            await this.store.read(doc.blob_key);
            const recognition = this.identity.config.recognitionConfigFile ? await recognizeDocument(this.identity.config, task.payload.rawBase64 ? { text: decodeRaw(Buffer.from(task.payload.rawBase64, 'base64')) } : { file: this.store.path(doc.blob_key), kind: doc.kind, sha256: doc.sha256 }) : null;
            const raw = recognition ? recognition.raw : task.payload.rawBase64
                ? decodeRaw(Buffer.from(task.payload.rawBase64, "base64"))
                : await extractFile(this.store.path(doc.blob_key), doc.kind);
            if (recognition?.documentType === 'other' || (!recognition && task.payload.newCandidatesOnly && isClearlyNonResume(doc.file_name, raw)))
                return await this.db.tx(async (c) => {
                    if (!(await this.valid(c, task)))
                        return false;
                    await c.query("UPDATE tasks SET state='succeeded',result=$2,lease_until=NULL,updated_at=now() WHERE id=$1", [task.id, { skippedNonResume: true, reason: 'not_a_resume' }]);
                    await this.identity.audit(c, a.id, 'resume.not_resume', doc.id, { taskId: task.id, source: recognition ? 'model_classification' : 'document_title' });
                    return true;
                });
            const aliases = (await new Dictionary(this.db).list()).map((x) => ({
                name: x.name,
                aliases: x.aliases,
            })), parsed = recognition || (raw.trim() ? await parseResumeProfile(this.identity.config, raw, aliases) : { ...parseProfile(raw, aliases), provenance: { method: 'rules', tokens: 0, elapsedMs: 0 } });
            return await this.db.tx(async (c) => {
                // All discovery/finalization transactions share this short SQL gate.
                // Human duplicate choices still control whether any records are merged.
                await c.query("SELECT pg_advisory_xact_lock(hashtextextended('ingest-duplicate-discovery',0))");
                if (!(await this.valid(c, task)))
                    return false;
                if (!raw.trim() || recognition?.documentType === 'unknown') {
                    await c.query("UPDATE tasks SET state='needs_text',error_code='text_required',lease_until=NULL,updated_at=now() WHERE id=$1", [task.id]);
                    return true;
                }
                const result = (await c.query("INSERT INTO parse_results(document_id,raw_bytes,profile,evidence,parser_version,recognition) VALUES($1,$2,$3,$4,$5,$6) RETURNING id", [
                    doc.id,
                    encodeRaw(raw),
                    parsed.profile,
                    encodeJSON(parsed.evidence),
                    parsed.parserVersion,
                    recognition?.recognition || null,
                ])).rows[0];
                await this.identity.audit(c, a.id, 'resume.parse', result.id, { taskId: task.id, parserVersion: parsed.parserVersion, ...parsed.provenance });
                const candidates = (await c.query("SELECT c.id,c.version,c.profile,CASE WHEN $2 THEN (SELECT coalesce(jsonb_agg(h.profile),'[]'::jsonb) FROM (SELECT profile FROM candidate_profile_versions WHERE candidate_id=c.id UNION ALL SELECT p.profile FROM resume_versions r JOIN parse_results p ON p.id=r.parse_result_id WHERE r.candidate_id=c.id) h) ELSE '[]'::jsonb END known_profiles,EXISTS(SELECT 1 FROM resume_versions v JOIN parse_results p ON p.id=v.parse_result_id JOIN resume_documents d ON d.id=p.document_id WHERE v.candidate_id=c.id AND d.sha256=$1) same_file FROM candidates c WHERE $2 OR c.deleted_at IS NULL", [doc.sha256, task.payload.newCandidatesOnly === true])).rows;
                const duplicates = candidates.flatMap((c) => {
                    const p = c.profile, known = [p, ...c.known_profiles], phone = (s) => { const n = s.replace(/\D/g, ""); return /^(?:0086|86)1\d{10}$/.test(n) ? n.slice(-11) : n; }, email = (s) => s.trim().toLowerCase();
                    const sameContact = known.some(p => (parsed.profile.phone &&
                        phone(p.phone || "") === phone(parsed.profile.phone)) ||
                        (parsed.profile.email &&
                            email(p.email || "") === email(parsed.profile.email)));
                    const sameName = parsed.profile.name !== "待确认" && known.some(p => p.name === parsed.profile.name);
                    const confidence = c.same_file || sameContact
                        ? "high"
                        : sameName && p.school && p.school === parsed.profile.school
                            ? "medium"
                            : sameName
                                ? "low"
                                : null;
                    return confidence
                        ? [
                            {
                                candidateId: c.id,
                                candidateVersion: c.version,
                                name: p.name,
                                confidence,
                                reason: c.same_file
                                    ? "same_file"
                                    : sameContact
                                        ? "same_contact"
                                        : sameName
                                            ? "same_name"
                                            : "similar",
                            },
                        ]
                        : [];
                });
                if (duplicates.length) {
                    if (task.payload.newCandidatesOnly && duplicates.some(d => d.confidence === 'high')) {
                        await c.query("UPDATE tasks SET state='succeeded',result=$2,lease_until=NULL,updated_at=now() WHERE id=$1", [task.id, { skippedExisting: true, reason: 'existing_person', parseResultId: result.id }]);
                        return true;
                    }
                    await c.query("UPDATE tasks SET state='awaiting_duplicate_decision',result=$2,lease_until=NULL,updated_at=now() WHERE id=$1", [task.id, { parseResultId: result.id, duplicates }]);
                    return true;
                }
                const finalized = await this.tasks.finalize(c, a, task, result.id);
                if (finalized.applicationId)
                    await this.recompute(c, finalized.applicationId);
                await c.query("UPDATE tasks SET state='succeeded',result=$2,lease_until=NULL,updated_at=now() WHERE id=$1", [task.id, finalized]);
                return true;
            });
        }
        catch (e) {
            try {
                this.onProcessingError?.(e);
            }
            catch { }
            await this.db.query("UPDATE tasks SET state='failed',error_code=$4,lease_until=NULL,updated_at=now() WHERE id=$1 AND claim_token=$2 AND worker_id=$3 AND state='running' AND lease_until>now()", [
                task.id,
                task.claim_token,
                this.workerId,
                e?.code === "job_closed"
                    ? "job_closed"
                    : /^resume_(?:model_(?:unavailable|timeout|response_invalid|config_invalid|input_too_large|not_configured)|recognition_(?:timeout|failed|invalid|not_configured))$/.test(e?.message || '') ? e.message
                        : "processing_failed",
            ]);
            return false;
        }
    }
    async recompute(c, applicationId, fixed) {
        const input = fixed || await captureMatchInputs(this.identity, c, applicationId);
        if (!input)
            return { skipped: true };
        if (input.applicationId !== applicationId || input.dictionaryVersion !== input.dictionaryRef.version)
            fail(422, 'matching_inputs_invalid');
        const row = (await c.query("SELECT a.job_id,a.candidate_id,r.id resume_version_id,v.requirements,p.id parse_result_id,p.raw_bytes,p.profile,p.evidence,p.parser_version,p.human_corrections,p.created_at parse_created_at FROM applications a JOIN resume_versions r ON r.id=$2 AND r.candidate_id=a.candidate_id JOIN parse_results p ON p.id=r.parse_result_id JOIN job_versions v ON v.job_id=a.job_id AND v.version=$3 WHERE a.id=$1 AND a.deleted_at IS NULL", [applicationId, input.resumeVersionId, input.jobVersion])).rows[0];
        if (!row)
            return { skipped: true, stale: true };
        const template = await loadMatchingTemplate(this.identity, input.templateRef, c), dictionary = await loadDictionarySnapshot(this.identity, input.dictionaryRef, c), raw = decodeRaw(row.raw_bytes), parsed = pinnedParsed(row, raw, dictionary), compared = compareConfiguredProfile(parsed, raw, row.requirements, template, dictionary);
        const expected = template.mode === 'prd_compat' ? PINNED_COMPAT_ALGORITHM : compared.algorithmVersion;
        if (expected !== input.algorithmVersion)
            fail(409, 'matching_algorithm_unavailable');
        const data = { ...compared, formulaAlgorithmVersion: compared.algorithmVersion, algorithmVersion: input.algorithmVersion, parseResultId: row.parse_result_id, inputs: input };
        const snapshot = (await c.query("INSERT INTO match_snapshots(application_id,job_version,resume_version_id,algorithm_version,dictionary_version,data,reference_score) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(application_id,job_version,resume_version_id,algorithm_version,dictionary_version) DO UPDATE SET application_id=EXCLUDED.application_id RETURNING id", [applicationId, input.jobVersion, input.resumeVersionId, input.algorithmVersion, input.dictionaryVersion, encodeJSON(data), { ...data.score, inputs: input }])).rows[0];
        return { snapshotId: snapshot.id, stale: !await matchInputCurrent(this.identity, c, input) };
    }
    async enqueueStaleMatches() {
        const count = await this.db.tx(async (c) => {
            await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['matching:' + this.db.config.schema]);
            const writer = (await c.query("SELECT id FROM users WHERE status='active' AND directory_active AND roles&&ARRAY['admin','manager','recruiter']::text[] ORDER BY created_at,id LIMIT 1")).rows[0];
            if (!writer)
                return 0;
            const rows = (await c.query(`SELECT a.id FROM applications a JOIN jobs j ON j.id=a.job_id JOIN candidates p ON p.id=a.candidate_id WHERE a.is_current AND a.deleted_at IS NULL AND p.deleted_at IS NULL AND a.resume_version_id IS NOT NULL AND coalesce(a.configuration_refs->'matchingHold'->>'jobVersion','')<>j.requirements_version::text AND NOT EXISTS(SELECT 1 FROM match_snapshots m WHERE ${currentMatchSql('m', 'a', 'j')}) AND NOT EXISTS(SELECT 1 FROM tasks t WHERE t.kind='recompute' AND t.state IN ('queued','running') AND t.payload->>'applicationId'=a.id::text) ORDER BY a.id`)).rows;
            for (const row of rows)
                await queueMatch(this.identity, c, row.id, writer.id, { automatic: true, reason: 'matching_version_refresh' });
            return rows.length;
        });
        return count + await enqueueInboxMatches(this.identity);
    }
}
//# sourceMappingURL=worker.js.map