import { configuredRequest, configuredExport } from '../business-config/query-routes.js';
import { ConfiguredQueryService } from '../business-config/query.js';
import { parse, z, uuid } from "../http/validation.js";
import { CampusService } from "./service.js";
import { ConfiguredEntities } from '../business-config/entities.js';
export function campusRoutes(app, identity) {
    const configured = new ConfiguredEntities(identity);
    const s = new CampusService(identity), id = (p) => parse(z.object({ id: uuid }), p).id;
    app.get("/api/v4/campus/permissions", (req) => s.permissions(req.actor));
    app.get("/api/v4/campus/grants", (req) => s.grants(req.actor));
    app.put("/api/v4/campus/grants", (req) => s.grant(req.actor, req.body));
    app.post("/api/v4/campus/query", (req) => configuredRequest(req.body) ? new ConfiguredQueryService(identity).query(req.actor, 'campus', configuredRequest(req.body)) : s.query(req.actor, req.body));
    app.post("/api/v4/campus", (req) => configured.write(req.actor, 'campus', null, req.body));
    app.patch("/api/v4/campus/:id", (req) => configured.write(req.actor, 'campus', id(req.params), req.body));
    app.post("/api/v4/campus/:id/delete", (req) => s.remove(req.actor, id(req.params), req.body));
    app.post("/api/v4/campus/:id/reveal", async (req, reply) => {
        reply.header("cache-control", "no-store").header("pragma", "no-cache");
        return s.reveal(req.actor, id(req.params), req.body);
    });
    app.post("/api/v4/campus/export", async (req, reply) => {
        const configuredBody = configuredExport(req.body);
        if (configuredBody)
            return reply.type('text/csv; charset=utf-8').send(await new ConfiguredQueryService(identity).exportFields(req.actor, 'campus', configuredBody.scope, configuredBody.fieldQuery));
        return reply
            .header("cache-control", "no-store")
            .type("text/csv; charset=utf-8")
            .header("content-disposition", 'attachment; filename="campus.csv"')
            .send(Buffer.from(await s.export(req.actor, req.body), "utf8"));
    });
}
//# sourceMappingURL=routes.js.map