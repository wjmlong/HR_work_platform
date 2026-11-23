import { fail } from '../http/errors.js';
import { parseMoney, compareAmounts } from './money.js';
export const empty = (v) => v === null || v === undefined || v === '' || Array.isArray(v) && v.length === 0;
const calendarDate = (v) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || v.startsWith('0000-'))
        return false;
    const date = new Date(v + 'T00:00:00.000Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === v;
};
export function conditionMatches(c, values, available = () => true) {
    if (!c)
        return true;
    if ('rules' in c)
        return c.mode === 'all' ? c.rules.every(r => conditionMatches(r, values, available)) : c.rules.some(r => conditionMatches(r, values, available));
    if (!available(c.fieldId))
        return false;
    const value = values[c.fieldId];
    if (c.op === 'empty')
        return empty(value);
    if (c.op === 'not_empty')
        return !empty(value);
    if (c.op === 'eq')
        return value === c.value;
    if (c.op === 'contains')
        return Array.isArray(value) ? value.includes(c.value) : typeof value === 'string' && typeof c.value === 'string' && value.includes(c.value);
    if (c.op === 'range' && Array.isArray(c.value) && c.value.length === 2 && !empty(value)) {
        const [min, max] = c.value;
        return typeof value === 'number' && typeof min === 'number' && typeof max === 'number' ? value >= min && value <= max : typeof value === 'string' && typeof min === 'string' && typeof max === 'string' && value >= min && value <= max;
    }
    return false;
}
export function fieldVisible(def, f, values, allowed = () => true, visiting = new Set()) {
    if (!f.active || !allowed(f) || visiting.has(f.fieldId))
        return false;
    const path = new Set(visiting).add(f.fieldId);
    return conditionMatches(f.visibleWhen, values, id => { const dependency = def.fields.find(f => f.fieldId === id); return !!dependency && fieldVisible(def, dependency, values, allowed, path); });
}
export function validateValue(f, value, previous) {
    if (empty(value))
        return null;
    const error = () => fail(422, 'field_invalid:' + f.fieldId);
    switch (f.type) {
        case 'text':
        case 'longtext':
            if (typeof value !== 'string' || value.includes('\0') || value.length > (f.constraints.maxLength ?? (f.type === 'text' ? 2000 : 10000)))
                return error();
            return value;
        case 'number': {
            if (typeof value !== 'number' || !Number.isFinite(value) || f.constraints.min !== undefined && value < f.constraints.min || f.constraints.max !== undefined && value > f.constraints.max)
                return error();
            if (f.constraints.precision !== undefined) {
                const [coefficient, exponent = '0'] = String(value).toLowerCase().split('e');
                if (Math.max(0, (coefficient.split('.')[1]?.length || 0) - Number(exponent)) > f.constraints.precision)
                    return error();
            }
            return value;
        }
        case 'boolean':
            if (typeof value !== 'boolean')
                return error();
            return value;
        case 'date': {
            if (typeof value !== 'string' || !calendarDate(value))
                return error();
            return value;
        }
        case 'datetime': {
            if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value))
                return error();
            if (!calendarDate(value.slice(0, 10)) || Number(value.slice(11, 13)) > 23)
                return error();
            const date = new Date(value);
            if (!Number.isFinite(date.getTime()))
                return error();
            return date.toISOString();
        }
        case 'select':
        case 'multiselect': {
            const values = f.type === 'select' ? [value] : value;
            if (!Array.isArray(values) || values.length > 100 || values.some(v => typeof v !== 'string' || !v || v.length > 300))
                return error();
            const old = new Set(Array.isArray(previous) ? previous : [previous]);
            if (f.options.length && !(f.coreKey && ['skills', 'requirements.skills', 'requirements.schoolPreferences'].includes(f.coreKey))) {
                if (values.some(v => !f.options.some(o => o.id === v && (o.active || old.has(v))) && !(f.coreKey && old.has(v))))
                    return error();
            }
            else if (!f.coreKey)
                return error();
            return f.type === 'select' ? value : [...new Set(values)];
        }
        case 'money':
        case 'money_range': {
            const m = parseMoney(value);
            if (f.type === 'money' && m.max !== null && m.max !== m.min)
                return error();
            if ([m.min, m.max].some(v => v !== null && (f.constraints.min !== undefined && compareAmounts(v, String(f.constraints.min)) < 0 || f.constraints.max !== undefined && compareAmounts(v, String(f.constraints.max)) > 0)))
                return error();
            return m;
        }
    }
}
export function validateFieldValues(def, input, previous, mode, visibilityDefinition = def) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        fail(422, 'field_map_invalid');
    const fields = new Map(def.fields.map(f => [f.fieldId, f]));
    for (const id of Object.keys(input))
        if (!fields.has(id))
            fail(422, 'field_unknown:' + id);
    const result = { ...previous };
    for (const f of def.fields) {
        const present = Object.hasOwn(input, f.fieldId);
        if (!present && mode === 'create' && f.defaultValue !== undefined)
            result[f.fieldId] = validateValue(f, f.defaultValue, undefined);
        else if (present) {
            if (!f.active && JSON.stringify(input[f.fieldId]) !== JSON.stringify(previous[f.fieldId]))
                fail(422, 'field_inactive:' + f.fieldId);
            const value = validateValue(f, input[f.fieldId], previous[f.fieldId]);
            if (value === null)
                delete result[f.fieldId];
            else
                result[f.fieldId] = value;
        }
    }
    for (const f of def.fields) {
        if (!f.active)
            continue;
        const available = (id) => { const dependency = visibilityDefinition.fields.find(f => f.fieldId === id); return !!dependency && fieldVisible(visibilityDefinition, dependency, result); };
        const visible = fieldVisible(visibilityDefinition, f, result), required = f.required || !!f.requiredWhen && conditionMatches(f.requiredWhen, result, available);
        if (!visible) {
            if (Object.hasOwn(input, f.fieldId) && JSON.stringify(result[f.fieldId]) !== JSON.stringify(previous[f.fieldId]))
                fail(422, 'field_hidden:' + f.fieldId);
            continue;
        }
        const value = result[f.fieldId], missing = empty(value) || ['money', 'money_range'].includes(f.type) && !!value && value.min === null && value.max === null;
        if (mode !== 'draft' && required && missing)
            fail(422, 'field_required:' + f.fieldId);
    }
    return result;
}
//# sourceMappingURL=field-validation.js.map