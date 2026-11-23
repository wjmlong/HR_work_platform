import { configuredRequest } from '../business-config/query-routes.js';
import { ConfiguredQueryService } from '../business-config/query.js';
import { CandidateTools } from "./tools.js";
import { parse, z, uuid } from "../http/validation.js";
import { RecruitingService } from "./service.js";
import { ConfiguredRecruiting } from '../business-config/recruiting.js';
import { ChecklistService, checklistUpgradePreview } from './checklists.js';
import { checklistStage } from '../business-config/checklist-template.js';
import { ccOptions } from './cc.js';
import { registerInboxMatching } from './matching-flow.js';
export function recruitingRoutes(app, id) {
    registerInboxMatching(app, id);
    const checks = new ChecklistService(id), checkParam = (p) => parse(z.object({ id: uuid, stage: checklistStage }).strict(), p);
    app.get('/api/v4/applications/:id/checklists', req => checks.all(req.actor, parse(z.object({ id: uuid }), req.params).id));
    app.post('/api/v4/applications/:id/checklists/open', req => checks.open(req.actor, parse(z.object({ id: uuid }), req.params).id, req.body));
    app.patch('/api/v4/applications/:id/checklist-items/:itemId', req => { const p = parse(z.object({ id: uuid, itemId: uuid }).strict(), req.params); return checks.updateItem(req.actor, p.id, p.itemId, req.body); });
    app.post('/api/v4/applications/:id/checklists/:stage/upgrade-preview', req => { const p = checkParam(req.params), b = parse(checklistUpgradePreview, req.body); return checks.previewUpgrade(req.actor, p.id, p.stage, b.target); });
    app.post('/api/v4/business-config/checklists/adopt', req => checks.adoptUpgrade(req.actor, req.body));
    app.get('/api/v4/applications/:id/cc-options', req => { const q = parse(z.object({ stage: checklistStage, jobId: uuid.optional() }).strict(), req.query); return ccOptions(id, req.actor, parse(z.object({ id: uuid }), req.params).id, q.stage, q.jobId); });
    const tools = new CandidateTools(id);
    app.get("/api/v4/candidates/tools/scan", (req) => tools.scan(req.actor));
    app.post("/api/v4/candidates/tools/merge-preview", (req) => tools.mergePreview(req.actor, req.body));
    app.post("/api/v4/candidates/tools/merge", (req) => tools.merge(req.actor, req.body));
    app.post("/api/v4/candidates/tools/reparse-preview", (req) => tools.reparsePreview(req.actor));
    app.post("/api/v4/candidates/tools/reparse-apply", (req) => tools.reparseApply(req.actor, req.body));
    app.post("/api/v4/candidates/ledger/export", async (req, reply) => reply
        .type("text/csv; charset=utf-8")
        .header("content-disposition", 'attachment; filename="recruit-ledger.csv"')
        .send(Buffer.from(await tools.ledger(req.actor, req.body), "utf8")));
    const configured = new ConfiguredRecruiting(id);
    const r = new RecruitingService(id), param = (p) => parse(z.object({ id: uuid }), p).id;
    app.get("/api/v4/jobs", (req) => configured.jobs(req.actor));
    app.get("/api/v4/jobs/:id/public-jd", (req) => configured.publicJob(req.actor, param(req.params)));
    app.post("/api/v4/jobs/:id/close-preview", (req) => r.closeJobPreview(req.actor, param(req.params), req.body));
    app.put("/api/v4/jobs/:id/salary-grants", (req) => r.salaryGrant(req.actor, param(req.params), req.body));
    app.post("/api/v4/jobs", (req) => configured.job(req.actor, null, req.body));
    app.patch("/api/v4/jobs/:id", (req) => configured.job(req.actor, param(req.params), req.body));
    app.post("/api/v4/candidates/query", (req) => r.candidates(req.actor, req.body));
    app.post("/api/v4/candidates", (req) => configured.candidate(req.actor, null, req.body));
    app.patch("/api/v4/candidates/:id", (req) => configured.candidate(req.actor, param(req.params), req.body));
    app.post("/api/v4/candidates/:id/archive", req => r.archiveCandidate(req.actor, param(req.params), req.body));
    app.post("/api/v4/candidates/:id/delete", (req) => r.removeCandidate(req.actor, param(req.params), req.body));
    app.post("/api/v4/applications/:id/delete", (req) => r.removeApplication(req.actor, param(req.params), req.body));
    app.get("/api/v4/candidates/:id", (req) => configured.person(req.actor, param(req.params)));
    app.post("/api/v4/applications/query", (req) => configuredRequest(req.body) ? new ConfiguredQueryService(id).query(req.actor, 'application', configuredRequest(req.body)) : r.applications(req.actor, req.body));
    app.post("/api/v4/applications", (req) => configured.apply(req.actor, req.body));
    app.get("/api/v4/applications/:id", (req) => configured.projectApplication(req.actor, param(req.params)));
    app.get("/api/v4/applications/:id/events", async (req) => {
        const applicationId = param(req.params);
        await id.applicationAccess(req.actor, applicationId);
        return (await id.db.query("SELECT e.*,u.name actor_name,f.name from_job_name,t.name to_job_name FROM application_events e JOIN users u ON u.id=e.actor_id LEFT JOIN jobs f ON f.id=e.from_job_id LEFT JOIN jobs t ON t.id=e.to_job_id WHERE e.application_id IN(SELECT sibling.id FROM applications sibling JOIN applications head ON head.candidate_id=sibling.candidate_id WHERE head.id=$1) AND ($2 OR e.application_id=$1) ORDER BY e.at,e.id", [
            applicationId,
            req.actor.roles.some((r) => ["admin", "manager", "recruiter"].includes(r)),
        ])).rows;
    });
    app.patch('/api/v4/applications/:id/fields', req => configured.application(req.actor, param(req.params), req.body));
    app.post("/api/v4/applications/:id/transition", (req) => r.transition(req.actor, param(req.params), req.body));
    app.post("/api/v4/applications/batch-transition", (req) => r.batchTransition(req.actor, req.body));
    app.post("/api/v4/applications/:id/transfer", (req) => r.transfer(req.actor, param(req.params), req.body));
    app.post("/api/v4/applications/:id/transfer-preview", (req) => r.transferPreview(req.actor, param(req.params), req.body));
    app.post("/api/v4/applications/:id/collection-completion", (req) => r.collectionCompletion(req.actor, param(req.params), req.body));
    app.post("/api/v4/applications/:id/resume", (req) => r.useResume(req.actor, param(req.params), req.body));
}
//# sourceMappingURL=routes.js.map