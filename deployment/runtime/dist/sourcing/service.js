import { leadQueryPermissions, projectLegacyCore, assertLegacyField } from '../business-config/legacy-fields.js';
import { requireRole } from "../identity/service.js";
import { Dictionary } from "../dictionary/service.js";
import { BusinessDictionaryService, validateOption } from '../business-config/dictionaries.js';
import { fail, found } from "../http/errors.js";
import { parse, z, version, text } from "../http/validation.js";
import { leadInput, leadPatch, queryInput, setupInput, filterNames, state, } from "./schema.js";
import { searchEvidence, recordSearchEvidence } from "./search.js";
import { leadWhere, virtualFacets, directionValues } from "./sql.js";
const writers = ["admin", "manager", "recruiter"], states = [
    "uncontacted",
    "contacted",
    "replied",
    "resume_received",
    "uploaded",
];
export function overdue(row, now = new Date()) {
    const at = row.state === "uncontacted"
        ? row.created_at
        : row.state === "contacted"
            ? row.last_contacted_at
            : null;
    return (!!at &&
        now.getTime() - new Date(at).getTime() >
            (row.state === "uncontacted" ? 7 : 14) * 86400000);
}
export const leadTransitionRequest = z
    .object({
    version,
    state,
    occurredAt: z.iso.datetime({ offset: true }).optional(),
    reason: z.string().max(1000).default(""),
    confirm: z.boolean().default(false),
})
    .strict();
export const leadFollowupRequest = z
    .object({
    version,
    kind: z.enum(["contact", "note"]),
    note: text,
    occurredAt: z.iso.datetime({ offset: true }),
})
    .strict();
