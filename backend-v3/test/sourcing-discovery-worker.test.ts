import test from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase, actor } from './helpers.js';
import { Identity } from '../src/identity/service.js';
import { FeishuProvider } from '../src/identity/provider.js';
import { DiscoveryTasks } from '../src/sourcing-discovery/tasks.js';
export async function fixture(t: any) { const env = await testDatabase(); t.after(env.cleanup); const a = await actor(env.db), id = new Identity(env.db, env.config, new FeishuProvider(env.config)), tasks = new DiscoveryTasks(id); const j = (await env.db.query("INSERT INTO jobs(name) VALUES('自动化') RETURNING id")).rows[0]; const task = await tasks.create(a, { name: '任务', jobId: j.id, sources: ['zhihu'] }); await tasks.action(a, task.id, { version: 1, action: 'start' }); return { ...env, a, id, tasks, task }; }
test('source import deduplicates, queues once, and fences stale/cancelled workers', async (t) => {
    const f = await fixture(t);
    const m = await import('../src/sourcing-discovery/sources.js').catch(() => null);
    assert.ok(m, 'source service exists');
    const q = await import('../src/sourcing-discovery/queue.js');
    const s = new m.SourceService(f.id), queue = new q.DiscoveryQueue(f.id);
    const item = { platform: 'zhihu', nativeId: 'test', displayName: '测试作者', profileUrl: 'https://www.zhihu.com/people/test', entityType: 'account', accessMethod: 'manual_import', externalModelAllowed: true, evidence: [{ id: 'e1', text: 'AI自动化 n8n', sourceUrl: 'https://www.zhihu.com/people/test', capturedAt: new Date().toISOString() }] };
    const r = await s.submit(f.a, f.task.id, { version: 2, items: [item, item] });
    assert.equal(new Set(r.map((x: any) => x.id)).size, 1);
    await s.enqueue(f.a, r[0].id, { version: 1 });
    await assert.rejects(() => s.enqueue(f.a, r[0].id, { version: 1 }));
    const [a, b] = await Promise.all([queue.claim('one'), queue.claim('two')]);
    assert.equal([a, b].filter(Boolean).length, 1);
    const lease = (a || b)!;
    await f.tasks.action(f.a, f.task.id, { version: 2, action: 'cancel' });
    assert.equal(await queue.complete(lease, { directions: [], missing: [] }, 10), false);
    assert.equal((await f.db.query('SELECT draft FROM discovery_sources WHERE id=$1', [r[0].id])).rows[0].draft, null);
});
