import {readdir,readFile} from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { Identity, requireRole } from "../identity/service.js";
import { InterviewGrants } from "../identity/grants.js";
import { parse, z, uuid, version } from "../http/validation.js";
import { fail, found } from "../http/errors.js";
export const auditRequest = z
  .object({
    before: z.string().regex(/^\d+$/).optional(),
    limit: z.number().int().min(1).max(100).default(25),
  })
  .strict();
export const grantsRequest = z
  .object({ version, userIds: z.array(uuid).max(100) })
  .strict();
export function adminRoutes(app: FastifyInstance, id: Identity) {
  app.get("/api/v4/admin/status", async (req) => {
    requireRole(req.actor, "admin");
    const tasks = (
      await id.db.query(
        "SELECT state,count(*)::int count FROM tasks GROUP BY state",
      )
    ).rows;
    const backups=[];
    const directory=path.join(path.dirname(id.config.storageRoot),"backups");
    for(const entry of await readdir(directory,{withFileTypes:true}).catch(()=>[])) {
      if(!entry.isDirectory())continue;
      try { const m=JSON.parse(await readFile(path.join(directory,entry.name,"manifest.json"),"utf8"));
        if([3,4].includes(m.version)&&m.sourceSchema===id.config.schema&&Number.isFinite(Date.parse(m.createdAt)))
          backups.push({createdAt:m.createdAt,fileCount:m.files.length,tableCount:Object.keys(m.tables).length});
      } catch {}
    }
    backups.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    return {
      backup:{count:backups.length,latest:backups[0]||null},
      version: "4.0.0",
      instance: id.config.instance,
      tasks,
      modelConfigured: false,
      sourcingConfigured: false,
      feishuConfigured: id.provider.configured(),
    };
  });
  app.post("/api/v4/admin/audit/query", async (req) => {
    requireRole(req.actor, "admin");
    const b = parse(auditRequest, req.body);
    return (
      await id.db.query(
        "SELECT id,actor_id,kind,entity_id,detail,instance,at FROM audit_events WHERE ($1::bigint IS NULL OR id<$1) ORDER BY id DESC LIMIT $2",
        [b.before || null, b.limit],
      )
    ).rows;
  });
  app.get("/api/v4/applications/:id/grants", async (req) => {
    requireRole(req.actor, "admin", "manager");
    const applicationId=parse(z.object({id:uuid}),req.params).id;
    const row=found((await id.db.query("SELECT version FROM applications WHERE id=$1 AND deleted_at IS NULL",[applicationId])).rows[0]);
    const users=(await id.db.query("SELECT user_id FROM application_grants WHERE application_id=$1 ORDER BY user_id",[applicationId])).rows;
    return {applicationId,version:row.version,userIds:users.map(x=>x.user_id)};
  });
  app.put("/api/v4/applications/:id/grants", async (req) => {
    requireRole(req.actor, "admin", "manager");
    const applicationId = parse(z.object({ id: uuid }), req.params).id,
      b = parse(grantsRequest, req.body);
    return id.db.tx(async (c) => {
      const row = found(
        (
          await c.query("SELECT * FROM applications WHERE id=$1 FOR UPDATE", [
            applicationId,
          ])
        ).rows[0],
      );
      if (row.version !== b.version) fail(409, "version_conflict");
      const ids = [...new Set(b.userIds)];
      if (
        (
          await c.query(
            "SELECT id FROM users WHERE id=ANY($1::uuid[]) AND status='active' AND 'viewer'=ANY(roles)",
            [ids],
          )
        ).rowCount !== ids.length
      )
        fail(422, "viewer_invalid");
      await c.query("DELETE FROM application_grants WHERE application_id=$1", [
        applicationId,
      ]);
      for (const uid of ids)
        await c.query(
          "INSERT INTO application_grants(application_id,user_id) VALUES($1,$2)",
          [applicationId, uid],
        );
      await c.query(
        "UPDATE applications SET version=version+1,updated_at=now() WHERE id=$1",
        [applicationId],
      );
      await id.audit(c, req.actor.id, "application.grants", applicationId, {
        userIds: ids,
      });
      return { applicationId, version: b.version + 1, userIds: ids };
    });
  });
  // Job screening grants: admin-only, 14 days by default, one forward step on the board.
  app.get("/api/v4/job-screening-grants", async (req) => {
    requireRole(req.actor, "admin");
    const b = parse(
      z.object({ jobId: uuid.optional() }).strict(),
      req.query,
    );
    const rows = (
      await id.db.query(
        `SELECT g.job_id AS "jobId",j.name AS "jobName",g.user_id AS "userId",u.name AS "userName",u.open_id AS "openId",
                g.expires_at AS "expiresAt",g.revoked_at AS "revokedAt",g.created_at AS "createdAt",
                (g.revoked_at IS NULL AND g.expires_at>now()) AS active
         FROM job_screening_grants g JOIN users u ON u.id=g.user_id JOIN jobs j ON j.id=g.job_id
         WHERE ($1::uuid IS NULL OR g.job_id=$1)
         ORDER BY active DESC,g.expires_at DESC,u.name LIMIT 300`,
        [b.jobId || null],
      )
    ).rows;
    return { items: rows };
  });
  app.post("/api/v4/job-screening-grants", async (req) => {
    requireRole(req.actor, "admin");
    const b = parse(
      z
        .object({
          jobId: uuid,
          openId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
          expiresAt: z.iso.datetime({ offset: true }).optional(),
        })
        .strict(),
      req.body,
    );
    const expiresAt = b.expiresAt
      ? new Date(b.expiresAt)
      : new Date(Date.now() + 14 * 86400000);
    if (expiresAt.getTime() <= Date.now())
      fail(422, "expiry_must_be_future");
    const grants = new InterviewGrants(id);
    return id.db.tx(async (c) => {
      const job = found(
        (
          await c.query("SELECT id,name,open FROM jobs WHERE id=$1 FOR SHARE", [
            b.jobId,
          ])
        ).rows[0],
      );
      const u = await grants.verifiedUser(c, b.openId);
      // A screening grant is also the approval step: the member becomes an active viewer.
      if (u.status === "pending" || !u.roles.includes("viewer"))
        await c.query(
          "UPDATE users SET roles=CASE WHEN 'viewer'=ANY(roles) THEN roles ELSE array_append(roles,'viewer') END,status=CASE WHEN status='pending' THEN 'active' ELSE status END,version=version+1,updated_at=now() WHERE id=$1",
          [u.id],
        );
      const row = (
        await c.query(
          `INSERT INTO job_screening_grants(job_id,user_id,expires_at,created_by) VALUES($1,$2,$3,$4)
           ON CONFLICT(job_id,user_id) DO UPDATE SET expires_at=GREATEST(job_screening_grants.expires_at,EXCLUDED.expires_at),revoked_at=NULL,created_by=EXCLUDED.created_by,created_at=now()
           RETURNING *`,
          [b.jobId, u.id, expiresAt, req.actor.id],
        )
      ).rows[0];
      await id.audit(c, req.actor.id, "job_screening.grant", b.jobId, {
        userId: u.id,
        openId: b.openId,
        expiresAt: row.expires_at,
      });
      return {
        jobId: b.jobId,
        jobName: job.name,
        userId: u.id,
        userName: u.name,
        expiresAt: row.expires_at,
      };
    });
  });
  app.delete("/api/v4/job-screening-grants/:jobId/:userId", async (req) => {
    requireRole(req.actor, "admin");
    const p = parse(
      z.object({ jobId: uuid, userId: uuid }).strict(),
      req.params,
    );
    return id.db.tx(async (c) => {
      const rows = (
        await c.query(
          "UPDATE job_screening_grants SET revoked_at=now() WHERE job_id=$1 AND user_id=$2 AND revoked_at IS NULL RETURNING *",
          [p.jobId, p.userId],
        )
      ).rows;
      if (!rows.length) fail(404, "grant_not_found");
      await id.audit(c, req.actor.id, "job_screening.revoke", p.jobId, {
        userId: p.userId,
      });
      return { jobId: p.jobId, userId: p.userId, revoked: true };
    });
  });
}
