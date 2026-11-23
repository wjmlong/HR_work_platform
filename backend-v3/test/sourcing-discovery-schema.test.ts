import test from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase, actor } from './helpers.js';
test('discovery schema rejects unverifiable contacts and accepts cited platform entry', async () => {
    const m = await import('../src/sourcing-discovery/schema.js').catch(() => null);
    assert.ok(m, 'discovery schemas must exist');
    const b = { type: 'platform_dm', evidenceIds: ['e1'], observedAt: new Date().toISOString(), purpose: '职业联系', limitations: [] };
    assert.equal(m.contactInput.safeParse(b).success, false);
    assert.equal(m.contactInput.safeParse({ ...b, entryUrl: 'https://www.zhihu.com/people/demo' }).success, true);
    assert.equal(m.contactInput.safeParse({ ...b, type: 'email' }).success, false);
    assert.equal(m.contactInput.safeParse({ ...b, type: 'email', value: 'wrong' }).success, false);
    assert.equal(m.contactInput.safeParse({ ...b, entryUrl: 'javascript:alert(1)' }).success, false);
    assert.equal(m.contactInput.safeParse({ ...b, entryUrl: 'https://www.zhihu.com/x?token=secret' }).success, false);
});
test('migration supports discovery state and keeps legacy followups unassigned', async (t) => {
    const { db, cleanup } = await testDatabase();
    t.after(cleanup);
    const a = await actor(db);
    const tables = await db.query("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename='discovery_tasks'");
    assert.equal(tables.rowCount, 1, 'discovery migration exists');
    await db.migrate();
    const x = await db.query("INSERT INTO leads(name,org,direction,source,line,owner_id) VALUES('旧线索','组织','自动化','其他','social',$1) RETURNING id", [a.id]);
    const { ensureLegacyRelations } = await import('../src/sourcing-discovery/schema.js');
    await ensureLegacyRelations(db);
    await ensureLegacyRelations(db);
    const rows = await db.query('SELECT * FROM discovery_lead_jobs WHERE lead_id=$1', [x.rows[0].id]);
    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0].job_id, null);
});
