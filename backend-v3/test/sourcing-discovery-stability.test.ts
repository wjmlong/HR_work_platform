import test from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase, actor } from './helpers.js';
import { Identity } from '../src/identity/service.js';
import { FeishuProvider } from '../src/identity/provider.js';
import { DiscoveryTasks } from '../src/sourcing-discovery/tasks.js';
import { SourceService } from '../src/sourcing-discovery/sources.js';
import { DiscoveryQueue } from '../src/sourcing-discovery/queue.js';
test('pause fences in-flight worker; repeated claims respect global model concurrency and budget', async (t) => { const f = await testDatabase(); t.after(f.cleanup); const a = await actor(f.db), id = new Identity(f.db, f.config, new FeishuProvider(f.config)), tasks = new DiscoveryTasks(id), sources = new SourceService(id), queue = new DiscoveryQueue(id), job = (await f.db.query("INSERT INTO jobs(name) VALUES('合成岗位') RETURNING id")).rows[0]; const taskIds = []; for (let n = 0; n < 3; n++) {
    const task = await tasks.create(a, { name: '并发' + n, jobId: job.id, sources: ['zhihu'] });
    taskIds.push(task.id);
    await tasks.action(a, task.id, { version: 1, action: 'start' });
    const [source] = await sources.submit(a, task.id, { version: 2, items: [{ platform: 'zhihu', displayName: '合成' + n, profileUrl: 'https://example.com/' + n, entityType: 'account', accessMethod: 'manual_import', externalModelAllowed: true, evidence: [{ id: 'e1', text: 'Python 自动化', sourceUrl: 'https://example.com/' + n, capturedAt: new Date().toISOString() }] }] });
    await sources.enqueue(a, source.id, { version: 1 });
} const leases = await Promise.all([queue.claim('a'), queue.claim('b'), queue.claim('c')]); assert.equal(leases.filter(Boolean).length, 2); const first = leases.find(Boolean)!; const taskId = (await f.db.query('SELECT task_id FROM discovery_runs WHERE id=$1', [first.run_id])).rows[0].task_id; await tasks.action(a, taskId, { version: 2, action: 'pause' }); assert.equal(await queue.complete(first, { summary: 'late' }, 100), false); await tasks.action(a, taskId, { version: 3, action: 'resume' }); await f.db.query('UPDATE discovery_runs SET calls=50 WHERE id=$1', [first.run_id]); assert.equal(await queue.complete(first, { summary: 'still late' }, 100), false); await queue.claim('budget'); assert.equal((await f.db.query('SELECT state FROM discovery_queue WHERE id=$1', [first.id])).rows[0].state, 'failed'); assert.equal((await f.db.query('SELECT draft FROM discovery_sources WHERE id=$1', [first.source_id])).rows[0].draft, null); });
