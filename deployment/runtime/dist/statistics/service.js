import { evaluationBasis, templateScores, aggregateEvaluationCohorts } from '../business-config/evaluation-template.js';
import { requireRole } from "../identity/service.js";
import { parse, z, text, uuid } from "../http/validation.js";
import { fail, found } from "../http/errors.js";
import { ranks } from "../recruiting/schema.js";
const roles = ["admin", "manager", "recruiter"], stages = Object.keys(ranks);
const median = (v) => {
    if (!v.length)
        return null;
    const s = [...v].sort((a, b) => a - b), i = Math.floor(s.length / 2);
    return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
};
export const statisticsRequest = z
    .object({
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
    asOf: z.iso.datetime({ offset: true }).optional(),
})
    .strict();
export const protocolRequest = z
    .object({
    name: text,
    definition: z.string().trim().min(1).max(10000),
    previousId: uuid.optional(),
})
    .strict();
export const sampleRequest = z
    .object({
    resumeVersionId: uuid,
    protocolId: uuid,
    mode: z.enum(["manual", "assisted"]),
    seconds: z.number().int().min(1).max(86400).optional(),
    startedAt: z.iso.datetime({ offset: true }).optional(),
    endedAt: z.iso.datetime({ offset: true }).optional(),
    interrupted: z.boolean().default(false),
})
    .strict();
