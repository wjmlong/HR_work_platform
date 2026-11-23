import { z, uuid, parse } from "../http/validation.js";
import { Identity, requireRole, type Actor } from "../identity/service.js";
import {currentMatchSql,matchingListReadable} from '../business-config/bindings.js';
import {legacyDefinition,legacyKeys,profileSearchColumns,projectLegacyCore} from '../business-config/legacy-fields.js';
import { ranks } from "../recruiting/schema.js";
import { flowCountSql } from "../recruiting/query.js";
import { stageOrder } from "../recruiting/workflow.js";
export const dashboardRequest = z
  .object({ query: z.string().max(300).default(""), jobId: uuid.optional() })
  .strict();
export class DashboardService {
  constructor(readonly identity: Identity) {}
  async query(a: Actor, input: unknown) {
    requireRole(a, "admin", "manager", "recruiter");
    const [resumeDefinition,jobDefinition]=await Promise.all([legacyDefinition(this.identity,a,'resume'),legacyDefinition(this.identity,a,'job')]),search=profileSearchColumns(resumeDefinition,a,'p.profile'),searchExpression=search.length?"concat_ws(' ',"+search.join(',')+")":"''",nameVisible=legacyKeys(resumeDefinition,a).has('name'),jobNameVisible=legacyKeys(jobDefinition,a).has('name'),matchVisible=matchingListReadable(resumeDefinition,jobDefinition,a);
    const q = parse(dashboardRequest, input),
      params = [
        q.jobId || null,
        "%" + q.query.replace(/[\\%_]/g, "\\$&") + "%",
      ];
    return this.identity.db.tx(async (c) => {
      await c.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const base = `FROM candidates p LEFT JOIN applications a ON a.candidate_id=p.id AND a.is_current AND a.deleted_at IS NULL WHERE p.deleted_at IS NULL AND ($1::uuid IS NULL OR a.job_id=$1) AND ${searchExpression} ILIKE $2`;
      const counts = (
        await c.query(
          `SELECT count(*)::int candidates,count(a.id)::int workflows ${base}`,
          params,
        )
      ).rows[0];
      const stageCounts = Object.fromEntries(stageOrder.map((s) => [s, 0]));
      for (const row of (
        await c.query(
          `SELECT a.status,count(*)::int count ${base} AND a.id IS NOT NULL GROUP BY a.status`,
          params,
        )
      ).rows)
        stageCounts[row.status as keyof typeof stageCounts] = row.count;
      const jobs = (
        await c.query(
          "SELECT count(*)::int total,count(*) FILTER(WHERE open)::int open,count(*) FILTER(WHERE open AND coalesce(level,'')='')::int ungraded FROM jobs WHERE ($1::uuid IS NULL OR id=$1)",
          [q.jobId || null],
        )
      ).rows[0];
      const warningRows = (
        await c.query(
          `SELECT a.id,p.profile->>'name' name,
    (a.status='offered' AND a.collected_at IS NULL AND NOT EXISTS(SELECT 1 FROM application_events e WHERE e.application_id IN(SELECT prior.id FROM applications prior WHERE prior.candidate_id=p.id) AND e.to_state='collecting')) w1,
    (a.status IN ('collecting','background_check','offered','hired') AND NOT EXISTS(SELECT 1 FROM application_events e WHERE e.application_id IN(SELECT prior.id FROM applications prior WHERE prior.candidate_id=p.id) AND e.to_state=a.status AND coalesce(e.cc,'')<>'')) w2,
    (a.status='terminated' AND coalesce(a.term_reason,'')='') w3 ${base} AND a.id IS NOT NULL AND a.status IN ('collecting','background_check','offered','hired','terminated')`,
          params,
        )
      ).rows;
      const warnings: any[] = [];
      for (const [code, key, message] of [
        ["W1", "w1", "已发 offer 的候选人还没走完「资料收集 / 背调」"],
        ["W2", "w2", "已进入面试后环节，但没有抄送各部门提醒准备事项的记录"],
        ["W3", "w3", "录用终止未填写终止原因，请补录"],
      ]) {
        const rows = warningRows.filter((r) => r[key]);
        if (rows.length)
          warnings.push({
            code,
            count: rows.length,
            message,
            names: nameVisible?rows.slice(0, 20).map((r) => r.name):[],
            applicationIds: rows.slice(0, 20).map((r) => r.id),
          });
      }
      if (jobs.ungraded&&legacyKeys(jobDefinition,a).has('level'))
        warnings.push({
          code: "W4",
          count: jobs.ungraded,
          message: "在招岗位未设置「内部岗位等级」，发布前需补上",
          names: [],
        });
      const denominator =
        stageCounts.offered +
        stageCounts.hired +
        stageCounts.rejected +
        stageCounts.terminated;
      const kpis = {
        candidates: counts.candidates,
        inProcess:
          counts.workflows -
          stageCounts.hired -
          stageCounts.rejected -
          stageCounts.terminated - stageCounts.hired_other,
        screening: stageCounts.screening,
        interviewing: stageCounts.interviewing,
        collectionAndBackground:
          stageCounts.collecting + stageCounts.background_check,
        offered: stageCounts.offered,
        hired: stageCounts.hired,
        terminated: stageCounts.terminated,
        hiredOther: stageCounts.hired_other, onHold: stageCounts.on_hold, reserve: stageCounts.reserve,
        rejected: stageCounts.rejected,
        offerConversion: denominator
          ? (stageCounts.offered + stageCounts.hired) / denominator
          : null,
        jobs: { open: jobs.open, total: jobs.total },
      };
      const funnel = stageOrder.slice(0, 7).map((stage) => ({
        stage,
        count: stageOrder
          .slice(0, 7)
          .filter((s) => ranks[s] >= ranks[stage])
          .reduce((n, s) => n + stageCounts[s], 0),
      }));
      const pendingBase = base.replace(
        "WHERE p.deleted_at",
        "LEFT JOIN interviews i ON i.application_id=a.id AND i.deleted_at IS NULL AND i.status IN ('pending','confirmed') WHERE p.deleted_at",
      );
      const pending = (
        await c.query(
          `SELECT i.id,i.application_id,i.starts_at,i.round,p.profile->>'name' name ${pendingBase} AND i.id IS NOT NULL ORDER BY i.starts_at,i.id LIMIT 4`,
          params,
        )
      ).rows;
      const offered = (
        await c.query(
          `SELECT a.id,a.updated_at,p.profile->>'name' name ${base} AND a.status='offered' AND a.updated_at>=now()-interval '7 days' ORDER BY a.updated_at DESC,a.id LIMIT 3`,
          params,
        )
      ).rows;
      const todos = [
        ...pending.map((r) => {if(!nameVisible)delete r.name;return {kind:"interview",...r};}),
        ...offered.map((r) => {if(!nameVisible)delete r.name;return {kind:"arrival",...r};}),
        ...warnings
          .filter((w) => ["W2", "W3"].includes(w.code))
          .map((w) => ({
            kind: w.code === "W2" ? "cc" : "termination_reason",
            count: w.count,
          })),
      ];
      const cards = (
        await c.query(
          `WITH ranked AS (SELECT a.*,p.profile,j.name job_name,j.requirements_version,row_number() OVER(PARTITION BY a.status ORDER BY a.updated_at DESC,a.id) n FROM candidates p JOIN applications a ON a.candidate_id=p.id AND a.is_current AND a.deleted_at IS NULL JOIN jobs j ON j.id=a.job_id WHERE p.deleted_at IS NULL AND ($1::uuid IS NULL OR a.job_id=$1) AND ${searchExpression} ILIKE $2) SELECT r.*,(${flowCountSql("r")}) flow_count,ms.reference_score match_score FROM ranked r LEFT JOIN LATERAL(SELECT coalesce(m.reference_score,m.data->'score') reference_score FROM match_snapshots m WHERE ${currentMatchSql('m','r','r')} ORDER BY m.created_at DESC LIMIT 1) ms ON true WHERE n<=30 ORDER BY status,n`,
          params,
        )
      ).rows;
      return {
        scope: q,
        kpis,
        stageCounts,
        warnings,
        funnel,
        funnelBasis: "current-rank-excluding-rejected-and-terminated",
        formulaVersion: "prd-20261019",
        todos,
        board: stageOrder.map((stage) => ({
          stage,
          total: stageCounts[stage],
          items: cards.filter((r) => r.status === stage).map(r=>{const out={...r,profile:projectLegacyCore(resumeDefinition,a,r.profile),match_score:matchVisible?r.match_score:null,match_hidden:!matchVisible};if(!jobNameVisible)delete out.job_name;return out;}),
          hasMore: stageCounts[stage] > 30,
        })),
      };
    });
  }
}
