import { sourceFieldAccess } from "../business-config/bindings.js";
import { EvaluationUpgradeService } from "../business-config/evaluation-versions.js";
import { defaultEvaluationTemplate } from "../business-config/evaluation-template.js";
import { fail, found } from "../http/errors.js";
import { parse, z } from "../http/validation.js";
import { InterviewService } from "../interviews/service.js";
import { ConfiguredEntities } from "../business-config/entities.js";
import { projectCore } from "../business-config/object-fields.js";
import { InterviewAssistant } from "./service.js";
import { toolkitProjection, assertToolkitWrite } from "../toolkit/access.js";
// 面试上下文与 AI 输出自查（I-1~I-6）。
// 数据落在 interviews.configuration_refs->'toolkit'，随业务表进入 SQL 备份；
// 不新建表、不改归档结构、不改既有评估 schema。
// AI 只生成草稿，所有归档动作必须由人逐项确认后触发。
export const MINUTES_ITEMS = ["结论", "证据", "疑点", "下一轮建议", "是否推进"];
export const REVIEW_CHECKLIST = [
    { id: "citation", label: "引用均为原文连续子串", hint: "每条理由都能在原话里逐字找到" },
    { id: "attribution", label: "未把面试官或未知说话人的话归为候选人", hint: "unknown / mixed 只作上下文" },
    { id: "no_score", label: "未把 AI 建议当作评分或录用结论", hint: "评分与是否推进均为人工填写" },
    { id: "uncertainty", label: "缺失信息已写明未覆盖或待核实", hint: "提及不等于实战证实" },
    { id: "not_valid_when", label: "已写明结论在什么条件下不成立", hint: "反例条件是必要项，不是可选项" },
    { id: "human_confirmed", label: "以上由本人核对确认", hint: "AI 草稿不自动归档" },
];
const CONTEXT_ORDER = ["jobRuler", "priorRounds", "historySamples", "currentDimensions"];
export const MATERIAL_ORDER = ["岗位标尺", "简历原文", "前几轮结论", "本轮维度"];
const minutesShape = z.object(Object.fromEntries(MINUTES_ITEMS.map((k) => [k, z.string().max(2000).default("")]))).strict();
const checkedShape = z.object(Object.fromEntries(REVIEW_CHECKLIST.map((c) => [c.id, z.boolean().default(false)]))).strict();
const reviewShape = z
    .object({
    minutes: minutesShape,
    checked: checkedShape,
    notValidWhen: z.string().max(500).default(""),
})
    .strict();