export class StatisticsService {
    identity;
    db;
    constructor(identity) {
        this.identity = identity;
        this.db = identity.db;
    }
    async report(a, input) {
        requireRole(a, ...roles);
        const q = parse(statisticsRequest, input), from = new Date(q.from), to = new Date(q.to);
        let asOf = q.asOf ? new Date(q.asOf) : new Date();
        if (from >= to || asOf < from)
            fail(422, "invalid_time_range");
        return this.db.tx(async (c) => {
            await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
            const asOfBound = q.asOf ||
                (await c.query("SELECT clock_timestamp()::text value")).rows[0].value;
            if (!q.asOf)
                asOf = new Date(asOfBound);
            const apps = (await c.query("SELECT * FROM applications WHERE created_at>=$1 AND created_at<$2 AND created_at<$3 AND deleted_at IS NULL AND is_current AND EXISTS(SELECT 1 FROM candidates p WHERE p.id=applications.candidate_id AND p.deleted_at IS NULL) ORDER BY created_at,id", [from, to, asOfBound])).rows, ids = apps.map((x) => x.id);
            const events = (await c.query("SELECT * FROM application_events WHERE application_id=ANY($1::uuid[]) AND at<$2 ORDER BY at,id", [ids, asOfBound])).rows;
            const current = Object.fromEntries([...stages, "terminated", "rejected", "hired_other", "on_hold", "reserve"].map((x) => [x, 0])), funnel = stages.map((stage) => ({ stage, count: 0, rate: 0 })), dwell = Object.fromEntries(stages.map((s) => [
                s,
                { totalSeconds: 0, samples: 0, meanSeconds: null },
            ]));
            let jumps = 0, unknownHistoricalApplications = 0;
            const channels = new Map(), rejections = {}, terminations = {};
            for (const app of apps) {
                const history = events.filter((e) => e.application_id === app.id), latest = history.at(-1), baselineKnown = app.baseline_at && new Date(app.baseline_at) <= asOf, status = latest?.to_state ||
                    (baselineKnown ? app.baseline_state : "unknown");
                if (baselineKnown || !history.length)
                    unknownHistoricalApplications++;
                current[status] = (current[status] || 0) + 1;
                const reached = new Set(history.flatMap((e) => [e.from_state, e.to_state])
                    .filter((state) => Object.hasOwn(ranks, state)).map((state) => ranks[state]));
                if (baselineKnown &&
                    app.baseline_state !== "rejected" &&
                    ranks[app.baseline_state] !== undefined)
                    reached.add(ranks[app.baseline_state]);
                for (const i of reached)
                    funnel[i].count++;
                const channel = channels.get(app.source) || {
                    source: app.source,
                    applications: 0,
                    screened: 0,
                    interviewed: 0,
                    offered: 0,
                    hired: 0,
                    rejected: 0,
                };
                channel.applications++;
                if (reached.has(1))
                    channel.screened++;
                if (reached.has(2))
                    channel.interviewed++;
                if (reached.has(ranks.offered))
                    channel.offered++;
                if (reached.has(ranks.hired))
                    channel.hired++;
                if (status === "rejected") {
                    channel.rejected++;
                    const reason = latest
                        ? latest.rejection_reason || latest.reason || "历史未注明"
                        : app.baseline_reject_reason || "历史未注明";
                    rejections[reason] = (rejections[reason] || 0) + 1;
                }
                if (status === 'terminated') {
                    const reason = latest?.term_reason || app.term_reason || 'historical_unknown';
                    terminations[reason] = (terminations[reason] || 0) + 1;
                }
                channels.set(app.source, channel);
                for (let i = 0; i < history.length; i++) {
                    const e = history[i], next = history[i + 1];
                    if (e.from_state &&
                        e.to_state !== "rejected" &&
                        e.from_state !== "rejected" &&
                        (ranks[e.to_state] ?? 0) > (ranks[e.from_state] ?? 0) + 1)
                        jumps++;
                    if (e.to_state === "hired" ||
                        e.to_state === "rejected" ||
                        !dwell[e.to_state])
                        continue;
                    const seconds = Math.max(0, ((next ? new Date(next.at) : asOf).getTime() -
                        new Date(e.at).getTime()) /
                        1000);
                    dwell[e.to_state].totalSeconds += seconds;
                    dwell[e.to_state].samples++;
                }
            }
            for (const item of funnel)
                item.rate = apps.length ? item.count / apps.length : 0;
            for (const value of Object.values(dwell))
                value.meanSeconds = value.samples
                    ? value.totalSeconds / value.samples
                    : null;
            const evaluationRecords = (await c.query("SELECT v.data,v.configuration_refs FROM evaluations e JOIN interviews i ON i.id=e.interview_id AND e.author_id=i.primary_interviewer_id JOIN LATERAL(SELECT * FROM evaluation_versions v WHERE v.evaluation_id=e.id AND v.at<$2 AND v.status='submitted' ORDER BY v.version DESC LIMIT 1) v ON true WHERE i.deleted_at IS NULL AND i.application_id=ANY($1::uuid[])", [ids, asOfBound])).rows;
            const scores = evaluationRecords.filter(r => evaluationBasis(r.configuration_refs)?.defaultComparable).flatMap(r => { const b = evaluationBasis(r.configuration_refs), value = templateScores(b.template, r.data).professional; return value === undefined ? [] : [value]; });
            // 端到端与环节间转化时间：只用 application_events 中首次进入各环节的真实时间，
            // 无事件证据的申请不计入；单位为天，给出 P50/P90 而不是只看均值。
            // 业务时间口径：初筛只留一条，并显式给出「面试到录用」「录用到入职」两条跨度。
            // 端点一律用业务名称，不把内部环节 ID 暴露到页面、CSV 或接口；无样本也保留行，值显示为空。
            const transitionDefs = [
                { stage: "初筛时间", label: "投递 → 初筛通过", from: "created", to: "screened" },
                { stage: "面试时间", label: "初筛通过 → 面试中", from: "screened", to: "interviewing" },
                { stage: "面试到录用时间", label: "面试中 → 已发 offer", from: "interviewing", to: "offered" },
                { stage: "录用到入职时间", label: "已发 offer → 已入职", from: "offered", to: "hired" },
            ];
            const firstEnter = new Map();
            for (const e of events) {
                if (!e.application_id || !e.to_state)
                    continue;
                const m = firstEnter.get(e.application_id) || {}, t = new Date(e.at).getTime();
                if (m[e.to_state] === undefined || t < m[e.to_state])
                    m[e.to_state] = t;
                firstEnter.set(e.application_id, m);
            }
            const pctDays = (vals, p) => {
                if (!vals.length)
                    return null;
                const s = [...vals].sort((x, y) => x - y);
                return +(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] / 86400000).toFixed(1);
            };
            const dayDiff = (from, to) => to - from;
            const endToEndSamples = [], byJobSamples = new Map();
            const transitionSamples = Object.fromEntries(transitionDefs.map(d => [d.label, []]));
            for (const app of apps) {
                const m = firstEnter.get(app.id);
                if (!m)
                    continue;
                const created = new Date(app.created_at).getTime();
                if (m.hired !== undefined) {
                    const span = dayDiff(created, m.hired);
                    if (span >= 0) {
                        endToEndSamples.push(span);
                        const arr = byJobSamples.get(String(app.job_id)) || [];
                        arr.push(span);
                        byJobSamples.set(String(app.job_id), arr);
                    }
                }
                for (const d of transitionDefs) {
                    const start = d.from === "created" ? created : m[d.from];
                    const end = m[d.to];
                    if (!Number.isFinite(start) || !Number.isFinite(end))
                        continue;
                    const span = dayDiff(start, end);
                    if (span >= 0)
                        transitionSamples[d.label].push(span);
                }
            }
            const jobIds = [...new Set(apps.map((x) => x.job_id).filter(Boolean))];
            const jobNames = new Map((jobIds.length
                ? (await c.query("SELECT id,name FROM jobs WHERE id=ANY($1::uuid[])", [jobIds])).rows
                : []).map((j) => [String(j.id), String(j.name)]));
            const durationAnalysis = {
                basis: "按 application_events 首次进入各环节的时间计算，无事件证据不计入；单位为天",
                endToEnd: {
                    samples: endToEndSamples.length,
                    p50: pctDays(endToEndSamples, 50), p90: pctDays(endToEndSamples, 90),
                    mean: endToEndSamples.length ? +(endToEndSamples.reduce((x, y) => x + y, 0) / endToEndSamples.length / 86400000).toFixed(1) : null,
                },
                transitions: transitionDefs.map(d => ({
                    label: d.label, stage: d.stage, samples: transitionSamples[d.label].length,
                    p50: pctDays(transitionSamples[d.label], 50), p90: pctDays(transitionSamples[d.label], 90),
                })),
                byJob: [...byJobSamples.entries()].map(([jobId, v]) => ({
                    jobId, jobName: jobNames.get(jobId) || "—", samples: v.length,
                    p50: pctDays(v, 50), p90: pctDays(v, 90),
                })).sort((x, y) => y.samples - x.samples),
            };
            return {
                cohort: {
                    from: from.toISOString(),
                    to: to.toISOString(),
                    asOf: asOf.toISOString(),
                    interval: "[from,to)",
                    unit: "application",
                    funnel: "current_rank_excluding_rejected_and_terminated",
                    history: "observed_event_states_and_imported_baseline_only",
                    dwell: "actual_events_only",
                },
                counts: {
                    applications: apps.length,
                    people: new Set(apps.map((x) => x.candidate_id)).size,
                    resumes: new Set(apps.map((x) => x.resume_version_id).filter(Boolean))
                        .size,
                },
                current,
                funnel: stages.map(stage => { const count = stages.filter(key => ranks[key] >= ranks[stage]).reduce((n, key) => n + (current[key] || 0), 0); return { stage, count, rate: apps.length ? count / apps.length : 0 }; }),
                historicalFunnel: funnel,
                terminations,
                dwell,
                jumps,
                unknownHistoricalApplications,
                channels: [...channels.values()],
                rejections,
                meanProfessionalScore: scores.length
                    ? scores.reduce((a, b) => a + b, 0) / scores.length
                    : null,
                professionalScoreSamples: scores.length,
                evaluationCohorts: aggregateEvaluationCohorts(evaluationRecords),
                durationAnalysis,
            };
        });
    }
    async protocol(a, input) {
        requireRole(a, "admin", "manager");
        const b = parse(protocolRequest, input);
        return this.db.tx(async (c) => {
            let version = 1;
            if (b.previousId)
                version =
                    found((await c.query("SELECT version FROM measurement_protocols WHERE id=$1", [b.previousId])).rows[0]).version + 1;
            const r = (await c.query("INSERT INTO measurement_protocols(name,definition,version,previous_id) VALUES($1,$2,$3,$4) RETURNING *", [b.name, b.definition, version, b.previousId || null])).rows[0];
            await this.identity.audit(c, a.id, "measurement.protocol", r.id, {
                version,
            });
            return r;
        });
    }
    async sample(a, input) {
        requireRole(a, ...roles);
        const b = parse(sampleRequest, input);
        const fromTimes = b.startedAt && b.endedAt
            ? Math.round((new Date(b.endedAt).getTime() - new Date(b.startedAt).getTime()) /
                1000)
            : null;
        if ((b.seconds !== undefined && !!(b.startedAt || b.endedAt)) ||
            (b.seconds === undefined && fromTimes === null))
            fail(422, "invalid_measurement");
        const seconds = b.seconds ?? fromTimes;
        if (seconds < 1 ||
            seconds > 86400 ||
            (b.endedAt && new Date(b.endedAt).getTime() > Date.now() + 60000))
            fail(422, "invalid_measurement");
        return this.db.tx(async (c) => {
            found((await c.query("SELECT id FROM resume_versions WHERE id=$1", [
                b.resumeVersionId,
            ])).rows[0]);
            found((await c.query("SELECT id FROM measurement_protocols WHERE id=$1", [
                b.protocolId,
            ])).rows[0]);
            const result = (await c.query("INSERT INTO screening_samples(resume_version_id,protocol_id,actor_id,mode,seconds,interrupted) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING *", [
                b.resumeVersionId,
                b.protocolId,
                a.id,
                b.mode,
                seconds,
                b.interrupted,
            ])).rows[0];
            if (!result)
                fail(409, "duplicate_sample");
            await this.identity.audit(c, a.id, "measurement.sample", result.id, {
                mode: b.mode,
                interrupted: b.interrupted,
            });
            return result;
        });
    }
    async measurements(a, protocolId) {
        requireRole(a, ...roles);
        const protocol = found((await this.db.query("SELECT * FROM measurement_protocols WHERE id=$1", [protocolId])).rows[0]), rows = (await this.db.query("SELECT mode,seconds,interrupted FROM screening_samples WHERE protocol_id=$1", [protocolId])).rows;
        const group = (mode) => {
            const values = rows
                .filter((r) => r.mode === mode && !r.interrupted)
                .map((r) => r.seconds);
            return {
                count: values.length,
                median: median(values),
                min: values.length ? Math.min(...values) : null,
                max: values.length ? Math.max(...values) : null,
                excludedInterrupted: rows.filter((r) => r.mode === mode && r.interrupted).length,
            };
        };
        const manual = group("manual"), assisted = group("assisted"), sufficient = manual.count >= 20 && assisted.count >= 20;
        return {
            protocol,
            manual,
            assisted,
            efficiency: sufficient ? 1 - assisted.median / manual.median : null,
            target: 0.4,
            statement: sufficient
                ? "同协议样本描述性比较，不能推断因果或个体效率。"
                : "每组至少20个同协议有效样本后计算；当前不作效率达成结论。",
        };
    }
}
//# sourceMappingURL=service.js.map