import { loadDefinition, writeFieldValues, currentValues } from './fields.js';
import { fieldAllowed, hasSalaryAccess } from './access.js';
import { validateFieldValues, fieldVisible } from './field-validation.js';
import { BusinessConfigService } from './service.js';
import { fail } from '../http/errors.js';
export const getPath = (o, path) => path.split('.').reduce((v, k) => v?.[k], o);
export function setPath(o, path, value) { const parts = path.split('.'), key = parts.pop(); let target = o; for (const part of parts)
    target = target[part] ??= {}; target[key] = value; }
export function coreValues(def, core) { return Object.fromEntries(def.fields.filter(f => f.coreKey && getPath(core, f.coreKey) !== undefined).map(f => [f.fieldId, getPath(core, f.coreKey)])); }
export function stripMetadata(input) { if (!input || typeof input !== 'object' || Array.isArray(input))
    fail(422, 'invalid_input'); const { definitionVersion, definitionRevision, customFields, ...core } = input; return core; }
export async function prepareObjectWrite(identity, a, kind, ref, input, next, previous = {}, mode = 'edit', coreOnly = false) {
    await new BusinessConfigService(identity).seed();
    const def = await loadDefinition(identity, kind, identity.db.sql, a);
    if (!Number.isInteger(input?.definitionVersion) || typeof input?.definitionRevision !== 'string')
        fail(409, 'client_update_required');
    if (input.definitionVersion !== def.ref.version || input.definitionRevision !== def.aclRevision)
        fail(409, 'configuration_changed');
    const salary = ref ? await hasSalaryAccess(identity, a, ref, identity.db.sql) : a.roles.some(r => ['admin', 'manager', 'recruiter'].includes(r));
    const writable = { ...def, fields: def.fields.filter(f => fieldAllowed(f, a, 'write', salary) && (!coreOnly || !!f.coreKey)) }, oldCustom = ref ? await currentValues(ref, identity.db.sql) : {};
    const custom = input.customFields ?? {};
    if (!custom || typeof custom !== 'object' || Array.isArray(custom))
        fail(422, 'field_map_invalid');
    for (const id of Object.keys(custom)) {
        const field = def.fields.find(f => f.fieldId === id && !f.coreKey);
        if (!field)
            fail(422, 'field_unknown:' + id);
        if (!fieldAllowed(field, a, 'write', salary))
            fail(403, 'field_forbidden:' + id);
    }
    const touched = stripMetadata(input);
    for (const field of def.fields.filter(f => f.coreKey)) {
        if (getPath(touched, field.coreKey) !== undefined && !fieldAllowed(field, a, 'write', salary))
            fail(403, 'field_forbidden:' + field.fieldId);
    }
    const old = { ...coreValues(def, previous), ...oldCustom }, changedCore = Object.fromEntries(writable.fields.filter(f => f.coreKey && (mode === 'create' || getPath(touched, f.coreKey) !== undefined)).map(f => [f.fieldId, getPath(next, f.coreKey)]));
    const validated = validateFieldValues(writable, { ...changedCore, ...custom }, old, mode, { ...def, fields: def.fields.filter(f => fieldAllowed(f, a, 'read', salary)) });
    const result = structuredClone(next);
    for (const field of writable.fields.filter(f => f.coreKey))
        if (Object.hasOwn(changedCore, field.fieldId) || mode === 'create')
            setPath(result, field.coreKey, validated[field.fieldId] ?? (Array.isArray(getPath(next, field.coreKey)) ? [] : getPath(next, field.coreKey) === null ? null : ''));
    return { def, mode, core: result, write: { definitionVersion: def.ref.version, definitionRevision: def.aclRevision, customFields: Object.fromEntries(Object.entries({ ...validated, ...Object.fromEntries(Object.keys(custom).filter(id => !Object.hasOwn(validated, id)).map(id => [id, null])) }).filter(([id]) => def.fields.some(f => f.fieldId === id && !f.coreKey))), evidenceBasis: input.reason }, coreValues: coreValues(def, result) };
}
export async function finishObjectWrite(identity, a, ref, prepared) {
    await writeFieldValues(identity, a, ref, prepared.write, identity.db.sql, prepared.coreValues, prepared.mode);
    const table = { job: 'jobs', resume: 'resume_versions', application: 'applications', lead: 'leads', campus: 'campuses', interview: 'interviews', evaluation: 'evaluations' }[ref.kind];
    // Evaluation bindings are stored on immutable evaluation versions, not the shared header.
    if (ref.kind !== 'evaluation')
        await identity.db.query(`UPDATE ${table} SET configuration_refs=configuration_refs||$2::jsonb WHERE id=$1`, [ref.id, { fields: prepared.def.ref }]);
}
export async function projectCore(identity, a, kind, core, ref) {
    await new BusinessConfigService(identity).seed();
    const def = await loadDefinition(identity, kind, identity.db.sql, a), salary = ref ? await hasSalaryAccess(identity, a, ref, identity.db.sql) : a.roles.some(r => ['admin', 'manager', 'recruiter'].includes(r));
    const result = structuredClone(core), values = { ...coreValues(def, core), ...(ref ? await currentValues(ref, identity.db.sql) : {}) };
    for (const f of def.fields.filter(f => f.coreKey))
        if (!fieldVisible(def, f, values, f => fieldAllowed(f, a, 'read', salary))) {
            const keys = f.coreKey.split('.'), last = keys.pop(), parent = keys.reduce((p, k) => p?.[k], result);
            if (parent)
                delete parent[last];
        }
    return { core: result, customFields: Object.fromEntries(Object.entries(values).filter(([id]) => def.fields.some(f => f.fieldId === id && !f.coreKey && fieldVisible(def, f, values, f => fieldAllowed(f, a, 'read', salary))))), definition: { ref: def.ref, aclRevision: def.aclRevision } };
}
//# sourceMappingURL=object-fields.js.map