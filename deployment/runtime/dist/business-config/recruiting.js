import { requireRole } from '../identity/service.js';
import { RecruitingService } from '../recruiting/service.js';
import { Jobs } from '../recruiting/jobs.js';
import { TaskService } from '../tasks/service.js';
import { FileStore } from '../files/storage.js';
import { jobInput, jobPatch, applyInput, profileInput } from '../recruiting/schema.js';
import { candidateEditRequest } from '../recruiting/service.js';
import { parse, z, version } from '../http/validation.js';
import { fail, found } from '../http/errors.js';
import { stripMetadata, prepareObjectWrite, finishObjectWrite, projectCore } from './object-fields.js';
export const configuredProperties = { definitionVersion: z.number().int().positive().optional(), definitionRevision: z.string().max(100).optional(), customFields: z.record(z.string().max(100), z.unknown()).optional() };
export const applicationFieldsRequest = z.object({ version, source: z.string().min(1).max(300).optional(), ...configuredProperties }).strict();
export const jobCore = (row) => ({ ...row, salaryRange: row.salary_range, marketSalary: row.market_salary, marketSource: row.market_source, salaryNote: row.salary_note, marketReferenceDate: row.market_reference_date });
export class ConfiguredRecruiting {
    identity;
    r;
    tasks;
    constructor(identity) {
        this.identity = identity;
        this.r = new RecruitingService(identity);
        this.tasks = new TaskService(identity, new FileStore(identity.config.storageRoot));
    }
    async projectJob(a, id) {
        const row = found((await new Jobs(this.identity).list(a)).find(r => r.id === id)), p = await projectCore(this.identity, a, 'job', jobCore(row), { kind: 'job', id }), out = { ...p.core, customFields: p.customFields, definition: p.definition };
        if (!Object.hasOwn(out.requirements || {}, 'skills'))
            delete out.hard_skills;
        for (const [camel, snake] of Object.entries({ salaryRange: 'salary_range', marketSalary: 'market_salary', marketSource: 'market_source', salaryNote: 'salary_note', marketReferenceDate: 'market_reference_date' })) {
            if (Object.hasOwn(out, camel))
                out[snake] = out[camel];
            else
                delete out[snake];
            delete out[camel];
        }
        return out;
    }
    async publicJob(a, id) { const r = await this.projectJob(a, id); return { id: r.id, name: r.name, department: r.department, skills: r.requirements?.skills || [], experienceYears: r.requirements?.experienceYears ?? null, experienceMaxYears: r.requirements?.experienceMaxYears ?? null, education: r.requirements?.education ?? null, description: r.requirements?.description || '' }; }
    async jobs(a) { return Promise.all((await this.r.jobs(a)).map(row => this.projectJob(a, row.id))); }
    async job(a, id, input) {
        return this.identity.db.tx(async () => {
            requireRole(a, 'admin', 'manager', 'recruiter');
            const bare = stripMetadata(input), old = id ? found((await this.r.jobs(a)).find(r => r.id === id)) : null;
            const parsed = id ? parse(jobPatch, { ...bare, ...(bare.requirements ? { requirements: { ...old.requirements, ...bare.requirements } } : {}) }) : parse(jobInput, bare), next = id ? { ...jobCore(old), ...parsed, requirements: parsed.requirements ?? old.requirements } : parsed;
            const p = await prepareObjectWrite(this.identity, a, 'job', id ? { kind: 'job', id } : null, input, next, old ? jobCore(old) : {}, id ? 'edit' : 'create');
            const market = p.write.customFields['builtin.job.marketCompensation'];
            if ((market?.min != null || market?.max != null) && !p.core.marketSource?.trim())
                fail(422, 'market_source_required');
            const body = Object.fromEntries(Object.entries(p.core).filter(([k]) => Object.hasOwn(parsed, k)));
            const saved = id ? await this.r.updateJob(a, id, body) : await this.r.createJob(a, body);
            await finishObjectWrite(this.identity, a, { kind: 'job', id: saved.id }, p);
            await this.identity.db.query('UPDATE job_versions SET configuration_refs=configuration_refs||$3::jsonb WHERE job_id=$1 AND version=$2', [saved.id, saved.version, { fields: p.def.ref }]);
            return this.projectJob(a, saved.id);
        });
    }
    async correct(a, id, input) {
        return this.identity.db.tx(async () => {
            const old = await this.tasks.raw(a, id), next = { ...old.profile, ...input.corrections };
            const p = await prepareObjectWrite(this.identity, a, 'resume', { kind: 'resume', id }, { ...input, ...input.corrections }, next, old.profile);
            const saved = await this.tasks.correctResume(a, id, { ...input, customFields: p.write.customFields });
            await this.identity.db.query('UPDATE resume_versions SET configuration_refs=$2 WHERE id=$1', [saved.resumeVersionId, { fields: p.def.ref }]);
            return saved;
        });
    }
    async projectApplication(a, id) { const row = await this.r.application(a, id), p = await projectCore(this.identity, a, 'application', row, { kind: 'application', id }), profile = await projectCore(this.identity, a, 'resume', row.profile, row.resume_version_id ? { kind: 'resume', id: row.resume_version_id } : undefined); return { ...p.core, profile: profile.core, customFields: p.customFields, resumeFields: profile.customFields, definition: p.definition }; }
    async application(a, id, input) {
        return this.identity.db.tx(async (c) => {
            const b = parse(applicationFieldsRequest, input), old = await this.identity.applicationAccess(a, id, true, c);
            const locked = found((await c.query('SELECT * FROM applications WHERE id=$1 FOR UPDATE', [id])).rows[0]);
            if (locked.version !== b.version)
                fail(409, 'version_conflict');
            const p = await prepareObjectWrite(this.identity, a, 'application', { kind: 'application', id }, b, { ...locked, source: b.source ?? locked.source }, locked);
            await c.query('UPDATE applications SET source=$2,version=version+1,updated_at=now() WHERE id=$1', [id, p.core.source]);
            await finishObjectWrite(this.identity, a, { kind: 'application', id }, p);
            return this.projectApplication(a, id);
        });
    }
    async apply(a, input) { return this.identity.db.tx(async () => { const b = parse(applyInput, stripMetadata(input)), p = await prepareObjectWrite(this.identity, a, 'application', null, input, b, {}, 'create'), row = await this.r.apply(a, p.core); await finishObjectWrite(this.identity, a, { kind: 'application', id: row.id }, p); return this.projectApplication(a, row.id); }); }
    // Personnel profile notes are a separate fact history; no typed resume values are propagated here.
    async person(a, id) { const row = await this.r.candidate(a, id), p = await projectCore(this.identity, a, 'resume', row.profile); return { ...row, applications: await Promise.all(row.applications.map(async (app) => (await projectCore(this.identity, a, 'application', app, { kind: 'application', id: app.id })).core)), profile: p.core, history: await Promise.all(row.history.map(async (h) => ({ ...h, profile: (await projectCore(this.identity, a, 'resume', h.profile)).core }))) }; }
    async candidate(a, id, input) {
        return this.identity.db.tx(async () => {
            const old = id ? await this.r.candidate(a, id) : null, b = id ? parse(candidateEditRequest, { ...stripMetadata(input), profile: { ...old.profile, ...input.profile } }) : parse(profileInput, stripMetadata(input)), next = id ? b.profile : b;
            if (Object.keys(input.customFields || {}).length)
                fail(422, 'resume_revision_required');
            const p = await prepareObjectWrite(this.identity, a, 'resume', null, { ...input, ...(id ? input.profile : stripMetadata(input)) }, next, old?.profile || {}, id ? 'edit' : 'create', true);
            const row = id ? await this.r.editCandidate(a, id, { version: b.version, profile: p.core }) : await this.r.createCandidate(a, p.core);
            await this.identity.db.query('UPDATE candidate_profile_versions SET configuration_refs=$3 WHERE candidate_id=$1 AND version=$2', [row.id, row.version, { fields: p.def.ref }]);
            return this.person(a, row.id);
        });
    }
}
//# sourceMappingURL=recruiting.js.map