import { requireRole } from "../identity/service.js";
import { parse, uuid, z } from "../http/validation.js";
import { readJobMatching, loadMatchingTemplate, loadDictionarySnapshot, pinnedParsed, matchingReadAccess, sourceFieldAccess, } from "../business-config/bindings.js";
import { compareConfiguredProfile } from "../business-config/match-template.js";
import { decodeRaw } from "../parsing/profile.js";
import { COMMON_TERMS } from "./common-terms.js";
import { inboxJobs, inboxRows, projectInboxDecision } from './inbox-matching.js';
const previewInput = z
    .object({ threshold: z.number().int().min(0).max(100).default(60) })
    .strict();
const crossInput = z
    .object({
    threshold: z.number().int().min(0).max(100).default(60),
    applicationId: uuid.optional(),
    mode: z.enum(['read', 'export']).default('read'),
})
    .strict();
// 跨岗位匹配：同一份简历在所有在招岗位各算一次分，找出「当前岗位低、别的岗位高」的人。
// 只读，不创建申请、不改状态；模板/字典按岗位缓存，避免逐人重复查库。
async function crossJobAlerts(id, actor, threshold, onlyId, mode = 'read') {
    const sql = id.db.sql;
    if (onlyId)
        await id.applicationAccess(actor, onlyId, false, sql);
    const jobs = (await sql.query("SELECT j.*,v.requirements FROM jobs j JOIN job_versions v ON v.job_id=j.id AND v.version=j.requirements_version WHERE j.open=true ORDER BY j.name,j.id")).rows;
    const apps = (await sql.query(`SELECT a.id,a.job_id,a.resume_version_id,c.profile AS candidate_profile,
       p.raw_bytes,p.profile AS parsed_profile,p.evidence,p.parser_version,
       p.human_corrections,p.created_at AS parse_created_at
     FROM applications a
     JOIN candidates c ON c.id=a.candidate_id
     JOIN resume_versions r ON r.id=a.resume_version_id
     JOIN parse_results p ON p.id=r.parse_result_id
     WHERE a.is_current AND a.deleted_at IS NULL AND a.resume_version_id IS NOT NULL
       AND c.deleted_at IS NULL AND c.archived_at IS NULL
       ${onlyId ? "AND a.id=$1" : ""}
     ORDER BY a.created_at DESC LIMIT 100`, onlyId ? [onlyId] : [])).rows;
    const ctx = new Map();
    const accessCache = new Map();
    for (const j of jobs) {
        try {
            const access = await matchingReadAccess(id, actor, j, null, sql, accessCache, mode);
            if (!access.allowed)
                continue;
            const fields = await sourceFieldAccess(id, actor, { kind: 'job', id: j.id }, j, sql, mode);
            const binding = await readJobMatching(id, sql, j.id);
            ctx.set(j.id, {
                requirements: j.requirements,
                fields,
                template: await loadMatchingTemplate(id, binding.templateRef, sql),
                dictionary: await loadDictionarySnapshot(id, binding.dictionaryRef, sql),
            });
        }
        catch { /* 未配好的岗位跳过 */ }
    }
    const items = [];
    for (const app of apps) {
        const resume = { id: app.resume_version_id, profile: app.parsed_profile };
        const fields = await sourceFieldAccess(id, actor, { kind: 'resume', id: resume.id }, app.candidate_profile, sql, mode);
        let raw;
        try {
            raw = decodeRaw(app.raw_bytes);
        }
        catch {
            continue;
        }
        const scores = [];
        for (const j of jobs) {
            const jc = ctx.get(j.id);
            if (!jc)
                continue;
            try {
                if (!(await matchingReadAccess(id, actor, j, resume, sql, accessCache, mode)).allowed)
                    continue;
                // Apply exclusions to actual evidence, including canonical IDs and human
                // assertions. The saved dictionary and normal job scoring stay unchanged.
                const parsed = pinnedParsed({ ...app, profile: app.parsed_profile || app.profile }, raw, jc.dictionary);
                const compared = compareConfiguredProfile(parsed, raw, jc.requirements, jc.template, jc.dictionary, { excludedSkillTerms: COMMON_TERMS });
                scores.push({ jobId: j.id, jobName: jc.fields.keys.has('name') ? j.name : '未授权岗位', score: compared.score.value, compared });
            }
            catch { /* 单个岗位算分失败不影响其它岗位 */ }
        }
        if (!scores.length)
            continue;
        const current = scores.find((s) => s.jobId === app.job_id);
        const best = scores.filter((s) => s.jobId !== app.job_id).sort((a, b) => b.score - a.score)[0];
        const currentScore = current?.score ?? null;
        const alert = !!best && best.score >= threshold && (currentScore === null || currentScore < threshold);
        const matched = (best?.compared?.groups || [])
            .flatMap((g) => g.items || [])
            .filter((i) => i && !i.items && i.status === "matched");
        const bestEvidence = matched.slice(0, 5).map((i) => ({
            label: i.label || i.skill,
            method: i.method,
            ...(fields.full && ctx.get(best?.jobId)?.fields.full ? { reason: i.reason } : {}),
        }));
        items.push({
            applicationId: app.id,
            name: fields.keys.has('name') ? app.candidate_profile?.name || '未填写姓名' : "未授权姓名",
            currentJobId: app.job_id,
            currentJobName: current?.jobName || "—",
            currentScore,
            bestJobId: best?.jobId || null,
            bestJobName: best?.jobName || null,
            bestScore: best?.score ?? null,
            bestHitCount: matched.length,
            bestEvidence,
            alert,
            scores: scores.map(({ compared: _c, ...s }) => s),
        });
    }
    if (mode === 'export')
        await id.audit(sql, actor.id, 'matching.cross_job_export', null, { threshold, applicationIds: items.map(item => item.applicationId), count: items.length });
    return {
        threshold, scanned: items.length, jobs: ctx.size,
        commonTermsExcluded: COMMON_TERMS.size,
        alerts: items.filter((x) => x.alert), items,
    };
}
export function registerInboxMatching(app, id) {
    app.post("/api/v4/candidates/matching/cross-job", async (req) => {
        requireRole(req.actor, "admin", "manager", "recruiter");
        const b = parse(crossInput, req.body || {});
        return crossJobAlerts(id, req.actor, b.threshold, b.applicationId, b.mode);
    });
    // 预览：只读，不创建申请、不改任何状态。
    app.post("/api/v4/candidates/matching/preview", async (req) => {
        requireRole(req.actor, "admin", "manager", "recruiter");
        const b = parse(previewInput, req.body || {});
        const sql = id.db.sql;
        const jobs = await inboxJobs(sql), rows = await inboxRows(sql);
        const cache = new Map();
        const accessCache = new Map();
        const items = [];
        let skippedNoIntent = 0, skippedNoJob = 0, scored = 0;
        for (const row of rows) {
            const fields = await sourceFieldAccess(id, req.actor, { kind: 'resume', id: row.resume_version_id }, row.profile, sql);
            if (!fields.keys.has('intent'))
                continue;
            const matching = await projectInboxDecision(id, req.actor, row, jobs, sql, accessCache);
            const intent = matching.intent;
            const job = jobs.find(j => j.id === matching.jobId);
            if (!job) {
                if (!intent)
                    skippedNoIntent++;
                else
                    skippedNoJob++;
            }
            if (!job)
                continue;
            if (!(await matchingReadAccess(id, req.actor, job, { id: row.resume_version_id, profile: row.parsed_profile }, sql, accessCache)).allowed)
                continue;
            let ctx = cache.get(job.id);
            if (ctx === undefined) {
                const reqs = job.requirements;
                if (!reqs) {
                    cache.set(job.id, null);
                    continue;
                }
                const binding = await readJobMatching(id, sql, job.id);
                ctx = {
                    requirements: reqs,
                    template: await loadMatchingTemplate(id, binding.templateRef, sql),
                    dictionary: await loadDictionarySnapshot(id, binding.dictionaryRef, sql),
                };
                cache.set(job.id, ctx);
            }
            if (!ctx)
                continue;
            let score;
            try {
                const raw = decodeRaw(row.raw_bytes);
                const parsed = pinnedParsed({ ...row, profile: row.parsed_profile || row.profile }, raw, ctx.dictionary);
                score = compareConfiguredProfile(parsed, raw, ctx.requirements, ctx.template, ctx.dictionary).score.value;
            }
            catch {
                continue;
            }
            scored++;
            if (score < b.threshold)
                continue;
            items.push({
                candidateId: row.id,
                name: fields.keys.has('name') ? row.profile?.name || '未填写姓名' : "未授权姓名",
                intent,
                jobId: job.id,
                jobName: job.name,
                matchBasis: 'matchBasis' in matching ? matching.matchBasis : '明确求职意向匹配在招岗位',
                matchKind: matching.kind,
                inboxMatchHash: 'inputHash' in matching ? matching.inputHash : undefined,
                score,
                resumeVersionId: row.resume_version_id,
            });
        }
        return {
            threshold: b.threshold,
            scanned: rows.length,
            scored,
            skippedNoIntent,
            skippedNoJob,
            items,
            generatedAt: new Date().toISOString(),
        };
    });
}
//# sourceMappingURL=matching-flow.js.map