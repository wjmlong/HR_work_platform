import { queueMatch } from '../business-config/bindings.js';
import { createHash } from "node:crypto";
import { requireRole } from "../identity/service.js";
import { FileStore } from "../files/storage.js";
import { TaskService } from "./service.js";
import { parse, z, uuid } from "../http/validation.js";
import { Commands } from "../http/commands.js";
import { fail, found } from "../http/errors.js";
export const uploadTextRequest = z
    .object({
    jobId: uuid,
    source: z.string().min(1).max(300).default("手动上传"),
    note: z.string().max(2000).default(""),
    text: z
        .string()
        .min(1)
        .max(2 * 1024 * 1024),
    name: z.string().max(200).default("粘贴简历.txt"),
})
    .strict();
import { ConfiguredRecruiting } from '../business-config/recruiting.js';
export function taskRoutes(app, id) {
    const store = new FileStore(id.config.storageRoot), s = new TaskService(id, store), commands = new Commands(id.db), param = (p) => parse(z.object({ id: uuid }), p).id;
    app.post("/api/v4/uploads", async (req) => {
        requireRole(req.actor, "admin", "manager", "recruiter");
        let data, name, jobId, source = "手动上传", note = "";
        for await (const part of req.parts()) {
            if (part.type === "file") {
                name = part.filename;
                data = await part.toBuffer();
                if (part.file.truncated)
                    fail(413, "file_too_large");
            }
            else if (part.fieldname === "jobId" && typeof part.value === "string")
                jobId = part.value;
            else if (part.type === "field" &&
                part.fieldname === "source" &&
                typeof part.value === "string")
                source = parse(z.string().min(1).max(300), part.value);
            else if (part.type === "field" &&
                part.fieldname === "note" &&
                typeof part.value === "string")
                note = parse(z.string().max(2000), part.value);
            else
                fail(422, "invalid_input");
        }
        if (!data || !name || !jobId)
            fail(422, "file_and_job_required");
        const b = { name, data, jobId, source, note };
        return commands.run(req.actor, req.headers["idempotency-key"], {
            name,
            jobId,
            source,
            note,
            sha256: createHash("sha256").update(data).digest("hex"),
        }, () => s.upload(req.actor, b));
    });
    app.post("/api/v4/uploads/text", async (req) => {
        const b = parse(uploadTextRequest, req.body);
        return s.upload(req.actor, {
            jobId: b.jobId,
            source: b.source,
            note: b.note,
            name: b.name,
            data: Buffer.from(JSON.stringify(b.text), "utf8"),
            paste: true,
        });
    });
    app.post("/api/v4/tasks/query", (req) => s.query(req.actor, req.body));
    app.get("/api/v4/tasks", (req) => s.list(req.actor));
    app.get("/api/v4/tasks/:id", (req) => s.get(req.actor, param(req.params)));
    app.post("/api/v4/tasks/:id/cancel", (req) => s.cancel(req.actor, param(req.params)));
    app.post("/api/v4/tasks/:id/retry", (req) => s.retry(req.actor, param(req.params)));
    app.post("/api/v4/tasks/:id/text", (req) => s.supplyText(req.actor, param(req.params), req.body));
    app.post("/api/v4/tasks/:id/duplicate", (req) => s.resolveDuplicate(req.actor, param(req.params), req.body));
    app.get("/api/v4/applications/:id/matches", (req) => s.matches(req.actor, param(req.params)));
    app.post("/api/v4/applications/:id/recompute", async (req) => {
        const applicationId = param(req.params);
        const current = await id.applicationAccess(req.actor, applicationId, true);
        if (!current.resume_version_id)
            fail(409, 'resume_required');
        return id.db.tx(c => queueMatch(id, c, applicationId, req.actor.id, { reason: 'explicit_recompute' }));
    });
    app.post("/api/v4/resumes/:id/corrections", (req) => new ConfiguredRecruiting(id).correct(req.actor, param(req.params), req.body));
    app.get("/api/v4/resumes/:id/raw", (req) => s.raw(req.actor, param(req.params)));
    app.get("/api/v4/resumes/:id/file", async (req, reply) => {
        const resumeId = param(req.params), r = await s.raw(req.actor, resumeId), doc = found((await id.db.query("SELECT * FROM resume_documents WHERE id=$1", [
            r.documentId,
        ])).rows[0]);
        await id.audit(id.db.pool, req.actor.id, "resume.download", resumeId);
        reply
            .header("content-security-policy", "sandbox; default-src 'none'")
            .header("content-disposition", "attachment; filename*=UTF-8''" +
            encodeURIComponent(doc.file_name + (doc.kind === "paste" ? ".json" : "")))
            .type(doc.kind === "paste"
            ? "application/json; charset=utf-8"
            : "application/octet-stream");
        return store.read(doc.blob_key);
    });
}
//# sourceMappingURL=routes.js.map