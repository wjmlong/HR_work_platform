import {CalendarSync} from '../feishu-meetings/sync.js';
import {Directory} from './directory.js';
import {InterviewGrants,grantInput} from './grants.js';
import {ConfiguredEntities} from '../business-config/entities.js';
import {projectCore} from '../business-config/object-fields.js';
import {loadDefinition} from '../business-config/fields.js';
import {TaskService} from '../tasks/service.js';
import {FileStore} from '../files/storage.js';
import type { FastifyInstance } from "fastify";
import { Identity, token, requireRole } from "./service.js";
import { fail, found } from "../http/errors.js";
import { parse, z, uuid, version } from "../http/validation.js";
export const callbackRequest = z
  .object({
    state: z.string().min(10).max(200),
    code: z.string().min(1).max(2000).optional(),
    error: z.string().max(100).optional(),
  })
  .strict();
export const memberRequest = z
  .object({
    version,
    status: z.enum(["active", "disabled", "rejected"]),
    roles: z
      .array(z.enum(["admin", "manager", "recruiter", "interviewer", "viewer"]))
      .max(5),
  })
  .strict();
export const assignmentQuery = z
  .object({
    role: z.enum(["interviewer", "viewer", "owner", "cc"]),
    ids:z.string().max(4000).optional().transform(v=>v?parse(z.array(uuid).min(1).max(100),v.split(",")):null),
    query: z.string().max(100).default(""),
    page: z
      .string()
      .regex(/^[1-9][0-9]{0,6}$/)
      .default("1")
      .transform(Number),
    pageSize: z
      .string()
      .regex(/^(?:[1-9][0-9]?|100)$/)
      .default("25")
      .transform(Number),
  })
  .strict();
