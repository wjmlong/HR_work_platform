import {currentMatchSql,matchingListReadable} from '../business-config/bindings.js';
import {legacyDefinition,assertLegacyField,profileSearchColumns,projectLegacyCore,legacyKeys} from '../business-config/legacy-fields.js';
import { z, uuid } from "../http/validation.js";
import { parse } from "../http/validation.js";
import { stage } from "./schema.js";
import { Identity, requireRole, type Actor } from "../identity/service.js";
import {fail} from "../http/errors.js";
export const applicationQueryInput = z
  .object({
    query: z.string().max(300).default(""),
    lifecycle: z.enum(["all","active","archive"]).default("all"),
    deleted: z.boolean().default(false),
    jobId: uuid.optional(),
    status: stage.optional(),
    education: z
      .enum([
        "none",
        "secondary",
        "associate",
        "bachelor",
        "master",
        "doctor",
        "unknown",
      ])
      .optional(),
    skill: z.string().max(100).default(""),
    flow: z.enum(["all", "transferred", "never"]).default("all"),
    sort: z.enum(["new", "match", "exp", "name"]).default("new"),
    page: z.number().int().positive().default(1),
    pageSize: z.number().int().min(1).max(100).default(25),
  })
  .strict();
export const flowCountSql = (alias: string) =>
  `SELECT count(*)::int FROM application_events flow JOIN applications prior ON prior.id=flow.application_id WHERE prior.candidate_id=${alias}.candidate_id AND flow.interaction IN ('form','transfer')`;
const flowTimeSql = (alias: string) =>
  `SELECT max(flow.at) FROM application_events flow JOIN applications prior ON prior.id=flow.application_id WHERE prior.candidate_id=${alias}.candidate_id AND flow.interaction IN ('form','transfer')`;
