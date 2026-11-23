import { BackupCopies, copyInput, copyApply, WEB_BACKUP_BODY_BYTES } from "./copies.js";
import { parse, z } from "../http/validation.js";
const id = z.string().regex(/^[a-f0-9]{24}$/);
export const copyExport = z.object({ copyId: id.optional(), includeFiles: z.boolean().optional() }).strict();
export const copyQuery = z
    .object({
    id,
    page: z.number().int().positive().default(1),
    section: z
        .enum(["candidates", "leads", "campuses", "jobs", "interviews"])
        .optional(),
})
    .strict();
export function copyRoutes(app, identity) {
    const service = new BackupCopies(identity);
    app.get("/api/v4/admin/backups", async (req) => service.list(req.actor));
    app.post("/api/v4/admin/backups/preview", { bodyLimit: WEB_BACKUP_BODY_BYTES }, async (req) => service.preview(req.actor, parse(copyInput, req.body)));
    app.post("/api/v4/admin/backups/apply", { bodyLimit: WEB_BACKUP_BODY_BYTES }, async (req) => service.apply(req.actor, parse(copyApply, req.body)));
    app.post("/api/v4/admin/backups/export", async (req, reply) => {
        const b = parse(copyExport, req.body || {}), data = await service.export(req.actor, b.copyId, b.includeFiles);
        return reply
            .type("application/json")
            .header("content-disposition", 'attachment; filename="recruit-v4-backup.json"')
            .send(JSON.stringify(data));
    });
    app.post("/api/v4/admin/backups/query", async (req) => {
        const b = parse(copyQuery, req.body);
        return service.inspect(req.actor, b.id, b.page, b.section);
    });
}
//# sourceMappingURL=copy-routes.js.map