export function identityRoutes(app: FastifyInstance, identity: Identity) {
  const db = identity.db,
    cookie = {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "lax" as const,
    };
  const directory=new Directory(identity),grants=new InterviewGrants(identity);
  app.get('/api/v4/directory/members',async req=>{
    requireRole(req.actor,'admin');
    const q=parse(z.object({query:z.string().max(100).default(''),page:z.coerce.number().int().positive().max(100000).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(25)}).strict(),req.query);
    return directory.search(q);
  });
  const interviewId=(params:unknown)=>parse(z.object({id:uuid}),params).id;
  app.get('/api/v4/interviews/:id/access-grants',req=>grants.list(req.actor,interviewId(req.params)));
  app.post('/api/v4/interviews/:id/access-grants',req=>grants.grant(req.actor,interviewId(req.params),parse(grantInput,req.body)));
  app.post('/api/v4/interview-access-grants/:id/revoke',req=>grants.revoke(req.actor,interviewId(req.params)));
  app.patch('/api/v4/interview-access-grants/:id',req=>grants.extend(req.actor,interviewId(req.params),parse(z.object({expiresAt:z.iso.datetime({offset:true})}).strict(),req.body).expiresAt));
  app.get('/api/v4/my-interviews',req=>grants.mine(req.actor));
  app.patch('/api/v4/interviews/:id/schedule',req=>grants.schedule(req.actor,interviewId(req.params),req.body));
  app.get('/api/v4/interviews/:id/materials',async req=>{
    const id=interviewId(req.params),a=await identity.interviewActor(req.actor,id),interview=await new ConfiguredEntities(identity).project(a,'interview',id);
    const meeting=found((await db.query('SELECT application_id FROM interviews WHERE id=$1',[id])).rows[0]),application=await identity.applicationAccess(a,meeting.application_id);
    const job=found((await db.query('SELECT j.*,v.requirements FROM jobs j JOIN job_versions v ON v.job_id=j.id AND v.version=j.requirements_version WHERE j.id=$1',[application.job_id])).rows[0]);
    const projectedJob=await projectCore(identity,a,'job',{id:job.id,name:job.name,department:job.department,level:job.level,requirements:job.requirements},{kind:'job',id:job.id});
    const resume=application.resume_version_id?await new TaskService(identity,new FileStore(identity.config.storageRoot)).raw(a,application.resume_version_id,true):null;
    const evaluationDefinition=await loadDefinition(identity,'evaluation',db.sql,a);
    const scope=new CalendarSync(identity).scope;
    const link=(await db.query('SELECT event_id,state,last_error,updated_at FROM calendar_event_links WHERE scope=$1 AND interview_id=$2',[scope,id])).rows[0];
    const outbound=(await db.query('SELECT generation>completed_generation queued,attempts,last_error FROM calendar_sync_outbox WHERE scope=$1 AND interview_id=$2',[scope,id])).rows[0];
    const calendar={enabled:!!identity.config.calendarSync?.enabled,eventId:link?.event_id||null,state:link?.state||null,updatedAt:link?.updated_at||null,lastError:outbound?.last_error||link?.last_error||null,queued:!!outbound?.queued,attempts:outbound?.attempts||0};
    return {calendar,interview,application:{id:application.id,jobId:application.job_id,candidateId:application.candidate_id},job:{...projectedJob.core,customFields:projectedJob.customFields},resume,evaluationDefinition,access:{temporary:!!a.temporaryScope,role:a.temporaryScope?.role||null}};
  });
  app.get("/api/v4/auth/providers", async () => ({
    feishu: identity.provider.configured(),
    password: false,
    registration: false,
  }));
  app.get("/api/v4/auth/feishu/start", async (req, reply) => {
    if (!identity.provider.configured()) fail(503, "feishu_not_configured");
    await identity.limit("oauth:" + req.ip);
    const state = token(),
      browser = token(),
      verifier = token();
    await db.query(
      "INSERT INTO oauth_states(state_hash,browser_hash,verifier,expires_at) VALUES($1,$2,$3,now()+interval '5 minutes')",
      [identity.hash(state), identity.hash(browser), verifier],
    );
    reply.setCookie((identity.config.cookiePrefix || "__Host-recruit_v4") + "_oauth", browser, {
      ...cookie,
      maxAge: 300,
    });
    return reply.redirect(identity.provider.authorizeUrl(state, verifier));
  });
  const callback: import("fastify").RouteHandlerMethod = async (req, reply) => {
    const q = parse(callbackRequest, req.query);
    const r = await db.query(
        "DELETE FROM oauth_states WHERE state_hash=$1 RETURNING *",
        [identity.hash(q.state)],
      ),
      s = r.rows[0];
    reply.clearCookie((identity.config.cookiePrefix || "__Host-recruit_v4") + "_oauth", cookie);
    if (
      !s ||
      new Date(s.expires_at).getTime() < Date.now() ||
      s.browser_hash !==
        identity.hash(req.cookies[(identity.config.cookiePrefix || "__Host-recruit_v4") + "_oauth"] || "") ||
      !q.code ||
      q.error
    )
      fail(401, "oauth_state_invalid");
    const session = await identity.establish(
      await identity.provider.identity(q.code, s.verifier),
    );
    reply.setCookie((identity.config.cookiePrefix || "__Host-recruit_v4") + "_session", session, {
      ...cookie,
      maxAge: 28800,
    });
    return reply.redirect("/");
  };
  for (const path of ["/api/v4/auth/feishu/callback", "/api/v3/auth/feishu/callback", "/api/auth/feishu/callback"]) app.get(path, callback);
  app.get("/api/v4/auth/me", async (req) => ({...req.actor,calendarSyncEnabled:!!identity.config.calendarSync?.enabled,environment:identity.config.schema.startsWith('recruit_test_')?'isolated_test':'business'}));
  app.post("/api/v4/auth/logout", async (req, reply) => {
    await db.query("DELETE FROM sessions WHERE token_hash=$1", [
      identity.hash(req.cookies[(identity.config.cookiePrefix || "__Host-recruit_v4") + "_session"] || ""),
    ]);
    reply.clearCookie((identity.config.cookiePrefix || "__Host-recruit_v4") + "_session", cookie);
    return { ok: true };
  });
  app.get("/api/v4/assignment-members", async (req) => {
    requireRole(req.actor, "admin", "manager", "recruiter");
    const q = parse(assignmentQuery, req.query);
    if (q.role === "viewer") requireRole(req.actor, "admin", "manager");
    const roles =
      q.role === "viewer"
        ? ["viewer"]
        : [
            "admin",
            "manager",
            "recruiter",
            ...(q.role === "interviewer" || q.role === "cc" ? ["interviewer"] : []),
            ...(q.role === "cc" ? ["viewer"] : []),
          ];
    const where =
      "tenant=$1 AND app_id=$2 AND status='active' AND directory_active AND roles&&$3::text[] AND name ILIKE $4 AND ($5::uuid[] IS NULL OR id=ANY($5::uuid[]))";
    return db.tx(async (c) => {
      await c.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const params = [
        identity.config.feishu.tenant,
        identity.config.feishu.appId,
        roles,
        "%" + q.query.replace(/[\\%_]/g, "\\$&") + "%",
        q.ids,
      ];
      const total = Number(
        (await c.query("SELECT count(*) FROM users WHERE " + where, params))
          .rows[0].count,
      );
      const items = (
        await c.query(
          "SELECT id,name,roles,open_id FROM users WHERE " +
            where +
            " ORDER BY name,id LIMIT $6 OFFSET $7",
          [...params, q.pageSize, (q.page - 1) * q.pageSize],
        )
      ).rows;
      const decorated=await directory.decorate(items,p=>p.open_id);
      return { items:decorated.map(({open_id,...p})=>p), total, page: q.page };
    });
  });
  app.get("/api/v4/members", async (req) => {
    requireRole(req.actor, "admin");
    return directory.decorate((
      await db.query(
        "SELECT id,name,roles,status,version,directory_active,open_id FROM users ORDER BY created_at,id LIMIT 1000",
      )
    ).rows,p=>p.open_id).then(rows=>rows.map(({open_id,...p})=>p));
  });
  app.patch("/api/v4/members/:id", async (req) => {
    requireRole(req.actor, "admin");
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(memberRequest, req.body);
    if (b.status === "active" && !b.roles.length) fail(422, "roles_required");
    return db.tx(async (c) => {
      await c.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('member-admins',0))",
      );
      const u = found(
        (await c.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [id]))
          .rows[0],
      );
      if (u.version !== b.version) fail(409, "version_conflict");
      if (b.status === "active" && !u.directory_active)
        fail(409, "directory_inactive");
      if (
        u.roles.includes("admin") &&
        u.status === "active" &&
        (b.status !== "active" || !b.roles.includes("admin"))
      ) {
        const count = await c.query(
          "SELECT count(*) FROM users WHERE status='active' AND 'admin'=ANY(roles)",
        );
        if (Number(count.rows[0].count) <= 1) fail(409, "last_admin");
      }
      const row = (
        await c.query(
          "UPDATE users SET roles=$2,status=$3,version=version+1,updated_at=now() WHERE id=$1 RETURNING id,name,roles,status,version",
          [id, b.roles, b.status],
        )
      ).rows[0];
      await c.query("DELETE FROM sessions WHERE user_id=$1", [id]);
      await identity.audit(c, req.actor.id, "member.change", id, {
        status: b.status,
        roles: b.roles,
      });
      return row;
    });
  });
}