const writers = ["admin", "manager", "recruiter"] as const;
export async function readApplications(
  identity: Identity,
  a: Actor,
  input: unknown,
  allRows = false,
) {
  requireRole(a, ...writers, "interviewer", "viewer");
  const q = parse(applicationQueryInput, input),
    all = a.roles.some((role) => writers.includes(role as any));
  if (q.deleted) requireRole(a, "admin", "manager");
  const [definition,jobDefinition]=await Promise.all([legacyDefinition(identity,a,'resume'),legacyDefinition(identity,a,'job')]),searchColumns=profileSearchColumns(definition,a),matchVisible=matchingListReadable(definition,jobDefinition,a);
  if(q.sort==='match'&&!matchVisible)fail(403,'matching_sort_forbidden');
  if(q.education)assertLegacyField(definition,a,'education');if(q.skill)assertLegacyField(definition,a,'skills');if(q.sort==='exp')assertLegacyField(definition,a,'experienceYears','sort');if(q.sort==='name')assertLegacyField(definition,a,'name','sort');
  return identity.db.tx(async (c) => {
    await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const params: unknown[] = [
      q.jobId || null,
      q.status || null,
      q.deleted,
      all,
      a.id,
      a.roles.includes("interviewer"),
      a.roles.includes("viewer"),
    ];
    const argument = (value: unknown) => {
      params.push(value);
      return "$" + params.length;
    };
    let where =
      "a.is_current AND (a.deleted_at IS NOT NULL)=$3 AND c.deleted_at IS NULL AND ($1::uuid IS NULL OR a.job_id=$1) AND ($2::text IS NULL OR a.status=$2) AND ($4 OR ($6 AND EXISTS(SELECT 1 FROM interviews i JOIN interviewers x ON x.interview_id=i.id WHERE i.application_id=a.id AND i.deleted_at IS NULL AND i.status<>'cancelled' AND x.user_id=$5 AND NOT x.temporary_access)) OR ($7 AND EXISTS(SELECT 1 FROM application_grants g WHERE g.application_id=a.id AND g.user_id=$5)))";
    if(q.lifecycle!=="all") where += " AND a.status "+(q.lifecycle==="active"?"NOT IN":"IN")+" ('hired','terminated','rejected','hired_other')";
    if (q.query.trim())
      where +=
        " AND "+(searchColumns.length?"concat_ws(' ',"+searchColumns.join(',')+")":"''")+" ILIKE " +
        argument("%" + q.query.replace(/[\\%_]/g, "\\$&") + "%");
    if (q.education)
      where +=
        q.education === "unknown"
          ? " AND coalesce(c.profile->>'education','')=''"
          : " AND c.profile->>'education'=" + argument(q.education);
    const skill = q.skill.trim().toLowerCase();
    if (skill) {
      const ascii = /^[a-z0-9_]+$/i.test(skill),
        expression = ascii
          ? "(^|[^a-z0-9_])" +
            skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
            "($|[^a-z0-9_])"
          : skill;
      where +=
        " AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(c.profile->'skills','[]')) sk(value) WHERE " +
        (ascii
          ? "lower(sk.value)~" + argument(expression)
          : "strpos(lower(sk.value)," + argument(expression) + ")>0") +
        ")";
    }
    if (q.flow !== "all")
      where +=
        " AND (" +
        flowCountSql("a") +
        ")" +
        (q.flow === "transferred" ? ">0" : "=0");
    const joins =
      " FROM applications a JOIN candidates c ON c.id=a.candidate_id JOIN jobs j ON j.id=a.job_id";
    const stageCounts: Record<string, number> = Object.fromEntries(
      (
        await c.query(
          "SELECT a.status,count(*)::int total" +
            joins +
            " WHERE " +
            where +
            " GROUP BY a.status",
          [params[0], null, ...params.slice(2)],
        )
      ).rows.map((row) => [row.status, row.total]),
    );
    const total = q.status
      ? stageCounts[q.status] || 0
      : Object.values(stageCounts).reduce((sum, n) => sum + n, 0);
    const limit = "$" + (params.length + 1),
      offset = "$" + (params.length + 2);
    const scoreWhere=(app:string,job:string)=>currentMatchSql('m',app,job);
    const order =
      q.sort === "name"
        ? "(c.profile->>'name') COLLATE \"zh-x-icu\" ASC"
        : q.sort === "exp"
          ? "(c.profile->>'experienceYears')::numeric DESC NULLS LAST"
          : q.sort === "match"
            ? "(SELECT coalesce(m.reference_score->>'value',m.data->'score'->>'value',m.data->'score'->>'lower')::numeric FROM match_snapshots m WHERE " +
              scoreWhere("a", "j") +
              " LIMIT 1) DESC NULLS LAST"
            : "c.created_at DESC";
    const rows = (
      await c.query(
        "WITH page AS MATERIALIZED(SELECT a.*,c.profile,c.created_at candidate_created_at,j.name job_name,j.requirements_version" +
          joins +
          " WHERE " +
          where +
          " ORDER BY " +
          order +
          ",a.id" +
          (allRows ? "" : " LIMIT " + limit + " OFFSET " + offset) +
          ") SELECT p.*,ms.summary match,(" +
          flowCountSql("p") +
          ") flow_count,(" +
          flowTimeSql("p") +
          ") last_flow_at FROM page p LEFT JOIN LATERAL(SELECT jsonb_build_object('score',coalesce(m.reference_score,m.data->'score'),'snapshotId',m.id) summary FROM match_snapshots m WHERE " +
          scoreWhere("p", "p") +
          " LIMIT 1) ms ON true ORDER BY " +
          (q.sort === "new"
            ? "p.candidate_created_at DESC"
            : q.sort === "name"
              ? "(p.profile->>'name') COLLATE \"zh-x-icu\" ASC"
              : q.sort === "exp"
                ? "(p.profile->>'experienceYears')::numeric DESC NULLS LAST"
                : "(ms.summary->'score'->>'value')::numeric DESC NULLS LAST") +
          ",p.id",
        allRows
          ? params
          : [...params, q.pageSize, (q.page - 1) * q.pageSize],
      )
    ).rows;
    return {
      items: rows.map(r=>{const out={...r,profile:projectLegacyCore(definition,a,r.profile),match:matchVisible?r.match:null,match_hidden:!matchVisible};if(!legacyKeys(jobDefinition,a).has('name'))delete out.job_name;return out;}),
      total,
      stageCounts,
      page: q.page,
      pageSize: q.pageSize,
    };
  });
}
