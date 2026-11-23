import { SourceService } from './sources.js';
import type { Identity } from '../identity/service.js';
export type Lease = {
    id: string;
    run_id: string;
    source_id: string;
    claim_token: number;
    worker_id: string;
    reserved_tokens: number;
    [key: string]: any;
};
export class DiscoveryQueue {
    readonly db;
    constructor(readonly identity: Identity) { this.db = identity.db; }
    async claim(workerId: string, modelAvailable = true): Promise<Lease | null> {
        return this.db.tx(async (c) => {
            await c.query("SELECT pg_advisory_xact_lock(hashtext(current_schema()),18001)");
            await c.query("UPDATE discovery_queue SET state='failed',error_code='lease_expired' WHERE state='running' AND lease_until<now() AND attempts>=3");
            const q = (await c.query("SELECT q.* FROM discovery_queue q JOIN discovery_runs r ON r.id=q.run_id JOIN discovery_tasks t ON t.id=r.task_id WHERE (q.state='queued' OR q.state='running' AND q.lease_until<now() AND q.attempts<3) AND q.available_at<=now() AND r.ended_at IS NULL AND t.state='running' AND (q.kind='fetch' OR $1::boolean) ORDER BY q.created_at,q.id FOR UPDATE OF q SKIP LOCKED LIMIT 1", [modelAvailable])).rows[0];
            if (!q)
                return null;
            const r = (await c.query('SELECT * FROM discovery_runs WHERE id=$1 FOR UPDATE', [q.run_id])).rows[0];
            if (q.kind === 'fetch' && q.attempts > 0) {
                const used = await new SourceService(this.identity).budget(r, q.input.platform);
                if (used.total >= r.limits.pages || used.source >= r.limits.pagesPerSource) {
                    await c.query("UPDATE discovery_queue SET state='failed',error_code='budget_exhausted',lease_until=NULL WHERE id=$1", [q.id]);
                    return null;
                }
            }
            const elapsed = r.active_seconds + (r.active_since ? (Date.now() - new Date(r.active_since).getTime()) / 1000 : 0);
            // A call is conservatively reserved before claiming; expired leases never refund unknown provider spend.
            const reserve = q.kind === 'extract' ? 20000 : 0;
            if ((q.kind === 'extract' && r.calls >= r.limits.calls) || r.tokens + r.reserved_tokens + reserve > r.limits.tokens || elapsed >= r.limits.minutes * 60) {
                await c.query("UPDATE discovery_queue SET state='failed',error_code='budget_exhausted' WHERE id=$1", [q.id]);
                return null;
            }
            const running = Number((await c.query("SELECT count(*) FROM discovery_queue WHERE state='running' AND lease_until>now() AND kind=$1", [q.kind])).rows[0].count);
            if (running >= 2)
                return null;
            if (q.kind === 'fetch' && (await c.query("SELECT 1 FROM discovery_queue WHERE kind='fetch' AND state='running' AND lease_until>now() AND input->>'host'=$1", [q.input.host])).rowCount)
                return null;
            await c.query('UPDATE discovery_runs SET calls=calls+$3,reserved_tokens=reserved_tokens+$2 WHERE id=$1', [r.id, reserve, q.kind === 'extract' ? 1 : 0]);
            return (await c.query("UPDATE discovery_queue SET state='running',attempts=attempts+1,claim_token=claim_token+1,worker_id=$2,lease_until=now()+interval '60 seconds',reserved_tokens=$3 WHERE id=$1 RETURNING *", [q.id, workerId, reserve])).rows[0];
        });
    }
    async heartbeat(l: Lease) { return !!(await this.db.query("UPDATE discovery_queue SET lease_until=now()+interval '60 seconds' WHERE id=$1 AND state='running' AND claim_token=$2 AND worker_id=$3 AND lease_until>now()", [l.id, l.claim_token, l.worker_id])).rowCount; }
    async complete(l: Lease, result: unknown, tokens: number) { return this.db.tx(async (c) => { const row = (await c.query("SELECT q.* FROM discovery_queue q JOIN discovery_runs r ON r.id=q.run_id JOIN discovery_tasks t ON t.id=r.task_id WHERE q.id=$1 AND q.claim_token=$2 AND q.worker_id=$3 AND q.state='running' AND q.lease_until>now() AND t.state='running' AND r.ended_at IS NULL FOR UPDATE OF q,r,t", [l.id, l.claim_token, l.worker_id])).rows[0]; if (!row)
        return false; await c.query('UPDATE discovery_sources SET draft=$2,version=version+1 WHERE id=$1 AND status=\'pending\' AND version=($3::int)', [l.source_id, result, row.input.sourceVersion]); await c.query("UPDATE discovery_queue SET state='completed',lease_until=NULL WHERE id=$1", [l.id]); await c.query('UPDATE discovery_runs SET tokens=tokens+$2,reserved_tokens=greatest(0,reserved_tokens-$3) WHERE id=$1', [l.run_id, Math.max(0, Math.ceil(tokens)), l.reserved_tokens]); return true; }); }
    async fail(l: Lease, code: string, retry = false) { await this.db.query("UPDATE discovery_queue SET state=$4,error_code=$5,available_at=now()+interval '30 seconds',lease_until=NULL WHERE id=$1 AND claim_token=$2 AND worker_id=$3 AND state='running'", [l.id, l.claim_token, l.worker_id, retry && l.attempts < 3 ? 'queued' : 'failed', code]); }
}
