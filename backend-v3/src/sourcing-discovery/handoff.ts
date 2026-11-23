import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {extractFile} from '../files/extract.js';
import { createHash } from 'node:crypto';
import type { Actor, Identity } from '../identity/service.js';
import { FileStore } from '../files/storage.js';
import { TaskService } from '../tasks/service.js';
import { fail, found } from '../http/errors.js';
import { DiscoveryPolicy } from './policy.js';
import { signedToken } from './reviews.js';
export interface RecruitingHandoffPort {
    preview(actor: Actor, leadJobId: string): Promise<any>;
    accept(actor: Actor, input: {
        leadJobId: string;
        version: number;
        previewToken: string;
        name: string;
        data: Buffer;
    }): Promise<any>;
    reconcile(actor: Actor, handoffId: string): Promise<any>;
}
export class RecruitingHandoff implements RecruitingHandoffPort {
    readonly policy;
    readonly tasks;
    readonly db;
    constructor(readonly identity: Identity) { this.db = identity.db; this.policy = new DiscoveryPolicy(identity); this.tasks = new TaskService(identity, new FileStore(identity.config.storageRoot)); }
    async preview(a: Actor, id: string) { await this.policy.fields(a); const row = await this.policy.leadJob(a, id, true); if (!row.job_id)
        fail(409, 'job_required'); if (row.do_not_contact)
        fail(409, 'do_not_contact'); if (row.state !== 'resume_received')
        fail(409, 'resume_required'); const job = found((await this.db.query('SELECT id,version,open FROM jobs WHERE id=$1', [row.job_id])).rows[0]); if (!job.open)
        fail(409, 'job_closed'); return { leadJobId: id, leadId: row.lead_id, jobId: row.job_id, version: row.version, previewToken: signedToken(this.identity.config.secret, { id, version: row.version, jobVersion: job.version, userId: a.id }), notice: '接收后复用招聘工作台解析和重复检测；同人冲突需在上传简历页人工处理。' }; }
    async accept(a: Actor, b: {
        leadJobId: string;
        version: number;
        previewToken: string;
        name: string;
        data: Buffer;
    }) { if (b.data.length > 10 * 1024 * 1024)
        fail(413, 'file_too_large'); if(b.name.toLowerCase().endsWith('.pdf')){const dir=await mkdtemp(join(tmpdir(),'sourcing-pdf-'));try{const file=join(dir,'resume.pdf');await writeFile(file,b.data,{mode:0o600});await extractFile(file,'pdf',{maxPages:20}).catch(()=>fail(422,'sourcing_pdf_invalid_or_over_20_pages'));}finally{await rm(dir,{recursive:true,force:true});}}
        return this.db.tx(async (c) => { await c.query('SELECT id FROM discovery_lead_jobs WHERE id=$1 FOR UPDATE', [b.leadJobId]); const p = await this.preview(a, b.leadJobId); if (p.version !== b.version || p.previewToken !== b.previewToken)
        fail(409, 'preview_stale'); const hash = createHash('sha256').update(b.data).digest('hex'); const old = (await c.query('SELECT id FROM discovery_handoffs WHERE lead_job_id=$1 AND file_hash=$2', [b.leadJobId, hash])).rows[0]; if (old)
        return { handoffId: old.id, duplicate: true }; const task = await this.tasks.upload(a, { name: b.name, data: b.data, jobId: p.jobId, source: '人才搜集', note: '来自已人工核验的线索，交接关系 ' + b.leadJobId }); const r = (await c.query('INSERT INTO discovery_handoffs(lead_job_id,upload_task_id,file_hash) VALUES($1,$2,$3) RETURNING id,version', [b.leadJobId, task.id, hash])).rows[0]; await this.identity.audit(c, a.id, 'discovery.handoff.accept', r.id); return { handoffId: r.id, uploadTaskId: task.id, state: 'accepted', version: r.version }; }); }
    async reconcile(a: Actor, id: string) { return this.db.tx(async (c) => { const h = found((await c.query('SELECT * FROM discovery_handoffs WHERE id=$1 FOR UPDATE', [id])).rows[0]); await c.query('SELECT id FROM discovery_lead_jobs WHERE id=$1 FOR UPDATE', [h.lead_job_id]); const j = await this.policy.leadJob(a, h.lead_job_id, true); const task = found((await c.query('SELECT state,result FROM tasks WHERE id=$1', [h.upload_task_id])).rows[0]); let state = ['failed', 'cancelled'].includes(task.state) ? 'failed' : task.state.startsWith('awaiting_') ? 'needs_review' : 'processing'; let links: any = {}; if (task.state === 'succeeded' && task.result?.applicationId) {
        const r = found((await c.query('SELECT id,candidate_id,resume_version_id,job_id FROM applications WHERE id=$1 AND deleted_at IS NULL', [task.result.applicationId])).rows[0]);
        await this.identity.applicationAccess(a, r.id, false, c);
        if (r.job_id !== j.job_id || j.candidate_id && j.candidate_id !== r.candidate_id)
            fail(409, 'handoff_identity_conflict');
        links = { candidateId: r.candidate_id, applicationId: r.id, resumeVersionId: r.resume_version_id };
        state = 'linked';
        await c.query('UPDATE discovery_lead_jobs SET candidate_id=$2,application_id=$3,resume_version_id=$4 WHERE id=$1', [j.id, r.candidate_id, r.id, r.resume_version_id]);
    } await c.query('UPDATE discovery_handoffs SET state=$2 WHERE id=$1', [id, state]); return { handoffId: id, leadId: j.lead_id, jobId: j.job_id, uploadTaskId: h.upload_task_id, state, version: h.version, candidateId: null, applicationId: null, resumeVersionId: null, ...links }; }); }
    async confirm(a: Actor, id: string, version: number) { return this.db.tx(async (c) => { const h = found((await c.query('SELECT * FROM discovery_handoffs WHERE id=$1 FOR UPDATE', [id])).rows[0]); await c.query('SELECT id FROM discovery_lead_jobs WHERE id=$1 FOR UPDATE', [h.lead_job_id]); const j = await this.policy.leadJob(a, h.lead_job_id, true); if (h.version !== version)
        fail(409, 'version_conflict'); if (j.do_not_contact)
        fail(409, 'do_not_contact'); if (j.state !== 'resume_received')
        fail(409, 'lead_transition_invalid'); await c.query("UPDATE discovery_lead_jobs SET state='uploaded',version=version+1 WHERE id=$1", [j.id]); await c.query('UPDATE discovery_handoffs SET confirmed_at=now(),version=version+1 WHERE id=$1', [id]); await this.identity.audit(c, a.id, 'discovery.handoff.confirm', id); return { handoffId: id, version: version + 1 }; }); }
}
