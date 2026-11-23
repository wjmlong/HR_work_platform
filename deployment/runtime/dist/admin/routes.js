import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { requireRole } from "../identity/service.js";
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
export function adminRoutes(app, id) {
    app.get("/api/v4/admin/status", async (req) => {
        requireRole(req.actor, "admin");
        const tasks = (await id.db.query("SELECT state,count(*)::int count FROM tasks GROUP BY state")).rows;
        const backups = [];
        const directory = path.join(path.dirname(id.config.storageRoot), "backups");
        for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
            if (!entry.isDirectory())
                continue;
            try {
                const m = JSON.parse(await readFile(path.join(directory, entry.name, "manifest.json"), "utf8"));
                if ([3, 4].includes(m.version) && m.sourceSchema === id.config.schema && Number.isFinite(Date.parse(m.createdAt)))
                    backups.push({ createdAt: m.createdAt, fileCount: m.files.length, tableCount: Object.keys(m.tables).length });
            }
            catch { }
        }
        backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return {
            backup: { count: backups.length, latest: backups[0] || null },
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
        return (await id.db.query("SELECT id,actor_id,kind,entity_id,detail,instance,at FROM audit_events WHERE ($1::bigint IS NULL OR id<$1) ORDER BY id DESC LIMIT $2", [b.before || null, b.limit])).rows;
    });
    app.get("/api/v4/applications/:id/grants", async (req) => {
        requireRole(req.actor, "admin", "manager");
        const applicationId = parse(z.object({ id: uuid }), req.params).id;
        const row = found((await id.db.query("SELECT version FROM applications WHERE id=$1 AND deleted_at IS NULL", [applicationId])).rows[0]);
        const users = (await id.db.query("SELECT user_id FROM application_grants WHERE application_id=$1 ORDER BY user_id", [applicationId])).rows;
        return { applicationId, version: row.version, userIds: users.map(x => x.user_id) };
    });
    app.put("/api/v4/applications/:id/grants", async (req) => {
        requireRole(req.actor, "admin", "manager");
        const applicationId = parse(z.object({ id: uuid }), req.params).id, b = parse(grantsRequest, req.body);
        return id.db.tx(async (c) => {
            const row = found((await c.query("SELECT * FROM applications WHERE id=$1 FOR UPDATE", [
                applicationId,
            ])).rows[0]);
            if (row.version !== b.version)
                fail(409, "version_conflict");
            const ids = [...new Set(b.userIds)];
            if ((await c.query("SELECT id FROM users WHERE id=ANY($1::uuid[]) AND status='active' AND 'viewer'=ANY(roles)", [ids])).rowCount !== ids.length)
                fail(422, "viewer_invalid");
            await c.query("DELETE FROM application_grants WHERE application_id=$1", [
                applicationId,
            ]);
            for (const uid of ids)
                await c.query("INSERT INTO application_grants(application_id,user_id) VALUES($1,$2)", [applicationId, uid]);
            await c.query("UPDATE applications SET version=version+1,updated_at=now() WHERE id=$1", [applicationId]);
            await id.audit(c, req.actor.id, "application.grants", applicationId, {
                userIds: ids,
            });
            return { applicationId, version: b.version + 1, userIds: ids };
        });
    });
}
//# sourceMappingURL=routes.js.map