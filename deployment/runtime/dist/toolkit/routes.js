import { assertLegacySource, assertLegacyField, legacyDefinition } from '../business-config/legacy-fields.js';
import { toolkitProjection, assertToolkitWrite } from './access.js';
import { ConfiguredRecruiting, jobCore } from '../business-config/recruiting.js';
import { loadDefinition } from '../business-config/fields.js';
import { fieldAllowed } from '../business-config/access.js';
import { BusinessConfigService } from '../business-config/service.js';
import { requireRole } from "../identity/service.js";
import { parse, z, uuid, version } from "../http/validation.js";
import { fail, found } from "../http/errors.js";
// 「招聘助手」：只读聚合 + 结构化补充数据落库。
// 补充数据统一写进业务表已有的 configuration_refs->toolkit，随业务表一起进入 SQL 备份，
// 不新增表、不改字段定义，避免与配置化写入互相覆盖。
const OFFER_GATES = ["编制确认", "薪资审批", "背调完成", "offer 审批"];
const BACKGROUND_ITEMS = ["学历", "任职起止", "公司主体", "汇报线", "团队规模", "离职原因"];
const MINUTES_ITEMS = ["结论", "证据", "疑点", "下一轮建议", "是否推进"];
const recordInput = z
    .object({
    scope: z.enum(["application", "interview", "job", "candidate"]),
    id: uuid,
    kind: z.enum([
        "offerGates",
        "backgroundCheck",
        "minutes",
        "followup",
        "jobExtras",
        "realName",
        "level",
    ]),
    payload: z.unknown(),
    version: version.optional(),
})
    .strict();
const searchInput = z
    .object({ terms: z.array(z.string().trim().min(1).max(40)).min(1).max(12) })
    .strict();
const savedSearchInput = z
    .object({
    name: z.string().trim().min(1).max(40),
    query: z
        .object({
        search: z.string().max(200).default(""),
        mode: z.string().max(20).default("all"),
        line: z.string().max(20).default("all"),
        filters: z.unknown(),
    })
        .strict(),
})
    .strict();
