import { toolkitProjection } from '../toolkit/access.js';
import { loadDefinition } from '../business-config/fields.js';
import { fieldAllowed } from '../business-config/access.js';
import { BusinessConfigService } from '../business-config/service.js';
import { assertLegacyField, legacyDefinition } from '../business-config/legacy-fields.js';
import { randomUUID } from "node:crypto";
import { requireRole } from "../identity/service.js";
import { parse, z, uuid, version } from "../http/validation.js";
import { fail, found } from "../http/errors.js";
// 内部推荐：依据《山子高科内部推荐管理办法（试行）V3》（2026-10-19）。
// 数据落在既有 leads 表的 configuration_refs->toolkit->referral，
// 不新建表、不改归档结构；积分规则由服务端统一计算，页面不自行改分。
export const GRADES = {
    初级: 1.0,
    中级: 1.5,
    高级: 2.0,
    特殊: null,
};
export const STAGE_POINTS = { interview: 1, offered: 5, hired: 10 };
export const POINT_VALUE_CNY = 50;
export const MAX_SCORE = 50;
export const EXCLUSIONS = [
    "none",
    "false_material",
    "candidate_abandon",
    "early_leave",
    "violation",
];
export const EXCLUDED_PERSONS = [
    "none",
    "hr_recruiter",
    "interviewer",
    "conflict_of_interest",
    "current_or_recent_employee",
];
const grade = z.enum(["初级", "中级", "高级", "特殊"]);
const referralInput = z
    .object({
    referrerName: z.string().trim().min(1).max(40),
    referrerDept: z.string().trim().max(60).default(""),
    referrerJob: z.string().trim().max(60).default(""),
    referrerPhone: z.string().trim().max(40).default(""),
    candidateName: z.string().trim().min(1).max(40),
    targetJob: z.string().trim().min(1).max(120),
    grade,
    education: z.string().trim().max(60).default(""),
    currentOrg: z.string().trim().max(120).default(""),
    candidatePhone: z.string().trim().max(40).default(""),
    relation: z.enum(["前同事", "朋友", "亲属", "其他"]).default("其他"),
    relationOther: z.string().trim().max(60).default(""),
    channel: z.string().trim().max(60).default(""),
    reason: z.string().trim().max(1000).default(""),
    signedAt: z.string().trim().max(20).default(""),
    excludedPerson: z.enum(EXCLUDED_PERSONS).default("none"),
    conflictDeclared: z.boolean().default(false),
    stages: z
        .object({ interview: z.boolean(), offered: z.boolean(), hired: z.boolean() })
        .default({ interview: false, offered: false, hired: false }),
    specialScore: z.number().min(0).max(50).nullable().default(null),
    exclusion: z.enum(EXCLUSIONS).default("none"),
    review: z.enum(["pending", "approved", "rejected"]).default("pending"),
    confirmed: z.boolean().default(false),
})
    .strict();
const updateInput = z
    .object({
    version,
    stages: z.object({ interview: z.boolean(), offered: z.boolean(), hired: z.boolean() }).optional(),
    specialScore: z.number().min(0).max(50).nullable().optional(),
    exclusion: z.enum(EXCLUSIONS).optional(),
    excludedPerson: z.enum(EXCLUDED_PERSONS).optional(),
    review: z.enum(["pending", "approved", "rejected"]).optional(),
    confirmed: z.boolean().optional(),
    conflictDeclared: z.boolean().optional(),
    reason: z.string().trim().max(1000).optional(),
})
    .strict();
