import { requireRole } from "../identity/service.js";
import { parse, uuid, z } from "../http/validation.js";
import { resolveJobMatching, loadMatchingTemplate, loadDictionarySnapshot, pinnedParsed, } from "../business-config/bindings.js";
import { compareConfiguredProfile } from "../business-config/match-template.js";
import { decodeRaw } from "../parsing/profile.js";
import { COMMON_TERMS } from "./common-terms.js";
const previewInput = z
    .object({ threshold: z.number().int().min(0).max(100).default(60) })
    .strict();
const crossInput = z
    .object({
    threshold: z.number().int().min(0).max(100).default(60),
    applicationId: uuid.optional(),
})
    .strict();
const norm = (s) => String(s || "")
    .replace(/[\s\u3000]+/g, "")
    .replace(/[（(][^)）]*[)）]/g, "")
    .toLowerCase();
// 期望职位里常混进邮箱、电话和「电子邮箱：」这类标签，先清掉再按顿号/斜杠拆词。
function intentTokens(intent) {
    const clean = String(intent || "")
        .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, " ")
        .replace(/(?:电子邮箱|邮箱|联系电话|手机|电话|联系方式|联系)\s*[:：]?/g, " ")
        .replace(/\d{6,}/g, " ")
        .replace(/[、\/,，;；|]+/g, "|");
    return clean
        .split("|")
        .map(norm)
        .filter((t) => t.length >= 2);
}
// 只按「期望职位同名岗位」匹配：相等或互为包含（长度≥2）才算，不做语义猜测。
function sameNameJob(intent, jobs) {
    const tokens = intentTokens(intent);
    if (!tokens.length)
        return null;
    return (jobs.find((j) => {
        const n = norm(j.name);
        return tokens.some((t) => n === t || n.includes(t) || t.includes(n));
    }) || null);
}
// 跨岗位匹配：同一份简历在所有在招岗位各算一次分，找出「当前岗位低、别的岗位高」的人。
// 只读，不创建申请、不改状态；模板/字典按岗位缓存，避免逐人重复查库。
async function crossJobAlerts(id, threshold, onlyId) {
    const sql = id.db.sql;
    const jobs = (await sql.query("SELECT id,name,requirements_version FROM jobs WHERE open=true ORDER BY name")).rows;
    const apps = (await sql.query(`SELECT a.id,a.job_id,a.resume_version_id,c.profile->>'name' AS name,
       p.raw_bytes,p.profile AS parsed_profile,p.evidence,p.parser_version,
       p.human_corrections,p.created_at AS parse_created_at
     FROM applications a
     JOIN candidates c ON c.id=a.candidate_id
     JOIN resume_versions r ON r.id=a.resume_version_id
     JOIN parse_results p ON p.id=r.parse_result_id
     WHERE a.is_current AND a.deleted_at IS NULL AND a.resume_version_id IS NOT NULL
       ${onlyId ? "AND a.id=$1" : ""}
     ORDER BY a.created_at DESC LIMIT 100`, onlyId ? [onlyId] : [])).rows;
    const ctx = new Map();
    for (const j of jobs) {
        const reqs = (await sql.query("SELECT requirements FROM job_versions WHERE job_id=$1 AND version=$2", [j.id, j.requirements_version])).rows[0]?.requirements;
        if (!reqs)
            continue;
        try {
            const binding = await resolveJobMatching(id, sql, j.id);
            ctx.set(j.id, {
                requirements: reqs,
                template: await loadMatchingTemplate(id, binding.templateRef, sql),
                dictionary: await loadDictionarySnapshot(id, binding.dictionaryRef, sql),
            });
        }
        catch { /* 未配好的岗位跳过 */ }
    }
    const items = [];
    for (const app of apps) {
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
                // 跨岗推荐只看有判别力的命中：共性词（如「投资/融资/银行」）不参与命中，
                // 但保留 option id 自身映射，避免技能未注册校验失败。主评分不受影响。
                const aliases = Object.fromEntries(Object.entries(jc.dictionary.aliases)
                    .filter(([a, c]) => a === c || !COMMON_TERMS.has(a)));
                const cleanDictionary = { ...jc.dictionary, aliases };
                const parsed = pinnedParsed({ ...app, profile: app.parsed_profile || app.profile }, raw, cleanDictionary);
                const compared = compareConfiguredProfile(parsed, raw, jc.requirements, jc.template, cleanDictionary);
                scores.push({ jobId: j.id, jobName: j.name, score: compared.score.value, compared });
            }
            catch { /* 单个岗位算分失败不影响其它岗位 */ }
        }
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
            reason: i.reason,
        }));
        items.push({
            applicationId: app.id,
            name: app.name || "未授权姓名",
            currentJobId: app.job_id,
            currentJobName: current?.jobName || jobs.find((j) => j.id === app.job_id)?.name || "—",
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
    return {
        threshold, scanned: apps.length, jobs: jobs.length,
        commonTermsExcluded: COMMON_TERMS.size,
        alerts: items.filter((x) => x.alert), items,
    };
}
export function registerInboxMatching(app, id) {
    app.post("/api/v4/candidates/matching/cross-job", async (req) => {
        requireRole(req.actor, "admin", "manager", "recruiter");
        const b = parse(crossInput, req.body || {});
        return crossJobAlerts(id, b.threshold, b.applicationId);
    });
    // 预览：只读，不创建申请、不改任何状态。
    app.post("/api/v4/candidates/matching/preview", async (req) => {
        requireRole(req.actor, "admin", "manager", "recruiter");
        const b = parse(previewInput, req.body || {});
        const sql = id.db.sql;
        const jobs = (await sql.query("SELECT id,name FROM jobs WHERE open=true ORDER BY name")).rows;
        const rows = (await sql.query(`SELECT c.id,c.profile,r.id AS resume_version_id,
          p.raw_bytes,p.profile AS parsed_profile,p.evidence,p.parser_version,
          p.human_corrections,p.created_at AS parse_created_at
        FROM candidates c
        JOIN LATERAL (SELECT id,parse_result_id FROM resume_versions WHERE candidate_id=c.id ORDER BY created_at DESC,id DESC LIMIT 1) r ON true
        JOIN parse_results p ON p.id=r.parse_result_id
        WHERE c.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.candidate_id=c.id AND a.is_current AND a.deleted_at IS NULL)
        ORDER BY c.created_at DESC LIMIT 300`)).rows;
        const cache = new Map();
        const items = [];
        let skippedNoIntent = 0, skippedNoJob = 0, scored = 0;
        for (const row of rows) {
            const intent = String(row.profile?.intent || "");
            const job = sameNameJob(intent, jobs);
            if (!intentTokens(intent).length)
                skippedNoIntent++;
            else if (!job)
                skippedNoJob++;
            if (!job)
                continue;
            let ctx = cache.get(job.id);
            if (ctx === undefined) {
                const reqs = (await sql.query("SELECT requirements FROM job_versions WHERE job_id=$1 ORDER BY version DESC LIMIT 1", [job.id])).rows[0]?.requirements;
                if (!reqs) {
                    cache.set(job.id, null);
                    continue;
                }
                const binding = await resolveJobMatching(id, sql, job.id);
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
                name: row.profile?.name || "未授权姓名",
                intent,
                jobId: job.id,
                jobName: job.name,
                matchBasis: "期望职位「" + intentTokens(intent).join("/") + "」匹配到同名在招岗位",
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