import { JobQuestions } from './job-questions.js';
import { FileStore } from "../files/storage.js";
import { MaterialService } from "./service.js";
import { parse, z, uuid } from "../http/validation.js";
import { modelStatus } from "./model.js";
import { decodeJSON } from "../parsing/json.js";
import { found } from "../http/errors.js";
export function materialRoutes(app, id) {
    const s = new MaterialService(id, new FileStore(id.config.storageRoot)), param = (p) => parse(z.object({ id: uuid }), p).id;
    const bank = new JobQuestions(id);
    app.get("/api/v4/jobs/:id/question-bank", req => bank.get(req.actor, param(req.params)));
    app.post("/api/v4/jobs/:id/question-bank", req => bank.generate(req.actor, param(req.params), req.body));
    app.post("/api/v4/jobs/:id/question-bank/learn", req => bank.learn(req.actor, param(req.params), req.body));
    app.get("/api/v4/materials/capabilities", async () => ({
        rules: { configured: true },
        model: modelStatus(id.config),
    }));
    app.post("/api/v4/applications/:id/questions", (req) => s.questions(req.actor, param(req.params), req.body));
    app.get("/api/v4/questions/:id", (req) => s.get(req.actor, "questions", param(req.params)));
    app.patch("/api/v4/questions/:id", (req) => s.editQuestions(req.actor, param(req.params), req.body));
    app.post("/api/v4/applications/:id/briefs", (req) => s.brief(req.actor, param(req.params)));
    app.get("/api/v4/briefs/:id", (req) => s.get(req.actor, "briefs", param(req.params)));
    app.post("/api/v4/briefs/:id/conclusion", (req) => s.conclude(req.actor, param(req.params), req.body));
    app.get("/api/v4/applications/:id/materials", async (req) => {
        const applicationId = param(req.params);
        await id.applicationAccess(req.actor, applicationId);
        const questions = (await id.db.query("SELECT id,version,created_at FROM question_sets WHERE application_id=$1 ORDER BY created_at,id", [applicationId])).rows, briefs = (await id.db.query("SELECT id,version,created_at FROM briefs WHERE application_id=$1 ORDER BY created_at,id", [applicationId])).rows;
        return { questions, briefs };
    });
    app.get("/api/v4/materials/:id/versions", async (req) => {
        const materialId = param(req.params), row = found((await id.db.query("SELECT application_id,'questions' kind FROM question_sets WHERE id=$1 UNION ALL SELECT application_id,'briefs' kind FROM briefs WHERE id=$1", [materialId])).rows[0]);
        await id.applicationAccess(req.actor, row.application_id);
        await s.assertMaterialAccess(req.actor, row.kind, materialId);
        return (await id.db.query("SELECT * FROM material_versions WHERE material_id=$1 ORDER BY version", [materialId])).rows.map((r) => ({ ...r, data: decodeJSON(r.data) }));
    });
}
//# sourceMappingURL=routes.js.map