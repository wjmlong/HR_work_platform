import { projectCore, coreValues } from '../business-config/object-fields.js';
import { loadDefinition, currentValues } from '../business-config/fields.js';
import { fieldAllowed, hasSalaryAccess } from '../business-config/access.js';
import { fieldVisible } from '../business-config/field-validation.js';
import { fail } from '../http/errors.js';
// Aggregates must use the same configured fields as the entity detail/export.
export async function toolkitProjection(identity, a, kind, core, ref, mode = 'read') {
    const projected = await projectCore(identity, a, kind, core, ref), out = projected.core;
    const def = await loadDefinition(identity, kind, identity.db.sql, a);
    const values = { ...coreValues(def, core), ...(ref ? await currentValues(ref, identity.db.sql) : {}) };
    const salary = ref ? await hasSalaryAccess(identity, a, ref, identity.db.sql) : a.roles.some(r => ['admin', 'manager', 'recruiter'].includes(r));
    const keys = new Set(def.fields.filter(f => f.coreKey && fieldVisible(def, f, values, x => fieldAllowed(x, a, mode, salary))).map(f => f.coreKey));
    for (const f of def.fields.filter(f => f.coreKey && !keys.has(f.coreKey))) {
        const path = f.coreKey.split('.'), key = path.pop(), parent = path.reduce((v, k) => v?.[k], out);
        if (parent)
            delete parent[key];
    }
    if (kind === 'resume' && !keys.has('name'))
        delete out.realName;
    return { core: out, keys, full: def.fields.filter(f => f.coreKey).every(f => keys.has(f.coreKey)), definition: projected.definition };
}
export async function assertToolkitWrite(identity, a, kind, core, ref, keys) {
    const projection = await toolkitProjection(identity, a, kind, core, ref);
    const def = await loadDefinition(identity, kind, identity.db.sql, a);
    const salary = ref ? await hasSalaryAccess(identity, a, ref, identity.db.sql) : a.roles.some(r => ['admin', 'manager', 'recruiter'].includes(r));
    for (const key of keys) {
        const f = def.fields.find(f => f.coreKey === key);
        if (!f || !projection.keys.has(key) || !fieldAllowed(f, a, 'write', salary))
            fail(403, 'field_forbidden:' + key);
    }
}
//# sourceMappingURL=access.js.map