import { ReportService } from './report.js';
import { DashboardService } from './service.js';
export function dashboardRoutes(app, id) { const service = new DashboardService(id); const report = new ReportService(id); app.post('/api/v4/dashboard/report/query', req => report.query(req.actor, req.body)); app.get('/api/v4/dashboard/preferences', req => report.settings(req.actor)); app.put('/api/v4/dashboard/preferences', req => report.save(req.actor, req.body)); app.post('/api/v4/dashboard/query', req => service.query(req.actor, req.body)); }
//# sourceMappingURL=routes.js.map