export function computeReferral(r) {
    const stages = r.stages || {};
    let base = (stages.interview ? STAGE_POINTS.interview : 0) +
        (stages.offered ? STAGE_POINTS.offered : 0) +
        (stages.hired ? STAGE_POINTS.hired : 0);
    const notes = [];
    let score = 0;
    let ineligible = false;
    // 第十五条（三）：入职 6 个月内离职或试用期不合格，取消入职阶段 10 分，保留前两阶段。
    if (r.exclusion === "early_leave") {
        base = Math.max(0, base - STAGE_POINTS.hired);
        notes.push("入职 6 个月内离职/试用期不合格：取消入职 10 分，保留面试与录用积分");
    }
    // 第十三条 / 第十四条：不享受或不纳入内推积分。
    if (r.excludedPerson && r.excludedPerson !== "none") {
        ineligible = true;
        notes.push("属于办法第十三/十四条排除情形，不纳入内推积分");
    }
    // 第十五条（一）（二）（四）：当次积分不予认可 / 不纳入 / 取消资格。
    if (["false_material", "candidate_abandon", "violation"].includes(r.exclusion)) {
        ineligible = true;
        notes.push("按办法第十五条，当次内推积分不认可");
    }
    if (r.review === "rejected") {
        ineligible = true;
        notes.push("形式审核未通过，不计分");
    }
    if (r.duplicateOf) {
        ineligible = true;
        notes.push("第八条：同一被推荐人以最先登记且材料完备者为准，本条不重复计分");
    }
    if (!ineligible) {
        if (r.grade === "特殊") {
            score = Math.min(MAX_SCORE, Number(r.specialScore ?? 0));
            notes.push("特殊档按『一人一议』议定积分填写，权重不超过 4.0 倍");
        }
        else {
            const weight = GRADES[r.grade] ?? 1.0;
            score = Math.min(MAX_SCORE, Math.round(base * weight * 10) / 10);
            notes.push(`（${base} 分）× ${weight.toFixed(1)} 倍档位权重${base * weight > MAX_SCORE ? "，按单次上限 50 分封顶" : ""}`);
        }
    }
    return {
        base,
        weight: r.grade === "特殊" ? null : GRADES[r.grade] ?? 1.0,
        stagePoints: { ...STAGE_POINTS },
        score,
        amountCny: Math.round(score * POINT_VALUE_CNY),
        ineligible,
        notes,
    };
}
const checkInput = z
    .object({
    referrerName: z.string().trim().max(40).default(""),
    candidateName: z.string().trim().max(40).default(""),
    candidatePhone: z.string().trim().max(40).default(""),
    targetJob: z.string().trim().max(120).default(""),
})
    .strict();
