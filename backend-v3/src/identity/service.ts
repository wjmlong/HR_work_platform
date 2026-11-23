import { createHmac, randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { Database, Sql } from "../db.js";
import type { Config } from "../config.js";
import type { IdentityProvider, Principal } from "./provider.js";
import { fail, found } from "../http/errors.js";
export const token = () => randomBytes(32).toString("base64url");
export type Role = "admin" | "manager" | "recruiter" | "interviewer" | "viewer";
export type Actor = {
  id: string;
  name: string;
  roles: Role[];
  status: string;
  version: number;
  csrf: string;
  open_id: string;
  temporaryAccess?: boolean;
  temporaryScope?: {interviewId:string;applicationId:string;role:"interviewer"|"coordinator"};
  // Job-scoped, time-boxed screening grants. Additional read scope only; never a role.
  screeningScope?: string[];
  screeningUntil?: string | null;
  permanentRoles?: Role[];
};
export function requireRole(actor: Actor, ...roles: Role[]) {
  if (actor.status !== "active" || !actor.roles.some((r) => roles.includes(r)))
    fail(403, "forbidden");
}
export class Identity {
  constructor(
    readonly db: Database,
    readonly config: Config,
    readonly provider: IdentityProvider,
  ) {}
  hash(value: string) {
    return createHmac("sha256", this.config.secret).update(value).digest("hex");
  }
  async limit(key: string, max = 30) {
    const r = await this.db.query(
      "INSERT INTO rate_limits(key,started_at,attempts) VALUES($1,now(),1) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN rate_limits.started_at<now()-interval '5 minutes' THEN 1 ELSE rate_limits.attempts+1 END,started_at=CASE WHEN rate_limits.started_at<now()-interval '5 minutes' THEN now() ELSE rate_limits.started_at END RETURNING attempts",
      [this.hash(key)],
    );
    if (r.rows[0].attempts > max) fail(429, "rate_limited");
  }
  async establish(p: Principal) {
    const f = this.config.feishu;
    if (p.tenant !== f.tenant || p.appId !== f.appId || !p.active)
      fail(403, "identity_not_allowed");
    const t = token(),
      csrf = token();
    await this.db.tx(async (c) => {
      const r = await c.query(
        "INSERT INTO users(tenant,app_id,open_id,name,roles,status) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant,app_id,open_id) DO UPDATE SET name=EXCLUDED.name,verified_at=now() RETURNING *",
        [
          p.tenant,
          p.appId,
          p.openId,
          p.name,
          f.admins.includes(p.openId) ? ["admin"] : [],
          f.admins.includes(p.openId) ? "active" : "pending",
        ],
      );
      const u = r.rows[0];
      if (!u.directory_active || ["disabled", "rejected"].includes(u.status))
        fail(403, "membership_disabled");
      await c.query(
        "INSERT INTO sessions(token_hash,user_id,csrf,user_version,expires_at) VALUES($1,$2,$3,$4,now()+interval '8 hours')",
        [this.hash(t), u.id, csrf, u.version],
      );
      await this.audit(c, u.id, "auth.login", u.id, { status: u.status });
    });
    return t;
  }
  async authenticate(req: FastifyRequest, {includeTemporaryAccess=true}:{includeTemporaryAccess?:boolean}={}): Promise<Actor> {
    const value = req.cookies[(this.config.cookiePrefix || "__Host-recruit_v4") + "_session"];
    if (!value) fail(401, "login_required");
    const r = await this.db.query(
      "SELECT u.*,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND s.user_version=u.version AND u.status IN ('active','pending') AND u.directory_active AND u.tenant=$2 AND u.app_id=$3",
      [this.hash(value),this.config.feishu.tenant,this.config.feishu.appId],
    );
    const u = r.rows[0];
    if (!u) fail(401, "session_invalid");
    if (Date.now() - new Date(u.verified_at).getTime() > 600000) {
      let p: Principal;
      try {
        p = await this.provider.contact(u.open_id);
      } catch {
        fail(503, "directory_unavailable");
      }
      if (
        !p.active ||
        p.tenant !== u.tenant ||
        p.appId !== u.app_id ||
        p.openId !== u.open_id
      ) {
        await this.db.tx(async (c) => {
          await c.query(
            "UPDATE users SET status='disabled',directory_active=false,version=version+1 WHERE id=$1",
            [u.id],
          );
          await c.query("DELETE FROM sessions WHERE user_id=$1", [u.id]);
        });
        fail(401, "membership_disabled");
      }
      await this.db.query("UPDATE users SET verified_at=now() WHERE id=$1", [
        u.id,
      ]);
    }
    // This navigation/capability hint is not authority; interviewActor checks live target grants.
    if(!includeTemporaryAccess)return u as Actor;
    const temporaryAccess=!!(await this.db.query('SELECT 1 FROM active_interview_grants WHERE user_id=$1 LIMIT 1',[u.id])).rowCount;
    const screening = (
      await this.db.query(
        "SELECT array_agg(job_id) AS jobs,max(expires_at) AS until FROM active_job_screening_grants WHERE user_id=$1",
        [u.id],
      )
    ).rows[0];
    const screeningScope=(screening?.jobs || []) as string[];
    return {...u,temporaryAccess,screeningScope,screeningUntil:screening?.until ?? null} as Actor;
  }
  // A scoped actor is only used inside a validated interview route, never as a session role.
  async interviewActor(actor:Actor,interviewId:string,mode:'read'|'coordinate'='read',sql:Sql=this.db.sql):Promise<Actor>{
    const member=(await sql.query('SELECT * FROM users WHERE id=$1',[actor.id])).rows[0];
    if(!member||member.version!==actor.version||!member.directory_active||!['active','pending'].includes(member.status))fail(403,'membership_changed');
    const f=this.config.feishu;
    const interview=found((await sql.query('SELECT * FROM interviews WHERE id=$1 AND deleted_at IS NULL',[interviewId])).rows[0]);
    if(actor.temporaryScope&&actor.temporaryScope.interviewId!==interviewId)fail(403,'forbidden');
    const roles=member.roles as Role[];
    if(member.status==='active'&&roles.some(r=>['admin','manager','recruiter'].includes(r)))return {...actor,roles,temporaryScope:undefined};
    if(member.status==='active'&&mode==='read'&&roles.includes('interviewer')&&interview.status!=='cancelled'&&(await sql.query('SELECT 1 FROM interviewers WHERE interview_id=$1 AND user_id=$2 AND NOT temporary_access',[interviewId,actor.id])).rowCount)return {...actor,roles,temporaryScope:undefined};
    if(member.tenant!==f.tenant||member.app_id!==f.appId)fail(403,'identity_not_allowed');
    const grant=(await sql.query("SELECT role FROM active_interview_grants WHERE interview_id=$1 AND user_id=$2 AND ($3='read' OR role='coordinator') ORDER BY role LIMIT 1",[interviewId,actor.id,mode])).rows[0];
    if(!grant)fail(403,'forbidden');
    return {...actor,status:'active',roles:['interviewer'],permanentRoles:roles,temporaryAccess:true,temporaryScope:{interviewId,applicationId:interview.application_id,role:grant.role}};
  }
  // Mutation authority comes from this interview, never a different round of its application.
  async evaluationActor(actor:Actor,interviewId:string,forPrimary:boolean,sql:Sql=this.db.sql):Promise<Actor>{
    const bounded=await this.interviewActor(actor,interviewId,'read',sql);
    if(forPrimary&&bounded.temporaryScope)fail(403,'forbidden');
    return bounded;
  }
  async applicationAccess(
    actor: Actor,
    id: string,
    write = false,
    sql: Sql = this.db.sql,
  ) {
    if(actor.temporaryScope){
      if(write||actor.temporaryScope.applicationId!==id)fail(403,'forbidden');
      await this.interviewActor(actor,actor.temporaryScope.interviewId,'read',sql);
    }else if(actor.status!=='active')fail(403,'forbidden');
    const app = found(
      (
        await sql.query(
          "SELECT * FROM applications WHERE id=$1 AND deleted_at IS NULL",
          [id],
        )
      ).rows[0],
    );
    if(actor.temporaryScope)return app;
    if (actor.roles.some((r) => ["admin", "manager", "recruiter"].includes(r)))
      return app;
    if (!write && actor.roles.includes("interviewer")) {
      if (
        (
          await sql.query(
            "SELECT 1 FROM interviews i JOIN interviewers x ON x.interview_id=i.id WHERE i.application_id=$1 AND x.user_id=$2 AND NOT x.temporary_access AND i.deleted_at IS NULL AND i.status<>'cancelled'",
            [id, actor.id],
          )
        ).rowCount
      )
        return app;
    }
    if (
      !write &&
      actor.roles.includes("viewer") &&
      (
        await sql.query(
          "SELECT 1 FROM application_grants WHERE application_id=$1 AND user_id=$2",
          [id, actor.id],
        )
      ).rowCount
    )
      return app;
    // A live screening grant reads one job's applications; it never writes here.
    if (
      !write &&
      (
        await sql.query(
          "SELECT 1 FROM active_job_screening_grants WHERE job_id=$1 AND user_id=$2",
          [app.job_id, actor.id],
        )
      ).rowCount
    )
      return app;
    fail(403, "forbidden");
  }
  async profileVersion(sql: Sql, actorId: string, candidate: any) {
    await sql.query(
      "INSERT INTO candidate_profile_versions(candidate_id,version,profile,actor_id) VALUES($1,$2,$3,$4)",
      [candidate.id, candidate.version, candidate.profile, actorId],
    );
  }
  async audit(
    sql: Sql,
    actorId: string | null,
    kind: string,
    entityId: string | null,
    detail: object = {},
  ) {
    await sql.query(
      "INSERT INTO audit_events(actor_id,kind,entity_id,detail,instance,request_id) VALUES($1,$2,$3,$4,$5,$6)",
      [
        actorId,
        kind,
        entityId,
        detail,
        this.config.instance,
        this.db.requestId,
      ],
    );
  }
}
