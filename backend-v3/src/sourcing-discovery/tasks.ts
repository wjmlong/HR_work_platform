import type { Identity, Actor } from '../identity/service.js';
import { fail, found } from '../http/errors.js';
import { DiscoveryPolicy } from './policy.js';
import { parse, taskInput, pageInput, actionInput, platforms } from './schema.js';
export class DiscoveryTasks {
    readonly db;
    readonly policy;
    constructor(readonly identity: Identity) { this.db = identity.db; this.policy = new DiscoveryPolicy(identity); }
    async capabilities(a: Actor) { this.policy.writer(a); return platforms.options.map(platform => ({ platform, mode: 'manual_import', search: 'manual', detail: 'manual', contact: 'manual_review_required', directContact: 'unverified', import: true, automatic: false, verifiedAt: null, limitations: ['登录平台由本人浏览器操作；提交后须人工核验。'] })); }
    async create(a: Actor, input: unknown) {
        this.policy.writer(a);
        const b = parse(taskInput, input);
        return this.db.tx(async (c) => {
            const job = found((await c.query('SELECT * FROM jobs WHERE id=$1 FOR SHARE', [b.jobId])).rows[0]);
            if (!job.open)
                fail(409, 'job_closed');
            const owner = b.ownerId || a.id;
            if (owner !== a.id)
                this.policy.admin(a);
            if (!(await c.query("SELECT 1 FROM users WHERE id=$1 AND status='active' AND directory_active AND roles&&ARRAY['admin','manager','recruiter']::text[]", [owner])).rowCount)
                fail(422, 'owner_invalid');
            const row = (await c.query('INSERT INTO discovery_tasks(name,job_id,owner_id,created_by,snapshot) VALUES($1,$2,$3,$4,$5) RETURNING id,state,version', [b.name, b.jobId, owner, a.id, { ...b, jobVersion: job.version }])).rows[0];
            await this.identity.audit(c, a.id, 'discovery.task.create', row.id);
            return row;
        });
    }
    async get(a: Actor, id: string) { const row = await this.policy.assertTask(a, id); const runs = (await this.db.query('SELECT id,state,pages,calls,tokens,reserved_tokens,created_at,ended_at FROM discovery_runs WHERE task_id=$1 ORDER BY created_at', [id])).rows; const work=(await this.db.query("SELECT q.id,q.kind,q.state,q.error_code,q.attempts,q.created_at,q.input->>'mode' mode,q.input->>'query' query,q.input->>'resultCount' result_count FROM discovery_queue q JOIN discovery_runs r ON r.id=q.run_id WHERE r.task_id=$1 ORDER BY q.created_at DESC LIMIT 100",[id])).rows;return { ...row, runs, work }; }
    async query(a: Actor, input: unknown) { this.policy.writer(a); const b = parse(pageInput, input), admin = a.roles.includes('admin'); const cond = '($1::boolean OR owner_id=$2 OR EXISTS(SELECT 1 FROM discovery_collaborators c WHERE c.task_id=t.id AND c.user_id=$2)) AND ($3::text IS NULL OR state=$3)'; const args = [admin, a.id, b.state || null]; const total = Number((await this.db.query('SELECT count(*) FROM discovery_tasks t WHERE ' + cond, args)).rows[0].count); const items = (await this.db.query('SELECT id,name,job_id,owner_id,state,version,created_at FROM discovery_tasks t WHERE ' + cond + ' ORDER BY created_at DESC,id LIMIT $4 OFFSET $5', [...args, b.pageSize, (b.page - 1) * b.pageSize])).rows; return { items, total, page: b.page, pageSize: b.pageSize, asOf: new Date().toISOString() }; }
    async action(a: Actor, id: string, input: unknown) {
        const b = parse(actionInput, input);
        return this.db.tx(async (c) => {
            await c.query('SELECT id FROM discovery_tasks WHERE id=$1 FOR UPDATE', [id]);
            const row = await this.policy.assertTask(a, id, 'write');
            if (row.version !== b.version)
                fail(409, 'version_conflict');
            let next = row.state;
            switch (b.action) {
                case 'start':
                    if (row.state !== 'draft')
                        fail(409, 'discovery_transition_invalid');
                    next = 'running';
                    break;
                case 'pause':
                    if (row.state !== 'running')
                        fail(409, 'discovery_transition_invalid');
                    next = 'paused';
                    break;
                case 'resume':
                    if (row.state !== 'paused')
                        fail(409, 'discovery_transition_invalid');
                    next = 'running';
                    break;
                case 'cancel':
                    next = 'cancelled';
                    break;
                case 'close':
                    if ((await c.query("SELECT 1 FROM discovery_sources WHERE task_id=$1 AND status IN('pending','reviewed')", [id])).rowCount)
                        fail(409, 'discovery_pending_reviews');
                    if ((await c.query("SELECT 1 FROM discovery_queue q JOIN discovery_runs r ON r.id=q.run_id WHERE r.task_id=$1 AND q.state IN('queued','running')", [id])).rowCount)
                        fail(409, 'discovery_pending_work');
                    next = 'completed';
                    break;
                case 'retry':
                    if (!['paused', 'review'].includes(row.state))
                        fail(409, 'discovery_transition_invalid');
                    next = 'running';
                    await c.query("UPDATE discovery_runs SET ended_at=now(),state='completed' WHERE task_id=$1 AND ended_at IS NULL", [id]);
                    break;
            }
            if (['start', 'retry'].includes(b.action))
                await c.query('INSERT INTO discovery_runs(task_id,limits,active_since) VALUES($1,$2,now())', [id, row.snapshot.limits]);
            if (['pause', 'retry'].includes(b.action))
                await c.query("UPDATE discovery_queue SET state='queued',claim_token=claim_token+1,lease_until=NULL WHERE run_id IN(SELECT id FROM discovery_runs WHERE task_id=$1) AND state='running'", [id]);
            if (b.action === 'retry')
                await c.query("UPDATE discovery_queue SET state='cancelled',claim_token=claim_token+1 WHERE run_id IN(SELECT id FROM discovery_runs WHERE task_id=$1 AND ended_at IS NOT NULL) AND state='queued'", [id]);
            if (b.action === 'pause')
                await c.query("UPDATE discovery_runs SET active_seconds=active_seconds+EXTRACT(EPOCH FROM now()-active_since),active_since=NULL,state='paused' WHERE task_id=$1 AND ended_at IS NULL AND active_since IS NOT NULL", [id]);
            if (b.action === 'resume')
                await c.query("UPDATE discovery_runs SET active_since=now(),state='running' WHERE task_id=$1 AND ended_at IS NULL", [id]);
            if (['cancel', 'close'].includes(b.action)) {
                await c.query("UPDATE discovery_runs SET ended_at=now(),state=$2 WHERE task_id=$1 AND ended_at IS NULL", [id, next]);
                await c.query("UPDATE discovery_queue SET state='cancelled',claim_token=claim_token+1 WHERE run_id IN(SELECT id FROM discovery_runs WHERE task_id=$1) AND state IN('running','queued')", [id]);
            }
            const result = (await c.query('UPDATE discovery_tasks SET state=$2,version=version+1,updated_at=now() WHERE id=$1 RETURNING id,state,version', [id, next])).rows[0];
            await this.identity.audit(c, a.id, 'discovery.task.' + b.action, id);
            return result;
        });
    }
}
