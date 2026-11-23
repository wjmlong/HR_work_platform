import { requireRole } from '../identity/service.js';
import { z, parse } from '../http/validation.js';
import { fail } from '../http/errors.js';
import { assertFilterField, fieldAllowed, privileged, salaryField } from './access.js';
import { BusinessConfigService } from './service.js';
import { loadDefinition } from './fields.js';
import { validateValue } from './field-validation.js';
import { decimalAmount, compareAmounts } from './money.js';
import { csvDocument } from '../http/csv.js';
export const moneyContext = z.object({ currency: z.string().regex(/^[A-Z]{3}$/), period: z.enum(['annual', 'monthly']), includesBonus: z.enum(['yes', 'no']), includesEquity: z.enum(['yes', 'no']) }).strict();
export const fieldFilter = z.object({ fieldId: z.string().max(100), op: z.enum(['eq', 'in', 'contains', 'range', 'empty', 'not_empty']), value: z.unknown().optional(), money: moneyContext.optional() }).strict();
export const fieldQuerySchema = z.object({ definitionVersion: z.number().int().positive(), definitionRevision: z.string().max(100).optional(), filters: z.array(fieldFilter).max(30).default([]), sort: z.array(z.object({ fieldId: z.string().max(100), direction: z.enum(['asc', 'desc']), money: moneyContext.optional() }).strict()).max(5).default([]), columns: z.array(z.string().max(100)).min(1).max(100), facets: z.array(z.string().max(100)).max(10).default([]), query: z.string().max(500).default(''), page: z.number().int().positive().default(1), pageSize: z.number().int().min(1).max(100).default(25) }).strict();
const coreKeys = {
    job: { name: 'o.name', level: 'o.level', department: 'o.department', headcount: 'o.headcount', urgency: 'o.urgency', salaryRange: 'o.salary_range', marketSalary: 'o.market_salary', marketSource: 'o.market_source', salaryNote: 'o.salary_note', marketReferenceDate: 'o.market_reference_date', 'requirements.skills': "ARRAY(SELECT jsonb_array_elements_text(coalesce(jv.requirements->'skills','[]')))", 'requirements.education': "jv.requirements->>'education'", 'requirements.experienceYears': "(jv.requirements->>'experienceYears')::numeric", 'requirements.experienceMaxYears': "(jv.requirements->>'experienceMaxYears')::numeric", 'requirements.experienceDescription': "jv.requirements->>'experienceDescription'", 'requirements.schoolPreferences': "ARRAY(SELECT jsonb_array_elements_text(coalesce(jv.requirements->'schoolPreferences','[]')))", 'requirements.description': "jv.requirements->>'description'" },
    resume: Object.fromEntries(['name', 'phone', 'email', 'location', 'bachelorSchool', 'intent', 'expectedSalary', 'firstEmployment', 'companies', 'education', 'experienceYears', 'school', 'major', 'skills', 'summary'].map(k => [k, k === 'skills' || k === 'companies' ? `ARRAY(SELECT jsonb_array_elements_text(coalesce(p.profile->'${k}','[]')))` : k === 'experienceYears' ? `(p.profile->>'${k}')::numeric` : `p.profile->>'${k}'`])),
    application: { source: 'o.source' }, interview: { round: 'o.round', startsAt: 'o.starts_at', durationMinutes: 'o.duration_minutes', form: 'o.form', location: 'o.location', meetingUrl: 'o.meeting_url', feedback: 'o.feedback' }, evaluation: {},
    lead: Object.fromEntries(['name', 'org', 'school', 'major', 'skills', 'direction', 'contact', 'source', 'note'].map(k => [k, 'o.' + k])), campus: Object.fromEntries(['school', 'region', 'city', 'tier', 'url', 'note'].map(k => [k, 'o.' + k])),
};
function salarySql(kind, alias, a, param) { if (privileged(a))
    return 'true'; const user = param(a.id), job = kind === 'job' ? alias + '.id' : kind === 'application' ? alias + '.job_id' : kind === 'interview' ? 'ap.job_id' : kind === 'resume' ? 'ap.job_id' : null; return job ? `EXISTS(SELECT 1 FROM job_salary_grants sg WHERE sg.user_id=${user}::uuid AND sg.job_id=${job})` : 'false'; }
