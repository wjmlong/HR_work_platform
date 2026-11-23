import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Database } from '../db.js';
import { Identity } from '../identity/service.js';
import { FeishuProvider } from '../identity/provider.js';
import { FileStore } from '../files/storage.js';
import { restore, snapshot, TABLES } from './backup.js';
import { V3_TABLES, upgradeV3 } from './upgrade-v3.js';
import { BusinessConfigService } from '../business-config/service.js';
import { BindingService, matchInputsSchema, queueMatch } from '../business-config/bindings.js';
import { Dictionary } from '../dictionary/service.js';
import { RecruitingService } from '../recruiting/service.js';
import { writeFieldValues, currentValues } from '../business-config/fields.js';
import { fail } from '../http/errors.js';
const hash = (v) => createHash('sha256').update(v).digest('hex');
const canonical = (v) => v instanceof Date ? v.toISOString() : Buffer.isBuffer(v) ? '\\x' + v.toString('hex') : Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const rowsHash = (rows) => hash(JSON.stringify(rows.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'))));
export async function schemaRevision(db) { return Number((await db.query('SELECT coalesce(max(version),0)::int n FROM schema_migrations WHERE version<1000')).rows[0].n); }
export async function upgradeBusinessConfiguration(db) {
    return db.tx(async () => {
        const identity = new Identity(db, db.config, new FeishuProvider(db.config));
        await db.migrate();
        await new Dictionary(db).seed();
        await new BindingService(identity).initialize();
        const recoveredTasks = [];
        await db.tx(async (c) => {
            await c.query("SELECT pg_advisory_xact_lock(hashtextextended('business-configuration-upgrade',0))");
            const old = (await c.query("SELECT * FROM tasks WHERE kind='recompute' AND state IN('queued','running') ORDER BY created_at,id FOR UPDATE")).rows;
            for (const task of old) {
                if (matchInputsSchema.safeParse(task.payload).success)
                    continue;
                await c.query("UPDATE tasks SET state='failed',error_code='legacy_unpinned_task',lease_until=NULL,claim_token=claim_token+1,updated_at=now() WHERE id=$1", [task.id]);
                let next = null;
                const app = (await c.query("SELECT a.id,j.open FROM applications a JOIN jobs j ON j.id=a.job_id JOIN candidates p ON p.id=a.candidate_id JOIN users u ON u.id=$2 WHERE a.id=$1 AND a.is_current AND a.deleted_at IS NULL AND p.deleted_at IS NULL AND a.resume_version_id IS NOT NULL AND u.status='active' AND u.directory_active AND u.roles&&ARRAY['admin','manager','recruiter']::text[]", [typeof task.payload.applicationId === 'string' && /^[a-f0-9-]{36}$/i.test(task.payload.applicationId) ? task.payload.applicationId : null, task.actor_id])).rows[0];
                if (app?.open)
                    next = (await queueMatch(identity, c, app.id, task.actor_id, { reason: 'explicit_legacy_task_recovery_current_inputs' })).id;
                recoveredTasks.push({ oldTaskId: task.id, newTaskId: next });
                await identity.audit(c, task.actor_id, 'business_config.legacy_task_recovery', task.id, { newTaskId: next, oldPayloadPreserved: true, basis: 'new task uses currently known inputs, not reconstructed historical inputs' });
            }
        });
        return { schemaRevision: await schemaRevision(db), recoveredTasks };
    });
}
async function writeProbe(db) {
    const identity = new Identity(db, db.config, new FeishuProvider(db.config)), u = (await db.query("INSERT INTO users(tenant,app_id,open_id,name,status,roles) VALUES('synthetic-recovery','synthetic-recovery',$1,'合成升级验证（仅测试副本）','active',ARRAY['admin','manager','recruiter','interviewer','viewer']) RETURNING *", ['probe-' + randomUUID()])).rows[0], configs = new BusinessConfigService(identity), def = await configs.effective(u, 'job'), doc = await configs.version(u, def.ref), fieldId = 'probe.' + randomUUID();
    doc.fields.push({ fieldId, label: '恢复后合成草稿写入', type: 'text', active: true, required: false, order: 10000, group: '恢复演练' });
    const draft = await configs.saveDraft(u, { key: 'fields.job', baseVersion: def.ref.version, document: doc }), ref = await configs.publish(u, await configs.preview(u, draft.id)), current = await configs.effective(u, 'job'), level = current.fields.find(f => f.coreKey === 'level')?.options.find(o => o.active)?.id;
    if (!level)
        fail(409, 'restore_probe_level_unavailable');
    const job = await new RecruitingService(identity).createJob(u, { name: '合成升级验证（仅测试副本）', level });
    await writeFieldValues(identity, u, { kind: 'job', id: job.id }, { definitionVersion: ref.version, definitionRevision: current.aclRevision, customFields: { [fieldId]: 'synthetic-recovery-proof' } }, db.sql, {}, 'draft');
    const value = (await currentValues({ kind: 'job', id: job.id }, db.sql))[fieldId];
    if (value !== 'synthetic-recovery-proof')
        fail(500, 'restore_write_probe_failed');
    return { persisted: true, jobId: job.id, fieldId, definition: ref, mode: 'isolated_synthetic_draft_no_inferred_business_values' };
}
export async function verifyBusinessConfigUpgrade({ archiveDirectory, testConfig, storeRoot }) {
    const url = new URL(testConfig.databaseUrl);
    if (!/^recruit_test_[a-z0-9]{1,48}$/.test(testConfig.schema) || url.hostname !== '127.0.0.1' || url.port !== '55434' || url.pathname !== '/recruit_v4' || url.search || url.hash)
        fail(403, 'upgrade_verification_requires_test_schema');
    const db = new Database(testConfig), store = new FileStore(storeRoot);
    try {
        await db.migrate();
        const manifest = JSON.parse(await readFile(path.join(archiveDirectory, 'manifest.json'), 'utf8')), source = JSON.parse(await readFile(path.join(archiveDirectory, 'database.json'), 'utf8')), isV3 = manifest.version === 3 && Object.keys(source).length === V3_TABLES.length;
        if (isV3)
            await upgradeV3(db, store, archiveDirectory, false);
        else
            await restore(db, store, archiveDirectory);
        const restored = await snapshot(db), tables = Object.fromEntries(TABLES.map(t => [t, { count: restored[t].length, hash: hash(JSON.stringify(restored[t])) }]));
        if (!isV3)
            for (const [table, rows] of Object.entries(source)) {
                if (table === 'schema_migrations') {
                    for (const row of rows)
                        if (!restored[table].some(r => r.version === row.version && canonical(r.applied_at) === canonical(row.applied_at)))
                            fail(500, 'restore_invariant_failed:' + table);
                    continue;
                }
                const keys = rows[0] ? Object.keys(rows[0]) : [], actual = restored[table].map(r => Object.fromEntries(keys.map(k => [k, r[k]])));
                if (rowsHash(rows) !== rowsHash(actual))
                    fail(500, 'restore_invariant_failed:' + table);
            }
        const intentionalV3Changes = { schema_migrations: ['version', 'applied_at'], sessions: ['*'], oauth_states: ['*'], rate_limits: ['*'], idempotency_keys: ['*'], interviews: ['status'], tasks: ['state', 'worker_id', 'lease_until', 'claim_token'], candidates: ['profile', 'version', 'created_at', 'updated_at'], applications: ['resume_version_id', 'version', 'note', 'source', 'created_at', 'updated_at'] };
        if (isV3)
            for (const [table, rows] of Object.entries(source)) {
                const changed = intentionalV3Changes[table] || [];
                if (changed.includes('*')) {
                    if (restored[table].length)
                        fail(500, 'restore_invariant_failed:' + table);
                    continue;
                }
                const keys = (rows[0] ? Object.keys(rows[0]) : []).filter(k => !changed.includes(k)), actual = restored[table];
                for (const row of rows) {
                    if (!actual.some(r => JSON.stringify(canonical(Object.fromEntries(keys.map(k => [k, r[k]])))) === JSON.stringify(canonical(Object.fromEntries(keys.map(k => [k, row[k]]))))))
                        fail(500, 'restore_invariant_failed:' + table);
                }
            }
        const files = [];
        for (const f of manifest.files) {
            const bytes = await store.read(f.key);
            if (bytes.length !== f.size || hash(bytes) !== f.hash)
                fail(500, 'restore_file_invariant_failed');
            files.push({ ...f });
        }
        const upgrade = await upgradeBusinessConfiguration(db), configuration = { versions: Number((await db.query('SELECT count(*) n FROM business_config_versions')).rows[0].n), values: Number((await db.query('SELECT count(*) n FROM custom_field_values')).rows[0].n), checklists: Number((await db.query('SELECT count(*) n FROM application_checklists')).rows[0].n) }, probe = await writeProbe(db);
        return { sourceRevision: manifest.schemaRevision ?? Math.max(0, ...source.schema_migrations.map((r) => r.version).filter((n) => n < 1000)), sourceVersion: manifest.version, sourceHash: manifest.databaseHash, preserved: true, invariantMode: isV3 ? 'v3_mapped_with_explicit_column_exceptions' : 'exact_original_columns', intentionalChanges: isV3 ? intentionalV3Changes : {}, tables, files, configuration, upgrade, writeProbe: probe };
    }
    finally {
        await db.close();
    }
}
//# sourceMappingURL=business-config-upgrade.js.map