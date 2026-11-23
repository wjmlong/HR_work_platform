import { z, parse, uuid, version } from '../http/validation.js';
import { requireRole } from '../identity/service.js';
import { legacyDefinition, legacyKeys, projectLegacyCore } from '../business-config/legacy-fields.js';
import { fail, found } from '../http/errors.js';
import { stageOrder } from '../recruiting/workflow.js';
import { ranks } from '../recruiting/schema.js';
export const reportMetric = z.enum(['stages', 'departments', 'jobs', 'sources', 'funnel', 'openings']);
export const reportSettings = z.object({ version, widgets: z.array(z.object({ metric: reportMetric, chart: z.enum(['bar', 'donut', 'funnel']) }).strict().refine(w => w.metric !== 'funnel' || w.chart !== 'donut', { message: '累计漏斗不能用占比饼图' })).min(1).max(6) }).strict();
export const defaultReportSettings = { version: 1, widgets: [{ metric: 'stages', chart: 'bar' }, { metric: 'openings', chart: 'donut' }, { metric: 'funnel', chart: 'funnel' }] };
export const reportQuery = z.object({ jobId: uuid.optional(), metric: reportMetric.optional(), value: z.string().max(300).optional(), page: z.number().int().min(1).default(1) }).strict();
export class ReportService {
    identity;
    constructor(identity) {
        this.identity = identity;
    }
    async settings(a) { requireRole(a, 'admin', 'manager', 'recruiter'); return (await this.identity.db.query('SELECT dashboard_preferences FROM users WHERE id=$1', [a.id])).rows[0]?.dashboard_preferences || defaultReportSettings; }
    async save(a, input) { requireRole(a, 'admin', 'manager', 'recruiter'); const b = parse(reportSettings, input); return this.identity.db.tx(async (c) => { const row = found((await c.query('SELECT dashboard_preferences FROM users WHERE id=$1 FOR UPDATE', [a.id])).rows[0]), old = row.dashboard_preferences || defaultReportSettings; if (old.version !== b.version)
        fail(409, 'version_conflict'); const next = { ...b, version: b.version + 1 }; await c.query('UPDATE users SET dashboard_preferences=$2 WHERE id=$1', [a.id, next]); await this.identity.audit(c, a.id, 'dashboard.configure', a.id, { version: next.version, widgets: b.widgets }); return next; }); }
    async query(a, input) {
        requireRole(a, 'admin', 'manager', 'recruiter');
        const q = parse(reportQuery, input);
        const [resumeDef, jobDef] = await Promise.all([legacyDefinition(this.identity, a, 'resume'), legacyDefinition(this.identity, a, 'job')]), jobKeys = legacyKeys(jobDef, a);
        if (['departments', 'openings'].includes(q.metric || '') && !jobKeys.has('department') || q.metric === 'jobs' && !jobKeys.has('name'))
            fail(403, 'field_read_forbidden');
        return this.identity.db.tx(async (c) => {
            await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
            const base = "FROM applications a JOIN candidates p ON p.id=a.candidate_id JOIN jobs j ON j.id=a.job_id WHERE a.is_current AND a.deleted_at IS NULL AND p.deleted_at IS NULL AND ($1::uuid IS NULL OR a.job_id=$1)", params = [q.jobId || null];
            const rows = (await c.query(`SELECT a.status,j.id job_id,j.name job_name,coalesce(nullif(j.department,''),'未分配部门') department,a.source,count(*)::int count ${base} GROUP BY a.status,j.id,j.name,j.department,a.source`, params)).rows;
            const group = (key, label = key) => { const out = new Map(); for (const r of rows) {
                const id = r[key];
                const v = out.get(id) || { value: id, label: r[label], count: 0 };
                v.count += r.count;
                out.set(id, v);
            } return [...out.values()].sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value))); };
            const stages = group('status'), core = stageOrder.filter(s => ranks[s] !== undefined), funnel = core.map(s => ({ value: s, label: s, count: rows.filter(r => ranks[r.status] >= ranks[s]).reduce((n, r) => n + r.count, 0) }));
            const openings = jobKeys.has('department') ? (await c.query("SELECT coalesce(nullif(department,''),'未分配部门') value,count(*)::int count FROM jobs WHERE open AND ($1::uuid IS NULL OR id=$1) GROUP BY coalesce(nullif(department,''),'未分配部门') ORDER BY count DESC", [q.jobId || null])).rows.map(r => ({ ...r, label: r.value })) : [];
            const groups = { openings, stages, departments: jobKeys.has('department') ? group('department') : [], jobs: jobKeys.has('name') ? group('job_id', 'job_name') : [], sources: group('source'), funnel };
            if (q.metric === 'openings') {
                const values = [q.jobId || null, q.value ?? null], where = "FROM jobs WHERE open AND ($1::uuid IS NULL OR id=$1) AND ($2::text IS NULL OR coalesce(nullif(department,''),'未分配部门')=$2)", total = Number((await c.query('SELECT count(*) n ' + where, values)).rows[0].n), items = (await c.query('SELECT id,name,headcount,department ' + where + ' ORDER BY name,id LIMIT 25 OFFSET ' + ((q.page - 1) * 25), values)).rows.map(r => ({ id: r.id, name: jobKeys.has('name') ? r.name : undefined, headcount: jobKeys.has('headcount') ? r.headcount : undefined, department: r.department }));
                return { groups, total, items, page: q.page, unit: 'job', scope: q };
            }
            let where = '';
            if (q.metric && q.value !== undefined) {
                if (q.metric === 'funnel') {
                    if (!core.includes(q.value))
                        fail(422, 'invalid_input');
                    params.push(core.filter(s => ranks[s] >= ranks[q.value]));
                    where = ' AND a.status=ANY($2::text[])';
                }
                else {
                    const expr = { stages: 'a.status', departments: "coalesce(nullif(j.department,''),'未分配部门')", jobs: 'j.id::text', sources: 'a.source' }[q.metric];
                    params.push(q.value);
                    where = ` AND ${expr}=$2`;
                }
            }
            const total = Number((await c.query(`SELECT count(*) n ${base}${where}`, params)).rows[0].n);
            const items = q.metric ? (await c.query(`SELECT a.id,a.candidate_id,a.job_id,a.status,a.updated_at,p.profile,j.name job_name ${base}${where} ORDER BY a.updated_at DESC,a.id LIMIT 25 OFFSET ${(q.page - 1) * 25}`, params)).rows.map(r => ({ ...r, profile: projectLegacyCore(resumeDef, a, r.profile), job_name: jobKeys.has('name') ? r.job_name : undefined })) : [];
            return { groups, total, items, page: q.page, scope: q, asOf: new Date().toISOString(), unit: 'current_application', statement: '按未删除的当前岗位申请统计；漏斗只累计常规流程，待定、储备、录用到其他、终止与淘汰单列。部门/岗位分布按候选人申请量计算。' };
        });
    }
}
//# sourceMappingURL=report.js.map