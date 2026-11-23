import { InterviewService } from '../interviews/service.js';
import { coreValues, getPath } from './object-fields.js';
import { fail } from '../http/errors.js';
import { assertObjectAccess, fieldAllowed, hasSalaryAccess } from './access.js';
import { loadDefinition, currentValues } from './fields.js';
import { storedCoreValues } from './core-values.js';
import { fieldVisible } from './field-validation.js';
import { csvDocument } from '../http/csv.js';
// Deactivation removes current input; the current ACL still controls saved
// history. A disabled target can be read, but unavailable dependencies cannot.
export function historyAllowed(def, f, a, values, salary, mode = 'read') {
    return fieldVisible(def, { ...f, active: true }, values, f => fieldAllowed(f, a, mode, salary));
}
export function historyField(f) { return { fieldId: f.fieldId, coreKey: f.coreKey, label: f.label, type: f.type, unit: f.unit, options: f.options }; }
export async function fieldHistory(identity, a, ref, mode = 'read') {
    if (ref.kind === 'evaluation')
        return identity.db.tx(async (c) => {
            // Evaluation history has its own author/editor/submission visibility. Reading
            // raw EAV history would expose private drafts once the shared header submits.
            const versions = await new InterviewService(identity).evaluationVersions(a, ref.id);
            if (!versions.length)
                fail(403, 'forbidden');
            const def = await loadDefinition(identity, ref.kind, c, a), salary = await hasSalaryAccess(identity, a, ref, c), latest = versions.at(-1), values = { ...coreValues(def, latest.data), ...latest.configuration_refs?.values }, items = [];
            for (const v of versions) {
                const snapshot = v.configuration_refs || {}, saved = snapshot.fieldSnapshot || (snapshot.fields ? (await c.query('SELECT document FROM business_config_versions WHERE config_id=$1 AND version=$2', [snapshot.fields.configId, snapshot.fields.version])).rows[0]?.document?.fields : null);
                if (!saved || !snapshot.values)
                    continue;
                for (const f of saved) {
                    const current = def.fields.find(p => p.fieldId === f.fieldId);
                    if (!current || !historyAllowed(def, current, a, values, salary, mode))
                        continue;
                    const value = f.coreKey ? getPath(v.data, f.coreKey) : snapshot.values[f.fieldId];
                    items.push({ id: v.evaluation_id + ':' + v.version + ':' + f.fieldId, version: v.version, versionKind: 'evaluation', definition: snapshot.fields, field: historyField(f), value: value ?? null, absent: value === undefined, source: { kind: 'evaluation_version', status: v.status }, actorId: v.editor_id, at: v.at, optionLabelsRecorded: !!snapshot.fieldSnapshot || !f.dictionaryKey });
                }
            }
            return { object: ref, items, notice: '评估字段按有权查看的草稿/提交版本展示，记录版本为评估版本；未保存的旧定义或来源不推定补齐。' };
        });
    return identity.db.tx(async (c) => {
        await assertObjectAccess(identity, a, ref, 'read', c);
        const def = await loadDefinition(identity, ref.kind, c, a), salary = await hasSalaryAccess(identity, a, ref, c), values = { ...await storedCoreValues(c, ref, def), ...await currentValues(ref, c) };
        const rows = (await c.query('SELECT h.*,v.document FROM custom_field_value_versions h JOIN business_config_versions v ON v.config_id=h.config_id AND v.version=h.definition_version WHERE h.object_kind=$1 AND h.object_id=$2 ORDER BY h.created_at,h.field_id,h.version', [ref.kind, ref.id])).rows;
        const items = rows.flatMap(r => { const current = def.fields.find(f => f.fieldId === r.field_id); if (!current || !historyAllowed(def, current, a, values, salary, mode))
            return []; const saved = r.source?.fieldDefinition || r.document.fields?.find((f) => f.fieldId === r.field_id); if (!saved)
            return []; const { fieldDefinition: _, ...source } = r.source || {}; return [{ id: r.id, version: r.version, definition: { configId: r.config_id, version: r.definition_version }, field: historyField(saved), value: r.value, source, actorId: r.actor_id, at: r.created_at, optionLabelsRecorded: !!r.source?.fieldDefinition || !saved.dictionaryKey }]; });
        return { object: ref, items, notice: '仅展示已保存的字段版本；未保存的旧核心操作、当时选项名称或来源不推定补齐。' };
    });
}
export async function exportFieldHistory(identity, a, ref) { const result = await fieldHistory(identity, a, ref, 'export'); await identity.audit(identity.db.sql, a.id, 'business_fields.history_export', ref.id, { kind: ref.kind, count: result.items.length }); return csvDocument([['记录ID', '字段ID', '当时字段名称', '值（保留金额口径）', '字段版本', '定义版本', '操作者ID', '时间', '来源', '当时选项名称已记录'], ...result.items.map(r => [ref.id, r.field.fieldId, r.field.label, JSON.stringify(r.value), r.version, r.definition.version, r.actorId, new Date(r.at).toISOString(), JSON.stringify(r.source), r.optionLabelsRecorded ? '是' : '未记录'])]); }
//# sourceMappingURL=history.js.map