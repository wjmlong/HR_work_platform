import { inheritResumeFields, loadDefinition } from '../business-config/fields.js';
import { queueMatch, lockMatchingCandidateJobs } from '../business-config/bindings.js';
import { legacyDefinition, assertLegacyField, assertLegacySource } from '../business-config/legacy-fields.js';
import { readApplications } from "./query.js";
import { createHash } from "node:crypto";
import { requireRole } from "../identity/service.js";
import { parse, z, uuid } from "../http/validation.js";
import { fail, found } from "../http/errors.js";
import { Dictionary } from "../dictionary/service.js";
import { parseProfile, decodeRaw } from "../parsing/profile.js";
import { applyCorrections } from "../parsing/corrections.js";
import { encodeJSON, decodeJSON } from "../parsing/json.js";
import { csvDocument } from "../http/csv.js";
const writers = ["admin", "manager", "recruiter"];
export const mergePreviewInput = z
    .object({
    sourceId: uuid,
    targetId: uuid,
    keepApplicationId: uuid.optional(),
})
    .strict();
export const mergeInput = mergePreviewInput
    .extend({
    previewHash: z.string().regex(/^[a-f0-9]{64}$/),
    confirm: z.boolean(),
    backupAcknowledged: z.boolean(),
})
    .strict();
export const reparseApplyInput = z
    .object({
    previewId: uuid,
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    confirm: z.boolean(),
})
    .strict();