export class SourcingService {
    identity;
    db;
    dictionary;
    constructor(identity) {
        this.identity = identity;
        this.db = identity.db;
        this.dictionary = new Dictionary(this.db);
    }
    async setup(a, input) {
        requireRole(a, ...writers, "interviewer", "viewer");
        const b = parse(setupInput, input);
        await this.db.query("INSERT INTO sourcing_setups(user_id,data) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET data=$2,updated_at=now()", [a.id, b]);
        return b;
    }
    async getSetup(a) {
        requireRole(a, ...writers, "interviewer", "viewer");
        return ((await this.db.query("SELECT data FROM sourcing_setups WHERE user_id=$1", [a.id])).rows[0]?.data || {});
    }
    async request(a) {
        requireRole(a, ...writers, "interviewer", "viewer");
        const setup = await this.getSetup(a);
        parse(setupInput, setup);
        return (await this.db.query("INSERT INTO collection_requests(user_id,setup,execution_status) VALUES($1,$2,'not_configured') RETURNING *", [a.id, setup])).rows[0];
    }
    async create(a, input) {
        requireRole(a, ...writers);
        const b = parse(leadInput, input);
        if (b.state === "contacted" && !b.occurredAt)
            fail(422, "contact_time_required");
        if (b.state === "uncontacted" && b.occurredAt)
            fail(422, "contact_state_conflict");
        const followed = b.followupDate
            ? new Date(b.followupDate + "T00:00:00+08:00")
            : null;
        if ((b.occurredAt && new Date(b.occurredAt).getTime() > Date.now() + 60000) ||
            (followed && followed.getTime() > Date.now() + 60000))
            fail(422, "future_followup");
        return this.db.tx(async (c) => {
            const owner = b.ownerId || a.id;
            const sources = (await new BusinessDictionaryService(this.identity).dictionary(a, 'lead_sources')).options;
            if (!sources.some(o => o.id === b.source))
                fail(422, 'invalid_input');
            validateOption(sources, b.source);
            if (!(await c.query("SELECT 1 FROM users WHERE id=$1 AND status='active' AND directory_active AND roles&&ARRAY['admin','manager','recruiter']::text[]", [owner])).rowCount)
                fail(422, "owner_invalid");
            const skills = await this.dictionary.normalize(b.skills, c);
            const row = (await c.query("INSERT INTO leads(name,org,school,major,skills,direction,contact,source,line,owner_id,note,raw,state,last_contacted_at,last_followup_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,greatest($14::timestamptz,$15::timestamptz)) RETURNING *", [
                b.name,
                b.org,
                b.school,
                b.major,
                skills,
                b.direction,
                b.contact,
                b.source,
                b.line,
                owner,
                b.note,
                b.raw,
                b.state,
                b.occurredAt || null,
                followed,
            ])).rows[0];
            await c.query("INSERT INTO lead_events(lead_id,actor_id,kind,to_state) VALUES($1,$2,'create',$3)", [row.id, a.id, b.state]);
            if (b.occurredAt)
                await c.query("INSERT INTO lead_followups(lead_id,actor_id,kind,note,occurred_at) VALUES($1,$2,'contact',$3,$4)", [row.id, a.id, b.note || "新建时补录实际联系", b.occurredAt]);
            if (followed)
                await c.query("INSERT INTO lead_followups(lead_id,actor_id,kind,note,occurred_at) VALUES($1,$2,'note',$3,$4)", [
                    row.id,
                    a.id,
                    b.note || "新建时补录跟进日期（不代表实际联系）",
                    followed,
                ]);
            await this.identity.audit(c, a.id, "lead.create", row.id);
            return row;
        });
    }
    async update(a, id, input) {
        requireRole(a, ...writers);
        const b = parse(leadPatch, input);
        return this.db.tx(async (c) => {
            const row = found((await c.query("SELECT * FROM leads WHERE id=$1 AND deleted_at IS NULL FOR UPDATE", [id])).rows[0]);
            if (row.version !== b.version)
                fail(409, "version_conflict");
            if (b.source !== undefined) {
                const sources = (await new BusinessDictionaryService(this.identity).dictionary(a, 'lead_sources')).options;
                if (b.source !== row.source && !sources.some(o => o.id === b.source))
                    fail(422, 'invalid_source');
                validateOption(sources, b.source, row.source);
            }
            const values = [id], sets = [];
            for (const [k, v] of Object.entries(b)) {
                if (k === "version")
                    continue;
                const col = k === "ownerId" ? "owner_id" : k;
                if (k === "ownerId" &&
                    !(await c.query("SELECT 1 FROM users WHERE id=$1 AND status='active' AND directory_active AND roles&&ARRAY['admin','manager','recruiter']::text[]", [v])).rowCount)
                    fail(422, "owner_invalid");
                values.push(k === "skills"
                    ? await this.dictionary.normalize(v, c)
                    : v);
                sets.push(col + "=$" + values.length);
            }
            const updated = (await c.query("UPDATE leads SET " +
                [...sets, "version=version+1", "updated_at=now()"].join(",") +
                " WHERE id=$1 RETURNING *", values)).rows[0];
            await this.identity.audit(c, a.id, "lead.edit", id, {
                fields: Object.keys(b).filter((k) => k !== "version"),
            });
            return updated;
        });
    }
    async transition(a, id, input) {
        requireRole(a, ...writers);
        const b = parse(leadTransitionRequest, input);
        if (b.occurredAt && new Date(b.occurredAt).getTime() > Date.now() + 60000)
            fail(422, "future_followup");
        return this.db.tx(async (c) => {
            const row = found((await c.query("SELECT * FROM leads WHERE id=$1 AND deleted_at IS NULL FOR UPDATE", [id])).rows[0]);
            if ((await c.query('SELECT 1 FROM discovery_subjects WHERE lead_id=$1 AND do_not_contact FOR SHARE', [id])).rowCount)
                fail(409, 'do_not_contact');
            if (row.version !== b.version)
                fail(409, "version_conflict");
            if (["uploaded", "declined"].includes(row.state)) {
                if (!b.confirm || !b.reason.trim())
                    fail(409, "terminal_confirmation");
                requireRole(a, "admin", "manager");
            }
            if (b.state === "contacted" && !b.occurredAt)
                fail(422, "contact_time_required");
            if (b.state === "declined" && !b.reason.trim())
                fail(422, "reason_required");
            const adjacent = states.indexOf(b.state) === states.indexOf(row.state) + 1 ||
                (row.state === "replied" && b.state === "contacted") ||
                b.state === row.state ||
                b.state === "declined";
            if (!adjacent && (!b.confirm || !b.reason.trim()))
                fail(409, "stage_confirmation");
            if (!adjacent)
                requireRole(a, "admin", "manager");
            const updated = (await c.query("UPDATE leads SET state=$2,version=version+1,updated_at=now(),last_contacted_at=CASE WHEN $2='contacted' THEN greatest(last_contacted_at,$3::timestamptz) ELSE last_contacted_at END,last_followup_at=CASE WHEN $2='contacted' THEN greatest(last_followup_at,$3::timestamptz) ELSE last_followup_at END WHERE id=$1 RETURNING *", [id, b.state, b.occurredAt || null])).rows[0];
            if (b.state === "contacted")
                await c.query("INSERT INTO lead_followups(lead_id,actor_id,kind,note,occurred_at) VALUES($1,$2,'contact',$3,$4)", [id, a.id, b.reason || "人工记录联系", b.occurredAt]);
            await c.query("INSERT INTO lead_events(lead_id,actor_id,kind,from_state,to_state,reason) VALUES($1,$2,'transition',$3,$4,$5)", [id, a.id, row.state, b.state, b.reason]);
            await this.identity.audit(c, a.id, "lead.transition", id, {
                from: row.state,
                to: b.state,
            });
            return updated;
        });
    }
    async followup(a, id, input) {
        requireRole(a, ...writers);
        const b = parse(leadFollowupRequest, input);
        if (new Date(b.occurredAt).getTime() > Date.now() + 60000)
            fail(422, "future_followup");
        return this.db.tx(async (c) => {
            const row = found((await c.query("SELECT * FROM leads WHERE id=$1 AND deleted_at IS NULL FOR UPDATE", [id])).rows[0]);
            if ((await c.query('SELECT 1 FROM discovery_subjects WHERE lead_id=$1 AND do_not_contact FOR SHARE', [id])).rowCount)
                fail(409, 'do_not_contact');
            if (row.version !== b.version)
                fail(409, "version_conflict");
            if (["uploaded", "declined"].includes(row.state))
                fail(409, "terminal_lead");
            await c.query("INSERT INTO lead_followups(lead_id,actor_id,kind,note,occurred_at) VALUES($1,$2,$3,$4,$5)", [id, a.id, b.kind, b.note, b.occurredAt]);
            const next = b.kind === "contact" && row.state === "uncontacted"
                ? "contacted"
                : row.state;
            const result = (await c.query("UPDATE leads SET state=$2,version=version+1,updated_at=now(),last_followup_at=greatest(last_followup_at,$3::timestamptz),last_contacted_at=CASE WHEN $4='contact' THEN greatest(last_contacted_at,$3::timestamptz) ELSE last_contacted_at END WHERE id=$1 RETURNING *", [id, next, b.occurredAt, b.kind])).rows[0];
            await c.query("INSERT INTO lead_events(lead_id,actor_id,kind,from_state,to_state) VALUES($1,$2,'followup',$3,$4)", [id, a.id, row.state, next]);
            await this.identity.audit(c, a.id, "lead.followup", id, { kind: b.kind });
            return result;
        });
    }
    async remove(a, id, v, restore = false) {
        requireRole(a, ...writers);
        if (restore)
            requireRole(a, "admin", "manager");
        return this.db.tx(async (c) => {
            const r = await c.query("UPDATE leads SET deleted_at=" +
                (restore ? "NULL" : "now()") +
                ",version=version+1,updated_at=now() WHERE id=$1 AND version=$2 RETURNING id,version", [id, v]);
            if (!r.rowCount)
                fail(409, "version_conflict");
            await this.identity.audit(c, a.id, restore ? "lead.restore" : "lead.delete", id);
            return r.rows[0];
        });
    }
    matches(row, q, except) {
        if (q.line && q.line !== "all" && row.line !== q.line)
            return false;
        for (const name of filterNames) {
            if (name === except)
                continue;
            const values = q.filters[name];
            if (values?.length &&
                !values.some((v) => name === "skills" ? row.skills.includes(v) : row[name] === v))
                return false;
        }
        return searchEvidence([
            row.name,
            row.org,
            row.school,
            row.major,
            ...row.skills,
            row.direction,
            row.contact,
            row.source,
            row.note,
            row.raw,
        ].join("\n"), q.query, q.matchMode).matched;
    }
    async query(a, input) {
        requireRole(a, ...writers);
        const q = parse(queryInput, input), permission = await leadQueryPermissions(this.identity, a, q);
        if (q.deleted)
            requireRole(a, "admin", "manager");
        return this.db.tx(async (c) => {
            await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
            const where = leadWhere(q, undefined, permission.keys), rows = (await c.query("SELECT l.*,(SELECT u.name FROM users u WHERE u.id=l.owner_id) owner_name FROM leads l WHERE " +
                where.sql +
                " ORDER BY l.created_at DESC,l.id LIMIT $" +
                (where.values.length + 1) +
                " OFFSET $" +
                (where.values.length + 2), [...where.values, q.pageSize, (q.page - 1) * q.pageSize])).rows;
            const total = Number((await c.query("SELECT count(*) FROM leads l WHERE " + where.sql, where.values)).rows[0].count), values = [];
            const scopes = new Map(), ctes = [];
            const source = (w, columns) => {
                const key = w.sql + JSON.stringify(w.values);
                let name = scopes.get(key);
                if (!name) {
                    name = "facet_scope_" + scopes.size;
                    scopes.set(key, name);
                    const offset = values.length;
                    values.push(...w.values);
                    const condition = w.sql.replace(/\$(\d+)/g, (_, n) => "$" + (Number(n) + offset));
                    ctes.push({ name, condition, columns: new Set() });
                }
                const scope = ctes.find((x) => x.name === name);
                for (const column of columns)
                    scope.columns.add(column);
                return name + " l";
            };
            const groups = new Map();
            for (const name of filterNames) {
                if (virtualFacets[name] || !permission.keys.has(name) && !['state', 'owner_id'].includes(name))
                    continue;
                const w = leadWhere(q, name, permission.keys), key = w.sql + JSON.stringify(w.values);
                const group = groups.get(key) || { where: w, names: [] };
                group.names.push(name);
                groups.set(key, group);
            }
            const unions = [];
            for (const { where: w, names } of groups.values()) {
                const scoped = source(w, names), scalar = names.filter((n) => n !== "skills" && n !== "direction");
                if (scalar.length) {
                    const branch = (result) => "CASE " +
                        scalar
                            .map((n) => "WHEN GROUPING(l." + n + ")=0 THEN " + result(n))
                            .join(" ") +
                        " END";
                    unions.push("SELECT " +
                        branch((n) => "'" + n + "'") +
                        " facet," +
                        branch((n) => "l." + n + "::text") +
                        " value,count(*)::int count FROM " +
                        scoped +
                        " GROUP BY GROUPING SETS(" +
                        scalar.map((n) => "(l." + n + ")").join(",") +
                        ")");
                }
                for (const multivalue of names.filter((n) => n === "skills" || n === "direction"))
                    unions.push("SELECT '" +
                        multivalue +
                        "' facet,v.value,count(*)::int count FROM " +
                        scoped +
                        " CROSS JOIN LATERAL (SELECT DISTINCT btrim(token) value FROM unnest(" +
                        (multivalue === "skills" ? "l.skills" : directionValues) +
                        ") tokens(token) WHERE btrim(token)<>'') v GROUP BY v.value");
            }
            for (const [name, options] of Object.entries(virtualFacets)) {
                if (name === 'contactAvailability' && !permission.keys.has('contact'))
                    continue;
                const w = leadWhere(q, name, permission.keys), scoped = source(w, name === "contactAvailability"
                    ? ["contact"]
                    : [
                        "state",
                        "created_at",
                        "last_contacted_at",
                        "last_followup_at",
                    ]);
                const counts = Object.entries(options).flatMap(([v, p]) => [
                    "'" + v + "'",
                    "count(*) FILTER(WHERE " + p + ")",
                ]);
                unions.push("SELECT '" +
                    name +
                    "' facet,j.key value,j.value::int count FROM (SELECT jsonb_build_object(" +
                    counts.join(",") +
                    ") counts FROM " +
                    scoped +
                    ") t CROSS JOIN LATERAL jsonb_each_text(t.counts) j");
            }
            const counts = (await c.query("WITH " +
                ctes
                    .map((scope) => scope.name +
                    " AS MATERIALIZED(SELECT " +
                    [...scope.columns]
                        .map((column) => "l." + column)
                        .join(",") +
                    " FROM leads l WHERE " +
                    scope.condition +
                    ")")
                    .join(",") +
                " " +
                unions.join(" UNION ALL "), values)).rows, facets = {};
            for (const name of filterNames) {
                if (name === 'contactAvailability' && !permission.keys.has('contact') || !virtualFacets[name] && !permission.keys.has(name) && !['state', 'owner_id'].includes(name))
                    continue;
                const map = new Map(counts.filter((r) => r.facet === name).map((r) => [r.value, r.count]));
                for (const v of q.filters[name] || [])
                    if (!map.has(v))
                        map.set(v, 0);
                facets[name] = [...map]
                    .filter(([value, count]) => (value.trim() && Number(count) > 0) ||
                    (q.filters[name] || []).includes(value))
                    .sort(([a], [b]) => a.localeCompare(b, "zh"))
                    .map(([value, count]) => ({ value, count }));
            }
            const items = rows.map(raw => {
                const r = projectLegacyCore(permission.def, a, raw);
                if (!permission.keys.has('raw'))
                    delete r.raw;
                return ({
                    ...r,
                    overdue: overdue(r),
                    hits: recordSearchEvidence({
                        ...Object.fromEntries([
                            "name",
                            "org",
                            "school",
                            "major",
                            "skills",
                            "direction",
                            "contact",
                            "source",
                            "note",
                            "raw",
                        ].map((k) => [
                            k,
                            Array.isArray(r[k]) ? r[k].join(" / ") : r[k] || "",
                        ])),
                        state: {
                            uncontacted: "未联系",
                            contacted: "已联系未回",
                            replied: "已回复",
                            resume_received: "已拿到简历",
                            uploaded: "已上传系统",
                            declined: "明确拒绝",
                        }[r.state] || "",
                        line: { high: "高端线", focus: "集中线", social: "社媒线" }[r.line] || "",
                    }, q.query, q.matchMode),
                });
            });
            return { items, total, facets, page: q.page, pageSize: q.pageSize };
        });
    }
    async metrics(a, input) {
        requireRole(a, ...writers);
        const q = parse(queryInput, input), permission = await leadQueryPermissions(this.identity, a, q), where = leadWhere(q, undefined, permission.keys), rows = (await this.db.query("SELECT l.state,l.source FROM leads l WHERE " + where.sql, where.values)).rows;
        const summary = (rows) => {
            const acquired = rows.filter((r) => ["resume_received", "uploaded"].includes(r.state)).length;
            return {
                total: rows.length,
                following: rows.filter((r) => ["uncontacted", "contacted", "replied"].includes(r.state)).length,
                acquired,
                conversionRate: rows.length ? acquired / rows.length : 0,
            };
        };
        return {
            ...summary(rows),
            channels: permission.keys.has('source') ? [...new Set(rows.map((r) => r.source))].map((source) => ({
                source,
                ...summary(rows.filter((r) => r.source === source)),
            })) : [],
            asOf: new Date().toISOString(),
        };
    }
    async csv(a, input, scope = "filtered") {
        requireRole(a, ...writers);
        const q = parse(queryInput, scope === "all" ? {} : input), permission = await leadQueryPermissions(this.identity, a, q);
        for (const key of ['name', 'org', 'school', 'major', 'skills', 'direction', 'contact', 'source', 'note'])
            assertLegacyField(permission.def, a, key, 'export');
        return this.db.tx(async (c) => {
            await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
            const where = leadWhere(q, undefined, permission.keys), rows = (await c.query("SELECT l.*,(SELECT u.name FROM users u WHERE u.id=l.owner_id) owner_name FROM leads l WHERE " +
                where.sql +
                " ORDER BY l.created_at DESC,l.id", where.values)).rows;
            const cell = (v) => {
                let s = String(v ?? "");
                if (/^[\s]*[=+@\-\t\r]/.test(s))
                    s = "'" + s;
                return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
            };
            const data = [
                [
                    "姓名",
                    "单位",
                    "院校",
                    "专业",
                    "技能",
                    "研究方向/成果",
                    "联系方式",
                    "来源",
                    "状态",
                    "跟进日",
                    "备注",
                ],
                ...rows.map((r) => [
                    r.name,
                    r.org,
                    r.school,
                    r.major,
                    r.skills.join(" / "),
                    r.direction,
                    r.contact,
                    r.source,
                    {
                        uncontacted: "未联系",
                        contacted: "已联系未回",
                        replied: "已回复",
                        resume_received: "已拿到简历",
                        uploaded: "已上传系统",
                        declined: "明确拒绝",
                    }[r.state] || r.state,
                    r.last_followup_at
                        ? new Date(r.last_followup_at).toLocaleDateString("sv-SE", {
                            timeZone: "Asia/Shanghai",
                        })
                        : "",
                    r.note,
                ]),
            ];
            await this.identity.audit(c, a.id, "lead.export", null, {
                scope,
                count: rows.length,
            });
            return ("\uFEFF" +
                data.map((row) => row.map(cell).join(",")).join("\r\n") +
                "\r\n");
        });
    }
}
//# sourceMappingURL=service.js.map