import { InterviewerReview } from './service.js';
export function interviewerReviewRoutes(app, identity) {
    const service = new InterviewerReview(identity);
    app.post('/api/v4/interviewer-review/cohorts/export', async (req, reply) => reply.type('text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="interviewer-cohorts.csv"').send(Buffer.from(await service.exportCohorts(req.actor, req.body), 'utf8')));
    app.post('/api/v4/interviewer-review/query', req => service.query(req.actor, req.body));
    app.post('/api/v4/interviewer-review/export', async (req, reply) => reply.type('text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="interviewer-review.csv"').send(Buffer.from(await service.export(req.actor, req.body), 'utf8')));
}
//# sourceMappingURL=routes.js.map