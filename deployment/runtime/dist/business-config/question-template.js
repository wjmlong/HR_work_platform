import { z, parse } from '../http/validation.js';
import { fail } from '../http/errors.js';
import { groupedQuestions } from '../materials/question-groups.js';
const id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,99}$/), label = z.string().trim().min(1).max(300), text = z.string().trim().min(1).max(4000);
const applicability = z.object({ families: z.array(label).max(100).default([]), levels: z.array(label).max(100).default([]), rounds: z.array(z.number().int().min(1).max(50)).max(50).default([]) }).strict();
const question = z.object({ id, active: z.boolean().default(true), prompt: text, referencePoints: z.array(text).min(1).max(30), followups: z.array(text).max(20).default([]), skills: z.array(label).max(100).default([]), source: z.string().trim().min(1).max(2000) }).strict();
export const questionDocumentSchema = z.object({ kind: z.literal('questions'), entity: z.literal('job'), key: id, label, description: z.string().max(2000).default(''), mode: z.enum(['prd_compat', 'custom']), applies: applicability.default({ families: [], levels: [], rounds: [] }), weakProbe: z.boolean().default(true), groups: z.array(z.object({ id, label, count: z.number().int().min(1).max(100), order: z.number().int().min(0).max(10000), questions: z.array(question).max(100) }).strict()).min(1).max(30) }).strict();
export const questionPlaceholderKeys = ['candidate.name', 'candidate.skills', 'candidate.education', 'candidate.experienceYears', 'job.name', 'job.skills', 'job.level', 'job.family', 'interview.round'];
const placeholders = (s) => [...s.matchAll(/\{\{([^{}]+)\}\}/g)].map(m => m[1].trim());
export function validateQuestionTemplate(input) { const doc = parse(questionDocumentSchema, input); if (!doc.key.startsWith('questions.'))
    fail(422, 'configuration_key_mismatch'); if (new Set(doc.groups.map(g => g.id)).size !== doc.groups.length)
    fail(422, 'duplicate_question_group'); const ids = doc.groups.flatMap(g => g.questions.map(q => q.id)); if (new Set(ids).size !== ids.length)
    fail(422, 'duplicate_question_id'); if (doc.groups.reduce((sum, g) => sum + g.count, 0) + (doc.weakProbe ? 1 : 0) > 100)
    fail(422, 'question_limit'); for (const g of doc.groups)
    for (const q of g.questions)
        for (const s of [q.prompt, ...q.followups, ...q.referencePoints])
            for (const key of placeholders(s))
                if (!questionPlaceholderKeys.includes(key))
                    fail(422, 'question_placeholder_forbidden'); return doc; }
export function defaultQuestionTemplate() { const rows = groupedQuestions([]), names = [...new Set(rows.map(q => q.group))]; return validateQuestionTemplate({ kind: 'questions', entity: 'job', key: 'questions.prd_default', label: 'PRD 默认六组题库', description: '默认六组 2/2/2/4/3/3 与首个弱项专项；参考答案供人工核对。', mode: 'prd_compat', weakProbe: true, groups: names.map((name, i) => ({ id: 'group.' + i, label: name, count: rows.filter(q => q.group === name).length, order: i, questions: rows.filter(q => q.group === name).map((q, n) => ({ id: 'group.' + i + '.question.' + n, active: true, prompt: q.prompt, referencePoints: q.referencePoints, followups: q.followups, skills: [], source: 'PRD 规则题库 v2' })) })) }); }
function interpolate(s, context) { return s.replace(/\{\{([^{}]+)\}\}/g, (_, key) => { key = key.trim(); if (!Object.hasOwn(context, key))
    fail(403, 'question_placeholder_forbidden'); const value = context[key]; return value === null || value === undefined || value === '' || Array.isArray(value) && !value.length ? '未明确' : Array.isArray(value) ? value.join('、') : String(value); }); }
export function generateTemplateQuestions(input, comparison, context, ref) {
    const t = validateQuestionTemplate(input);
    if (t.mode === 'prd_compat')
        return groupedQuestions(comparison.skills || []);
    for (const [filter, key] of [[t.applies.families, 'job.family'], [t.applies.levels, 'job.level'], [t.applies.rounds, 'interview.round']])
        if (filter.length && !filter.includes(context[key]))
            fail(422, 'question_template_not_applicable');
    const source = (q) => ({ kind: 'question_template', id: q.id, version: ref?.version || 1, ...(ref ? { configId: ref.configId } : {}), sourceText: q.source }), result = [];
    for (const group of [...t.groups].sort((a, b) => a.order - b.order)) {
        const eligible = group.questions.filter(q => q.active && (!q.skills.length || q.skills.some(skill => (comparison.skills || []).some((s) => s.requirement === skill))));
        for (let n = 0; n < group.count; n++) {
            const q = eligible[n], basis = q?.skills.map(skill => (comparison.skills || []).find((s) => s.requirement === skill)).filter(Boolean) || [], groups = (comparison.groups || []).filter((g) => { const contains = (node) => q?.skills.includes(node.skill) || Array.isArray(node.items) && node.items.some(contains); return contains(g); });
            result.push(q ? { id: q.id, questionId: q.id, groupId: group.id, group: group.label, skill: q.skills.join('、') || '岗位通用核对', prompt: interpolate(q.prompt, context), referencePoints: q.referencePoints.map(s => interpolate(s, context)), followups: q.followups.map(s => interpolate(s, context)), source: source(q), coverage: 'human', basis: basis.some((s) => s.status === 'not_matched') ? 'not_matched' : basis.some((s) => s.status === 'unknown') ? 'unknown' : basis.length ? 'matched' : 'not_applicable', evidence: basis.flatMap((s) => s.evidence || []), skillGroups: groups.map((g) => ({ id: g.id, label: g.label, satisfied: g.satisfied })) } : { id: group.id + '.gap.' + n, groupId: group.id, group: group.label, skill: '岗位专业实践', prompt: '当前题库未覆盖本组第 ' + (n + 1) + ' 个问题，请由面试官补充与岗位有关的可验证问题。', referencePoints: ['区分亲历事实与计划', '记录可核对的结果与边界'], followups: ['哪些信息仍需人工确认？'], source: source({ id: group.id + '.gap.' + n, source: '题库覆盖不足的通用核对提示' }), coverage: 'generic', coverageGap: true, basis: 'unknown', evidence: [] });
        }
    }
    if (t.weakProbe) {
        const weak = groupedQuestions(comparison.skills || []).find(q => q.group === '弱项专项');
        if (weak)
            result.push({ ...weak, source: source({ id: 'weak.first_missing', source: '首个未命中技能的通用核对模板' }) });
    }
    return result;
}
//# sourceMappingURL=question-template.js.map