const archiveShape = reviewShape.extend({ confirmed: z.literal(true) });
const saveInput = reviewShape.extend({ expectedVersion: z.number().int().positive() });
const archiveInput = archiveShape.extend({ expectedVersion: z.number().int().positive() });
const blankState = () => ({
    minutes: Object.fromEntries(MINUTES_ITEMS.map((k) => [k, ""])),
    checked: Object.fromEntries(REVIEW_CHECKLIST.map((c) => [c.id, false])),
    notValidWhen: "",
});
const clip = (v, n = 160) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
export class InterviewReviewService {
    identity;
    constructor(identity) {
        this.identity = identity;
    }
    get db() {
        return this.identity.db;
    }
    // 复用现有 interviewActor 授权：临时面试官只能访问本场，不能跨场读取。
    async scope(a, interviewId) {
        a = await this.identity.interviewActor(a, interviewId);
        const row = found((await this.db.query(`SELECT i.id,i.version,i.round,i.starts_at,i.status,i.application_id,
                  a.job_id,a.candidate_id,a.resume_version_id,
                  i.configuration_refs->'toolkit' AS toolkit
           FROM interviews i JOIN applications a ON a.id=i.application_id
           WHERE i.id=$1 AND i.deleted_at IS NULL`, [interviewId])).rows[0]);
        return { a, row };
    }
    async jobContext(a, row) {
        const job = found((await this.db.query(`SELECT j.id,j.name,j.department,j.level,j.open,j.requirements_version,jv.requirements
           FROM jobs j JOIN job_versions jv ON jv.job_id=j.id AND jv.version=j.requirements_version
           WHERE j.id=$1`, [row.job_id])).rows[0]);
        const access = await sourceFieldAccess(this.identity, a, { kind: "job", id: job.id }, job);
        const requirements = {};
        for (const key of ["skills", "description", "experienceYears", "experienceMaxYears", "education"])
            if (access.keys.has("requirements." + key) && job.requirements?.[key] !== undefined)
                requirements[key] = job.requirements[key];
        return { job: (await projectCore(this.identity, a, 'job', job, { kind: 'job', id: job.id })).core, requirements };
    }
    async dimensions(a, row) {
        // 优先用本场 AI 会话快照（顺序固定、版本可追溯），再退回当前生效模板。
        const session = (await this.db.query(`SELECT basis,analysis FROM interview_assistant_sessions
         WHERE interview_id=$1 AND state='finished' AND analysis IS NOT NULL
         ORDER BY created_at DESC LIMIT 1`, [row.id])).rows[0];
        if (session)
            await new InterviewAssistant(this.identity).sourceAccess(a, session.basis);
        if (session?.basis?.dimensions?.length)
            return { dimensions: session.basis.dimensions, session, source: "session" };
        const shape = (list) => list.filter((d) => d.active !== false).map((d) => ({ id: d.id, label: d.label, description: d.description || "", anchors: d.anchors || [] }));
        // 当前生效模板优先；该链路依赖事务内的模板绑定与授权，失败时退回已发布配置，最后用 PRD 默认四维，
        // 避免岗位标尺因为模板服务异常而整体为空（I-1 的可用性底线）。
        try {
            const effective = await new EvaluationUpgradeService(this.identity).effective(a, row.id, !a.temporaryScope);
            const list = shape(effective.template?.dimensions || []);
            if (list.length)
                return { dimensions: list, session: null, source: "template" };
        }
        catch (error) {
            if (error.statusCode === 403)
                throw error; /* 仅可用性故障使用已发布配置 */
        }
        const published = (await this.db.query(`SELECT v.document FROM business_config_versions v JOIN business_configs c ON c.id=v.config_id
         WHERE c.key='evaluation.prd_default' AND v.version=c.published_version`)).rows[0]?.document;
        const list = shape(published?.dimensions || defaultEvaluationTemplate().dimensions || []);
        return { dimensions: list, session: null, source: list.length ? (published ? "published" : "default") : "missing" };
    }
    // I-1 上下文速览卡 + I-4 不确定场景 + I-5 脱敏与顺序留痕
    async contextCard(a, interviewId, reveal = false) {
        const { a: actor, row } = await this.scope(a, interviewId);
        const { job, requirements } = await this.jobContext(actor, row);
        const { dimensions, session, source } = await this.dimensions(actor, row);
        // Reuse immutable evaluation visibility and current field projection.
        const interviews = new InterviewService(this.identity);
        const entities = new ConfiguredEntities(this.identity);
        const visible = async (applicationId, submitted = false) => {
            const versions = await interviews.evaluations(actor, applicationId, submitted);
            return Promise.all(versions.map(async (v) => ({ ...v, ...(await entities.evaluationVersion(actor, v.id, v.version)) })));
        };
        const priorRows = (actor.temporaryScope ? [] : await visible(row.application_id)).filter((v) => v.interview_id !== row.id && v.round < row.round);
        const priorRounds = priorRows.map((v) => ({ round: v.round, status: v.status, summary: clip(v.data?.summary), conclusion: v.data?.conclusion || null }));
        const historySamples = [];
        if (!actor.temporaryScope) {
            const applications = (await this.db.query("SELECT id FROM applications WHERE job_id=$1 AND id<>$2 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 100", [row.job_id, row.application_id])).rows;
            for (const application of applications) {
                try {
                    for (const v of await visible(application.id, true)) {
                        historySamples.push({ round: v.round, summary: clip(v.data?.summary), conclusion: v.data?.conclusion || null });
                        if (historySamples.length === 3)
                            break;
                    }
                }
                catch (error) {
                    if (error.statusCode !== 403)
                        throw error;
                }
                if (historySamples.length === 3)
                    break;
            }
        }
        const deptJobs = (await this.db.query("SELECT count(*)::int AS n FROM jobs WHERE open AND department=$1", [job.department])).rows[0]?.n || 0;
        const uncertainty = [];
        if (!dimensions.length)
            uncertainty.push({ code: "missing_info", message: "本场尚无岗位能力标尺，我拿不准该按哪些维度判断" });
        if (!priorRounds.length)
            uncertainty.push({ code: "missing_info", message: "没有前几轮结论，我拿不准本轮该重点核实什么" });
        if (!historySamples.length)
            uncertainty.push({ code: "missing_info", message: "没有同岗位历史样本，评分松紧度我拿不准" });
        if (!row.resume_version_id)
            uncertainty.push({ code: "missing_info", message: "本场未选择简历版本，履历类信息我拿不准" });
        if (deptJobs > 1)
            uncertainty.push({ code: "similar_job", message: `同部门有 ${deptJobs} 个在招岗位，岗位标尺可能不唯一，我拿不准是否适用本岗位` });
        const lastNo = [...priorRounds].reverse().find((r) => r.conclusion === "no");
        if (lastNo)
            uncertainty.push({ code: "condition_conflict", message: `第 ${lastNo.round} 轮结论为不推进但安排了后续面试，条件口径可能冲突，我拿不准` });
        if (session?.analysis?.dimensions?.length && session.analysis.dimensions.every((d) => d.status === "not_covered"))
            uncertainty.push({ code: "condition_conflict", message: "本场 AI 草稿全部维度未覆盖，无法据此形成能力结论，我拿不准" });
        // 默认脱敏：不返回姓名、手机号等无关字段；仅永久 HR 角色可显式申请显示姓名，并留审计。
        const privileged = !actor.temporaryScope && actor.roles.some((r) => ["admin", "manager", "recruiter"].includes(r));
        const revealed = reveal && privileged;
        let candidateName = null;
        if (revealed) {
            const c = (await this.db.query("SELECT profile->>'name' AS name FROM candidates WHERE id=$1", [row.candidate_id])).rows[0];
            const projected = await projectCore(this.identity, actor, 'resume', { name: c?.name });
            candidateName = projected.core.name || null;
        }
        await this.identity.audit(this.db.sql, actor.id, "interview.review.context", interviewId, {
            order: CONTEXT_ORDER,
            materialOrder: MATERIAL_ORDER,
            redacted: !revealed,
            revealed,
            dimensionSource: source,
            uncertainty: uncertainty.map((u) => u.code),
        });
        return {
            order: CONTEXT_ORDER,
            materialOrder: MATERIAL_ORDER,
            redacted: !revealed,
            candidateName,
            generatedAt: new Date().toISOString(),
            jobRuler: {
                jobName: job.name,
                department: job.department,
                level: job.level || null,
                requirements,
                dimensions: dimensions.map((d) => ({ id: d.id, label: d.label, description: clip(d.description, 240), anchors: d.anchors || [] })),
                source,
            },
            priorRounds,
            historySamples,
            currentDimensions: dimensions.map((d) => ({ id: d.id, label: d.label, description: clip(d.description, 240) })),
            uncertainty,
        };
    }
    // I-3 评估分理由标签：只取已校验过的原文引用，不生成新结论。
    async evidence(a, interviewId) {
        const { a: actor } = await this.scope(a, interviewId);
        const rows = (await this.db.query(`SELECT basis,analysis FROM interview_assistant_sessions
         WHERE interview_id=$1 AND state='finished' AND analysis IS NOT NULL
         ORDER BY created_at DESC LIMIT 5`, [interviewId])).rows;
        for (const r of rows)
            await new InterviewAssistant(this.identity).sourceAccess(actor, r.basis);
        const labels = new Map();
        for (const r of rows)
            for (const d of r.basis?.dimensions || [])
                labels.set(d.id, d.label);
        const items = new Map();
        for (const r of rows) {
            for (const d of r.analysis?.dimensions || []) {
                const key = String(d.dimensionId);
                const entry = items.get(key) || { dimensionId: key, label: labels.get(key) || key, quotes: [], notCovered: false };
                entry.notCovered = entry.notCovered || d.status === "not_covered";
                for (const e of d.evidence || []) {
                    const quote = { segmentId: String(e.segmentId), quote: clip(e.quote, 600) };
                    if (!entry.quotes.some((q) => q.segmentId === quote.segmentId && q.quote === quote.quote))
                        entry.quotes.push(quote);
                }
                items.set(key, entry);
            }
        }
        return { source: "ai_draft", items: [...items.values()], note: "理由来自 AI 草稿的原文引用，需人工核对后才能作为评分依据" };
    }
    draft(analysis) {
        const dims = analysis?.dimensions || [];
        const covered = dims.filter((d) => d.status === "evidence");
        const missing = dims.filter((d) => d.status === "not_covered").map((d) => d.dimensionId);
        const quotes = covered.flatMap((d) => (d.evidence || []).map((e) => clip(e.quote, 300)));
        return {
            "结论": covered.length ? covered.map((d) => clip(d.summary, 200)).join("；").slice(0, 900) : "",
            "证据": quotes.slice(0, 8).join("\n"),
            "疑点": [...(analysis?.nextSteps || []), ...(missing.length ? ["未覆盖维度：" + missing.join("、")] : [])].map((s) => clip(s, 300)).join("\n").slice(0, 900),
            "下一轮建议": (analysis?.suggestions || []).map((s) => clip(s.question, 300)).join("\n").slice(0, 900),
            "是否推进": "", // 红线：AI 不给录用结论，必须人工填写
        };
    }
    otherDraft(a, row) {
        const saved = row.toolkit?.outputReview;
        return saved?.source === 'human_draft' && saved.savedBy !== a.id;
    }
    async reviewAccess(a, row, write = false) {
        if (write && this.otherDraft(a, row))
            fail(403, 'private_evaluation_draft');
        const interview = found((await this.db.query('SELECT * FROM interviews WHERE id=$1', [row.id])).rows[0]);
        const minutes = row.toolkit?.outputReview?.minutes || row.toolkit?.minutes || {};
        const core = { summary: minutes['结论'] || '', evidenceNotes: minutes['证据'] || '', risks: minutes['疑点'] || '' };
        const fields = await toolkitProjection(this.identity, a, 'evaluation', core);
        const feedback = await toolkitProjection(this.identity, a, 'interview', interview, { kind: 'interview', id: row.id });
        if (!['summary', 'evidenceNotes', 'risks'].every(key => fields.keys.has(key)) || !feedback.keys.has('feedback'))
            fail(403, 'review_fields_forbidden');
        if (write) {
            try {
                await assertToolkitWrite(this.identity, a, 'evaluation', core, undefined, ['summary', 'evidenceNotes', 'risks']);
            }
            catch (error) {
                if (error.statusCode === 403)
                    fail(403, 'review_fields_forbidden');
                throw error;
            }
        }
    }
    // I-6 输出自查清单：草稿可随时保存，正式纪要只在人工确认后归档。
    async outputReview(a, interviewId) {
        const { a: actor, row } = await this.scope(a, interviewId);
        await this.reviewAccess(actor, row);
        const stored = row.toolkit?.outputReview || {};
        const readOnly = this.otherDraft(actor, row);
        const saved = readOnly ? {} : stored;
        const state = {
            minutes: { ...blankState().minutes, ...(saved.minutes || {}) },
            checked: { ...blankState().checked, ...(saved.checked || {}) },
            notValidWhen: typeof saved.notValidWhen === "string" ? saved.notValidWhen : "",
        };
        const analyses = (await this.db.query(`SELECT basis,analysis FROM interview_assistant_sessions
         WHERE interview_id=$1 AND state='finished' AND analysis IS NOT NULL
         ORDER BY created_at DESC LIMIT 1`, [interviewId])).rows;
        for (const analysis of analyses)
            await new InterviewAssistant(this.identity).sourceAccess(actor, analysis.basis);
        const archived = row.toolkit?.outputReview?.archived || null;
        return {
            expectedVersion: row.version,
            readOnly,
            readOnlyReason: readOnly ? 'private_evaluation_draft' : null,
            checklist: REVIEW_CHECKLIST,
            minutesItems: MINUTES_ITEMS,
            state: !readOnly && !stored.minutes && !archived && analyses[0] ? { ...state, minutes: { ...state.minutes, ...this.draft(analyses[0].analysis) } } : state,
            draft: analyses[0] ? this.draft(analyses[0].analysis) : null,
            archived,
            minutes: row.toolkit?.minutes || null,
        };
    }
    async saveReview(a, interviewId, input) {
        return this.db.tx(async () => {
            await this.db.query("SELECT id FROM interviews WHERE id=$1 AND deleted_at IS NULL FOR UPDATE", [interviewId]);
            const { a: actor, row } = await this.scope(a, interviewId);
            const { expectedVersion, ...b } = parse(saveInput, input);
            if (row.version !== expectedVersion)
                fail(409, "version_conflict");
            await this.reviewAccess(actor, row, true);
            const toolkit = {
                ...(row.toolkit || {}),
                outputReview: { ...b, source: "human_draft", savedAt: new Date().toISOString(), savedBy: actor.id, archived: row.toolkit?.outputReview?.archived || null },
            };
            await this.write(interviewId, toolkit);
            await this.identity.audit(this.db.sql, actor.id, "interview.review.save", interviewId, { checked: REVIEW_CHECKLIST.filter((c) => b.checked[c.id]).length });
            return { ok: true, expectedVersion: row.version + 1 };
        });
    }
    async archive(a, interviewId, input) {
        return this.db.tx(async () => {
            await this.db.query("SELECT id FROM interviews WHERE id=$1 AND deleted_at IS NULL FOR UPDATE", [interviewId]);
            const { a: actor, row } = await this.scope(a, interviewId);
            const { expectedVersion, ...b } = parse(archiveInput, input);
            if (row.version !== expectedVersion)
                fail(409, "version_conflict");
            await this.reviewAccess(actor, row, true);
            const missing = [];
            for (const item of MINUTES_ITEMS)
                if (!String(b.minutes[item] || "").trim())
                    missing.push("纪要：" + item);
            for (const c of REVIEW_CHECKLIST)
                if (!b.checked[c.id])
                    missing.push("自查：" + c.label);
            if (!String(b.notValidWhen || "").trim())
                missing.push("结论不成立条件");
            if (missing.length)
                fail(422, "review_incomplete");
            const stamp = new Date().toISOString();
            const toolkit = {
                ...(row.toolkit || {}),
                minutes: { ...b.minutes, confirmedAt: stamp, confirmedBy: actor.id, source: "human_confirmed" },
                outputReview: {
                    ...b,
                    source: "human_confirmed",
                    archived: { at: stamp, by: actor.id, checklistVersion: 1, materialOrder: MATERIAL_ORDER },
                    savedAt: stamp,
                    savedBy: actor.id,
                },
            };
            await this.write(interviewId, toolkit);
            await this.identity.audit(this.db.sql, actor.id, "interview.review.archive", interviewId, {
                minutes: MINUTES_ITEMS,
                checklist: REVIEW_CHECKLIST.map((c) => c.id),
                notValidWhen: true,
                materialOrder: MATERIAL_ORDER,
            });
            return { ok: true, archivedAt: stamp, expectedVersion: row.version + 1 };
        });
    }
    async write(interviewId, toolkit) {
        const r = await this.db.query(`UPDATE interviews SET configuration_refs=coalesce(configuration_refs,'{}'::jsonb)
         || jsonb_build_object('toolkit',coalesce(configuration_refs->'toolkit','{}'::jsonb)||$2::jsonb), version=version+1,updated_at=now()
       WHERE id=$1 AND deleted_at IS NULL RETURNING id`, [interviewId, JSON.stringify(toolkit)]);
        if (!r.rowCount)
            fail(404, "not_found");
    }
}
//# sourceMappingURL=review.js.map