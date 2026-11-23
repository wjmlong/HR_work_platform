import { BusinessDictionaryService, validateOption } from '../business-config/dictionaries.js';
import { requireRole } from '../identity/service.js';
import { z, parse, version } from '../http/validation.js';
import { found, fail } from '../http/errors.js';
import { legacyDefinition, legacyKeys } from '../business-config/legacy-fields.js';
import { generateTemplateQuestions } from '../business-config/question-template.js';
import { resolveJobTemplate, loadTemplate } from '../business-config/selections.js';
import { questionGenerationRequest } from './service.js';
import { generateModelQuestions } from './model.js';
export const bankRequest = questionGenerationRequest.extend({ provider: z.enum(['rules', 'model']).default('rules') });
import { randomUUID } from 'node:crypto';
export const learningQuestion = z.object({ version, prompt: z.string().trim().min(5).max(4000), points: z.array(z.string().trim().min(1).max(1000)).min(1).max(20), source: z.string().trim().min(5).max(1000) }).strict();
export class JobQuestions {
    identity;
    constructor(identity) {
        this.identity = identity;
    }
    async access(a) { requireRole(a, 'admin', 'manager', 'recruiter'); const keys = legacyKeys(await legacyDefinition(this.identity, a, 'job'), a); if (!['name', 'level', 'requirements.skills'].every(k => keys.has(k)))
        fail(403, 'material_source_forbidden'); }
    async get(a, id) { await this.access(a); return found((await this.identity.db.query('SELECT id,name,requirements_version,question_bank FROM jobs WHERE id=$1', [id])).rows[0]); }
    async generate(a, id, input) {
        await this.access(a);
        const b = parse(bankRequest, input);
        if (b.family)
            validateOption((await new BusinessDictionaryService(this.identity).dictionary(a, 'job_families')).options, b.family);
        const snapshot = found((await this.identity.db.query('SELECT j.name,j.level,j.version,j.requirements_version,v.requirements FROM jobs j JOIN job_versions v ON v.job_id=j.id AND v.version=j.requirements_version WHERE j.id=$1', [id])).rows[0]);
        if (b.provider === 'model') {
            const binding = await resolveJobTemplate(this.identity, this.identity.db.sql, id, 'questions'), template = await loadTemplate(this.identity, 'questions', binding.templateRef);
            generateTemplateQuestions(template.document, { skills: (snapshot.requirements.skills || []).map((requirement) => ({ requirement, status: 'unknown', evidence: [] })) }, { 'job.name': snapshot.name, 'job.level': snapshot.level, 'job.skills': snapshot.requirements.skills, 'job.family': b.family ?? null, 'interview.round': b.round ?? null }, binding.templateRef);
            await this.identity.limit('model.questions:' + a.id, 20);
        }
        const ai = b.provider === 'model' ? await generateModelQuestions(this.identity.config, { name: snapshot.name, skills: snapshot.requirements.skills || [], family: b.family, round: b.round }) : null;
        return this.identity.db.tx(async (c) => {
            const job = found((await c.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE', [id])).rows[0]), requirements = found((await c.query('SELECT requirements FROM job_versions WHERE job_id=$1 AND version=$2', [id, job.requirements_version])).rows[0]).requirements, binding = await resolveJobTemplate(this.identity, c, id, 'questions'), doc = (await loadTemplate(this.identity, 'questions', binding.templateRef, c)).document;
            if (job.version !== snapshot.version || job.requirements_version !== snapshot.requirements_version)
                fail(409, 'version_conflict');
            const context = { 'job.name': job.name, 'job.level': job.level, 'job.skills': requirements.skills, 'job.family': b.family ?? null, 'interview.round': b.round ?? null, 'candidate.name': null, 'candidate.skills': null, 'candidate.education': null, 'candidate.experienceYears': null };
            const generated = generateTemplateQuestions(doc, { skills: (requirements.skills || []).map((requirement) => ({ requirement, status: 'unknown', evidence: [] })) }, context, binding.templateRef);
            const star = [['S · 情境', '请描述一个与该岗位相关的真实项目，当时的业务背景与约束是什么？', '交代背景、规模和约束，不泄露前雇主机密'], ['T · 任务', '你个人承担什么目标与责任，如何定义成功？', '区分团队目标与个人责任，给出衡量指标'], ['A · 行动', '你具体采取了哪些行动，为什么选择这一方案？', '讲清关键取舍、本人贡献和验证步骤'], ['R · 结果', '最终结果如何，有哪些可核对的指标和复盘改进？', '核对结果口径、失败经验及可迁移能力']].map(([group, prompt, point], i) => ({ id: 'star.' + i, group, prompt, referencePoints: [point], followups: [], source: { kind: 'rule_catalog', id: 'star', version: 1 } }));
            const old = job.question_bank || { version: 0, history: [], learned: [] }, bank = { version: old.version + 1, jobVersion: job.requirements_version, provider: b.provider, model: ai?.provenance ?? null, templateRef: binding.templateRef, context: b, questions: [...(!ai && generated.filter(q => /STAR/.test(q.group || '')).length >= 4 ? [] : star), ...(ai ? ai.questions : generated)], learned: old.learned || [], history: [...(old.history || []), ...(old.version ? [{ ...old, history: undefined }] : [])].slice(-30), createdAt: new Date().toISOString(), actorId: a.id };
            await c.query('UPDATE jobs SET question_bank=$2 WHERE id=$1', [id, bank]);
            await this.identity.audit(c, a.id, 'job.questions_generate', id, { version: bank.version, jobVersion: bank.jobVersion, provider: bank.provider, model: bank.model });
            return bank;
        });
    }
    async learn(a, id, input) { await this.access(a); const b = parse(learningQuestion, input); return this.identity.db.tx(async (c) => { const row = found((await c.query('SELECT question_bank FROM jobs WHERE id=$1 FOR UPDATE', [id])).rows[0]), old = row.question_bank; if (!old || old.version !== b.version)
        fail(409, 'version_conflict'); if ((old.learned || []).length >= 100)
        fail(422, 'question_bank_full'); const next = { ...old, version: old.version + 1, learned: [...(old.learned || []), { id: 'human:' + randomUUID(), group: '实际面试沉淀', prompt: b.prompt, referencePoints: b.points, followups: [], source: { kind: 'human', sourceText: b.source, authorId: a.id, version: 1 }, actorId: a.id, createdAt: new Date().toISOString() }], history: [...(old.history || []), { ...old, history: undefined }].slice(-30) }; await c.query('UPDATE jobs SET question_bank=$2 WHERE id=$1', [id, next]); await this.identity.audit(c, a.id, 'job.questions_learn', id, { version: next.version }); return next; }); }
}
//# sourceMappingURL=job-questions.js.map