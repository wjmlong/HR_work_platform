import { githubSearch, SearchService } from './search.js';
import { DiscoveryPolicy } from './policy.js';
import type { Identity, Actor } from '../identity/service.js';
import { DiscoveryQueue, type Lease } from './queue.js';
import { extractDirections, discoveryModelStatus } from './model.js';
import { fetchPublicPage } from './public-fetch.js';
import { SourceService } from './sources.js';
export class DiscoveryWorker {
    readonly queue;
    constructor(readonly identity: Identity, readonly workerId: string) { this.queue = new DiscoveryQueue(identity); }
    async actor(id: string, taskId: string) { const row = (await this.identity.db.query("SELECT * FROM users WHERE id=$1 AND status='active' AND directory_active", [id])).rows[0]; if (!row)
        throw Error('actor_revoked'); const actor = { ...row, csrf: '' } as Actor, policy = new DiscoveryPolicy(this.identity); await policy.fields(actor); await policy.assertTask(actor, taskId, 'write'); return actor; }
    async fetch(lease: Lease) { const b = lease.input, a = await this.actor(b.actorId, b.taskId), capability = (await this.identity.db.query('SELECT data FROM discovery_capabilities WHERE platform=$1', [b.platform])).rows[0]?.data; if (!capability?.publicFetch)
        throw Error('source_not_verified'); const page = await fetchPublicPage(b.url, capability.hosts); return this.identity.db.tx(async (c) => { const t = (await c.query("SELECT t.* FROM discovery_tasks t JOIN discovery_runs r ON r.task_id=t.id WHERE r.id=$1 AND t.state='running' AND r.ended_at IS NULL FOR UPDATE OF t", [lease.run_id])).rows[0]; if (!t)
        return; const current = (await c.query("SELECT 1 FROM discovery_queue WHERE id=$1 AND claim_token=$2 AND worker_id=$3 AND state='running' AND lease_until>now() FOR UPDATE", [lease.id, lease.claim_token, lease.worker_id])).rowCount; if (!current)
        return; const receipts=await new SourceService(this.identity).submit(a, t.id, { version: t.version, items: [{ platform: b.platform, profileUrl: page.url, displayName: new URL(page.url).hostname, entityType: 'institution', accessMethod: 'public_fetch', externalModelAllowed: false, evidence: [{ id: 'e1', text: page.text, sourceUrl: page.url, capturedAt: page.capturedAt }] }] }, true); await c.query("UPDATE discovery_queue SET state='completed',lease_until=NULL,source_id=$2 WHERE id=$1", [lease.id,receipts[0].id]); }); }
    async once() { const lease = await this.queue.claim(this.workerId, discoveryModelStatus(this.identity.config).configured); if (!lease)
        return false; let heartbeat: ReturnType<typeof setInterval> | undefined; try {
        heartbeat = setInterval(() => { void this.queue.heartbeat(lease).catch(() => { }); }, 20000);
        if (lease.kind === 'fetch' && lease.input.mode === 'github_search') {
            await this.actor(lease.input.actorId, lease.input.taskId);
            const rows = await githubSearch(lease.input.query, lease.input.limit);
            await this.actor(lease.input.actorId, lease.input.taskId);
            await new SearchService(this.identity).complete(lease, rows);
        } else if (lease.kind === 'fetch')
            await this.fetch(lease);
        else {
            const source = (await this.identity.db.query('SELECT data,submitted_by,task_id FROM discovery_sources WHERE id=$1', [lease.source_id])).rows[0];
            if (!source?.data.externalModelAllowed)
                throw Error('external_model_consent_required');
            await this.actor(source.submitted_by, source.task_id);
            const result = await extractDirections(this.identity.config, source.data.evidence);
            await this.actor(source.submitted_by, source.task_id);
            await this.queue.complete(lease, result.draft, result.tokens);
        }
    }
    catch (error) {
        const code = error instanceof Error && ['search_rate_limited','search_timeout','search_identity_mismatch','search_response_limit','discovery_budget_exhausted','actor_revoked'].includes(error.message) ? error.message : lease.kind === 'fetch' ? 'source_fetch_failed' : 'model_failed';
        await this.queue.fail(lease, code, false);
    }
    finally {
        clearInterval(heartbeat);
    } return true; }
}