export const ledgerInput = z
    .object({
    jobId: uuid.optional(),
    query: z.string().max(300).default(""),
    status: z.string().max(30).optional(),
    education: z.string().max(30).optional(),
    skill: z.string().max(100).optional(),
    flow: z.enum(["all", "transferred", "never"]).default("all"),
})
    .strict();
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const normal = (value) => value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, "");
const edu = {
    none: "",
    secondary: "高中/中专",
    associate: "大专",
    bachelor: "本科",
    master: "硕士",
    doctor: "博士",
};
export class CandidateTools {
    identity;
    constructor(identity) {
        this.identity = identity;
    }
    get db() {
        return this.identity.db;
    }
    async scan(a) {
        requireRole(a, ...writers);
        await assertLegacySource(this.identity, a, ['resume', 'application'], false);
        const rows = (await this.db.query("SELECT c.id,c.version,c.profile,ARRAY(SELECT DISTINCT d.sha256 FROM resume_versions r JOIN parse_results p ON p.id=r.parse_result_id JOIN resume_documents d ON d.id=p.document_id WHERE r.candidate_id=c.id) fingerprints FROM candidates c WHERE c.deleted_at IS NULL ORDER BY c.id")).rows;
        const parents = new Map(rows.map((row) => [row.id, row.id])), buckets = new Map(), edges = new Map();
        const root = (id) => {
            let p = id;
            while (parents.get(p) !== p)
                p = parents.get(p);
            return p;
        };
        const connect = (left, right, confidence, reason) => {
            const rank = { high: 0, medium: 1, low: 2 }[confidence], ids = [left.id, right.id].sort(), key = ids.join(":");
            const old = edges.get(key);
            if (!old || rank < old.rank)
                edges.set(key, { ids, rank, confidence, reason });
            parents.set(root(right.id), root(left.id));
        };
        for (const row of rows) {
            const p = row.profile;
            const keys = [
                ...(row.fingerprints || []).map((fp) => ["file:" + fp, "high"]),
                ...(p.email ? [["email:" + normal(p.email), "high"]] : []),
                ...(String(p.phone || "").replace(/\D/g, "")
                    ? [["phone:" + String(p.phone).replace(/\D/g, ""), "high"]]
                    : []),
                ...(p.name && p.name !== "待确认"
                    ? [["name:" + normal(p.name), "low"]]
                    : []),
            ];
            for (const [key, grade] of keys) {
                const list = buckets.get(key) || [];
                if (list.length) {
                    const peer = list[0];
                    const confidence = grade === "low" && p.school && p.school === peer.profile.school
                        ? "medium"
                        : grade;
                    connect(peer, row, confidence, key.split(":")[0]);
                }
                list.push(row);
                buckets.set(key, list);
            }
        }
        const groups = new Map();
        for (const row of rows) {
            const key = root(row.id);
            const list = groups.get(key) || [];
            list.push(row);
            groups.set(key, list);
        }
        return {
            scanned: rows.length,
            groups: [...groups.values()]
                .filter((group) => group.length > 1)
                .map((group) => {
                const ids = group.map((row) => row.id);
                const related = [...edges.values()].filter((edge) => edge.ids.every((id) => ids.includes(id)));
                const rank = Math.max(...related.map((edge) => edge.rank));
                return {
                    candidateIds: ids,
                    confidence: rank === 0 ? "high" : rank === 1 ? "medium" : "low",
                    candidates: group.map((row) => ({
                        id: row.id,
                        version: row.version,
                        profile: row.profile,
                    })),
                    reasons: [...new Set(related.map((edge) => edge.reason))],
                };
            }),
            statement: "扫描只列疑似重复，不能据此自动合并。合并前需对照原文与资料并备份。",
        };
    }
    async mergeState(c, b, lock = false) {
        if (b.sourceId === b.targetId)
            fail(422, "merge_same_candidate");
        const candidates = (await c.query("SELECT * FROM candidates WHERE id=ANY($1::uuid[]) ORDER BY id" +
            (lock ? " FOR UPDATE" : ""), [[b.sourceId, b.targetId]])).rows;
        if (candidates.length !== 2 ||
            candidates.some((row) => row.deleted_at || row.merged_into_id))
            fail(409, "merge_candidate_unavailable");
        const applications = (await c.query("SELECT * FROM applications WHERE candidate_id=ANY($1::uuid[]) ORDER BY id" +
            (lock ? " FOR UPDATE" : ""), [[b.sourceId, b.targetId]])).rows;
        if (b.keepApplicationId &&
            !applications.some((row) => row.id === b.keepApplicationId && row.is_current && !row.deleted_at))
            fail(422, "merge_current_choice_required");
        if (applications.some((row) => row.is_current && !row.deleted_at) &&
            !b.keepApplicationId)
            fail(422, "merge_current_choice_required");
        const resumes = (await c.query("SELECT id,candidate_id,parse_result_id FROM resume_versions WHERE candidate_id=ANY($1::uuid[]) ORDER BY id", [[b.sourceId, b.targetId]])).rows;
        const source = candidates.find((row) => row.id === b.sourceId), target = candidates.find((row) => row.id === b.targetId);
        return {
            source,
            target,
            applications,
            resumes,
            keepApplicationId: b.keepApplicationId || null,
        };
    }
    async mergePreview(a, input) {
        requireRole(a, ...writers);
        await assertLegacySource(this.identity, a, ['resume', 'application'], false);
        const b = parse(mergePreviewInput, input);
        return this.db.tx(async (c) => {
            const state = await this.mergeState(c, b);
            return {
                ...state,
                hash: digest(state),
                backupRequired: true,
                warning: "合并无法通过业务界面撤销；请先备份，并明确保留哪条当前流程。所有原件、评估与流程历史仍保留。",
            };
        });
    }
    async merge(a, input) {
        requireRole(a, ...writers);
        await assertLegacySource(this.identity, a, ['resume', 'application'], true);
        const b = parse(mergeInput, input);
        if (!b.confirm)
            fail(409, "merge_confirmation");
        if (!b.backupAcknowledged)
            fail(409, "merge_backup_acknowledgment");
        return this.db.tx(async (c) => {
            const state = await this.mergeState(c, b, true);
            if (digest(state) !== b.previewHash)
                fail(409, "merge_preview_stale");
            const ids = [b.sourceId, b.targetId];
            await c.query("UPDATE applications SET is_current=false,version=version+1 WHERE candidate_id=ANY($1::uuid[]) AND is_current", [ids]);
            await c.query("UPDATE applications SET candidate_id=$2,version=version+1 WHERE candidate_id=$1", [b.sourceId, b.targetId]);
            await c.query("UPDATE resume_versions SET candidate_id=$2 WHERE candidate_id=$1", [b.sourceId, b.targetId]);
            if (b.keepApplicationId)
                await c.query("UPDATE applications SET is_current=true,version=version+1 WHERE id=$1", [b.keepApplicationId]);
            const source = (await c.query("UPDATE candidates SET merged_into_id=$2,deleted_at=now(),version=version+1,updated_at=now() WHERE id=$1 RETURNING *", [b.sourceId, b.targetId])).rows[0];
            const target = (await c.query("UPDATE candidates SET version=version+1,updated_at=now() WHERE id=$1 RETURNING *", [b.targetId])).rows[0];
            await this.identity.profileVersion(c, a.id, source);
            await this.identity.profileVersion(c, a.id, target);
            const receipt = (await c.query("INSERT INTO candidate_merges(source_id,target_id,keep_application_id,actor_id,source_snapshot,target_snapshot,manifest) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id", [
                b.sourceId,
                b.targetId,
                b.keepApplicationId || null,
                a.id,
                state.source,
                state.target,
                {
                    applicationIds: state.applications.map((row) => row.id),
                    resumeIds: state.resumes.map((row) => row.id),
                    previewHash: b.previewHash,
                },
            ])).rows[0];
            await this.identity.audit(c, a.id, "candidate.merge", b.targetId, {
                sourceId: b.sourceId,
                receiptId: receipt.id,
                keepApplicationId: b.keepApplicationId || null,
            });
            return {
                candidateId: b.targetId,
                mergedId: b.sourceId,
                currentApplicationId: b.keepApplicationId || null,
                receiptId: receipt.id,
            };
        });
    }
    async reparsePreview(a) {
        requireRole(a, ...writers);
        await assertLegacySource(this.identity, a, ['resume', 'application'], false);
        return this.db.tx(async (c) => {
            const dictionaryVersion = (await c.query("SELECT version FROM dictionary_versions WHERE id=1 FOR SHARE")).rows[0].version;
            const aliases = (await new Dictionary(this.db).list()).map((row) => ({
                name: row.name,
                aliases: row.aliases,
            }));
            const items = [];
            let cursor = null;
            for (;;) {
                const rows = (await c.query("SELECT c.id candidate_id,c.version candidate_version,c.profile,a.id application_id,a.version application_version,a.resume_version_id,r.id resume_id,p.id parse_id,p.document_id,p.raw_bytes,p.human_corrections,p.profile parsed_profile,p.evidence,p.parser_version,p.recognition FROM candidates c LEFT JOIN applications a ON a.candidate_id=c.id AND a.is_current AND a.deleted_at IS NULL LEFT JOIN LATERAL(SELECT id,parse_result_id FROM resume_versions r WHERE r.candidate_id=c.id ORDER BY (r.id=a.resume_version_id) DESC NULLS LAST,r.created_at DESC,r.id DESC LIMIT 1) r ON true LEFT JOIN parse_results p ON p.id=r.parse_result_id WHERE c.deleted_at IS NULL AND ($1::uuid IS NULL OR c.id>$1) ORDER BY c.id LIMIT 100", [cursor])).rows;
                for (const row of rows) {
                    if (!row.resume_id || !row.raw_bytes) {
                        items.push({
                            candidateId: row.candidate_id,
                            name: row.profile.name,
                            skip: "resume_missing",
                        });
                        continue;
                    }
                    const raw = decodeRaw(row.raw_bytes), parsed = applyCorrections(row.parser_version?.startsWith('deepseek-vision-') ? { profile: structuredClone(row.parsed_profile), evidence: decodeJSON(row.evidence), parserVersion: row.parser_version, warnings: [] } : parseProfile(raw, aliases), row.human_corrections || []);
                    const changes = Object.fromEntries(Object.keys(parsed.profile)
                        .filter((key) => JSON.stringify(parsed.profile[key]) !==
                        JSON.stringify(row.profile[key]))
                        .map((key) => [
                        key,
                        {
                            before: row.profile[key] ?? null,
                            after: parsed.profile[key],
                        },
                    ]));
                    items.push({
                        candidateId: row.candidate_id,
                        name: row.profile.name,
                        candidateVersion: row.candidate_version,
                        applicationId: row.application_id || null,
                        applicationVersion: row.application_version || null,
                        adoptedResumeId: row.resume_version_id || null,
                        resumeId: row.resume_id,
                        parseId: row.parse_id,
                        profile: parsed.profile,
                        changes,
                        parserVersion: parsed.parserVersion,
                    });
                }
                if (rows.length < 100)
                    break;
                cursor = rows.at(-1).candidate_id;
            }
            const payload = { dictionaryVersion, aliases, items }, hash = digest(payload), preview = (await c.query("INSERT INTO reparse_previews(actor_id,hash,payload) VALUES($1,$2,$3) RETURNING id,expires_at", [a.id, hash, payload])).rows[0];
            return {
                id: preview.id,
                hash,
                expiresAt: preview.expires_at,
                total: items.length,
                changed: items.filter((item) => !item.skip && Object.keys(item.changes).length).length,
                items: items.map(({ profile, ...item }) => item),
                statement: "仅刷新解析画像与采用的新简历版本；岗位、环节、来源、备注、抄送、淘汰和终止历史全部保留。并发改变的记录会跳过。",
            };
        });
    }
    async readReparsePreview(a, id) { requireRole(a, ...writers); await assertLegacySource(this.identity, a, ['resume', 'application']); const row = found((await this.db.query('SELECT * FROM reparse_previews WHERE id=$1 AND actor_id=$2', [id, a.id])).rows[0]), items = row.payload.items; return { id: row.id, hash: row.hash, expiresAt: row.expires_at, total: items.length, changed: items.filter((i) => !i.skip && Object.keys(i.changes).length).length, items: items.map(({ profile, ...i }) => i), statement: '仅刷新解析画像与采用的新简历版本；岗位、环节、来源、备注、抄送、淘汰和终止历史全部保留。并发改变的记录会跳过。' }; }
    async reparseApply(a, input) {
        requireRole(a, ...writers);
        await assertLegacySource(this.identity, a, ['resume', 'application'], true);
        const b = parse(reparseApplyInput, input);
        if (!b.confirm)
            fail(409, "reparse_confirmation");
        return this.db.tx(async (c) => {
            const preview = found((await c.query("SELECT * FROM reparse_previews WHERE id=$1 AND actor_id=$2 FOR UPDATE", [b.previewId, a.id])).rows[0]);
            if (preview.applied_at ||
                new Date(preview.expires_at).getTime() < Date.now() ||
                preview.hash !== b.hash)
                fail(409, "reparse_preview_stale");
            const payload = preview.payload;
            await lockMatchingCandidateJobs(c, payload.items.filter((item) => !item.skip).map((item) => item.candidateId));
            if ((await c.query("SELECT version FROM dictionary_versions WHERE id=1 FOR SHARE")).rows[0].version !== payload.dictionaryVersion)
                fail(409, "reparse_preview_stale");
            let updated = 0;
            const skipped = [];
            for (const item of payload.items) {
                if (item.skip) {
                    skipped.push({ candidateId: item.candidateId, reason: item.skip });
                    continue;
                }
                const person = (await c.query("SELECT * FROM candidates WHERE id=$1 FOR UPDATE", [
                    item.candidateId,
                ])).rows[0];
                const app = (await c.query("SELECT * FROM applications WHERE candidate_id=$1 AND is_current AND deleted_at IS NULL FOR UPDATE", [item.candidateId])).rows[0];
                if (!person ||
                    person.deleted_at ||
                    person.version !== item.candidateVersion ||
                    (app?.id || null) !== item.applicationId ||
                    (app?.version || null) !== item.applicationVersion ||
                    (app?.resume_version_id || null) !== item.adoptedResumeId) {
                    skipped.push({
                        candidateId: item.candidateId,
                        reason: "version_conflict",
                    });
                    continue;
                }
                const original = found((await c.query("SELECT * FROM parse_results WHERE id=$1", [
                    item.parseId,
                ])).rows[0]), raw = decodeRaw(original.raw_bytes), parsed = applyCorrections(original.parser_version?.startsWith('deepseek-vision-') ? { profile: structuredClone(original.profile), evidence: decodeJSON(original.evidence), parserVersion: original.parser_version, warnings: [] } : parseProfile(raw, payload.aliases), original.human_corrections || []);
                const parseResult = (await c.query("INSERT INTO parse_results(document_id,raw_bytes,profile,evidence,parser_version,human_corrections,recognition) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id", [
                    original.document_id,
                    original.raw_bytes,
                    parsed.profile,
                    encodeJSON(parsed.evidence),
                    parsed.parserVersion,
                    JSON.stringify(original.human_corrections || []),
                    original.recognition,
                ])).rows[0];
                const resume = (await c.query("INSERT INTO resume_versions(candidate_id,parse_result_id,created_by,parent_id) VALUES($1,$2,$3,$4) RETURNING id", [person.id, parseResult.id, a.id, item.resumeId])).rows[0];
                await inheritResumeFields(this.identity, a, item.resumeId, resume.id, c);
                const fieldDefinition = await loadDefinition(this.identity, 'resume', c, a);
                await c.query('UPDATE resume_versions SET configuration_refs=$2 WHERE id=$1', [resume.id, { fields: fieldDefinition.ref, origin: 'explicit_reparse' }]);
                const next = (await c.query("UPDATE candidates SET profile=$2,version=version+1,updated_at=now() WHERE id=$1 RETURNING *", [person.id, parsed.profile])).rows[0];
                await this.identity.profileVersion(c, a.id, next);
                if (app) {
                    await c.query("UPDATE applications SET resume_version_id=$2,version=version+1,updated_at=now() WHERE id=$1", [app.id, resume.id]);
                    await queueMatch(this.identity, c, app.id, a.id);
                }
                updated++;
            }
            await c.query("UPDATE reparse_previews SET applied_at=now() WHERE id=$1", [preview.id]);
            await this.identity.audit(c, a.id, "candidate.bulk_reparse", preview.id, {
                updated,
                skipped: skipped.length,
            });
            return { updated, skipped };
        });
    }
    async ledger(a, input) {
        const definition = await legacyDefinition(this.identity, a, 'resume');
        for (const key of ['name', 'phone', 'email', 'school', 'bachelorSchool', 'major', 'education', 'experienceYears', 'skills', 'expectedSalary'])
            assertLegacyField(definition, a, key, 'export');
        requireRole(a, ...writers);
        const b = parse(ledgerInput, input);
        const { items: unsorted } = await readApplications(this.identity, a, b, true);
        const rows = unsorted.sort((x, y) => x.job_name.localeCompare(y.job_name, "zh-CN") ||
            new Date(x.candidate_created_at).getTime() -
                new Date(y.candidate_created_at).getTime() ||
            x.id.localeCompare(y.id));
        const rank = {
            screening: 0,
            screened: 1,
            interviewing: 2,
            collecting: 3,
            background_check: 4,
            offered: 5,
            hired: 6,
        };
        const columns = [
            "序号",
            "岗位名称",
            "姓名",
            "性别",
            "年龄",
            "学历",
            "最高学历毕业院校",
            "本科毕业院校",
            "工作经历",
            "初次就业时间",
            "工作年限",
            "初筛",
            "面试",
            "offer",
            "入职",
        ];
        const csv = csvDocument([
            columns,
            ...rows.map((row, n) => {
                const p = row.profile, r = rank[row.status] ?? -1;
                const screen = row.status === "rejected"
                    ? "已淘汰：" + (row.reject_reason || "历史未注明")
                    : r >= 1
                        ? "通过"
                        : "";
                const interview = r >= 3 ? "通过" : r === 2 ? "进行中" : "";
                const offer = row.status === "hired_other" ? "录用到其他（非本公司 offer）" : row.status === "on_hold" ? "待定" : row.status === "reserve" ? "人才储备" : row.status === "terminated"
                    ? "录用终止：" + (row.term_reason || "历史未注明")
                    : r >= 5
                        ? "已发"
                        : "";
                return [
                    n + 1,
                    row.job_name,
                    p.name || "",
                    p.gender || "",
                    p.age ?? "",
                    edu[p.education] || "",
                    p.school || "",
                    p.bachelorSchool || "",
                    (p.companies || []).join(" / "),
                    p.firstEmployment || "",
                    p.experienceYears ?? "",
                    screen,
                    interview,
                    offer,
                    r === 6 ? "已入职" : "",
                ];
            }),
        ]);
        await this.db.tx((c) => this.identity.audit(c, a.id, "candidate.ledger_export", "ledger", {
            count: rows.length,
        }));
        return csv;
    }
}
//# sourceMappingURL=tools.js.map