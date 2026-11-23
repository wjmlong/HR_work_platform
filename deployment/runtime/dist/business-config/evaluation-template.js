import { z, parse } from '../http/validation.js';
import { fail } from '../http/errors.js';
import { dimensions, dimensionNames, validScore, mergeEvaluation } from '../interviews/scores.js';
const id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,99}$/), label = z.string().trim().min(1).max(300);
export const evaluationDocumentSchema = z.object({ kind: z.literal('evaluation'), entity: z.literal('evaluation'), key: id, label, description: z.string().max(2000).default(''), mode: z.enum(['prd_compat', 'custom']), dimensions: z.array(z.object({ id, label, description: z.string().max(2000).default(''), active: z.boolean().default(true), required: z.boolean().default(false), order: z.number().int().min(0).max(10000), anchors: z.array(z.object({ score: z.number().min(1).max(5).refine(validScore), label }).strict()).max(9).default([]) }).strict()).min(1).max(50) }).strict();
export function validateEvaluationTemplate(input) { const t = parse(evaluationDocumentSchema, input); if (!t.key.startsWith('evaluation.'))
    fail(422, 'configuration_key_mismatch'); if (new Set(t.dimensions.map(d => d.id)).size !== t.dimensions.length)
    fail(422, 'duplicate_evaluation_dimension'); if (!t.dimensions.some(d => d.active))
    fail(422, 'evaluation_dimension_required'); for (const d of t.dimensions) {
    if (/^(?:age|gender|sex|salary|expectedSalary|expectedCompensation)$/i.test(d.id) || /^(?:年龄|性别|薪资|期望薪资|期望年包)$/.test(d.label))
        fail(422, 'evaluation_dimension_forbidden');
    if (!d.active && d.required)
        fail(422, 'inactive_dimension_required');
    if (new Set(d.anchors.map(a => a.score)).size !== d.anchors.length)
        fail(422, 'duplicate_evaluation_anchor');
} return t; }
export function defaultEvaluationTemplate() { return validateEvaluationTemplate({ kind: 'evaluation', entity: 'evaluation', key: 'evaluation.prd_default', label: 'PRD 默认四维评估', mode: 'prd_compat', description: '1–5 分、0.5 步长；人工评分，供训练与口径对齐。', dimensions: dimensions.map((id, order) => ({ id, label: dimensionNames[id], active: true, required: false, order, anchors: [{ score: 1, label: '证据不足，需要核对' }, { score: 3, label: '达到本次核对的基本要求' }, { score: 5, label: '证据充分，边界与结果清晰' }] })) }); }
export function defaultComparable(template) { return template.mode === 'prd_compat' && template.key === 'evaluation.prd_default' && JSON.stringify(template.dimensions.filter(d => d.active).map(d => d.id).sort()) === JSON.stringify([...dimensions].sort()); }
export function templateScores(template, data) { return Object.fromEntries(template.dimensions.filter(d => d.active).flatMap(d => { const value = data?.scores && Object.hasOwn(data.scores, d.id) ? data.scores[d.id] : data?.[d.id]; return validScore(value) ? [[d.id, value]] : []; })); }
export function cleanTemplateEvaluation(template, input, mode) { const out = { ...input }, scores = templateScores(template, input); delete out.scores; for (const field of [...dimensions, 'overallScore', 'problemSolving'])
    delete out[field]; if (defaultComparable(template)) {
    for (const field of [...dimensions, 'overallScore', 'problemSolving']) {
        const value = scores[field] ?? input[field];
        if (validScore(value))
            out[field] = value;
    }
}
else
    out.scores = scores; for (const d of template.dimensions.filter(d => d.active && d.required))
    if (mode === 'submitted' && !validScore(scores[d.id]))
        fail(422, 'evaluation_score_required:' + d.id); return out; }
export function mergeTemplateEvaluation(template, previous, input, provided, mode) {
    if (defaultComparable(template)) {
        const active = new Set(template.dimensions.filter(d => d.active).map(d => d.id)), selected = Object.fromEntries(Object.entries(input.scores || {}).filter(([key]) => active.has(key))), next = { ...input, ...selected };
        delete next.scores;
        return cleanTemplateEvaluation(template, mergeEvaluation(previous, next, [...new Set([...provided.filter(k => k !== 'scores'), ...Object.keys(selected)])]), mode);
    }
    const out = { ...previous, ...Object.fromEntries(Object.entries(input).filter(([k]) => k !== 'scores' && ![...dimensions, 'overallScore', 'problemSolving'].includes(k))) }, scores = templateScores(template, previous);
    for (const [key, value] of Object.entries(input.scores || {})) {
        if (!template.dimensions.some(d => d.active && d.id === key))
            continue;
        if (validScore(value))
            scores[key] = value;
        else if (value === null || value === '')
            delete scores[key];
    }
    return cleanTemplateEvaluation(template, { ...out, scores }, mode);
}
export function comparableEvaluationKey(template) { return `${template.ref?.configId || template.key}@${template.ref?.version || 'legacy'}:${template.dimensions.filter(d => d.active).map(d => d.id).sort().join(',')}`; }
export function evaluationBasis(configurationRefs) { const saved = configurationRefs?.evaluationTemplate; if (!saved)
    return { template: defaultEvaluationTemplate(), legacy: true, defaultComparable: true }; try {
    const template = { ...validateEvaluationTemplate(saved.document), ref: saved.ref };
    return { template, legacy: false, defaultComparable: defaultComparable(template) };
}
catch {
    return null;
} }
export function aggregateEvaluationCohorts(records) { const cohorts = new Map(); for (const r of records) {
    const basis = evaluationBasis(r.configuration_refs);
    if (!basis)
        continue;
    const t = basis.template, key = comparableEvaluationKey(t), cohort = cohorts.get(key) || { key, templateRef: t.ref || null, label: t.label, defaultComparable: basis.defaultComparable, legacy: basis.legacy, dimensions: t.dimensions.filter(d => d.active).toSorted((a, b) => a.order - b.order).map(d => ({ id: d.id, label: d.label })), completed: 0, scoredSessions: 0, values: Object.fromEntries(t.dimensions.filter(d => d.active).map(d => [d.id, []])) };
    cohort.completed++;
    const scores = templateScores(t, r.data);
    if (Object.keys(scores).length)
        cohort.scoredSessions++;
    for (const [id, value] of Object.entries(scores))
        cohort.values[id].push(value);
    cohorts.set(key, cohort);
} return [...cohorts.values()].map(({ values, ...c }) => ({ ...c, dimensionAverages: Object.fromEntries(Object.entries(values).map(([id, v]) => [id, v.length ? v.reduce((n, x) => n + x, 0) / v.length : null])), dimensionSamples: Object.fromEntries(Object.entries(values).map(([id, v]) => [id, v.length])) })); }
// Service code loads after the pure configuration schema has initialized.
export class EvaluationTemplates {
    identity;
    constructor(identity) {
        this.identity = identity;
    }
    async previewEvaluationUpgrade(a, interviewId, target, forPrimary = false) { const { EvaluationUpgradeService } = await import('./evaluation-versions.js'); return new EvaluationUpgradeService(this.identity).preview(a, interviewId, target, forPrimary); }
    async adoptEvaluationUpgrade(a, input) { const { EvaluationUpgradeService } = await import('./evaluation-versions.js'); return new EvaluationUpgradeService(this.identity).adopt(a, input); }
}
//# sourceMappingURL=evaluation-template.js.map