const removeSearchInput = z.object({ name: z.string().trim().min(1).max(40) }).strict();
export function toolkitRoutes(app, id) {
    const sqlOf = () => id.db.sql;
    const scopeTable = {
        application: "applications",
        interview: "interviews",
        job: "jobs",
    };
    app.get("/api/v4/toolkit/overview", async (req) => {
        requireRole(req.actor, "admin", "manager", "recruiter");
        const sql = sqlOf();
        const { mode } = parse(z.object({ mode: z.enum(["read", "export"]).default("read") }).strict(), req.query);
        // #9 渠道转化 / #8 内推占比
        const channels = (await sql.query(`SELECT coalesce(nullif(trim(a.source),''),'未注明') AS source,
        count(*)::int AS applications,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM interviews i WHERE i.application_id=a.id AND i.deleted_at IS NULL))::int AS interviewed,
        count(*) FILTER (WHERE a.status IN ('offered','hired'))::int AS offered,
        count(*) FILTER (WHERE a.status='hired')::int AS hired
       FROM applications a WHERE a.is_current AND a.deleted_at IS NULL
       GROUP BY 1 ORDER BY applications DESC`)).rows;
        // #22 固定问句快捷查询
        const q = (await sql.query(`SELECT
        (SELECT count(*)::int FROM applications WHERE is_current AND deleted_at IS NULL AND created_at >= date_trunc('week',now())) AS new_this_week,
        (SELECT count(*)::int FROM applications WHERE is_current AND deleted_at IS NULL AND status='screening') AS screening,
        (SELECT count(*)::int FROM jobs WHERE open) AS open_jobs,
        (SELECT count(*)::int FROM applications WHERE is_current AND deleted_at IS NULL AND status='interviewing') AS interviewing,
        (SELECT count(*)::int FROM applications WHERE is_current AND deleted_at IS NULL AND status IN ('offered','hired')) AS offered,
        (SELECT count(*)::int FROM applications WHERE is_current AND deleted_at IS NULL AND status='hired') AS hired,
        (SELECT count(*)::int FROM applications WHERE is_current AND deleted_at IS NULL AND status='rejected') AS rejected,
        (SELECT count(*)::int FROM applications a WHERE a.is_current AND a.deleted_at IS NULL AND a.status='interviewing'
          AND NOT EXISTS (SELECT 1 FROM interviews i WHERE i.application_id=a.id AND i.deleted_at IS NULL AND i.status<>'cancelled' AND i.starts_at>=now())) AS interviewing_without_schedule,
        (SELECT jsonb_build_object('id',j.id,'name',j.name) FROM applications a JOIN jobs j ON j.id=a.job_id
          WHERE a.is_current AND a.deleted_at IS NULL AND a.status='screening'
          GROUP BY j.id,j.name ORDER BY count(*) DESC LIMIT 1) AS bottleneck_job`)).rows[0];
        // P2-10 四套候选人数字口径
        const n = (await sql.query(`SELECT
        (SELECT count(*)::int FROM applications WHERE is_current AND deleted_at IS NULL) AS current_apps,
        (SELECT count(*)::int FROM candidates WHERE deleted_at IS NULL) AS candidates,
        (SELECT count(*)::int FROM applications a JOIN jobs j ON j.id=a.job_id WHERE a.is_current AND a.deleted_at IS NULL AND j.open) AS open_job_apps,
        (SELECT count(*)::int FROM applications WHERE deleted_at IS NULL) AS all_apps`)).rows[0];
        // #17 已发 offer 到岗跟进（跟进记录已落库）
        const offers = (await sql.query(`SELECT a.id,a.version,c.profile->>'name' AS name,j.name AS job_name,a.updated_at,a.created_at,
        a.configuration_refs->'toolkit'->'followup' AS followup
       FROM applications a JOIN candidates c ON c.id=a.candidate_id JOIN jobs j ON j.id=a.job_id
       WHERE a.is_current AND a.deleted_at IS NULL AND a.status='offered'
       ORDER BY a.updated_at DESC LIMIT 50`)).rows;
        // #13 排期后待办（未来面试）+ 前一天提醒
        const todos = (await sql.query(`SELECT i.id,i.version,i.starts_at,i.round,c.profile->>'name' AS name,j.name AS job_name
       FROM interviews i
       JOIN applications a ON a.id=i.application_id AND a.deleted_at IS NULL
       JOIN candidates c ON c.id=a.candidate_id JOIN jobs j ON j.id=a.job_id
       WHERE i.deleted_at IS NULL AND i.status<>'cancelled' AND i.starts_at >= now()
       ORDER BY i.starts_at LIMIT 30`)).rows;
        const tomorrowInterviews = (await sql.query(`SELECT i.id,i.version,i.starts_at,i.round,c.profile->>'name' AS name,j.name AS job_name,i.location
       FROM interviews i
       JOIN applications a ON a.id=i.application_id AND a.deleted_at IS NULL
       JOIN candidates c ON c.id=a.candidate_id JOIN jobs j ON j.id=a.job_id
       WHERE i.deleted_at IS NULL AND i.status<>'cancelled'
         AND i.starts_at >= date_trunc('day',now()) + interval '1 day'
         AND i.starts_at < date_trunc('day',now()) + interval '2 days'
       ORDER BY i.starts_at LIMIT 30`)).rows;
        // P1-8 面试中但无未来排期
        const noSchedule = (await sql.query(`SELECT a.id,a.version,c.profile->>'name' AS name,j.name AS job_name,a.updated_at
       FROM applications a JOIN candidates c ON c.id=a.candidate_id JOIN jobs j ON j.id=a.job_id
       WHERE a.is_current AND a.deleted_at IS NULL AND a.status='interviewing'
         AND NOT EXISTS (SELECT 1 FROM interviews i WHERE i.application_id=a.id AND i.deleted_at IS NULL AND i.status<>'cancelled' AND i.starts_at>=now())
       ORDER BY a.updated_at DESC LIMIT 50`)).rows;
        // #10 背调清单按人 / #18 Offer 前节点按人
        const backgroundApps = (await sql.query(`SELECT a.id,a.version,c.profile->>'name' AS name,j.name AS job_name,a.status,
        a.configuration_refs->'toolkit'->'backgroundCheck' AS checklist
       FROM applications a JOIN candidates c ON c.id=a.candidate_id JOIN jobs j ON j.id=a.job_id
       WHERE a.is_current AND a.deleted_at IS NULL AND a.status='background_check'
       ORDER BY a.updated_at DESC LIMIT 50`)).rows;
        const offerGateApps = (await sql.query(`SELECT a.id,a.version,c.profile->>'name' AS name,j.name AS job_name,a.status,
        a.configuration_refs->'toolkit'->'offerGates' AS gates
       FROM applications a JOIN candidates c ON c.id=a.candidate_id JOIN jobs j ON j.id=a.job_id
       WHERE a.is_current AND a.deleted_at IS NULL
         AND a.status IN ('screened','interviewing','collecting','background_check','offered')
       ORDER BY a.updated_at DESC LIMIT 50`)).rows;
        // #15 面试纪要按场
        const recentInterviews = (await sql.query(`SELECT i.id,i.version,i.starts_at,i.round,c.profile->>'name' AS name,j.name AS job_name,
        i.configuration_refs->'toolkit'->'minutes' AS minutes
       FROM interviews i
       JOIN applications a ON a.id=i.application_id AND a.deleted_at IS NULL
       JOIN candidates c ON c.id=a.candidate_id JOIN jobs j ON j.id=a.job_id
       WHERE i.deleted_at IS NULL ORDER BY i.starts_at DESC LIMIT 30`)).rows;
        // #1 / #3 / #7 / #16 岗位素材（已落库、可检索）
        const jobMaterials = (await sql.query(`SELECT j.id,j.name,j.department,j.headcount,j.level,j.salary_range,j.market_salary,
        j.configuration_refs->'toolkit'->'jobExtras' AS extras,
        (SELECT count(*)::int FROM jobs x WHERE x.open AND x.department=j.department) AS dept_open_jobs,
        (SELECT coalesce(sum(headcount),0)::int FROM jobs x WHERE x.open AND x.department=j.department) AS dept_planned
       FROM jobs j WHERE j.open ORDER BY j.name`)).rows;
        const unleveledJobs = (await sql.query(`SELECT id,name,department,open,version FROM jobs WHERE level IS NULL OR btrim(level)='' ORDER BY name`)).rows;
        // P2-14 平台隐名候选人 + 真实姓名补录状态
        const hiddenNames = (await sql.query(`SELECT c.id,c.version,c.profile,c.profile->>'name' AS name,c.profile->>'realName' AS real_name,
        count(a.id)::int AS applications
       FROM candidates c LEFT JOIN applications a ON a.candidate_id=c.id AND a.is_current AND a.deleted_at IS NULL
       WHERE c.deleted_at IS NULL AND c.profile->>'name' ~ '^[一-龥]{1,2}(先生|女士)$'
       GROUP BY c.id,c.profile ORDER BY applications DESC,c.profile->>'name' LIMIT 50`)).rows;
        for (const item of jobMaterials) {
            const raw = found((await sql.query('SELECT j.*,v.requirements FROM jobs j JOIN job_versions v ON v.job_id=j.id AND v.version=j.requirements_version WHERE j.id=$1', [item.id])).rows[0]);
            const p = await toolkitProjection(id, req.actor, 'job', jobCore(raw), { kind: 'job', id: item.id }, mode);
            for (const key of ['name', 'department', 'headcount', 'level'])
                if (!p.keys.has(key))
                    delete item[key];
            item.extras = { ...(item.extras || {}) };
            for (const [copy, key] of Object.entries({ hardestPoint: 'requirements.description', triples: 'requirements.skills', salaryRange: 'salaryRange' }))
                if (!p.keys.has(key))
                    delete item.extras[copy];
            const def = await loadDefinition(id, 'job', sql, req.actor);
            item.extrasWritable = Object.fromEntries(Object.entries({ hardestPoint: 'requirements.description', triples: 'requirements.skills', salaryRange: 'salaryRange' }).map(([copy, key]) => [copy, p.keys.has(key) && def.fields.some(f => f.coreKey === key && fieldAllowed(f, req.actor, 'write'))]));
            if (!p.keys.has('salaryRange'))
                delete item.salary_range;
            if (!p.keys.has('marketSalary'))
                delete item.market_salary;
            if (!p.keys.has('department')) {
                delete item.dept_open_jobs;
                delete item.dept_planned;
            }
            item.version = raw.version;
        }
        for (const item of unleveledJobs) {
            const p = await toolkitProjection(id, req.actor, 'job', item, { kind: 'job', id: item.id }, mode);
            for (const key of ['name', 'department'])
                if (!p.keys.has(key))
                    delete item[key];
            item.visibleLevel = p.keys.has('level');
        }
        for (const item of hiddenNames) {
            const p = await toolkitProjection(id, req.actor, 'resume', item.profile, undefined, mode);
            if (!p.keys.has('name')) {
                delete item.name;
                delete item.real_name;
            }
            delete item.profile;
        }
        // Names in aggregate cards are copies of configured resume/job fields.
        for (const items of [offers, todos, tomorrowInterviews, noSchedule, backgroundApps, offerGateApps, recentInterviews]) {
            for (const item of items) {
                const interview = [todos, tomorrowInterviews, recentInterviews].includes(items);
                const source = found((await sql.query(interview
                    ? 'SELECT c.profile,j.*,to_jsonb(i) AS interview FROM interviews i JOIN applications a ON a.id=i.application_id JOIN candidates c ON c.id=a.candidate_id JOIN jobs j ON j.id=a.job_id WHERE i.id=$1'
                    : 'SELECT c.profile,j.* FROM applications a JOIN candidates c ON c.id=a.candidate_id JOIN jobs j ON j.id=a.job_id WHERE a.id=$1', [item.id])).rows[0]);
                if (interview) {
                    const raw = source.interview;
                    const p = await toolkitProjection(id, req.actor, 'interview', { ...raw, startsAt: raw.starts_at, durationMinutes: raw.duration_minutes, meetingUrl: raw.meeting_url }, { kind: 'interview', id: item.id }, mode);
                    for (const [copy, key] of Object.entries({ starts_at: 'startsAt', round: 'round', location: 'location', feedback: 'feedback', minutes: 'feedback' }))
                        if (!p.keys.has(key))
                            delete item[copy];
                    if (item.minutes) {
                        const m = item.minutes, fields = await toolkitProjection(id, req.actor, 'evaluation', { summary: m['结论'], evidenceNotes: m['证据'], risks: m['疑点'] }, undefined, mode);
                        if (!['summary', 'evidenceNotes', 'risks'].every(key => fields.keys.has(key)))
                            delete item.minutes;
                    }
                }
                if (!(await toolkitProjection(id, req.actor, 'resume', source.profile, undefined, mode)).keys.has('name'))
                    delete item.name;
                if (!(await toolkitProjection(id, req.actor, 'job', jobCore(source), { kind: 'job', id: source.id }, mode)).keys.has('name'))
                    delete item.job_name;
            }
        }
        const channelGroups = new Map();
        for (const channel of channels) {
            const projected = await toolkitProjection(id, req.actor, 'application', { source: channel.source }, undefined, mode);
            const source = projected.keys.has('source') ? channel.source : '未授权来源', prior = channelGroups.get(source);
            if (prior)
                for (const key of ['applications', 'interviewed', 'offered', 'hired'])
                    prior[key] += channel[key];
            else
                channelGroups.set(source, { ...channel, source });
        }
        if (q.bottleneck_job) {
            const raw = (await sql.query('SELECT * FROM jobs WHERE id=$1', [q.bottleneck_job.id])).rows[0];
            q.bottleneck_job = raw ? (await toolkitProjection(id, req.actor, 'job', jobCore(raw), { kind: 'job', id: raw.id }, mode)).core.name : null;
        }
        if (mode === 'export')
            await id.audit(sql, req.actor.id, 'toolkit.export', null, { scope: 'overview' });
        return {
            channels: [...channelGroups.values()],
            quick: {
                newThisWeek: q.new_this_week,
                screening: q.screening,
                openJobs: q.open_jobs,
                interviewing: q.interviewing,
                offered: q.offered,
                hired: q.hired,
                rejected: q.rejected,
                interviewingWithoutSchedule: q.interviewing_without_schedule,
                bottleneckJob: q.bottleneck_job || "暂无",
                offerConversion: q.offered ? Math.round((q.hired / q.offered) * 100) : 0,
            },
            numberDefinitions: [
                { label: "当前申请数", value: n.current_apps, definition: "applications 中 is_current=true 且未删除的记录；一人多岗按多条计", source: "招聘看板 / 收件箱" },
                { label: "候选人档案数", value: n.candidates, definition: "candidates 中未删除的档案数；一人只有一条，与岗位无关", source: "人才库" },
                { label: "在招岗位申请数", value: n.open_job_apps, definition: "当前申请中，关联岗位 open=true 的部分；已关闭/归档岗位的申请不计", source: "岗位管理" },
                { label: "历史申请总数", value: n.all_apps, definition: "全部未删除申请（含历史、非当前环节）；漏斗为累计经过人次，与此不同", source: "仪表盘漏斗" },
            ],
            offers,
            todos,
            tomorrowInterviews,
            noSchedule,
            backgroundApps,
            offerGateApps,
            recentInterviews,
            jobMaterials,
            unleveledJobs: unleveledJobs.filter(j => j.visibleLevel),
            hiddenNames,
            constants: { offerGates: OFFER_GATES, backgroundItems: BACKGROUND_ITEMS, minutesItems: MINUTES_ITEMS },
            generatedAt: new Date().toISOString(),
        };
    });
    // 结构化补充数据写入：只改 configuration_refs->toolkit 下的单一键，不覆盖其它配置引用。
    app.post("/api/v4/toolkit/record", async (req) => id.db.tx(async () => {
        requireRole(req.actor, "admin", "manager", "recruiter");
        const b = parse(recordInput, req.body);
        const sql = sqlOf();
        if (b.kind === "realName") {
            if (b.scope !== "candidate")
                fail(422, "field_invalid");
            const value = String(b.payload?.value ?? "").trim();
            if (!value || value.length > 40 || /^[\u4e00-\u9fff]{1,2}(先生|女士)$/.test(value))
                fail(422, "real_name_invalid");
            if (b.version === undefined)
                fail(409, 'client_update_required');
            const before = found((await sql.query('SELECT * FROM candidates WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [b.id])).rows[0]);
            if (before.version !== b.version)
                fail(409, 'version_conflict');
            await new BusinessConfigService(id).seed();
            const def = await loadDefinition(id, 'resume', sql, req.actor), field = def.fields.find(f => f.coreKey === 'name');
            const projection = await toolkitProjection(id, req.actor, 'resume', before.profile);
            if (!field || !field.active || !fieldAllowed(field, req.actor, 'write') || !projection.keys.has('name'))
                fail(403, 'field_forbidden:core.resume.name');
            const saved = found((await sql.query("UPDATE candidates SET profile=jsonb_set(profile,'{realName}',to_jsonb($2::text),true),version=version+1,updated_at=now() WHERE id=$1 AND version=$3 RETURNING *", [b.id, value, b.version])).rows[0]);
            await id.profileVersion(sql, req.actor.id, saved);
        }
        else if (b.kind === "level") {
            if (b.scope !== "job")
                fail(422, "field_invalid");
            if (b.version === undefined)
                fail(409, 'client_update_required');
            const value = String(b.payload?.value ?? "").trim();
            const projected = await new ConfiguredRecruiting(id).projectJob(req.actor, b.id);
            await new ConfiguredRecruiting(id).job(req.actor, b.id, { version: b.version, level: value, definitionVersion: projected.definition.ref.version, definitionRevision: projected.definition.aclRevision });
        }
        else {
            const allowed = { offerGates: "application", backgroundCheck: "application", followup: "application", minutes: "interview", jobExtras: "job" };
            if (allowed[b.kind] !== b.scope)
                fail(422, "field_invalid");
            if (b.version === undefined)
                fail(409, "client_update_required");
            const table = scopeTable[b.scope];
            if (!table)
                fail(422, "field_invalid");
            if (!b.payload || typeof b.payload !== "object" || Array.isArray(b.payload))
                fail(422, "field_invalid");
            if (b.kind === 'jobExtras') {
                b.payload = parse(z.object({ hardestPoint: z.string().max(2000).optional(), triples: z.array(z.string().max(1000)).max(12).optional(), salaryRange: z.string().max(1000).optional() }).strict(), b.payload);
                const job = found((await sql.query('SELECT j.*,v.requirements FROM jobs j JOIN job_versions v ON v.job_id=j.id AND v.version=j.requirements_version WHERE j.id=$1', [b.id])).rows[0]);
                const mapping = { hardestPoint: 'requirements.description', triples: 'requirements.skills', salaryRange: 'salaryRange' };
                await assertToolkitWrite(id, req.actor, 'job', jobCore(job), { kind: 'job', id: b.id }, Object.keys(b.payload).map(k => mapping[k]));
            }
            if (b.kind === 'minutes') {
                const interview = found((await sql.query('SELECT * FROM interviews WHERE id=$1 AND deleted_at IS NULL', [b.id])).rows[0]);
                await assertToolkitWrite(id, req.actor, 'interview', interview, { kind: 'interview', id: b.id }, ['feedback']);
                await assertToolkitWrite(id, req.actor, 'evaluation', {}, undefined, ['summary', 'evidenceNotes', 'risks']);
            }
            const where = b.scope === "job" ? "id=$1" : "id=$1 AND deleted_at IS NULL";
            const r = await sql.query(`UPDATE ${table} SET configuration_refs=jsonb_set(
           jsonb_set(coalesce(configuration_refs,'{}'::jsonb),'{toolkit}',
             coalesce(configuration_refs->'toolkit','{}'::jsonb),true),
           '{toolkit,${b.kind}}',${b.kind === 'jobExtras' ? "coalesce(configuration_refs->'toolkit'->'jobExtras','{}'::jsonb)||" : ""}$2::jsonb,true), version=version+1,updated_at=now()
         WHERE ${where} AND version=$3 RETURNING id`, [b.id, JSON.stringify(b.payload), b.version]);
            if (!r.rowCount)
                fail(409, "version_conflict");
        }
        await id.audit(sql, req.actor.id, "toolkit.record", b.id, { scope: b.scope, kind: b.kind });
        return { ok: true };
    }));
    // #7 能力三元组检索：用岗位侧填写的三元组在简历原文里做关键词召回（非语义模型）。
    app.post("/api/v4/toolkit/search", async (req) => {
        requireRole(req.actor, "admin", "manager", "recruiter");
        await assertLegacySource(id, req.actor, ["resume"]);
        const b = parse(searchInput, req.body);
        const sql = sqlOf();
        const rows = (await sql.query(`WITH terms AS (SELECT unnest($1::text[]) AS term)
         SELECT c.id,c.profile->>'name' AS name,c.profile->>'intent' AS intent,
           array_agg(DISTINCT t.term) AS matched_terms,count(DISTINCT t.term)::int AS hits
         FROM candidates c
         JOIN resume_versions rv ON rv.candidate_id=c.id
         JOIN parse_results pr ON pr.id=rv.parse_result_id
         CROSS JOIN terms t
         WHERE c.deleted_at IS NULL AND pr.raw_bytes IS NOT NULL
           AND convert_from(pr.raw_bytes,'UTF8') ILIKE '%'||t.term||'%'
         GROUP BY c.id,c.profile ORDER BY hits DESC,c.profile->>'name' LIMIT 30`, [b.terms])).rows;
        return { terms: b.terms, items: rows };
    });
    // #8 保存搜索条件：存在既有 sourcing_setups.data 里（该表已在备份表清单），不新建表。
    // newMatches 是站内「保存后出现的新线索」计数，不发送外部通知、不依赖定时任务。
    const setupKey = "savedSearches";
    const readSetup = async (uid) => {
        const r = await sqlOf().query("SELECT data FROM sourcing_setups WHERE user_id=$1", [uid]);
        return r.rows[0]?.data || {};
    };
    const writeSetup = async (uid, data) => sqlOf().query(`INSERT INTO sourcing_setups(user_id,data,updated_at) VALUES($1,$2::jsonb,now())
       ON CONFLICT (user_id) DO UPDATE SET data=$2::jsonb,updated_at=now()`, [uid, JSON.stringify(data)]);
    const listSearches = async (actor, suppliedData) => {
        const data = suppliedData ?? await readSetup(actor.id);
        const list = Array.isArray(data?.[setupKey]) ? data[setupKey] : [];
        if (list.some(s => String(s?.query?.search || '').trim())) {
            const def = await legacyDefinition(id, actor, 'lead');
            // This legacy aggregate searches all four columns. Reject it whenever
            // any source is hidden, unsearchable, or needs row-specific visibility.
            for (const key of ['name', 'org', 'school', 'major']) {
                if (!def.fields.some(f => f.coreKey === key))
                    fail(403, 'field_query_forbidden');
                assertLegacyField(def, actor, key);
            }
        }
        return Promise.all(list.map(async (s) => {
            const kw = String(s?.query?.search || "").trim();
            let newMatches = 0;
            if (kw) {
                const r = await sqlOf().query(`SELECT count(*)::int AS n FROM leads WHERE deleted_at IS NULL AND created_at>$1
             AND concat_ws(' ',name,org,school,major) ILIKE $2`, [s.createdAt, "%" + kw + "%"]);
                newMatches = r.rows[0]?.n || 0;
            }
            return { name: String(s.name), query: s.query || {}, createdAt: s.createdAt, newMatches };
        }));
    };
    app.get("/api/v4/toolkit/saved-searches", async (req) => {
        requireRole(req.actor, "admin", "manager", "recruiter");
        return { items: await listSearches(req.actor) };
    });
    app.post("/api/v4/toolkit/saved-searches", async (req) => {
        requireRole(req.actor, "admin", "manager", "recruiter");
        const b = parse(savedSearchInput, req.body);
        const data = await readSetup(req.actor.id);
        const list = Array.isArray(data?.[setupKey]) ? data[setupKey] : [];
        const next = list.filter((s) => String(s.name) !== b.name);
        if (next.length >= 20)
            fail(422, "too_many_saved_searches");
        next.push({ name: b.name, query: b.query, createdAt: new Date().toISOString() });
        data[setupKey] = next;
        const items = await listSearches(req.actor, data);
        await writeSetup(req.actor.id, data);
        await id.audit(sqlOf(), req.actor.id, "toolkit.saved_search.create", null, { name: b.name });
        return { items };
    });
    app.post("/api/v4/toolkit/saved-searches/remove", async (req) => {
        requireRole(req.actor, "admin", "manager", "recruiter");
        const b = parse(removeSearchInput, req.body);
        const data = await readSetup(req.actor.id);
        const list = Array.isArray(data?.[setupKey]) ? data[setupKey] : [];
        data[setupKey] = list.filter((s) => String(s.name) !== b.name);
        const items = await listSearches(req.actor, data);
        await writeSetup(req.actor.id, data);
        await id.audit(sqlOf(), req.actor.id, "toolkit.saved_search.remove", null, { name: b.name });
        return { items };
    });
}
//# sourceMappingURL=routes.js.map