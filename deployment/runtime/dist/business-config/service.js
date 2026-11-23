import { normalizeDictionaryAliases } from './dictionary-aliases.js';
import { ensureMeetingStages } from './meeting-stages.js';
import { resolveCcRecipients } from './checklist-template.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { requireRole } from '../identity/service.js';
import { parse } from '../http/validation.js';
import { fail, found } from '../http/errors.js';
import { defaultConfigs, coreDefinition, compensationFields, defaultTemplates } from './defaults.js';
import { draftRequest, publishRequest, validateDocument, entityKind } from './schema.js';
import { ensureDictionaries, fixedDictionaryKeys, dictionaryKeys } from './dictionaries.js';
import { publicationAnalysis } from './impact.js';
import { loadDefinition } from './fields.js';
const hash = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const entities = { job: 'jobs', resume: 'resume_versions', application: 'applications', interview: 'interviews', evaluation: 'evaluations', lead: 'leads', campus: 'campuses' };
const read = (a) => requireRole(a, 'admin', 'manager', 'recruiter', 'interviewer', 'viewer');
// Only immutable built-in key names are memoized. Readiness and all published
// pointers still come from SQL on every request (also after a restore).
let builtInKeys;
const seedKeys = () => builtInKeys ??= { fields: defaultConfigs().map(d => 'fields.' + d.entity), templates: defaultTemplates().map(d => d.key) };
const draftRow = (r) => ({ id: r.id, configId: r.config_id, version: r.version, baseVersion: r.base_version, document: r.document, publishedVersion: r.published_version });
export class BusinessConfigService {
    identity;
    constructor(identity) {
        this.identity = identity;
    }
    get db() { return this.identity.db; }
    async seeded(c) { const keys = seedKeys(), row = (await c.query("SELECT (SELECT count(*) FROM business_configs WHERE kind='fields' AND key=ANY($1::text[]))=7 AND EXISTS(SELECT 1 FROM schema_migrations WHERE version=1004) AND (SELECT count(*) FROM business_configs WHERE key=ANY($2::text[]) AND published_version>0)=$3 AND (SELECT count(*) FROM business_configs WHERE key=ANY($4::text[]))=$5 ready", [keys.fields, keys.templates, keys.templates.length, dictionaryKeys.map(k => 'dictionary.' + k), dictionaryKeys.length])).rows[0]; return row.ready; }
    async seed() {
        if (await this.seeded(this.db.sql))
            return;
        await ensureDictionaries(this.db);
        await this.db.tx(async (c) => {
            await c.query("SELECT pg_advisory_xact_lock(hashtextextended('business-config-seed',0))");
            if (await this.seeded(c))
                return;
            for (const doc of defaultConfigs()) {
                const row = (await c.query("INSERT INTO business_configs(key,kind,entity,label) VALUES($1,'fields',$2,$3) ON CONFLICT(key) DO NOTHING RETURNING id", ['fields.' + doc.entity, doc.entity, doc.entity])).rows[0];
                if (!row) {
                    if ((await c.query('SELECT 1 FROM schema_migrations WHERE version=1003')).rowCount)
                        continue;
                    const old = found((await c.query('SELECT c.id,c.published_version,v.document FROM business_configs c JOIN business_config_versions v ON v.config_id=c.id AND v.version=c.published_version WHERE c.key=$1 FOR UPDATE OF c', ['fields.' + doc.entity])).rows[0]);
                    const additions = compensationFields(doc.entity).filter(f => !old.document.fields.some((p) => p.fieldId === f.fieldId));
                    if (!additions.length)
                        continue;
                    for (const f of additions)
                        if (old.document.fields.some((p) => p.label === f.label))
                            f.label += '（结构化）';
                    await c.query('INSERT INTO business_config_versions(config_id,version,document) VALUES($1,$2,$3)', [old.id, old.published_version + 1, { ...old.document, fields: [...old.document.fields, ...additions] }]);
                    await c.query('UPDATE business_configs SET published_version=published_version+1,version=version+1 WHERE id=$1', [old.id]);
                    continue;
                }
                await c.query('INSERT INTO business_config_versions(config_id,version,document) VALUES($1,1,$2)', [row.id, doc]);
                await c.query('UPDATE business_configs SET published_version=1 WHERE id=$1', [row.id]);
            }
            for (const doc of defaultTemplates()) {
                const row = (await c.query('INSERT INTO business_configs(key,kind,entity,label) VALUES($1,$2,$3,$4) ON CONFLICT(key) DO NOTHING RETURNING id', [doc.key, doc.kind, doc.entity, doc.label])).rows[0];
                if (row) {
                    await c.query('INSERT INTO business_config_versions(config_id,version,document) VALUES($1,1,$2)', [row.id, doc]);
                    await c.query('UPDATE business_configs SET published_version=1 WHERE id=$1', [row.id]);
                }
            }
            await c.query('INSERT INTO schema_migrations(version) VALUES(1003) ON CONFLICT DO NOTHING');
            await ensureMeetingStages(c);
        });
    }
    async catalog(a) { read(a); await this.seed(); return (await this.db.query('SELECT id,key,kind,entity,label,published_version,version FROM business_configs ORDER BY kind,key')).rows; }
    async effective(a, kind) {
        read(a);
        parse(entityKind, kind);
        await this.seed();
        return this.db.tx(async (c) => { const definition = await loadDefinition(this.identity, kind, c, a); return { ...definition, fields: definition.fields.filter(f => a.roles.some(r => f.access.read.includes(r))) }; });
    }
    async version(a, ref) {
        read(a);
        const row = found((await this.db.query('SELECT document FROM business_config_versions WHERE config_id=$1 AND version=$2', [ref.configId, ref.version])).rows[0]);
        // Definition metadata is needed to administer a field even when its values
        // are restricted to another role; this never returns stored business values.
        if (row.document.kind === 'fields' && !a.roles.includes('admin'))
            return { ...row.document, fields: row.document.fields.filter((f) => a.roles.some(r => f.access.read.includes(r))) };
        return row.document;
    }
    async impact(entity, c) {
        const table = entities[entity];
        const rows = (await c.query(`SELECT id,${entity === 'resume' ? 'created_at' : 'version'} stamp FROM ${table} ORDER BY id`)).rows;
        const fields = (await c.query('SELECT object_id,field_id,version FROM custom_field_values WHERE object_kind=$1 ORDER BY object_id,field_id', [entity])).rows, views = (await c.query('SELECT id,version FROM saved_views WHERE entity=$1 ORDER BY id', [entity])).rows;
        return { affected: rows.length, impactHash: hash([rows, fields, views]) };
    }
    compatible(previous, next) {
        if (!previous)
            return;
        if (previous.kind !== next.kind || previous.entity !== next.entity)
            fail(422, 'configuration_kind_immutable');
        if ((previous.kind === 'match' || previous.kind === 'questions' || previous.kind === 'evaluation') && previous.mode === 'prd_compat')
            fail(422, 'prd_default_immutable');
        if (next.kind === 'dictionary' && previous.kind === 'dictionary') {
            if (next.key !== previous.key)
                fail(422, 'configuration_key_mismatch');
            if (fixedDictionaryKeys.includes(next.key.slice(11)) && JSON.stringify(next.options.map(o => o.id).sort()) !== JSON.stringify(previous.options.map(o => o.id).sort()))
                fail(422, 'core_dictionary_codes');
            for (const old of previous.options) {
                const option = next.options.find(o => o.id === old.id);
                if (!option)
                    fail(422, 'published_option_requires_deactivation');
                if (option.coreCode !== old.coreCode)
                    fail(422, 'core_dictionary_codes');
                if (next.key === 'dictionary.education' && old.rank !== option.rank)
                    fail(422, 'education_rank_immutable');
            }
            return;
        }
        if (next.kind !== 'fields' || previous.kind !== 'fields')
            return;
        const core = coreDefinition(next.entity);
        for (const f of next.fields)
            if (f.coreKey && !core.fields.some(c => c.coreKey === f.coreKey && c.fieldId === f.fieldId && c.type === f.type))
                fail(422, 'system_field_invalid');
        for (const old of previous.fields) {
            const field = next.fields.find(f => f.fieldId === old.fieldId);
            if (!field)
                fail(422, 'published_field_requires_deactivation');
            if (field.type !== old.type || field.coreKey !== old.coreKey || field.unit !== old.unit)
                fail(422, 'field_semantic_change_requires_migration');
            if (old.access.sensitivity === 'salary' && (field.access.sensitivity !== 'salary' || field.access.public))
                fail(422, 'salary_permission_ceiling');
            if (old.system && (!field.active || !field.required || !field.system || field.visibleWhen))
                fail(422, 'system_field_required');
        }
    }
    async saveDraft(a, input) {
        requireRole(a, 'admin');
        await this.seed();
        const b = parse(draftRequest, input), document = validateDocument(normalizeDictionaryAliases(b.document));
        if (document.kind === 'cc')
            await resolveCcRecipients(this.identity, a, document.defaultMemberIds);
        if ((document.kind === 'fields' ? 'fields.' + document.entity : document.key) !== b.key)
            fail(422, 'configuration_key_mismatch');
        return this.db.tx(async (c) => {
            let config = (await c.query('SELECT * FROM business_configs WHERE key=$1 FOR UPDATE', [b.key])).rows[0];
            if (!config) {
                if (b.baseVersion !== 0)
                    fail(409, 'version_conflict');
                config = (await c.query('INSERT INTO business_configs(key,kind,entity,label) VALUES($1,$2,$3,$4) RETURNING *', [b.key, document.kind, document.entity, 'label' in document ? document.label : b.key])).rows[0];
            }
            if (config.published_version !== b.baseVersion)
                fail(409, 'version_conflict');
            const previous = (await c.query('SELECT document FROM business_config_versions WHERE config_id=$1 AND version=$2', [config.id, b.baseVersion])).rows[0]?.document;
            this.compatible(previous, document);
            if (b.draftId) {
                const row = found((await c.query('SELECT * FROM business_config_drafts WHERE id=$1 AND actor_id=$2 FOR UPDATE', [b.draftId, a.id])).rows[0]);
                if (row.config_id !== config.id || row.version !== b.draftVersion || row.published_version)
                    fail(409, 'draft_conflict');
                return draftRow((await c.query('UPDATE business_config_drafts SET document=$2,version=version+1,updated_at=now() WHERE id=$1 RETURNING *', [row.id, document])).rows[0]);
            }
            return draftRow((await c.query('INSERT INTO business_config_drafts(config_id,actor_id,base_version,document) VALUES($1,$2,$3,$4) RETURNING *', [config.id, a.id, b.baseVersion, document])).rows[0]);
        });
    }
    async drafts(a) { requireRole(a, 'admin'); return (await this.db.query('SELECT * FROM business_config_drafts WHERE actor_id=$1 ORDER BY updated_at DESC', [a.id])).rows.map(draftRow); }
    async preview(a, draftId) {
        requireRole(a, 'admin');
        const d = found((await this.db.query('SELECT * FROM business_config_drafts WHERE id=$1 AND actor_id=$2', [draftId, a.id])).rows[0]);
        const baseline = (await this.db.query('SELECT published_version FROM business_configs WHERE id=$1', [d.config_id])).rows[0];
        if (!baseline || baseline.published_version !== d.base_version || d.published_version)
            fail(409, 'version_conflict');
        const impact = await this.impact(d.document.entity, this.db.sql);
        const body = { draftId: d.id, draftVersion: d.version, baseVersion: d.base_version, actorId: a.id, inputHash: hash(d.document), impactHash: impact.impactHash };
        return { ...body, signature: this.identity.hash(JSON.stringify(body)), affected: impact.affected, analysis: await publicationAnalysis(this.db.sql, a, d.document, d.config_id) };
    }
    async publish(a, input) {
        requireRole(a, 'admin');
        const { affected: _, analysis: __, ...plain } = (input && typeof input === 'object' ? input : {}), b = parse(publishRequest, plain), { signature, ...body } = b;
        const signatureBytes = Buffer.from(signature, 'hex'), expected = Buffer.from(this.identity.hash(JSON.stringify(body)), 'hex');
        if (b.actorId !== a.id || signatureBytes.length !== expected.length || !timingSafeEqual(signatureBytes, expected))
            fail(409, 'preview_invalid');
        return this.db.tx(async (c) => {
            // Lock in the same order as saveDraft to avoid cross-draft deadlocks.
            const d = found((await c.query('SELECT * FROM business_config_drafts WHERE id=$1 AND actor_id=$2', [b.draftId, a.id])).rows[0]);
            const config = found((await c.query('SELECT * FROM business_configs WHERE id=$1 FOR UPDATE', [d.config_id])).rows[0]);
            const locked = found((await c.query('SELECT * FROM business_config_drafts WHERE id=$1 FOR UPDATE', [d.id])).rows[0]);
            if (config.published_version !== b.baseVersion || locked.version !== b.draftVersion || locked.published_version)
                fail(409, 'version_conflict');
            if (hash(locked.document) !== b.inputHash)
                fail(409, 'preview_invalid');
            if ((await this.impact(locked.document.entity, c)).impactHash !== b.impactHash)
                fail(409, 'preview_stale');
            const document = validateDocument(locked.document), previous = (await c.query('SELECT document FROM business_config_versions WHERE config_id=$1 AND version=$2', [config.id, b.baseVersion])).rows[0]?.document;
            this.compatible(previous, document);
            if (document.kind === 'cc')
                await resolveCcRecipients(this.identity, a, document.defaultMemberIds, c);
            const version = b.baseVersion + 1;
            await c.query('INSERT INTO business_config_versions(config_id,version,document,actor_id) VALUES($1,$2,$3,$4)', [config.id, version, document, a.id]);
            await c.query('UPDATE business_configs SET published_version=$2,label=$3,version=version+1,updated_at=now() WHERE id=$1', [config.id, version, 'label' in document ? document.label : config.label]);
            await c.query('UPDATE business_config_drafts SET published_version=$2 WHERE id=$1', [locked.id, version]);
            await this.identity.audit(c, a.id, 'business_config.publish', config.id, { version, kind: document.kind, entity: document.entity });
            return { configId: config.id, version };
        });
    }
}
//# sourceMappingURL=service.js.map