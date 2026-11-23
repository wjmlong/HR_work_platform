import {discoveryRoutes} from '../sourcing-discovery/routes.js';
import {configuredRequest,configuredExport} from '../business-config/query-routes.js';
import {ConfiguredQueryService} from '../business-config/query.js';
import type { FastifyInstance } from "fastify";
import { Identity, requireRole } from "../identity/service.js";
import { parse, z, uuid, version, text } from "../http/validation.js";
import { SourcingService } from "./service.js";
import { Dictionary } from "../dictionary/service.js";
import { found,fail } from "../http/errors.js";
export const leadDeleteRequest = z
  .object({ version, restore: z.boolean().default(false) })
  .strict();
export const leadExportRequest = z
  .object({
    scope: z.enum(["filtered", "all"]).default("filtered"),
    query: z.unknown().default({}),
  })
  .strict();
export const dictionaryRequest = z
  .object({ name: text, aliases: z.array(text).max(100), category: text })
  .strict();
import {ConfiguredEntities} from '../business-config/entities.js';
export function sourcingRoutes(app: FastifyInstance, id: Identity) {
  discoveryRoutes(app,id);
  const configured=new ConfiguredEntities(id);
  const s = new SourcingService(id),
    d = new Dictionary(id.db);
  app.get("/api/v4/sourcing/setup", (req) => s.getSetup(req.actor));
  app.put("/api/v4/sourcing/setup", (req) => s.setup(req.actor, req.body));
  app.post("/api/v4/sourcing/requests", (req) => s.request(req.actor));
  app.post("/api/v4/leads/query", (req) => configuredRequest(req.body)?new ConfiguredQueryService(id).query(req.actor,'lead',configuredRequest(req.body)):s.query(req.actor, req.body as any));
  app.post("/api/v4/leads", (req) => configured.write(req.actor,'lead',null,req.body));
  const param = (v: unknown) => parse(z.object({ id: uuid }), v).id;
  app.patch("/api/v4/leads/:id", (req) =>
    configured.write(req.actor,'lead',param(req.params),req.body),
  );
  app.get("/api/v4/leads/:id", async (req) => {
    requireRole(req.actor, "admin", "manager", "recruiter");
    const leadId = param(req.params),
      row = found(
        (await id.db.query("SELECT l.*,(SELECT name FROM users WHERE id=l.owner_id) owner_name FROM leads l WHERE id=$1", [leadId]))
          .rows[0],
      );
    return {
      ...await configured.project(req.actor,'lead',leadId),owner_name:row.owner_name,
      followups: (
        await id.db.query(
          "SELECT f.*,u.name actor_name FROM lead_followups f JOIN users u ON u.id=f.actor_id WHERE lead_id=$1 ORDER BY occurred_at,f.id",
          [leadId],
        )
      ).rows,
      events: (
        await id.db.query(
          "SELECT * FROM lead_events WHERE lead_id=$1 ORDER BY at,id",
          [leadId],
        )
      ).rows,
    };
  });
  app.post("/api/v4/leads/:id/transition", (req) =>
    s.transition(req.actor, param(req.params), req.body),
  );
  app.post("/api/v4/leads/:id/followups", (req) =>
    s.followup(req.actor, param(req.params), req.body),
  );
  app.post("/api/v4/leads/:id/delete", (req) => {
    const b = parse(leadDeleteRequest, req.body);
    return s.remove(req.actor, param(req.params), b.version, b.restore);
  });
  app.post("/api/v4/leads/metrics", (req) =>
    s.metrics(req.actor, req.body as any),
  );
  app.post("/api/v4/leads/export", async (req, reply) => {
    const configuredBody=configuredExport(req.body);if(configuredBody)return reply.type('text/csv; charset=utf-8').send(await new ConfiguredQueryService(id).exportFields(req.actor,'lead',configuredBody.scope,configuredBody.fieldQuery));
    const b = parse(leadExportRequest, req.body);
    reply
      .type("text/csv; charset=utf-8")
      .header("content-disposition", 'attachment; filename="leads.csv"');
    return s.csv(req.actor, b.query as any, b.scope);
  });
  app.get("/api/v4/dictionary", async (req) => {
    requireRole(req.actor, "admin", "manager", "recruiter","interviewer","viewer");
    return d.list();
  });
  app.put("/api/v4/dictionary", async (req) => {
    requireRole(req.actor, "admin", "manager");
    fail(426,'use_business_config_publication');
  });
}
