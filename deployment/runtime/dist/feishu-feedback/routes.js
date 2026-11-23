import { parse, z, uuid } from '../http/validation.js';
import { requireRole } from '../identity/service.js';
import { ScreeningBatches } from './screening.js';
import { InterviewFeedback } from './service.js';
export function registerInterviewFeedbackRoutes(app, identity) {
    app.get('/api/v4/screening-reviewers', async (r) => {
        requireRole(r.actor, 'admin', 'manager', 'recruiter');
        const { jobId } = parse(z.object({ jobId: uuid.optional() }).strict(), r.query);
        if (!jobId)
            return { items: [] };
        const rows = await identity.db.query(`SELECT g.job_id "jobId",g.user_id "userId",u.name "userName",j.name "jobName",g.expires_at "expiresAt",true active
    FROM active_job_screening_grants g JOIN users u ON u.id=g.user_id JOIN jobs j ON j.id=g.job_id WHERE j.open AND g.job_id=$1 ORDER BY u.name`, [jobId]);
        return { items: rows.rows };
    });
    const batches = new ScreeningBatches(identity);
    app.post('/api/v4/screening-batches', r => batches.create(r.actor, r.body));
    const service = new InterviewFeedback(identity), id = (p) => parse(z.object({ id: uuid }), p).id;
    app.get('/api/v4/interviews/:id/feishu-feedback', r => service.status(r.actor, id(r.params)));
    app.post('/api/v4/interviews/:id/feishu-feedback', r => service.send(r.actor, id(r.params), r.body));
}
//# sourceMappingURL=routes.js.map