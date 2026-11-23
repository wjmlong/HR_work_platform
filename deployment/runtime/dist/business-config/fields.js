import { fail, found } from '../http/errors.js';
import { assertObjectAccess, fieldAllowed, hasSalaryAccess } from './access.js';
import { fieldVisible, validateFieldValues } from './field-validation.js';
import { resolveFieldDictionaries, definitionRevision } from './dictionaries.js';
import { storedCoreValues } from './core-values.js';
export { validateFieldValues } from './field-validation.js';
export async function loadDefinition(identity, kind, sql, a) {
    const row = found((await sql.query('SELECT c.id,c.published_version,v.document FROM business_configs c JOIN business_config_versions v ON v.config_id=c.id AND v.version=c.published_version WHERE c.key=$1 FOR SHARE OF c', ['fields.' + kind])).rows[0]);
    const ref = { configId: row.id, version: row.published_version }, resolved = await resolveFieldDictionaries(identity.db, row.document.fields, sql);
    return { entity: kind, ref, fields: resolved.fields, aclRevision: definitionRevision(ref, resolved.refs, a) };
}
export function projectFieldValues(def, a, values, mode, salaryAllowed = false) {
    return Object.fromEntries(def.fields.filter(f => fieldVisible(def, f, values, f => fieldAllowed(f, a, mode, salaryAllowed)) && Object.hasOwn(values, f.fieldId)).map(f => [f.fieldId, values[f.fieldId]]));
}
export const decodeFieldRow = (r) => r.value_type === 'number' ? Number(r.number_value) : r.value_type === 'boolean' ? r.bool_value : r.value_type === 'date' ? r.date_value : r.value_type === 'datetime' ? r.time_value.toISOString() : r.value_type === 'select' ? r.option_values[0] : r.value_type === 'multiselect' ? r.option_values : r.value_type === 'money' || r.value_type === 'money_range' ? { ...r.amount_metadata, min: r.amount_min, max: r.amount_max, currency: r.currency, period: r.pay_period } : r.text_value;
export async function currentValues(ref, c) { return Object.fromEntries((await c.query('SELECT * FROM custom_field_values WHERE object_kind=$1 AND object_id=$2', [ref.kind, ref.id])).rows.map(r => [r.field_id, decodeFieldRow(r)])); }
export async function readFieldValues(identity, a, ref, _sql) {
    return identity.db.tx(async (c) => {
        await assertObjectAccess(identity, a, ref, 'read', c);
        const def = await loadDefinition(identity, ref.kind, c, a), values = await currentValues(ref, c);
        const full = { ...await storedCoreValues(c, ref, def), ...values };
        return Object.fromEntries(Object.entries(projectFieldValues(def, a, full, 'read', await hasSalaryAccess(identity, a, ref, c))).filter(([id]) => Object.hasOwn(values, id)));
    });
}
function storageValue(f, value) {
    const v = [null, null, null, null, null, null, null, null, null, null, null];
    if (f.type === 'text' || f.type === 'longtext')
        v[0] = value;
    else if (f.type === 'number')
        v[1] = value;
    else if (f.type === 'date')
        v[2] = value;
    else if (f.type === 'datetime')
        v[3] = value;
    else if (f.type === 'boolean')
        v[4] = value;
    else if (f.type === 'select' || f.type === 'multiselect')
        v[5] = f.type === 'select' ? [value] : value;
    else {
        const m = value;
        v[6] = m.min;
        v[7] = m.max;
        v[8] = m.currency;
        v[9] = m.period;
        v[10] = m;
    }
    return v;
}
export async function writeFieldValues(identity, a, ref, input, _sql, coreValues = {}, mode = 'edit') {
    await identity.db.tx(async (c) => {
        await assertObjectAccess(identity, a, ref, 'write', c);
        await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ['fields:' + ref.kind + ':' + ref.id]);
        const def = await loadDefinition(identity, ref.kind, c, a);
        if (input.definitionVersion !== def.ref.version)
            fail(409, 'configuration_changed');
        if (input.definitionRevision !== undefined && input.definitionRevision !== def.aclRevision)
            fail(409, 'configuration_changed');
        const previous = await currentValues(ref, c), salaryAllowed = await hasSalaryAccess(identity, a, ref, c);
        if (!input.customFields || typeof input.customFields !== 'object' || Array.isArray(input.customFields))
            fail(422, 'field_map_invalid');
        for (const key of Object.keys(input.customFields)) {
            const field = def.fields.find(f => f.fieldId === key && !f.coreKey);
            if (!field)
                fail(422, 'field_unknown:' + key);
            if (!fieldAllowed(field, a, 'write', salaryAllowed))
                fail(403, 'field_forbidden:' + key);
        }
        coreValues = { ...await storedCoreValues(c, ref, def), ...coreValues };
        const writable = { ...def, fields: def.fields.filter(f => !f.coreKey && fieldAllowed(f, a, 'write', salaryAllowed)) };
        const validated = validateFieldValues(writable, input.customFields, { ...coreValues, ...Object.fromEntries(Object.entries(previous).filter(([id]) => writable.fields.some(f => f.fieldId === id))) }, mode, { ...def, fields: def.fields.filter(f => fieldAllowed(f, a, 'read', salaryAllowed)) });
        const next = { ...previous, ...Object.fromEntries(Object.entries(validated).filter(([id]) => writable.fields.some(f => f.fieldId === id))) };
        for (const field of writable.fields)
            if (!Object.hasOwn(validated, field.fieldId))
                delete next[field.fieldId];
        for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
            if (JSON.stringify(previous[key]) === JSON.stringify(next[key]))
                continue;
            const field = def.fields.find(f => f.fieldId === key);
            const version = Number((await c.query('SELECT coalesce(max(version),0)+1 n FROM custom_field_value_versions WHERE object_kind=$1 AND object_id=$2 AND field_id=$3', [ref.kind, ref.id, key])).rows[0].n);
            const source = { kind: 'human', actorId: a.id, fieldDefinition: field, ...(input.evidenceBasis ? { reason: input.evidenceBasis } : {}) };
            if (next[key] === undefined)
                await c.query('DELETE FROM custom_field_values WHERE object_kind=$1 AND object_id=$2 AND field_id=$3', [ref.kind, ref.id, key]);
            else
                await c.query(`INSERT INTO custom_field_values(object_kind,object_id,field_id,config_id,definition_version,value_type,text_value,number_value,date_value,time_value,bool_value,option_values,amount_min,amount_max,currency,pay_period,amount_metadata,version,source,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) ON CONFLICT(object_kind,object_id,field_id) DO UPDATE SET config_id=EXCLUDED.config_id,definition_version=EXCLUDED.definition_version,value_type=EXCLUDED.value_type,text_value=EXCLUDED.text_value,number_value=EXCLUDED.number_value,date_value=EXCLUDED.date_value,time_value=EXCLUDED.time_value,bool_value=EXCLUDED.bool_value,option_values=EXCLUDED.option_values,amount_min=EXCLUDED.amount_min,amount_max=EXCLUDED.amount_max,currency=EXCLUDED.currency,pay_period=EXCLUDED.pay_period,amount_metadata=EXCLUDED.amount_metadata,version=EXCLUDED.version,source=EXCLUDED.source,actor_id=EXCLUDED.actor_id,updated_at=now()`, [ref.kind, ref.id, key, def.ref.configId, def.ref.version, field.type, ...storageValue(field, next[key]), version, source, a.id]);
            await c.query('INSERT INTO custom_field_value_versions(object_kind,object_id,field_id,version,config_id,definition_version,value,source,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [ref.kind, ref.id, key, version, def.ref.configId, def.ref.version, JSON.stringify(next[key] ?? null), source, a.id]);
        }
        await identity.audit(c, a.id, 'business_fields.write', ref.id, { entity: ref.kind, definitionVersion: def.ref.version, fields: Object.keys(input.customFields) });
    });
}
export async function inheritResumeFields(identity, a, oldId, newId, c) {
    await assertObjectAccess(identity, a, { kind: 'resume', id: oldId }, 'read', c);
    await assertObjectAccess(identity, a, { kind: 'resume', id: newId }, 'write', c);
    if (!(await c.query('SELECT 1 FROM resume_versions n JOIN resume_versions o ON o.id=$1 AND o.candidate_id=n.candidate_id WHERE n.id=$2 AND n.parent_id=o.id', [oldId, newId])).rowCount)
        fail(409, 'resume_parent_mismatch');
    const rows = (await c.query("SELECT * FROM custom_field_values WHERE object_kind='resume' AND object_id=$1", [oldId])).rows;
    for (const row of rows) {
        const source = { ...row.source, inheritedFrom: { kind: 'resume', id: oldId, version: row.version }, originalAt: row.updated_at };
        await c.query(`INSERT INTO custom_field_values(object_kind,object_id,field_id,config_id,definition_version,value_type,text_value,number_value,date_value,time_value,bool_value,option_values,amount_min,amount_max,currency,pay_period,amount_metadata,version,source,actor_id) SELECT object_kind,$2,field_id,config_id,definition_version,value_type,text_value,number_value,date_value,time_value,bool_value,option_values,amount_min,amount_max,currency,pay_period,amount_metadata,1,$3,actor_id FROM custom_field_values WHERE object_kind='resume' AND object_id=$1 AND field_id=$4`, [oldId, newId, source, row.field_id]);
        await c.query("INSERT INTO custom_field_value_versions(object_kind,object_id,field_id,version,config_id,definition_version,value,source,actor_id) VALUES('resume',$1,$2,1,$3,$4,$5,$6,$7)", [newId, row.field_id, row.config_id, row.definition_version, JSON.stringify(decodeFieldRow(row)), source, row.actor_id]);
    }
}
//# sourceMappingURL=fields.js.map