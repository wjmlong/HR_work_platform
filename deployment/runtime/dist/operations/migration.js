import { queueMatch } from '../business-config/bindings.js';
import { createHash } from "node:crypto";
import { Identity, requireRole } from "../identity/service.js";
import { FeishuProvider } from "../identity/provider.js";
import { encodeRaw, parseProfile } from "../parsing/profile.js";
import { profileInput, requirementsInput } from "../recruiting/schema.js";
import { encodeJSON } from "../parsing/json.js";
import { applyCorrections } from "../parsing/corrections.js";
import { Dictionary } from "../dictionary/service.js";
import { fail } from "../http/errors.js";
import { validScore } from "../interviews/scores.js";
const statuses = {
    待筛选: "screening",
    初筛通过: "screened",
    面试中: "interviewing",
    资料收集中: "collecting",
    背调中: "background_check",
    已发Offer: "offered",
    已发offer: "offered",
    "已发 offer": "offered",
    已入职: "hired",
    已淘汰: "rejected",
    录用终止: "terminated",
};
const educationNames = {
    不限: "none",
    "高中/中专": "secondary",
    高中: "secondary",
    中专: "secondary",
    大专: "associate",
    本科: "bachelor",
    硕士: "master",
    博士: "doctor",
};
export const instant = (v) => {
    if (v === undefined || v === null || v === "")
        return null;
    const date = new Date(typeof v === "number" ? v : String(v));
    return Number.isFinite(date.getTime()) ? date : null;
};
export function legacyProfile(t, parsed) {
    const p = { ...parsed };
    const keys = {
        name: "name",
        phone: "phone",
        email: "email",
        school: "school",
        bachelorSchool: "bachelorSchool",
        major: "major",
        city: "location",
        intent: "intent",
        expect: "expectedSalary",
        gender: "gender",
    };
    for (const [old, key] of Object.entries(keys))
        if (Object.hasOwn(t, old))
            p[key] = safe(t[old]);
    if (Object.hasOwn(t, "edu"))
        p.education = educationNames[t.edu] || null;
    if (Object.hasOwn(t, "years"))
        p.experienceYears = typeof t.years === "number" ? t.years : null;
    if (Object.hasOwn(t, "age"))
        p.age = typeof t.age === "number" ? t.age : null;
    if (Object.hasOwn(t, "firstJobYear"))
        p.firstEmployment = t.firstJobYear === null ? null : String(t.firstJobYear);
    for (const key of ["skills", "companies"])
        if (Object.hasOwn(t, key))
            p[key] = Array.isArray(t[key])
                ? t[key].filter((v) => typeof v === "string").map(safe)
                : typeof t[key] === "string"
                    ? [safe(t[key])]
                    : [];
    return p;
}
export const safe = (v) => typeof v === "string"
    ? v
        .replace(/\0/g, "")
        .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD")
    : ""; // derived fields only; original remains byte-exact in archive.
