import { createHash } from 'node:crypto';
import type { Actor, Identity } from '../identity/service.js';
import { fail, found } from '../http/errors.js';
import { DiscoveryPolicy } from './policy.js';
import { parse, sourcesInput, pageInput, z, version, platforms, publicUrl } from './schema.js';
export class SourceService {
    readonly db;
    readonly policy;
    constructor(readonly identity: Identity) { this.db = identity.db; this.policy = new DiscoveryPolicy(identity); }
    async budget(run:any,platform:string){const q=(await this.db.query("SELECT coalesce(sum(greatest(1,attempts)),0)::int total,coalesce(sum(greatest(1,attempts)) FILTER(WHERE input->>'platform'=$2),0)::int source FROM discovery_queue WHERE run_id=$1 AND kind='fetch'",[run.id,platform])).rows[0];const manual=(await this.db.query("SELECT count(*)::int total,count(*) FILTER(WHERE platform=$3)::int source FROM discovery_sources s WHERE task_id=$1 AND created_at>=$2 AND NOT EXISTS(SELECT 1 FROM discovery_queue q WHERE q.kind='fetch' AND q.source_id=s.id)",[run.task_id,run.created_at,platform])).rows[0];return {total:q.total+manual.total,source:q.source+manual.source};}
    async submit(a: Actor, id: string, input: unknown, trustedFetch = false) {
        const b = parse(sourcesInput, input);
        await this.policy.fields(a);
        return this.db.tx(async (c) => {
            await c.query('SELECT id FROM discovery_tasks WHERE id=$1 FOR UPDATE', [id]);
            const task = await this.policy.assertTask(a, id, 'write');
            if (task.version !== b.version)
                fail(409, 'version_conflict');
            if (task.state !== 'running')
                fail(409, 'discovery_not_running');
            const run = found((await c.query('SELECT * FROM discovery_runs WHERE task_id=$1 AND ended_at IS NULL FOR UPDATE', [id])).rows[0]);
            const elapsed = run.active_seconds + (run.active_since ? (Date.now() - new Date(run.active_since).getTime()) / 1000 : 0);
            if (elapsed >= run.limits.minutes * 60)
                fail(409, 'discovery_budget_exhausted');
            const out = [];
            for (const item of b.items) {
                if (!task.snapshot.sources.includes(item.platform))
                    fail(422, 'source_not_selected');
                const hash = createHash('sha256').update(JSON.stringify({ ...item, evidence: item.evidence.map(({ capturedAt, ...e }) => e) })).digest('hex');
                let row = (await c.query('SELECT id,version FROM discovery_sources WHERE task_id=$1 AND content_hash=$2', [id, hash])).rows[0];
                if (!row) {
                    const used=await this.budget(run,item.platform);if(!trustedFetch&&(used.source>=run.limits.pagesPerSource||used.total>=run.limits.pages))fail(409,'discovery_budget_exhausted');
                    row = (await c.query('INSERT INTO discovery_sources(task_id,platform,native_id,profile_url,display_name,entity_type,data,content_hash,access_method,submitted_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,version', [id, item.platform, item.nativeId || null, item.profileUrl, item.displayName, item.entityType, { ...item, provenance: 'user_reported' }, hash, item.accessMethod, a.id])).rows[0];
                    for (const e of item.evidence)
                        await c.query('INSERT INTO discovery_evidence(source_id,segment_id,data) VALUES($1,$2,$3)', [row.id, e.id, e]);
                    await c.query('UPDATE discovery_runs SET pages=pages+1 WHERE id=$1', [run.id]);
                    run.pages++;
                }
                out.push(row);
            }
            await this.identity.audit(c, a.id, 'discovery.source.submit', id, { count: out.length });
            return out;
        });
    }
    async fetch(a: Actor, id: string, input: unknown) { await this.policy.fields(a); const b = parse(z.object({ version, platform: platforms, url: publicUrl }).strict(), input); return this.db.tx(async (c) => { await c.query('SELECT id FROM discovery_tasks WHERE id=$1 FOR UPDATE', [id]); const t = await this.policy.assertTask(a, id, 'write'); if (t.version !== b.version || t.state !== 'running')
        fail(409, 'version_conflict'); if (!t.snapshot.sources.includes(b.platform))
        fail(422, 'source_not_selected'); const capability = (await c.query('SELECT data FROM discovery_capabilities WHERE platform=$1', [b.platform])).rows[0]?.data; if (!capability?.publicFetch || !capability.hosts.includes(new URL(b.url).hostname))
        fail(409, 'source_not_verified'); const r = found((await c.query('SELECT * FROM discovery_runs WHERE task_id=$1 AND ended_at IS NULL FOR UPDATE', [id])).rows[0]); const used=await this.budget(r,b.platform);if(used.total>=r.limits.pages||used.source>=r.limits.pagesPerSource)fail(409,'discovery_budget_exhausted'); const old = (await c.query("SELECT id,state FROM discovery_queue WHERE run_id=$1 AND kind='fetch' AND input->>'url'=$2 AND state IN('queued','running')", [r.id, b.url])).rows[0]; if (old)
        return old; return (await c.query("INSERT INTO discovery_queue(run_id,kind,input) VALUES($1,'fetch',$2) RETURNING id,state", [r.id, { url: b.url, platform: b.platform, host: new URL(b.url).hostname, actorId: a.id, taskId: id }])).rows[0]; }); }
    async query(a: Actor, input: unknown) { await this.policy.fields(a); const b = parse(pageInput, input), args: any[] = [a.roles.includes('admin'), a.id]; let cond = '($1::boolean OR t.owner_id=$2 OR EXISTS(SELECT 1 FROM discovery_collaborators c WHERE c.task_id=t.id AND c.user_id=$2))'; if (b.taskId) {
        args.push(b.taskId);
        cond += ' AND s.task_id=$' + args.length;
    } if (b.state) {
        args.push(b.state);
        cond += ' AND s.status=$' + args.length;
    } const from = ' FROM discovery_sources s JOIN discovery_tasks t ON t.id=s.task_id WHERE ' + cond; const total = Number((await this.db.query('SELECT count(*)' + from, args)).rows[0].count); const items = (await this.db.query('SELECT s.id,s.task_id,s.platform,s.display_name,s.entity_type,s.profile_url,s.status,s.version,s.created_at' + from + ` ORDER BY s.created_at DESC,s.id LIMIT $${args.length + 1} OFFSET $${args.length + 2}`, [...args, b.pageSize, (b.page - 1) * b.pageSize])).rows; return { items, total, page: b.page, pageSize: b.pageSize, asOf: new Date().toISOString() }; }
    async get(a: Actor, id: string) { await this.policy.fields(a); const row = await this.policy.source(a, id); await this.identity.audit(this.db.sql, a.id, 'discovery.evidence.read', id); return { ...row, extractions: (await this.db.query('SELECT id,state,error_code,attempts,created_at FROM discovery_queue WHERE source_id=$1 ORDER BY created_at DESC LIMIT 10', [id])).rows }; }
    async enqueue(a: Actor, id: string, input: unknown) { const b = parse(z.object({ version }).strict(), input); await this.policy.fields(a); return this.db.tx(async (c) => { await c.query('SELECT id FROM discovery_sources WHERE id=$1 FOR UPDATE', [id]); const s = await this.policy.source(a, id, true); if (s.version !== b.version)
        fail(409, 'version_conflict'); if (!s.data.externalModelAllowed)
        fail(403, 'external_model_consent_required'); if (s.status !== 'pending')
        fail(409, 'already_published'); const run = found((await c.query("SELECT r.* FROM discovery_runs r JOIN discovery_tasks t ON t.id=r.task_id WHERE r.task_id=$1 AND r.ended_at IS NULL AND t.state='running' FOR UPDATE OF r", [s.task_id])).rows[0]); if ((await c.query("SELECT 1 FROM discovery_queue WHERE source_id=$1 AND state IN('queued','running')", [id])).rowCount)
        fail(409, 'discovery_already_queued'); const q = (await c.query("INSERT INTO discovery_queue(run_id,source_id,kind,input) VALUES($1,$2,'extract',$3) RETURNING id,state", [run.id, id, { sourceVersion: s.version }])).rows[0]; await this.identity.audit(c, a.id, 'discovery.extract.enqueue', id); return q; }); }
}