function compiler(def, a, alias, startParam, sets, projectedValues) {
    if (!['o', 'a', 'j', 'l', 'i', 'c'].includes(alias) || !Number.isInteger(startParam) || startParam < 0)
        fail(422, 'query_alias_invalid');
    const values = [], param = (v) => { values.push(v); return '$' + (startParam + values.length); };
    const authorize = (id, purpose = 'filter') => { if (purpose === 'column') {
        const f = def.fields.find(f => f.fieldId === id);
        if (!f || !f.active || !fieldAllowed(f, a, 'read', true))
            fail(403, 'field_query_forbidden');
        return f;
    } return assertFilterField(def, a, id, purpose, true); };
    const raw = (f) => {
        if (f.coreKey) {
            const e = coreKeys[def.entity][f.coreKey];
            if (!e)
                fail(403, 'field_query_forbidden');
            return e.replaceAll('o.', alias + '.');
        }
        if (projectedValues) {
            const key = param(f.fieldId), json = `${projectedValues}->${key}::text`, text = `${projectedValues}->>${key}::text`;
            if (['money', 'money_range'].includes(f.type))
                return '(' + json + ')';
            if (f.type === 'multiselect')
                return `CASE WHEN ${projectedValues} ? ${key}::text THEN ARRAY(SELECT jsonb_array_elements_text(${json})) ELSE NULL END`;
            const cast = { number: 'numeric', boolean: 'boolean', date: 'date', datetime: 'timestamptz' }[f.type];
            return cast ? `(${text})::${cast}` : text;
        }
        const column = { text: 'text_value', longtext: 'text_value', number: 'number_value', date: 'date_value', datetime: 'time_value', boolean: 'bool_value', select: 'option_values[1]', multiselect: 'option_values', money: "amount_metadata||jsonb_build_object('min',amount_min::text,'max',amount_max::text,'currency',currency,'period',pay_period)", money_range: "amount_metadata||jsonb_build_object('min',amount_min::text,'max',amount_max::text,'currency',currency,'period',pay_period)" }[f.type];
        return `(SELECT ${column} FROM custom_field_values fv WHERE fv.object_kind=${param(def.entity)} AND fv.object_id=${alias}.id AND fv.field_id=${param(f.fieldId)})`;
    };
    const visibility = (f, path = new Set()) => { if (!f.active || !fieldAllowed(f, a, 'read', true) || path.has(f.fieldId))
        return 'false'; const next = new Set(path).add(f.fieldId), tests = []; if (f.visibleWhen)
        tests.push(condition(f.visibleWhen, next)); if (salaryField(f))
        tests.push(salarySql(def.entity, alias, a, param)); return tests.length ? '(' + tests.join(' AND ') + ')' : 'true'; };
    const condition = (c, path) => { if ('rules' in c)
        return '(' + c.rules.map(r => condition(r, path)).join(c.mode === 'all' ? ' AND ' : ' OR ') + ')'; const f = def.fields.find(f => f.fieldId === c.fieldId); if (!f)
        return 'false'; return '(' + visibility(f, path) + ' AND ' + predicate(f, raw(f), { fieldId: f.fieldId, op: c.op, value: c.value }) + ')'; };
    const expr = (f) => { const test = visibility(f), v = raw(f); return test === 'true' ? v : `CASE WHEN ${test} THEN ${v} ELSE NULL END`; };
    const asValue = (f, v) => validateValue(f, v, v);
    const predicate = (f, e, filter, moneyRow) => {
        const money = f.type === 'money' || f.type === 'money_range', array = f.type === 'multiselect', text = ['text', 'longtext', 'select'].includes(f.type);
        if (filter.op === 'empty' || filter.op === 'not_empty') {
            if (filter.value !== undefined)
                fail(422, 'field_filter_invalid');
            const empty = array ? `(${e} IS NULL OR cardinality(${e})=0)` : money ? moneyRow ? `coalesce(${moneyRow}.amount_min,${moneyRow}.amount_max) IS NULL` : `(${e} IS NULL OR coalesce(${e}->>'min',${e}->>'max') IS NULL)` : text ? `(${e} IS NULL OR ${e}='')` : `${e} IS NULL`;
            return filter.op === 'empty' ? empty : `NOT (${empty})`;
        }
        let context = 'true';
        if (money) {
            if (!filter.money)
                fail(422, 'money_context_required');
            const m = parse(moneyContext, filter.money);
            context = Object.entries(m).map(([k, v]) => `${moneyRow ? (k === 'currency' ? moneyRow + '.currency' : k === 'period' ? moneyRow + '.pay_period' : moneyRow + '.amount_metadata->>' + param(k) + '::text') : e + '->>' + param(k) + '::text'}=${param(v)}`).join(' AND ');
            e = moneyRow ? `coalesce(${moneyRow}.amount_min,${moneyRow}.amount_max)` : `coalesce((${e}->>'min')::numeric,(${e}->>'max')::numeric)`;
        }
        const normalize = (v) => money ? decimalAmount(typeof v === 'string' ? v : fail(422, 'money_invalid')) : asValue(f, v);
        if (filter.op === 'range') {
            if (!['number', 'date', 'datetime', 'money', 'money_range'].includes(f.type) || !Array.isArray(filter.value) || filter.value.length !== 2)
                fail(422, 'field_filter_invalid');
            const [lo, hi] = filter.value.map(normalize);
            if (lo === null || hi === null || (money ? compareAmounts(lo, hi) > 0 : lo > hi))
                fail(422, 'field_filter_invalid');
            return `(${context} AND ${e} BETWEEN ${param(lo)} AND ${param(hi)})`;
        }
        if (filter.op === 'contains') {
            if (!text && !array)
                fail(422, 'field_filter_invalid');
            if (typeof filter.value !== 'string' || filter.value.length > 2000)
                fail(422, 'field_filter_invalid');
            return array ? `${param(filter.value)}=ANY(${e})` : `${e} ILIKE ${param('%' + filter.value.replace(/[\\%_]/g, '\\$&') + '%')}`;
        }
        if (filter.op === 'in') {
            if (!['select', 'multiselect', 'text'].includes(f.type) || !Array.isArray(filter.value) || !filter.value.length || filter.value.length > 100)
                fail(422, 'field_filter_invalid');
            const list = filter.value.map(v => asValue({ ...f, type: f.type === 'multiselect' ? 'select' : f.type }, v));
            return array ? `${e}&&${param(list)}::text[]` : `${e}=ANY(${param(list)}::text[])`;
        }
        if (filter.op !== 'eq')
            fail(422, 'field_filter_invalid');
        const v = normalize(filter.value);
        if (v === null)
            fail(422, 'field_filter_invalid');
        if (array)
            return `${e}=${param(v)}::text[]`;
        return `(${context} AND ${e}=${param(v)})`;
    };
    const filter = (f, entry) => {
        if (f.coreKey || f.visibleWhen || entry.op === 'empty')
            return predicate(f, expr(f), entry);
        // An indexed set of object IDs gives PostgreSQL value distributions and a
        // semi-join, instead of re-running a correlated scalar lookup per object.
        const column = { text: 'fv.text_value', longtext: 'fv.text_value', number: 'fv.number_value', date: 'fv.date_value', datetime: 'fv.time_value', boolean: 'fv.bool_value', select: 'fv.option_values[1]', multiselect: 'fv.option_values', money: "fv.amount_metadata||jsonb_build_object('min',fv.amount_min::text,'max',fv.amount_max::text,'currency',fv.currency,'period',fv.pay_period)", money_range: "fv.amount_metadata||jsonb_build_object('min',fv.amount_min::text,'max',fv.amount_max::text,'currency',fv.currency,'period',fv.pay_period)" }[f.type];
        const kind = param(def.entity), field = param(f.fieldId), test = predicate(f, column, entry, f.type.startsWith('money') ? 'fv' : undefined), salary = salaryField(f) ? salarySql(def.entity, alias, a, param) : 'true';
        // Keep this as an uncorrelated hashed set. Pull-up into nested semi-joins
        // underestimates combined EAV selectivity and repeats thousands of lookups.
        const select = `SELECT fv.object_id FROM custom_field_values fv WHERE fv.object_kind=${kind} AND fv.field_id=${field} AND ${test}`;
        let ids = select;
        if (sets) {
            const name = 'configured_filter_' + sets.length;
            sets.push(name + ' AS MATERIALIZED(' + select + ')');
            ids = 'SELECT object_id FROM ' + name;
        }
        return `(${salary} AND (${alias}.id IN (${ids})) IS TRUE)`;
    };
    return { values, param, authorize, expr, predicate, raw, filter };
}
export function compileFieldQuery(def, a, input, alias, startParam, sets, projectedValues) {
    const q = parse(fieldQuerySchema, input), c = compiler(def, a, alias, startParam, sets);
    q.columns.forEach(id => c.authorize(id, 'column'));
    q.facets.forEach(id => c.authorize(id));
    const clauses = q.filters.map(f => { const d = c.authorize(f.fieldId); return c.filter(d, f); });
    if (q.query.trim()) {
        const terms = q.query.trim().split(/\s+/).filter(Boolean), fields = def.fields.filter(f => f.active && f.searchable && fieldAllowed(f, a, 'read', true) && ['text', 'longtext', 'select', 'multiselect'].includes(f.type));
        for (const term of terms) {
            const expressions = fields.map(f => {
                const expression = c.expr(f), e = f.type === 'multiselect' ? `array_to_string(${expression},' ')` : expression;
                const raw = `${e} ILIKE ${c.param('%' + term.replace(/[\\%_]/g, '\\$&') + '%')}`;
                const options = f.options.filter(o => [o.label, ...(o.aliases || [])].some(label => label.toLocaleLowerCase().includes(term.toLocaleLowerCase()))).map(o => o.id);
                if (!options.length || !['select', 'multiselect'].includes(f.type))
                    return raw;
                return '(' + raw + ' OR ' + (f.type === 'multiselect' ? `${expression}&&${c.param(options)}::text[]` : `${expression}=ANY(${c.param(options)}::text[])`) + ')';
            });
            clauses.push(expressions.length ? '(' + expressions.join(' OR ') + ')' : 'false');
        }
    }
    const order = q.sort.map(s => { const f = c.authorize(s.fieldId, 'sort'); if (['longtext', 'multiselect', 'boolean'].includes(f.type) && f.type !== 'boolean')
        fail(422, 'field_sort_invalid'); let e = c.expr(f); if (f.type === 'money' || f.type === 'money_range') {
        if (!s.money)
            fail(422, 'money_context_required');
        const context = Object.entries(s.money).map(([k, v]) => `${e}->>${c.param(k)}::text=${c.param(v)}`).join(' AND ');
        e = `CASE WHEN ${context} THEN coalesce((${e}->>'min')::numeric,(${e}->>'max')::numeric) END`;
    } return `${e} ${s.direction === 'asc' ? 'ASC' : 'DESC'} NULLS LAST`; });
    return { where: clauses.length ? clauses.join(' AND ') : 'true', orderBy: [...order, alias + '.id'].join(','), values: c.values, filterClauses: q.filters.map((f, i) => ({ fieldId: f.fieldId, sql: clauses[i] })), queryClauses: clauses.slice(q.filters.length) };
}
const scope = (kind, a) => {
    const all = privileged(a), access = "($1 OR ($3 AND EXISTS(SELECT 1 FROM interviews ai JOIN interviewers ax ON ax.interview_id=ai.id WHERE ai.application_id=ap.id AND ai.deleted_at IS NULL AND ai.status<>'cancelled' AND ax.user_id=$2 AND NOT ax.temporary_access)) OR ($4 AND EXISTS(SELECT 1 FROM application_grants ag WHERE ag.application_id=ap.id AND ag.user_id=$2)))", args = [all, a.id, a.roles.includes('interviewer'), a.roles.includes('viewer')];
    if (kind === 'lead' || kind === 'campus') {
        requireRole(a, 'admin', 'manager', 'recruiter');
        return { from: kind === 'lead' ? 'leads o' : 'campuses o', where: 'o.deleted_at IS NULL AND $1::boolean AND $2::uuid IS NOT NULL AND $3::boolean IS NOT NULL AND $4::boolean IS NOT NULL', args };
    }
    if (kind === 'job')
        return { from: 'jobs o JOIN job_versions jv ON jv.job_id=o.id AND jv.version=o.requirements_version', where: `($1 OR EXISTS(SELECT 1 FROM job_salary_grants sg WHERE sg.job_id=o.id AND sg.user_id=$2) OR EXISTS(SELECT 1 FROM applications ap WHERE ap.job_id=o.id AND ap.deleted_at IS NULL AND ${access}))`, args };
    if (kind === 'application')
        return { from: 'applications o JOIN candidates c ON c.id=o.candidate_id', where: `o.is_current AND o.deleted_at IS NULL AND c.deleted_at IS NULL AND ${access.replaceAll('ap.id', 'o.id')}`, args };
    if (kind === 'resume')
        return { from: 'resume_versions o JOIN parse_results p ON p.id=o.parse_result_id JOIN candidates c ON c.id=o.candidate_id JOIN applications ap ON ap.resume_version_id=o.id AND ap.is_current AND ap.deleted_at IS NULL', where: `c.deleted_at IS NULL AND ${access}`, args };
    if (kind === 'interview') {
        requireRole(a, 'admin', 'manager', 'recruiter', 'interviewer');
        return { from: 'interviews o JOIN applications ap ON ap.id=o.application_id JOIN candidates c ON c.id=ap.candidate_id JOIN jobs j ON j.id=ap.job_id', where: "o.deleted_at IS NULL AND ap.deleted_at IS NULL AND c.deleted_at IS NULL AND ($1 OR (o.status<>'cancelled' AND EXISTS(SELECT 1 FROM interviewers ix WHERE ix.interview_id=o.id AND ix.user_id=$2 AND NOT ix.temporary_access))) AND $3::boolean IS NOT NULL AND $4::boolean IS NOT NULL", args };
    }
    fail(422, 'field_query_entity_unsupported');
};
function canPivot(def, a, q) { const ids = [...q.filters.map(f => f.fieldId), ...q.sort.map(s => s.fieldId), ...q.facets]; return !q.query.trim() && ids.length > 0 && ids.every(id => { const f = def.fields.find(f => f.fieldId === id); return f && !f.coreKey && !f.visibleWhen && (!salaryField(f) || privileged(a)) && !['longtext', 'multiselect'].includes(f.type); }); }
const pivotValue = (type) => ({ text: 'fv.text_value', longtext: 'fv.text_value', number: 'fv.number_value', date: 'fv.date_value', datetime: 'fv.time_value', boolean: 'fv.bool_value', select: 'fv.option_values[1]', multiselect: 'fv.option_values', money: "(fv.amount_metadata||jsonb_build_object('min',fv.amount_min::text,'max',fv.amount_max::text,'currency',fv.currency,'period',fv.pay_period))", money_range: "(fv.amount_metadata||jsonb_build_object('min',fv.amount_min::text,'max',fv.amount_max::text,'currency',fv.currency,'period',fv.pay_period))" }[type]);
function needsProjectedValues(def, columns) { return columns.some(id => { const f = def.fields.find(f => f.fieldId === id); return !f.coreKey || !!f.visibleWhen; }); }
function projectionJoin(kindParameter) { return `LEFT JOIN LATERAL(SELECT jsonb_object_agg(fv.field_id,CASE fv.value_type WHEN 'number' THEN to_jsonb(fv.number_value) WHEN 'boolean' THEN to_jsonb(fv.bool_value) WHEN 'date' THEN to_jsonb(fv.date_value) WHEN 'datetime' THEN to_jsonb(fv.time_value) WHEN 'select' THEN to_jsonb(fv.option_values[1]) WHEN 'multiselect' THEN to_jsonb(fv.option_values) WHEN 'money' THEN fv.amount_metadata||jsonb_build_object('min',fv.amount_min::text,'max',fv.amount_max::text,'currency',fv.currency,'period',fv.pay_period) WHEN 'money_range' THEN fv.amount_metadata||jsonb_build_object('min',fv.amount_min::text,'max',fv.amount_max::text,'currency',fv.currency,'period',fv.pay_period) ELSE to_jsonb(fv.text_value) END) field_map FROM custom_field_values fv WHERE fv.object_kind=${kindParameter} AND fv.object_id=o.id) configured_values ON true`; }
export class ConfiguredQueryService {
    identity;
    constructor(identity) {
        this.identity = identity;
    }
    async definition(a, kind) { return new BusinessConfigService(this.identity).effective(a, kind); }
    async validate(a, kind, input, exporting = false) {
        requireRole(a, 'admin', 'manager', 'recruiter', 'interviewer', 'viewer');
        const q = parse(fieldQuerySchema, input), def = await this.definition(a, kind);
        if (q.definitionVersion !== def.ref.version || q.definitionRevision && q.definitionRevision !== def.aclRevision)
            fail(409, 'configuration_changed');
        compileFieldQuery(def, a, q, 'o', 4);
        if (exporting)
            q.columns.forEach(id => assertFilterField(def, a, id, 'export', true));
        return { q, def };
    }
    async query(a, kind, input) { requireRole(a, 'admin', 'manager', 'recruiter', 'interviewer', 'viewer'); const q = parse(fieldQuerySchema, input); return this.run(a, kind, q, false); }
    async run(a, kind, q, allRows) {
        return this.identity.db.tx(async (sql) => {
            await sql.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            const def = await loadDefinition(this.identity, kind, sql, a), base = scope(kind, a);
            if (q.definitionVersion !== def.ref.version || q.definitionRevision && q.definitionRevision !== def.aclRevision)
                fail(409, 'configuration_changed');
            // Recently edited EAV rows are not all-visible: bitmap heap scans avoid
            // thousands of repeated heap visibility probes from index-only range scans.
            // Planner choices remain local to this read transaction.
            if (!allRows && canPivot(def, a, q)) {
                compileFieldQuery(def, a, q, 'o', 0);
                await sql.query('SET LOCAL enable_nestloop=off; SET LOCAL jit=off; SET LOCAL enable_indexonlyscan=off; SET LOCAL enable_indexscan=off');
                return this.pivotPage(sql, a, def, base, q);
            }
            const sets = [], compiled = compileFieldQuery(def, a, q, 'o', base.args.length, allRows ? undefined : sets), params = [...base.args, ...compiled.values], where = `(${base.where}) AND (${compiled.where})`;
            if (q.definitionVersion !== def.ref.version || q.definitionRevision && q.definitionRevision !== def.aclRevision)
                fail(409, 'configuration_changed');
            const c = compiler(def, a, 'o', params.length, undefined, needsProjectedValues(def, q.columns) ? 'configured_values.field_map' : undefined), valuesJoin = needsProjectedValues(def, q.columns) ? projectionJoin(c.param(kind)) : '', columns = [...new Set(q.columns)], projection = columns.map(id => { const f = c.authorize(id, 'column'); return c.param(id) + '::text,' + c.expr(f); }).join(','), extra = kind === 'resume' ? ',o.candidate_id,ap.id application_id,ap.version' : kind === 'application' ? ",o.candidate_id,o.job_id,o.status,o.version" : kind === 'interview' ? ",o.application_id,o.status,o.version" : kind === 'job' ? ',o.version,o.open' : kind === 'lead' ? ',o.state,o.version' : ',o.version';
            const limit = ` LIMIT ${c.param(allRows ? 500 : q.pageSize)} OFFSET ${c.param(allRows ? 0 : (q.page - 1) * q.pageSize)}`;
            if (!allRows) {
                const args = [...params, ...c.values], facetPairs = [];
                for (const id of q.facets) {
                    const fc = compiler(def, a, 'o', args.length), f = fc.authorize(id), expression = fc.expr(f);
                    if (f.type.startsWith('money') || f.type === 'longtext')
                        fail(422, 'field_facet_invalid');
                    const value = f.type === 'multiselect' ? `unnest(${expression})` : expression, where = [base.where, ...compiled.filterClauses.filter(x => x.fieldId !== id).map(x => x.sql), ...compiled.queryClauses].map(x => '(' + x + ')').join(' AND '), key = fc.param(id);
                    facetPairs.push(key + `::text,coalesce((SELECT jsonb_agg(to_jsonb(facet_row)) FROM(SELECT value,count(*)::int count FROM(SELECT DISTINCT o.id,${value} value FROM ${base.from} WHERE ${where}) options WHERE value IS NOT NULL GROUP BY value ORDER BY value LIMIT 500) facet_row),'[]'::jsonb)`);
                    args.push(...fc.values);
                }
                const matched = `configured_matches AS MATERIALIZED(SELECT o.id FROM ${base.from} WHERE ${where})`, page = `configured_page AS MATERIALIZED(SELECT o.id FROM ${base.from} JOIN configured_matches match_scope ON match_scope.id=o.id ORDER BY ${compiled.orderBy}${limit})`, rows = `SELECT o.id${extra},jsonb_build_object(${projection}) "fieldValues" FROM ${base.from} JOIN configured_page page ON page.id=o.id ${valuesJoin} ORDER BY ${compiled.orderBy}`;
                const result = (await sql.query(`WITH ${[...sets, matched, page].join(',')} SELECT(SELECT count(*)::int FROM configured_matches) total,coalesce((SELECT jsonb_agg(to_jsonb(page_row)) FROM(${rows}) page_row),'[]'::jsonb) items,jsonb_build_object(${facetPairs.join(',')}) facets`, args)).rows[0];
                return { items: result.items.map((r) => ({ ...r, customFields: Object.fromEntries(Object.entries(r.fieldValues).filter(([id]) => def.fields.some(f => f.fieldId === id && !f.coreKey))) })), total: result.total, page: q.page, pageSize: q.pageSize, facets: result.facets, definition: { ref: def.ref, aclRevision: def.aclRevision } };
            }
            const countCompiled = compileFieldQuery(def, a, { ...q, sort: [] }, 'o', base.args.length);
            const total = Number((await sql.query(`SELECT count(*)::int n FROM ${base.from} WHERE (${base.where}) AND (${countCompiled.where})`, [...base.args, ...countCompiled.values])).rows[0].n);
            // Materialize the authorized page before projecting potentially many custom
            // columns. Otherwise a sort can cause every matched row to fetch all values.
            const statement = `WITH configured_page AS MATERIALIZED(SELECT o.id FROM ${base.from} WHERE ${where} ORDER BY ${compiled.orderBy}${limit}) SELECT o.id${extra},jsonb_build_object(${projection}) "fieldValues" FROM ${base.from} JOIN configured_page page ON page.id=o.id ${valuesJoin} ORDER BY ${compiled.orderBy}`, args = [...params, ...c.values], rows = [];
            do {
                const page = (await sql.query(statement, args)).rows;
                rows.push(...page);
                if (!allRows || page.length < 500)
                    break;
                args[args.length - 1] = rows.length;
            } while (true);
            const facets = {};
            for (const id of q.facets) {
                const fq = { ...q, filters: q.filters.filter(f => f.fieldId !== id), sort: [], facets: [] }, fc = compileFieldQuery(def, a, fq, 'o', base.args.length), facetCompiler = compiler(def, a, 'o', base.args.length + fc.values.length), f = facetCompiler.authorize(id), expression = facetCompiler.expr(f), value = f.type === 'multiselect' ? `unnest(${expression})` : `${expression}`;
                if (f.type.startsWith('money') || f.type === 'longtext')
                    fail(422, 'field_facet_invalid');
                facets[id] = (await sql.query(`SELECT value,count(*)::int count FROM (SELECT DISTINCT o.id,${value} value FROM ${base.from} WHERE (${base.where}) AND (${fc.where})) options WHERE value IS NOT NULL GROUP BY value ORDER BY value LIMIT 500`, [...base.args, ...fc.values, ...facetCompiler.values])).rows;
            }
            return { items: rows.map(r => ({ ...r, customFields: Object.fromEntries(Object.entries(r.fieldValues).filter(([id]) => def.fields.some(f => f.fieldId === id && !f.coreKey))) })), total, page: q.page, pageSize: q.pageSize, facets, definition: { ref: def.ref, aclRevision: def.aclRevision } };
        });
    }
    async pivotPage(sql, a, def, base, q) {
        // Batch the required typed values once per object. Shared flags feed count,
        // paging and self-excluding facets in the same statement/snapshot.
        const c = compiler(def, a, 'o', base.args.length, undefined, needsProjectedValues(def, q.columns) ? 'configured_values.field_map' : undefined), valuesJoin = needsProjectedValues(def, q.columns) ? projectionJoin(c.param(def.entity)) : '', aggregate = [], joins = [], aliases = new Map(), flags = [], constraints = [];
        const aliasFor = (id) => { let alias = aliases.get(id); if (!alias) {
            alias = 'fv' + aliases.size;
            aliases.set(id, alias);
            joins.push(`LEFT JOIN custom_field_values ${alias} ON ${alias}.object_id=o.id AND ${alias}.object_kind=${c.param(def.entity)} AND ${alias}.field_id=${c.param(id)}`);
        } return alias; };
        const valueFor = (f) => pivotValue(f.type).replaceAll('fv.', aliasFor(f.fieldId) + '.');
        q.filters.forEach((entry, i) => { const f = c.authorize(entry.fieldId), test = c.predicate(f, valueFor(f), entry, f.type.startsWith('money') ? aliasFor(f.fieldId) : undefined), name = 'flag_' + i; if (q.facets.includes(f.fieldId)) {
            aggregate.push(`(${test}) ${name}`);
            flags.push({ fieldId: f.fieldId, sql: `coalesce(scope.${name},${entry.op === 'empty' ? 'true' : 'false'})` });
        }
        else
            constraints.push(test); });
        const sorts = q.sort.map((s, i) => { const f = c.authorize(s.fieldId, 'sort'), alias = aliasFor(f.fieldId); let value = valueFor(f); if (f.type.startsWith('money')) {
            const m = parse(moneyContext, s.money), parts = Object.entries(m).map(([k, v]) => `${k === 'currency' ? 'fv.currency' : k === 'period' ? 'fv.pay_period' : 'fv.amount_metadata->>' + c.param(k) + '::text'}=${c.param(v)}`);
            value = `CASE WHEN ${parts.join(' AND ')} THEN coalesce(fv.amount_min,fv.amount_max) END`.replaceAll('fv.', alias + '.');
        } aggregate.push(`${value} sort_${i}`); return { name: 'sort_' + i, direction: s.direction === 'asc' ? 'ASC' : 'DESC' }; });
        q.facets.forEach((id, i) => { const f = c.authorize(id); if (f.type.startsWith('money'))
            fail(422, 'field_facet_invalid'); aggregate.push(`${valueFor(f)} facet_${i}`); });
        const predicate = flags.length ? flags.map(f => f.sql).join(' AND ') : 'true', scopeOrder = [...sorts.map(s => `scope.${s.name} ${s.direction} NULLS LAST`), 'scope.id'].join(','), pageOrder = [...sorts.map(s => `page.${s.name} ${s.direction} NULLS LAST`), 'o.id'].join(','), projection = q.columns.map(id => { const f = c.authorize(id, 'column'); return c.param(id) + '::text,' + c.expr(f); }).join(','), limit = `LIMIT ${c.param(q.pageSize)} OFFSET ${c.param((q.page - 1) * q.pageSize)}`;
        const extra = def.entity === 'resume' ? ',o.candidate_id,ap.id application_id,ap.version' : def.entity === 'application' ? ',o.candidate_id,o.job_id,o.status,o.version' : def.entity === 'interview' ? ',o.application_id,o.status,o.version' : def.entity === 'job' ? ',o.version,o.open' : def.entity === 'lead' ? ',o.state,o.version' : ',o.version';
        const facets = q.facets.map((id, i) => { const where = flags.filter(f => f.fieldId !== id).map(f => f.sql); return c.param(id) + `::text,coalesce((SELECT jsonb_agg(to_jsonb(f)) FROM(SELECT scope.facet_${i} value,count(*)::int count FROM configured_scope scope WHERE ${[...where, `scope.facet_${i} IS NOT NULL`].join(' AND ')} GROUP BY scope.facet_${i} ORDER BY scope.facet_${i} LIMIT 500) f),'[]'::jsonb)`; }).join(',');
        // The authorized ID page is already materialized. Fetch those rows by key
        // rather than hashing/scanning the full base table again for 25 projections.
        const pageTable = { application: 'applications', lead: 'leads', campus: 'campuses' }[def.entity];
        const pageFrom = pageTable ? `configured_page page CROSS JOIN LATERAL(SELECT * FROM ${pageTable} selected WHERE selected.id=page.id OFFSET 0) o` : `${base.from} JOIN configured_page page ON page.id=o.id`;
        const statement = `WITH configured_scope AS MATERIALIZED(SELECT o.id${aggregate.length ? ',' + aggregate.join(',') : ''} FROM ${base.from} ${joins.join(' ')} WHERE ${[base.where, ...constraints].map(test => '(' + test + ')').join(' AND ')}),configured_page AS MATERIALIZED(SELECT scope.id${sorts.map(s => ',scope.' + s.name).join('')} FROM configured_scope scope WHERE ${predicate} ORDER BY ${scopeOrder} ${limit}) SELECT(SELECT count(*)::int FROM configured_scope scope WHERE ${predicate}) total,coalesce((SELECT jsonb_agg(to_jsonb(r)) FROM(SELECT o.id${extra},jsonb_build_object(${projection}) "fieldValues" FROM ${pageFrom} ${valuesJoin} ORDER BY ${pageOrder}) r),'[]'::jsonb) items,jsonb_build_object(${facets}) facets`;
        const result = (await sql.query(statement, [...base.args, ...c.values])).rows[0];
        return { items: result.items.map(r => ({ ...r, customFields: Object.fromEntries(Object.entries(r.fieldValues).filter(([id]) => def.fields.some(f => f.fieldId === id && !f.coreKey))) })), total: result.total, page: q.page, pageSize: q.pageSize, facets: result.facets, definition: { ref: def.ref, aclRevision: def.aclRevision } };
    }
    async exportFields(a, kind, scopeValue, input) {
        const { q, def } = await this.validate(a, kind, input, true);
        if (!['filtered', 'all'].includes(scopeValue))
            fail(422, 'invalid_input');
        const result = await this.run(a, kind, scopeValue === 'all' ? { ...q, filters: [], query: '', facets: [], page: 1 } : { ...q, facets: [] }, true);
        const fields = q.columns.map(id => def.fields.find(f => f.fieldId === id));
        const csv = csvDocument([[`导出时间 ${new Date().toISOString()}；${scopeValue === 'all' ? '全部有权记录' : '当前筛选全部结果'}；定义版本 ${def.ref.version}；金额按最低或唯一金额，同币种/口径/明确组成`], ['记录ID', ...fields.map(f => f.label + (f.unit ? '（' + f.unit + '）' : ''))], ...result.items.map(r => [r.id, ...fields.map(f => { const v = r.fieldValues[f.fieldId]; if (v == null)
                    return ''; if (Array.isArray(v))
                    return v.map(id => f.options.find(o => o.id === id)?.label || id).join('、'); if (f.type === 'select')
                    return f.options.find(o => o.id === v)?.label || v; if (f.type.startsWith('money'))
                    return JSON.stringify(v); return v; })])]);
        await this.identity.audit(this.identity.db.sql, a.id, 'configured.export', kind, { scope: scopeValue, count: result.total, fields: q.columns, definitionVersion: def.ref.version });
        return csv;
    }
}
//# sourceMappingURL=query.js.map