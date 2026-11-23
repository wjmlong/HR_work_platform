import test from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase, actor } from './helpers.js';
import { Identity } from '../src/identity/service.js';
import { FeishuProvider } from '../src/identity/provider.js';
import { DiscoveryTasks } from '../src/sourcing-discovery/tasks.js';
import { SourceService } from '../src/sourcing-discovery/sources.js';
import { DiscoveryReviews } from '../src/sourcing-discovery/reviews.js';
import { DiscoveryMerge } from '../src/sourcing-discovery/merge.js';
test('manual merge requires preview and preserves independent job relations; reversible before subsequent changes', async (t) => { const f = await testDatabase(); t.after(f.cleanup); const a = await actor(f.db), id = new Identity(f.db, f.config, new FeishuProvider(f.config)), tasks = new DiscoveryTasks(id), sources = new SourceService(id), reviews = new DiscoveryReviews(id), merges = new DiscoveryMerge(id); const subjects = []; for (let n = 0; n < 2; n++) {
    const job = (await f.db.query("INSERT INTO jobs(name) VALUES('合成岗位') RETURNING id")).rows[0], task = await tasks.create(a, { name: '合成任务', jobId: job.id, sources: ['zhihu'] });
    await tasks.action(a, task.id, { version: 1, action: 'start' });
    const [source] = await sources.submit(a, task.id, { version: 2, items: [{ platform: 'zhihu', displayName: '合成作者' + n, nativeId: 'merge' + n, profileUrl: 'https://example.com/' + n, entityType: 'account', accessMethod: 'manual_import', evidence: [{ id: 'e1', text: '自动化工作流，主页“发私信”按钮可见', sourceUrl: 'https://example.com/' + n, capturedAt: new Date().toISOString() }] }] });
    const r = await reviews.review(a, source.id, { version: 1, entityConfirmed: true, directionConfirmed: true, contactConfirmed: true, directions: [{ label: '自动化', evidenceIds: ['e1'] }], contacts: [{ type: 'platform_dm', entryUrl: 'https://example.com/' + n, evidenceIds: ['e1'], observedAt: new Date().toISOString(), purpose: '招聘' }], publishFields: ['displayName', 'directions', 'contacts'] });
    const p = await reviews.preview(a, source.id, { version: 2, reviewId: r.reviewId });
    subjects.push(await reviews.publish(a, source.id, { version: 2, reviewId: r.reviewId, previewToken: p.previewToken }));
} const pair = { sourceId: subjects[0].subjectId, targetId: subjects[1].subjectId }, p = await merges.preview(a, pair); await assert.rejects(() => merges.merge(a, { ...pair, previewToken: 'wrong', reason: '人工核验同一账号主体' }), /preview_stale/); const merged = await merges.merge(a, { ...pair, previewToken: p.previewToken, reason: '人工核验同一账号主体' }); assert.equal((await f.db.query('SELECT count(*) FROM discovery_lead_jobs WHERE lead_id=$1', [subjects[1].leadId])).rows[0].count, '2'); await assert.rejects(()=>merges.preview(a,{sourceId:pair.targetId,targetId:pair.sourceId}),/merge_target_redirected/);
    const {ensureLegacyRelations}=await import('../src/sourcing-discovery/schema.js');await ensureLegacyRelations(f.db);
    await merges.revert(a, merged.id); assert.equal((await f.db.query('SELECT count(*) FROM discovery_lead_jobs WHERE lead_id=$1', [subjects[0].leadId])).rows[0].count, '1'); assert.equal((await f.db.query('SELECT count(*) FROM candidates')).rows[0].count, '0'); });
