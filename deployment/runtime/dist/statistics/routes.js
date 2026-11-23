import { requireRole } from "../identity/service.js";
import { parse, z, uuid } from "../http/validation.js";
import { StatisticsService } from "./service.js";
export function statisticsRoutes(app, id) {
    const s = new StatisticsService(id);
    app.post("/api/v4/statistics/query", (req) => s.report(req.actor, req.body));
    app.post("/api/v4/measurements/protocols", (req) => s.protocol(req.actor, req.body));
    app.get("/api/v4/measurements/protocols", async (req) => {
        requireRole(req.actor, "admin", "manager", "recruiter");
        return (await id.db.query("SELECT * FROM measurement_protocols ORDER BY created_at,id")).rows;
    });
    app.post("/api/v4/measurements/samples", (req) => s.sample(req.actor, req.body));
    app.get("/api/v4/measurements/:id", (req) => s.measurements(req.actor, parse(z.object({ id: uuid }), req.params).id));
}
//# sourceMappingURL=routes.js.map