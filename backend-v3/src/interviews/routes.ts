import {interviewAssistantRoutes} from '../interview-assistant/routes.js';
import {EvaluationUpgradeService,evaluationUpgradePreview} from '../business-config/evaluation-versions.js';
import {configuredRequest} from '../business-config/query-routes.js';
import {ConfiguredQueryService} from '../business-config/query.js';
import type { FastifyInstance } from "fastify";
import type { Identity } from "../identity/service.js";
import { parse, z, uuid } from "../http/validation.js";
import { InterviewService } from "./service.js";
import {ConfiguredEntities} from '../business-config/entities.js';
export function interviewRoutes(app: FastifyInstance, id: Identity) {
  interviewAssistantRoutes(app,id);
  const templates=new EvaluationUpgradeService(id);
  app.get('/api/v4/interviews/:id/evaluation-template',req=>{const q=parse(z.object({forPrimary:z.enum(['true','false']).optional()}).strict(),req.query);return templates.effective(req.actor,parse(z.object({id:uuid}),req.params).id,q.forPrimary!=='false');});
  app.post('/api/v4/interviews/:id/evaluation-template/preview',req=>{const b=parse(evaluationUpgradePreview,req.body);return templates.preview(req.actor,parse(z.object({id:uuid}),req.params).id,b.target,b.forPrimary);});
  app.post('/api/v4/business-config/evaluations/adopt',req=>templates.adopt(req.actor,req.body));
  const configured=new ConfiguredEntities(id);
  const s = new InterviewService(id),
    param = (p: unknown) => parse(z.object({ id: uuid }), p).id;
  app.get("/api/v4/evaluations/:id/versions", (req) =>
    s.evaluationVersions(req.actor, param(req.params)).then(rows=>Promise.all(rows.map(r=>configured.evaluationVersion(req.actor,param(req.params),r.version)))),
  );
  app.get("/api/v4/evaluations/:id/versions/:version", (req) => {
    const p = parse(
      z.object({ id: uuid, version: z.string().regex(/^[1-9][0-9]{0,8}$/) }),
      req.params,
    );
    return configured.evaluationVersion(req.actor, p.id, Number(p.version));
  });
  app.post("/api/v4/interviews/query",req=>configuredRequest(req.body)?new ConfiguredQueryService(id).query(req.actor,'interview',configuredRequest(req.body)):s.query(req.actor,req.body));
  app.get("/api/v4/applications/:id/evaluation-history",req=>s.evaluationHistory(req.actor,param(req.params)));
  app.get("/api/v4/applications/:id/next-interview-round",req=>s.nextRound(req.actor,param(req.params)));
  app.post("/api/v4/interviews/:id/delete",req=>s.remove(req.actor,param(req.params),req.body));
  app.get("/api/v4/interviews", (req) => s.list(req.actor));
  app.post("/api/v4/interviews", (req) => configured.write(req.actor,'interview',null,req.body));
  app.patch("/api/v4/interviews/:id", (req) =>
    configured.write(req.actor,'interview',param(req.params),req.body),
  );
  app.get("/api/v4/interviews/:id/evaluation",req=>configured.currentEvaluation(req.actor,param(req.params)));
  app.put("/api/v4/interviews/:id/evaluation", (req) =>
    configured.evaluate(req.actor,param(req.params),req.body),
  );
  app.get("/api/v4/applications/:id/evaluations", (req) =>
    s.evaluations(req.actor, param(req.params)).then(rows=>Promise.all(rows.map(r=>configured.evaluationVersion(req.actor,r.id,r.version)))),
  );
}