// 参与资格自动核查：只能识别系统里已有的客观数据；亲属关系与离职日期无字段，明确交人工确认。
async function detectFlags(db, input) {
    const referrer = String(input.referrerName || "").trim(), candidate = String(input.candidateName || "").trim(), phone = String(input.candidatePhone || "").trim(), job = String(input.targetJob || "").trim();
    const flags = [];
    if (referrer) {
        const u = (await db.query("SELECT name,roles FROM users WHERE status='active' AND directory_active AND name=$1 LIMIT 1", [referrer])).rows[0];
        if (u && (u.roles || []).some((x) => ["admin", "manager", "recruiter"].includes(x)))
            flags.push({ code: "hr_recruiter", level: "auto", label: "推荐人疑似 HR / 专职招聘岗", basis: `系统用户 ${u.name} 持有 ${(u.roles || []).join("、")} 角色，按办法第十三条不享受积分` });
        const iv = await db.query(`SELECT 1 FROM interviewers ir JOIN users u ON u.id=ir.user_id
       JOIN interviews i ON i.id=ir.interview_id AND i.deleted_at IS NULL
       JOIN applications a ON a.id=i.application_id AND a.deleted_at IS NULL
       JOIN jobs j ON j.id=a.job_id
       WHERE u.name=$1 AND ($2::text IS NULL OR j.name=$2) LIMIT 1`, [referrer, job || null]);
        if (iv.rowCount)
            flags.push({ code: "interviewer", level: "auto", label: "推荐人参与过该岗位面试", basis: "面试记录中存在该推荐人作为面试官，按办法第十三条不享受积分" });
    }
    if (candidate || phone) {
        const ex = await db.query(`SELECT profile->>'name' AS name FROM candidates WHERE deleted_at IS NULL
       AND (($1<>'' AND profile->>'name'=$1) OR ($2<>'' AND profile->>'phone'=$2)) LIMIT 1`, [candidate, phone]);
        if (ex.rowCount)
            flags.push({ code: "existing_candidate", level: "auto", label: "被推荐人已在候选人库", basis: "匹配到现有候选人档案，需确认是否为现职员工或离职未满 6 个月" });
    }
    flags.push({ code: "manual_check", level: "manual", label: "利益关系与离职状态需人工确认", basis: "办法第十三条的亲属 / 直接上下级关系、第十四条离职未满 6 个月，系统暂无对应字段，需推荐人声明并由 HR 核对" });
    return flags;
}
const normalizedName = (v) => String(v || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
const normalizedPhone = (v) => String(v || '').normalize('NFKC').replace(/\D/g, '');
const referralKey = (r) => normalizedName(r.candidateName) + '|' + normalizedPhone(r.candidatePhone);
const completeMaterial = (r) => ['referrerName', 'referrerDept', 'referrerJob', 'referrerPhone', 'candidateName', 'candidatePhone', 'targetJob', 'grade', 'education', 'currentOrg', 'reason', 'signedAt'].every(key => String(r[key] || '').trim());
const matchingReferrals = async (db, input) => {
    const rows = (await db.query("SELECT id,created_at,configuration_refs->'toolkit'->'referral' AS referral FROM leads WHERE deleted_at IS NULL AND source='内推' AND configuration_refs->'toolkit'->'referral' IS NOT NULL ORDER BY created_at,id")).rows;
    return rows.filter((row) => referralKey(row.referral) === referralKey(input));
};
async function referralWriteAccess(id, a, values, skipEmpty = false) {
    await new BusinessConfigService(id).seed();
    const def = await loadDefinition(id, 'lead', id.db.sql, a);
    for (const [key, value] of Object.entries(values)) {
        if (value === undefined || (skipEmpty && value === ''))
            continue;
        const field = def.fields.find(f => f.coreKey === key);
        if (!field || !field.active || !fieldAllowed(field, a, 'write'))
            fail(403, 'field_forbidden:core.lead.' + key);
    }
}
const shape = (row) => {
    const r = row.referral || {};
    return { ...row, referral: { ...r, computed: computeReferral(r) } };
};
export function referralRoutes(app, id) {
    const sql = () => id.db.sql;
    const readRole = (actor) => requireRole(actor, "admin", "manager", "recruiter");
    app.get("/api/v4/referrals/overview", async (req) => {
        readRole(req.actor);
        const { mode } = parse(z.object({ mode: z.enum(["read", "export"]).default("read") }).strict(), req.query);
        const rows = (await sql().query(`SELECT id,name,org,school,direction,source,contact,note,raw,created_at,updated_at,version,
           configuration_refs->'toolkit'->'referral' AS referral
         FROM leads WHERE deleted_at IS NULL AND source='内推'
           AND configuration_refs->'toolkit'->'referral' IS NOT NULL
         ORDER BY created_at DESC LIMIT 300`)).rows.map(shape);
        for (const row of rows) {
            const p = await toolkitProjection(id, req.actor, 'lead', row, { kind: 'lead', id: row.id }, mode);
            for (const key of ['name', 'org', 'school', 'direction', 'source', 'contact', 'note'])
                if (!p.keys.has(key))
                    delete row[key];
            if (!p.full)
                delete row.raw;
            for (const [copy, key] of Object.entries({ candidateName: 'name', currentOrg: 'org', education: 'school', targetJob: 'direction', candidatePhone: 'contact', referrerPhone: 'contact', reason: 'note' }))
                if (!p.keys.has(key))
                    delete row.referral[copy];
        }
        if (mode === 'export')
            await id.audit(sql(), req.actor.id, 'referral.export', null, { count: rows.length });
        const byReferrer = new Map();
        for (const row of rows) {
            const r = row.referral || {};
            const key = String(r.referrerName || "未注明");
            const acc = byReferrer.get(key) || { name: key, count: 0, score: 0, amount: 0 };
            acc.count += 1;
            acc.score += Number(r.computed?.score || 0);
            acc.amount += Number(r.computed?.amountCny || 0);
            byReferrer.set(key, acc);
        }
        const db = sql();
        const referrers = [...new Set(rows.map((r) => String(r.referral?.referrerName || "").trim()).filter(Boolean))];
        const candidateNames = [...new Set(rows.map((r) => String(r.referral?.candidateName || "").trim()).filter(Boolean))];
        const candidatePhones = [...new Set(rows.map((r) => String(r.referral?.candidatePhone || "").trim()).filter(Boolean))];
        const hrNames = new Set((await db.query("SELECT name,roles FROM users WHERE status='active' AND directory_active AND name=ANY($1::text[])", [referrers])).rows
            .filter((u) => (u.roles || []).some((x) => ["admin", "manager", "recruiter"].includes(x)))
            .map((u) => String(u.name)));
        const interviewerRows = referrers.length
            ? (await db.query(`SELECT DISTINCT u.name,j.name AS job_name FROM interviewers ir JOIN users u ON u.id=ir.user_id
           JOIN interviews i ON i.id=ir.interview_id AND i.deleted_at IS NULL
           JOIN applications a ON a.id=i.application_id AND a.deleted_at IS NULL
           JOIN jobs j ON j.id=a.job_id WHERE u.name=ANY($1::text[])`, [referrers])).rows
            : [];
        const existingNames = new Set(), existingPhones = new Set();
        if (candidateNames.length || candidatePhones.length) {
            for (const c of (await db.query(`SELECT profile->>'name' AS n,profile->>'phone' AS p FROM candidates
         WHERE deleted_at IS NULL AND (profile->>'name'=ANY($1::text[]) OR profile->>'phone'=ANY($2::text[]))`, [candidateNames, candidatePhones])).rows) {
                if (c.n)
                    existingNames.add(String(c.n));
                if (c.p)
                    existingPhones.add(String(c.p));
            }
        }
        const manualFlag = { code: "manual_check", level: "manual", label: "利益关系与离职状态需人工确认", basis: "办法第十三、十四条涉及亲属 / 直接上下级关系与离职日期，系统暂无对应字段，需声明后由 HR 核对" };
        for (const row of rows) {
            const r = row.referral || {}, flags = [];
            if (hrNames.has(String(r.referrerName || "")))
                flags.push({ code: "hr_recruiter", level: "auto", label: "推荐人疑似 HR / 专职招聘岗", basis: "系统用户角色为 admin / manager / recruiter，按办法第十三条不享受积分" });
            if (interviewerRows.some((x) => x.name === r.referrerName && (!r.targetJob || x.job_name === r.targetJob)))
                flags.push({ code: "interviewer", level: "auto", label: "推荐人参与过该岗位面试", basis: "面试记录中存在该推荐人，按办法第十三条不享受积分" });
            if (existingNames.has(String(r.candidateName || "")) || (r.candidatePhone && existingPhones.has(String(r.candidatePhone))))
                flags.push({ code: "existing_candidate", level: "auto", label: "被推荐人已在候选人库", basis: "匹配到现有候选人档案，需确认是否为现职员工或离职未满 6 个月" });
            flags.push(manualFlag);
            row.flags = flags;
        }
        const groups = new Map();
        for (const row of rows) {
            const r = row.referral || {}, key = referralKey(r);
            const g = groups.get(key) || [];
            g.push(row);
            groups.set(key, g);
        }
        const duplicates = [...groups.entries()].filter(([, g]) => g.length > 1).map(([key, g]) => {
            const sorted = [...g].sort((a, b) => Number(!!a.referral?.duplicateOf) - Number(!!b.referral?.duplicateOf) || new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
            return {
                key,
                candidateName: sorted[0].referral?.candidateName || "",
                candidatePhone: sorted[0].referral?.candidatePhone || "",
                count: g.length,
                validId: sorted[0].id,
                validReferrer: sorted[0].referral?.referrerName || "",
                validAt: sorted[0].created_at,
                laterIds: sorted.slice(1).map((x) => x.id),
            };
        });
        const exclusionSummary = {
            duplicateRecords: rows.filter((r) => !!r.referral?.duplicateOf).length,
            duplicateGroups: duplicates.length,
            autoFlagged: rows.filter((r) => r.flags.some((f) => f.level === "auto")).length,
            declaredExcluded: rows.filter((r) => r.referral?.excludedPerson && r.referral.excludedPerson !== "none").length,
            manualPending: rows.length,
        };
        return {
            items: rows,
            duplicates,
            exclusionSummary,
            byReferrer: [...byReferrer.values()].sort((a, b) => b.score - a.score),
            rules: {
                grades: GRADES,
                stagePoints: STAGE_POINTS,
                pointValueCny: POINT_VALUE_CNY,
                maxScore: MAX_SCORE,
                settlement: "每年 12 月 31 日截止统计，人力资源部统一核对、登记、结算；积分按 1 分 = 50 元计入当年度奖金，不单独兑换现金",
            },
            generatedAt: new Date().toISOString(),
        };
    });
    // 登记前核查：查重 + 参与资格自动命中，结果只提示，不代替 HR 形式审核。
    app.post("/api/v4/referrals/check", async (req) => {
        readRole(req.actor);
        const b = parse(checkInput, req.body);
        const checkFields = async (kind, keys) => {
            if (!keys.length)
                return;
            const def = await legacyDefinition(id, req.actor, kind);
            for (const key of keys) {
                if (!def.fields.some(f => f.coreKey === key))
                    fail(403, 'field_query_forbidden');
                assertLegacyField(def, req.actor, key);
            }
        };
        // Match counts and eligibility flags expose whether the supplied value
        // exists, so authorize the lookup columns before accessing either source.
        await checkFields('lead', [
            ...(b.candidateName ? ['name'] : []),
            ...(b.candidatePhone ? ['contact'] : []),
            ...(b.targetJob ? ['direction'] : []),
        ]);
        await checkFields('resume', [
            ...(b.candidateName ? ['name'] : []),
            ...(b.candidatePhone ? ['phone'] : []),
        ]);
        await checkFields('job', b.targetJob ? ['name'] : []);
        const db = sql();
        const dup = (await matchingReferrals(db, b)).map((r) => ({ id: r.id, created_at: r.created_at, referrer_name: r.referral.referrerName, target_job: r.referral.targetJob, duplicateOf: r.referral.duplicateOf }));
        for (const row of dup) {
            const lead = found((await db.query('SELECT * FROM leads WHERE id=$1', [row.id])).rows[0]);
            if (!(await toolkitProjection(id, req.actor, 'lead', lead, { kind: 'lead', id: row.id })).keys.has('direction'))
                delete row.target_job;
        }
        const flags = await detectFlags(db, b);
        return {
            duplicates: dup,
            duplicateCount: dup.length,
            validReferrer: dup.find((r) => !r.duplicateOf)?.referrer_name || null,
            flags,
            note: "查重按被推荐人姓名与手机号；自动命中仅基于系统已有数据，利益关系、离职日期等仍需人工确认",
        };
    });
    app.post("/api/v4/referrals", async (req) => id.db.tx(async () => {
        readRole(req.actor);
        const b = parse(referralInput, req.body);
        await referralWriteAccess(id, req.actor, { name: b.candidateName, org: b.currentOrg, school: b.education, direction: b.targetJob, contact: b.candidatePhone || b.referrerPhone, note: b.reason, source: '内推' }, true);
        const db = sql();
        // A transaction-level key lock makes registration order deterministic across API instances.
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [id.config.schema + ':referral:' + referralKey(b)]);
        const matches = await matchingReferrals(db, b);
        const complete = matches.find((r) => completeMaterial(r.referral));
        const dup = complete || (!completeMaterial(b) ? matches[0] : null);
        const referral = {
            ...b,
            duplicateOf: dup?.id || null,
            createdBy: req.actor.id,
            registeredAt: new Date().toISOString(),
        };
        const newId = randomUUID();
        const raw = [
            `推荐人：${b.referrerName}（${b.referrerDept} / ${b.referrerJob} / ${b.referrerPhone}）`,
            `被推荐人：${b.candidateName} · 应聘岗位：${b.targetJob} · 档位：${b.grade}`,
            `最高学历：${b.education} · 现单位：${b.currentOrg} · 手机：${b.candidatePhone}`,
            `关系：${b.relation}${b.relationOther ? "（" + b.relationOther + "）" : ""} · 渠道来源：${b.channel}`,
            `推荐理由：${b.reason}`,
            `填报日期：${b.signedAt}`,
        ].join("\n");
        const inserted = (await db.query(`INSERT INTO leads(id,name,org,school,direction,contact,source,line,state,owner_id,note,raw,configuration_refs,version,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,'内推','social','uncontacted',$7,$8,$9,$10::jsonb,1,now(),now()) RETURNING id`, [
            newId,
            b.candidateName,
            b.currentOrg,
            b.education,
            b.targetJob,
            b.candidatePhone,
            req.actor.id,
            b.reason,
            raw,
            JSON.stringify({ toolkit: { referral } }),
        ])).rows[0];
        if (!dup) {
            for (const previous of matches)
                await db.query("UPDATE leads SET configuration_refs=jsonb_set(configuration_refs,'{toolkit,referral,duplicateOf}',to_jsonb($2::text),true),version=version+1,updated_at=now() WHERE id=$1", [previous.id, inserted.id]);
        }
        await id.audit(db, req.actor.id, "referral.create", inserted.id, {
            candidate: b.candidateName,
            grade: b.grade,
            duplicate: !!dup,
        });
        return { id: inserted.id, duplicateOf: dup?.id || null };
    }));
    app.patch("/api/v4/referrals/:id", async (req) => id.db.tx(async () => {
        readRole(req.actor);
        const targetId = parse(z.object({ id: uuid }), req.params).id;
        const b = parse(updateInput, req.body);
        await referralWriteAccess(id, req.actor, { note: b.reason });
        const db = sql();
        const row = found((await db.query("SELECT id,version,configuration_refs FROM leads WHERE id=$1 AND deleted_at IS NULL AND source='内推' FOR UPDATE", [targetId])).rows[0]);
        if (row.version !== b.version)
            fail(409, "version_conflict");
        const before = row.configuration_refs?.toolkit?.referral || {};
        const { version: _v, ...patch } = b;
        const next = { ...before, ...patch, updatedBy: req.actor.id, updatedAt: new Date().toISOString() };
        const updated = await db.query(`UPDATE leads SET configuration_refs=jsonb_set(
         jsonb_set(coalesce(configuration_refs,'{}'::jsonb),'{toolkit}',coalesce(configuration_refs->'toolkit','{}'::jsonb),true),
         '{toolkit,referral}',$2::jsonb,true),
         version=version+1,updated_at=now()
       WHERE id=$1 AND version=$3 RETURNING version`, [targetId, JSON.stringify(next), b.version]);
        if (!updated.rowCount)
            fail(409, "version_conflict");
        await id.audit(db, req.actor.id, "referral.update", targetId, {
            fields: Object.keys(patch),
            computed: computeReferral(next).score,
        });
        return { id: targetId, version: updated.rows[0].version, computed: computeReferral(next) };
    }));
}
//# sourceMappingURL=routes.js.map