export async function migrateLegacy(db, store, a, bundle, dryRun = true, interviewerMapping = {}) {
    requireRole(a, "admin");
    const bytes = encodeRaw(JSON.stringify(bundle)), sha = createHash("sha256").update(bytes).digest("hex"), data = bundle?.data || bundle, jobs = data?.jobs, talents = data?.talents, interviews = data?.interviews;
    if (!Array.isArray(jobs) ||
        !Array.isArray(talents) ||
        !Array.isArray(interviews))
        fail(422, "invalid_legacy_bundle");
    const conflicts = [], warnings = [];
    const preparedJobFields = new Map();
    for (const j of jobs) {
        const field = (name, aliases = []) => {
            const keys = [name, ...aliases].filter(key => Object.hasOwn(j, key));
            if (new Set(keys.map(key => JSON.stringify(j[key]))).size > 1)
                conflicts.push('conflicting_job_aliases:' + name);
            return keys.length ? j[keys[0]] : undefined;
        };
        const count = field('headcount', ['count']) ?? 1;
        const statusOpen = j.status === undefined ? undefined :
            { 在招: true, 已关闭: false }[j.status];
        if (j.status !== undefined && statusOpen === undefined)
            conflicts.push('invalid_job_status');
        if (Object.hasOwn(j, 'open') && typeof j.open !== 'boolean')
            conflicts.push('invalid_job_open');
        if (typeof j.open === 'boolean' && statusOpen !== undefined && j.open !== statusOpen)
            conflicts.push('conflicting_job_aliases:open');
        if (!Number.isInteger(count) || count < 1)
            conflicts.push('invalid_job_headcount');
        if (j.closedAt && !instant(j.closedAt))
            conflicts.push('invalid_job_closed_at');
        preparedJobFields.set(j.id, {
            count, open: j.open ?? statusOpen ?? true,
            department: safe(field('department', ['dept'])),
            salary: safe(field('salaryRange', ['salary'])),
            market: safe(field('marketSalary', ['mktSalary'])),
            marketSource: safe(field('marketSource', ['mktSource'])),
            salaryNote: safe(j.salaryNote), closeReason: safe(j.closeReason) || null, closedAt: instant(j.closedAt),
        });
    }
    // Unknown credential-bearing campus payloads cannot be archived as plaintext.
    const secretKey = (v) => !!v &&
        typeof v === "object" &&
        Object.entries(v).some(([k, x]) => /^(?:password|passwd|pwd|campusAccount|campusPassword)$/i.test(k) ||
            (typeof x === "object" && secretKey(x)));
    if (secretKey(bundle) ||
        (Array.isArray(data.campuses) && data.campuses.length))
        conflicts.push("campus_credentials_require_encrypted_import");
    if (talents.length)
        warnings.push("original_binary_unavailable");
    const jobIds = new Set(jobs.map((j) => j.id));
    if (jobIds.size !== jobs.length)
        conflicts.push("duplicate_job_ids");
    if (new Set(talents.map((t) => t.id)).size !== talents.length)
        conflicts.push("duplicate_talent_ids");
    for (const j of jobs)
        if (typeof j.id !== "string" || !safe(j.name).trim())
            conflicts.push("invalid_job");
    for (const t of talents) {
        if (typeof t.id !== "string" || !safe(t.name).trim())
            conflicts.push("invalid_talent");
        if (!jobIds.has(t.jobId))
            conflicts.push("missing_job_relation");
        if (!statuses[t.status])
            conflicts.push("unknown_application_stage");
        if (typeof t.raw !== "string" || !t.raw.trim())
            conflicts.push("resume_text_requires_review");
    }
    const preparedInterviews = [];
    const approvedUsers = new Set((await db.query("SELECT id FROM users WHERE status='active' AND directory_active")).rows.map((x) => x.id));
    for (const i of interviews) {
        const interviewer = interviewerMapping[safe(i.who)], round = typeof i.round === "number"
            ? i.round
            : { 一面: 1, 二面: 2, 三面: 3 }[i.round] ||
                Number(String(i.round).match(/^(\d+)(?:面|轮)?$/)?.[1]), starts = typeof i.startsAt === "string"
            ? instant(i.startsAt)
            : /^\d{4}-\d{2}-\d{2}$/.test(i.date) && /^\d{2}:\d{2}$/.test(i.time)
                ? instant(i.date + "T" + i.time + ":00+08:00")
                : null, status = {
            待进行: "pending",
            已通过: "passed",
            未通过: "failed",
            已取消: "cancelled",
            已完成: "legacy_completed",
        }[i.status], duration = i.durationMinutes ?? 60;
        if (!interviewer || !approvedUsers.has(interviewer))
            conflicts.push("interviewer_identity_mapping_required");
        if (!talents.some((t) => t.id === i.candId) ||
            !Number.isInteger(round) ||
            round < 1 ||
            !starts ||
            !status ||
            !Number.isInteger(duration) ||
            duration < 5 ||
            duration > 480)
            conflicts.push("interview_round_date_status_mapping_required");
        if (i.durationMinutes === undefined)
            warnings.push("legacy_interview_duration_60_minutes_requires_confirmation");
        if (!i.startsAt)
            warnings.push("legacy_interview_local_time_Asia_Shanghai");
        const evaluation = {};
        for (const [legacy, current] of Object.entries({ d1: 'professional', d2: 'communication', d3: 'logicalThinking', d4: 'culturalFit' })) {
            const value = i.scores?.[legacy];
            if (validScore(value))
                evaluation[current] = value;
            else if (value !== undefined && value !== null && value !== '')
                warnings.push('invalid_legacy_score_discarded');
        }
        if (safe(i.cover))
            evaluation.questionCoverage = safe(i.cover);
        if (Object.keys(evaluation).length) {
            evaluation.evidenceNotes = safe(i.fb);
            evaluation.legacyProvenance = { kind: 'legacy_import', sourceHash: sha, sourceInterviewId: safe(i.id) || null, originalOperator: 'unknown', originalRecordedAt: 'unknown', subjectMapping: 'explicit_primary_interviewer', importedBy: a.id };
            warnings.push('legacy_evaluation_original_operator_unknown');
        }
        preparedInterviews.push({
            source: i,
            interviewer,
            round,
            starts,
            status,
            duration,
            evaluation,
        });
    }
    const contacts = new Set(), preparedJobs = new Map(), preparedTalents = new Map();
    const aliases = (await new Dictionary(db).list()).map((x) => ({
        name: x.name,
        aliases: x.aliases,
    }));
    for (const j of jobs) {
        const experience = safe(j.exp).match(/(\d+(?:\.\d+)?)\s*(?:[-–~至]\s*(\d+(?:\.\d+)?))?\s*年/);
        const validation = requirementsInput.safeParse({
            skills: Array.isArray(j.skills)
                ? j.skills.filter((s) => typeof s === "string").map(safe)
                : [],
            experienceYears: typeof j.years === "number"
                ? j.years
                : experience
                    ? Number(experience[1])
                    : null,
            experienceMaxYears: experience?.[2] ? Number(experience[2]) : null,
            experienceDescription: safe(j.exp),
            schoolPreferences: Array.isArray(j.school)
                ? j.school.filter((s) => typeof s === "string").map(safe)
                : safe(j.school).trim()
                    ? [safe(j.school).trim()]
                    : [],
            education: educationNames[j.edu] || null,
            description: safe(j.jd || j.description),
        });
        if (!validation.success)
            conflicts.push("invalid_job_requirements");
        else
            preparedJobs.set(j.id, validation.data);
    }
    for (const t of talents) {
        if (typeof t.raw !== "string")
            continue;
        const parsed = parseProfile(t.raw, aliases), validation = profileInput.safeParse({
            ...legacyProfile(t, parsed.profile),
        });
        if (!validation.success)
            conflicts.push("invalid_candidate_profile");
        else {
            const corrections = Object.entries(validation.data)
                .filter(([key, value]) => JSON.stringify(value) !==
                JSON.stringify(parsed.profile[key]))
                .map(([field, value]) => ({
                field,
                value,
                actorId: a.id,
                reason: "历史结构化字段导入；原操作人及更正依据未提供",
                at: (instant(t.updated) || new Date()).toISOString(),
            }));
            const corrected = applyCorrections(parsed, corrections);
            preparedTalents.set(t.id, {
                parsed: corrected,
                profile: validation.data,
                evidence: encodeJSON(corrected.evidence),
                corrections,
            });
        }
        for (const contact of [parsed.profile.phone, parsed.profile.email].filter(Boolean)) {
            if (contacts.has(contact))
                warnings.push("duplicate_contact_kept_separate");
            contacts.add(contact);
        }
    }
    const report = {
        sourceHash: sha,
        sourceRevision: String(bundle.revision ?? bundle.rev ?? "unknown"),
        ready: !conflicts.length,
        counts: {
            jobs: jobs.length,
            candidates: talents.length,
            applications: talents.length,
            interviews: interviews.length,
        },
        conflicts: [...new Set(conflicts)],
        warnings: [...new Set(warnings)],
    };
    if (dryRun)
        return report;
    if (conflicts.length)
        fail(409, "migration_conflicts");
    const identity = new Identity(db, db.config, new FeishuProvider(db.config));
    return db.tx(async (c) => {
        await c.query("SELECT pg_advisory_xact_lock(hashtextextended('legacy-import',0))");
        if ((await c.query("SELECT 1 FROM migration_receipts WHERE source_sha256=$1", [sha])).rowCount)
            return { ...report, alreadyImported: true, imported: false };
        const existing = (await c.query("SELECT (SELECT count(*) FROM candidates)+(SELECT count(*) FROM jobs)+(SELECT count(*) FROM applications) total")).rows[0];
        if (Number(existing.total))
            fail(409, "migration_target_not_empty");
        await c.query("INSERT INTO migration_receipts(source_sha256,source_revision,manifest) VALUES($1,$2,$3)", [sha, report.sourceRevision, report]);
        await c.query("INSERT INTO legacy_archives(source_sha256,kind,source_key,data_bytes) VALUES($1,'bundle','all',$2)", [sha, bytes]);
        const mapping = new Map();
        for (const j of jobs) {
            const requirements = preparedJobs.get(j.id), fields = preparedJobFields.get(j.id), row = (await c.query("INSERT INTO jobs(name,department,headcount,open,level,salary_range,market_salary,market_source,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,coalesce($9,now()),coalesce($10,$9,now())) RETURNING id", [
                safe(j.name),
                fields.department,
                fields.count,
                fields.open,
                [
                    "P4",
                    "P5",
                    "P6",
                    "P7",
                    "P8",
                    "P9",
                    "M1",
                    "M2",
                    "M3",
                    "专业服务",
                ].includes(j.level)
                    ? j.level
                    : null,
                fields.salary,
                fields.marketSource
                    ? fields.market
                    : "",
                fields.marketSource,
                instant(j.created),
                instant(j.updated),
            ])).rows[0];
            await c.query('UPDATE jobs SET salary_note=$2,close_reason=$3,closed_at=$4 WHERE id=$1', [row.id, fields.salaryNote, fields.closeReason, fields.closedAt]);
            await c.query("INSERT INTO job_versions(job_id,version,requirements,actor_id) VALUES($1,1,$2,$3)", [row.id, requirements, a.id]);
            mapping.set(j.id, row.id);
        }
        const applicationMapping = new Map();
        for (const t of talents) {
            const { parsed, profile, evidence, corrections } = preparedTalents.get(t.id), f = await store.put("legacy-resume.txt", encodeRaw(t.raw), "paste");
            const doc = (await c.query("INSERT INTO resume_documents(blob_key,sha256,file_name,file_size,kind,owner_id) VALUES($1,$1,$2,$3,'paste',$4) RETURNING id", [f.sha256, f.name, f.size, a.id])).rows[0], p = (await c.query("INSERT INTO parse_results(document_id,raw_bytes,profile,evidence,parser_version,human_corrections) VALUES($1,$2,$3,$4,$5,$6) RETURNING id", [
                doc.id,
                encodeRaw(t.raw),
                profile,
                evidence,
                "legacy-structured-import-4.0.0",
                encodeJSON(corrections),
            ])).rows[0];
            const person = (await c.query("INSERT INTO candidates(profile,created_at,updated_at) VALUES($1,coalesce($2,now()),coalesce($3,$2,now())) RETURNING *", [profile, instant(t.created), instant(t.updated)])).rows[0], resume = (await c.query("INSERT INTO resume_versions(candidate_id,parse_result_id,created_by) VALUES($1,$2,$3) RETURNING id", [person.id, p.id, a.id])).rows[0], status = statuses[t.status];
            await identity.profileVersion(c, a.id, person);
            const app = (await c.query("INSERT INTO applications(candidate_id,job_id,resume_version_id,status,source,reject_reason,reject_detail,baseline_state,baseline_at,baseline_reject_reason,note,term_reason,term_detail,collected_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$4,coalesce($13,$12,now()),$6,$8,$9,$10,$11,coalesce($12,now()),coalesce($13,$12,now())) RETURNING id", [
                person.id,
                mapping.get(t.jobId),
                resume.id,
                status,
                safe(t.source) || "历史来源未注明",
                status === "rejected" ? safe(t.rejectReason) || null : null,
                status === "rejected" ? safe(t.rejectDetail) || null : null,
                safe(t.note),
                status === "terminated" ? safe(t.termReason) || null : null,
                status === "terminated" ? safe(t.termDetail) || null : null,
                instant(t.collectedAt),
                instant(t.created),
                instant(t.updated),
            ])).rows[0];
            applicationMapping.set(t.id, app.id);
            await queueMatch(identity, c, app.id, a.id, { reason: 'controlled_legacy_import' });
            // The legacy current stage is imported as a fact, not invented process events.
            await c.query("INSERT INTO legacy_archives(source_sha256,kind,source_key,data_bytes) VALUES($1,'mapping',$2,$3)", [
                sha,
                t.id,
                encodeRaw(JSON.stringify({
                    legacyTalentId: t.id,
                    candidateId: person.id,
                    resumeVersionId: resume.id,
                    applicationId: app.id,
                    status,
                })),
            ]);
        }
        for (const i of preparedInterviews) {
            const row = (await c.query("INSERT INTO interviews(application_id,round,starts_at,duration_minutes,form,status,created_by,primary_interviewer_id,location,feedback) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id", [
                applicationMapping.get(i.source.candId),
                i.round,
                i.starts,
                i.duration,
                safe(i.source.way),
                i.status,
                a.id,
                i.interviewer,
                safe(i.source.where),
                safe(i.source.fb),
            ])).rows[0];
            await c.query("INSERT INTO interviewers(interview_id,user_id) VALUES($1,$2)", [row.id, i.interviewer]);
            if (Object.keys(i.evaluation).length) {
                const evaluation = (await c.query("INSERT INTO evaluations(interview_id,author_id,status,data,last_editor_id) VALUES($1,$2,'submitted',$3,$4) RETURNING id", [row.id, i.interviewer, i.evaluation, a.id])).rows[0];
                await c.query("INSERT INTO evaluation_versions(evaluation_id,version,data,status,editor_id) VALUES($1,1,$2,'submitted',$3)", [evaluation.id, i.evaluation, a.id]);
            }
        }
        await identity.audit(c, a.id, "migration.import", sha, {
            counts: report.counts,
        });
        return { ...report, imported: true, alreadyImported: false };
    });
}
//# sourceMappingURL=migration.js.map