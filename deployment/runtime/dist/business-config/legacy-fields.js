import { BusinessConfigService } from './service.js';
import { loadDefinition } from './fields.js';
import { fieldAllowed } from './access.js';
import { fieldVisible } from './field-validation.js';
import { fail } from '../http/errors.js';
import { maskScreeningContacts } from './screening-mask.js';
export async function legacyDefinition(identity, a, kind) { await new BusinessConfigService(identity).seed(); return loadDefinition(identity, kind, identity.db.sql, a); }
export function legacyKeys(def, a, purpose = 'read') { return new Set(def.fields.filter(f => f.coreKey && f.active && !f.visibleWhen && fieldAllowed(f, a, purpose)).map(f => f.coreKey)); }
export function assertLegacyField(def, a, key, purpose = 'filter') { const f = def.fields.find(f => f.coreKey === key); if (f?.visibleWhen)
    fail(409, 'configured_query_required'); if (f && (!f.active || !fieldAllowed(f, a, purpose === 'export' ? 'export' : 'read') || purpose === 'filter' && !f.searchable || purpose === 'sort' && !f.sortable))
    fail(403, 'field_query_forbidden'); }
export function projectLegacyCore(def, a, core) { const out = structuredClone(core), get = (key) => key.split('.').reduce((v, k) => v?.[k], core), values = Object.fromEntries(def.fields.filter(f => f.coreKey).map(f => [f.fieldId, get(f.coreKey)])); for (const f of def.fields.filter(f => f.coreKey))
    if (!fieldVisible(def, f, values, f => fieldAllowed(f, a, 'read'))) {
        const keys = f.coreKey.split('.'), last = keys.pop(), parent = keys.reduce((v, k) => v?.[k], out);
        if (parent)
            delete parent[last];
    } if (def.entity === 'resume' && !Object.hasOwn(out, 'name'))
    delete out.realName; return def.entity === 'resume' ? maskScreeningContacts(a, out) : out; }
export function profileSearchColumns(def, a, root = 'c.profile') { const allowed = legacyKeys(def, a); return ['name', 'school', 'companies', 'skills', 'phone', 'email'].filter(k => allowed.has(k) && !def.fields.find(f => f.coreKey === k)?.visibleWhen).map(k => `${root}->>'${k}'`); }
export async function leadQueryPermissions(identity, a, q) { const def = await legacyDefinition(identity, a, 'lead'), keys = legacyKeys(def, a); for (const [key, v] of Object.entries(q.filters))
    if (Array.isArray(v) && v.length)
        assertLegacyField(def, a, key === 'contactAvailability' ? 'contact' : key); if (def.fields.filter(f => f.coreKey).every(f => keys.has(f.coreKey)))
    keys.add('raw'); return { def, keys }; }
export function projectLegacyInterview(def, resume, job, a, row) { const core = { ...row, startsAt: row.starts_at, durationMinutes: row.duration_minutes, meetingUrl: row.meeting_url }, out = projectLegacyCore(def, a, core); for (const [camel, snake] of Object.entries({ startsAt: 'starts_at', durationMinutes: 'duration_minutes', meetingUrl: 'meeting_url' })) {
    if (!Object.hasOwn(out, camel))
        delete out[snake];
    delete out[camel];
} if (!legacyKeys(resume, a).has('name'))
    delete out.candidate_name; if (!legacyKeys(job, a).has('name'))
    delete out.job_name; return out; }
export async function assertLegacySource(identity, a, kinds, write = false) { for (const kind of kinds) {
    const def = await legacyDefinition(identity, a, kind);
    if (def.fields.some(f => f.coreKey && (!f.active || f.visibleWhen || !fieldAllowed(f, a, write ? 'write' : 'read'))))
        fail(403, 'source_fields_forbidden');
} }
//# sourceMappingURL=legacy-fields.js.map