import {candidateLifecycleSql, activeCandidateSql, terminalStates} from './lifecycle.js';
import {inboxMatchesFor,assertInboxAdoption} from './inbox-matching.js';
import {ccForTransition} from './cc.js';
import {ChecklistService} from './checklists.js';
import {queueMatch,lockMatchingCandidateJobs} from '../business-config/bindings.js';
import {legacyDefinition,profileSearchColumns,projectLegacyCore} from '../business-config/legacy-fields.js';
import {maskScreeningContacts} from '../business-config/screening-mask.js';
import { applicationQueryInput, readApplications } from "./query.js";
import type { Sql } from "../db.js";
import { Identity, requireRole, type Actor } from "../identity/service.js";
import { parse, z, uuid, version } from "../http/validation.js";
import { fail, found } from "../http/errors.js";
import { Dictionary } from "../dictionary/service.js";
import {BusinessDictionaryService,validateOption} from '../business-config/dictionaries.js';
import { profileInput, applyInput, transitionInput, stage } from "./schema.js";
import { ALGORITHM } from "../parsing/match.js";
import { Jobs } from "./jobs.js";
import { carryStage, ccRecord, gateTransition, stageCC } from "./workflow.js";
const writers = ["admin", "manager", "recruiter"] as const;
const offerNodes=['编制确认','薪资审批','背调完成','offer 审批'];
function verifiedOfferGates(row:any){
 const gates=row.configuration_refs?.toolkit?.offerGates||{};
 if(!offerNodes.every(key=>gates[key]===true))fail(422,'offer_nodes_incomplete');
 return Object.fromEntries(offerNodes.map(key=>[key,true]));
}
// All entry paths must validate the same target-stage business requirements.
async function stageBusinessGates(c:Sql,row:any,to:string){
 if(to==='interviewing'){
  const person=found((await c.query("SELECT profile->>'name' AS name,profile->>'realName' AS real_name FROM candidates WHERE id=$1 AND deleted_at IS NULL",[row.candidate_id])).rows[0]);
  const name=String(person.name||'').trim(),real=String(person.real_name||'').trim();
  if(/^[\u4e00-\u9fff]{1,2}(先生|女士)$/.test(name)&&!real)fail(422,'real_name_required');
 }
 return to==='offered'?verifiedOfferGates(row):null;
}
// 看板批量流转：逐条复用单条流转的全部校验，任何一条失败不影响其它条，返回逐条结果。
export const batchTransitionInput = z
  .object({
    items: z.array(z.object({id:uuid,version,...transitionInput.pick({ccTemplateRef:true,ccRecipientIds:true}).shape}).strict()).min(1).max(50),
    to: z.enum(["screening", "screened", "interviewing", "collecting", "background_check", "offered", "hired"]),
    reason: z.string().trim().min(1).max(2000),
    opinion: z.string().trim().min(5).max(3000),
    confirm: z.boolean().default(false),
    ccMethod: transitionInput.shape.ccMethod,
  })
  .strict();
export const candidateEditRequest = z
  .object({ version, profile: profileInput })
  .strict();
export const transferRequest = transitionInput
  .omit({ to: true })
  .extend({ targetJobId: uuid, to: stage.optional() })
  .strict();
export const transferPreviewRequest = z
  .object({ version, targetJobId: uuid })
  .strict();
export const collectionCompletionRequest = z
  .object({ version, completed: z.boolean(), confirm: z.literal(true) })
  .strict();
export const useResumeRequest = z
  .object({ version, resumeVersionId: uuid })
  .strict();
export const archiveCandidateRequest = z.object({version,reason:z.string().trim().min(1).max(2000),restore:z.boolean().default(false)}).strict();
export const candidatesRequest = z
  .object({
    query: z.string().max(300).default(""),
    lifecycle: z.enum(["all","inbox","active","archive"]).default("all"),
    deleted: z.boolean().default(false),
    page: z.number().int().positive().default(1),
    pageSize: z.number().int().min(1).max(100).default(25),
  })
  .strict();
export const applicationsRequest = applicationQueryInput;
export const deleteRequest = z
  .object({
    version,
    reason: z.string().trim().min(1).max(2000),
    restore: z.boolean().default(false),
  })
  .strict();
export class RecruitingService {
  readonly db;
  readonly dictionary;
  constructor(readonly identity: Identity) {
    this.db = identity.db;
    this.dictionary = new Dictionary(this.db);
  }
  async createCandidate(a: Actor, input: unknown) {
    requireRole(a, ...writers);
    const b = parse(profileInput, input);
    b.skills = await this.dictionary.normalize(b.skills);
    return this.db.tx(async (c) => {
      const r = (
        await c.query(
          "INSERT INTO candidates(profile) VALUES($1) RETURNING *",
          [b],
        )
      ).rows[0];
      await this.identity.profileVersion(c, a.id, r);
      await this.identity.audit(c, a.id, "candidate.create", r.id);
      return r;
    });
  }
  async editCandidate(a: Actor, id: string, input: unknown) {
    requireRole(a, ...writers);
    const b = parse(candidateEditRequest, input);
    return this.db.tx(async (c) => {
      const r = (
        await c.query(
          "UPDATE candidates SET profile=$3,version=version+1,updated_at=now() WHERE id=$1 AND version=$2 AND deleted_at IS NULL RETURNING *",
          [id, b.version, b.profile],
        )
      ).rows[0];
      if (!r) fail(409, "version_conflict");
      await this.identity.profileVersion(c, a.id, r);
      await this.identity.audit(c, a.id, "candidate.edit", id);
      return r;
    });
  }
  async archiveCandidate(a: Actor, id: string, input: unknown) {
    requireRole(a, ...writers);
    const b = parse(archiveCandidateRequest, input);
    return this.db.tx(async c => {
      const person = found((await c.query('SELECT * FROM candidates WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [id])).rows[0]);
      if (person.version !== b.version) fail(409, 'version_conflict');
      const active = (await c.query(`SELECT ${activeCandidateSql} active FROM candidates c WHERE c.id=$1`, [id])).rows[0].active;
      if (active) fail(409, 'active_workflow_exists');
      if (b.restore && (await c.query("SELECT 1 FROM applications WHERE candidate_id=$1 AND deleted_at IS NULL AND status IN ('hired','terminated','rejected','hired_other') LIMIT 1",[id])).rowCount) fail(409,'recruitment_history_preserved');
      const row = (await c.query('UPDATE candidates SET archived_at=CASE WHEN $2 THEN NULL ELSE now() END,archive_reason=$3,version=version+1,updated_at=now() WHERE id=$1 RETURNING *', [id,b.restore,b.restore?'':b.reason])).rows[0];
      await this.identity.profileVersion(c,a.id,row);
      await this.identity.audit(c,a.id,b.restore?'candidate.return_to_inbox':'candidate.archive',id,{reason:b.reason});
      return {id:row.id,version:row.version,archived_at:row.archived_at,archive_reason:row.archive_reason};
    });
  }
  async candidate(a: Actor, id: string) {
    const person = found(
        (
          await this.db.query(
            `SELECT c.*,${candidateLifecycleSql} lifecycle FROM candidates c WHERE c.id=$1 AND c.deleted_at IS NULL`,
            [id],
          )
        ).rows[0],
      ),
      all = a.roles.some((r) => writers.includes(r as any));
    if (a.status !== "active") fail(403, "forbidden");
    const related = (
        await this.db.query(
          "SELECT * FROM applications WHERE candidate_id=$1 AND deleted_at IS NULL ORDER BY created_at,id",
          [id],
        )
      ).rows,
      applications: any[] = [];
    for (const app of related) {
      try {
        await this.identity.applicationAccess(a, app.id);
        applications.push(app);
      } catch {}
    }
    if (!all && !applications.length) fail(403, "forbidden");
    const ids = applications
      .map((app) => app.resume_version_id)
      .filter(Boolean);
    const resumes = (
      await this.db.query(
        "SELECT r.id,r.parse_result_id,r.parent_id,r.created_at,d.kind,d.file_name FROM resume_versions r JOIN parse_results p ON p.id=r.parse_result_id JOIN resume_documents d ON d.id=p.document_id WHERE r.candidate_id=$1 AND ($2 OR r.id=ANY($3::uuid[])) ORDER BY r.created_at,r.id",
        [id, all, ids],
      )
    ).rows;
    const history = all
      ? (
          await this.db.query(
            "WITH RECURSIVE family AS (SELECT id FROM candidates WHERE id=$1 UNION SELECT c.id FROM candidates c JOIN family f ON c.merged_into_id=f.id) SELECT v.* FROM candidate_profile_versions v JOIN family f ON f.id=v.candidate_id ORDER BY v.at,v.candidate_id,v.version",
            [id],
          )
        ).rows
      : [];
    return { ...person, applications, resumes, history };
  }
  async createJob(a: Actor, input: unknown) {
    return new Jobs(this.identity).create(a, input);
  }
  async updateJob(a: Actor, id: string, input: unknown) {
    return new Jobs(this.identity).update(a, id, input);
  }
  async closeJobPreview(a: Actor, id: string, input: unknown) {
    return new Jobs(this.identity).closePreview(a, id, input);
  }
  async publicJob(a: Actor, id: string) {
    return new Jobs(this.identity).publicJob(a, id);
  }
  async salaryGrant(a: Actor, id: string, input: unknown) {
    return new Jobs(this.identity).grant(a, id, input);
  }
  async apply(a: Actor, input: unknown) {
    requireRole(a, ...writers);
    const b = parse(applyInput, input);
    return this.db.tx((c) => this.applyTx(c, a, b));
  }
  async applyTx(
    c: Sql,
    a: Actor,
    b: {
      candidateId: string;
      jobId: string;
      resumeVersionId?: string;
      inboxMatchHash?: string;
      source: string;
      startNew?: boolean;
    },
    status = "screening",
  ) {
    await lockMatchingCandidateJobs(c,[b.candidateId],[b.jobId]);
    found(
      (
        await c.query(
          "SELECT id FROM candidates WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
          [b.candidateId],
        )
      ).rows[0],
    );
    const job = found(
      (await c.query("SELECT * FROM jobs WHERE id=$1 FOR SHARE", [b.jobId]))
        .rows[0],
    );
    if (!job.open) fail(409, "job_closed");
    await assertInboxAdoption(this.identity,a,c,b);
    const current = (await c.query('SELECT * FROM applications WHERE candidate_id=$1 AND is_current AND deleted_at IS NULL FOR UPDATE',[b.candidateId])).rows[0];
    if(current) {
      if (!b.startNew || !terminalStates.includes(current.status)) fail(409, 'current_workflow_exists');
      await c.query('UPDATE applications SET is_current=false,version=version+1,updated_at=now() WHERE id=$1',[current.id]);
      await this.identity.audit(c,a.id,'application.archive_for_new_attempt',current.id);
    }
    if (
      b.resumeVersionId &&
      !(
        await c.query(
          "SELECT 1 FROM resume_versions WHERE id=$1 AND candidate_id=$2",
          [b.resumeVersionId, b.candidateId],
        )
      ).rowCount
    )
      fail(422, "resume_candidate_mismatch");
    const r = (
      await c.query(
        "INSERT INTO applications(candidate_id,job_id,resume_version_id,source,status) VALUES($1,$2,$3,$4,$5) RETURNING *",
        [b.candidateId, b.jobId, b.resumeVersionId || null, b.source, status],
      )
    ).rows[0];
    await c.query(
      "INSERT INTO application_events(application_id,actor_id,to_state,reason) VALUES($1,$2,$3,$4)",
      [r.id, a.id, status, "人工创建申请"],
    );
    if (b.resumeVersionId)
      await queueMatch(this.identity,c,r.id,a.id);
    await this.identity.audit(c, a.id, "application.create", r.id);
    return r;
  }
  async application(a: Actor, id: string): Promise<any> {
    await this.identity.applicationAccess(a, id);
    const row = found(
      (
        await this.db.query(
          "SELECT a.*,c.profile,j.name job_name,j.requirements_version job_version,v.requirements FROM applications a JOIN candidates c ON c.id=a.candidate_id JOIN jobs j ON j.id=a.job_id JOIN job_versions v ON v.job_id=j.id AND v.version=j.requirements_version WHERE a.id=$1",
          [id],
        )
      ).rows[0],
    );
    return {...row, profile: maskScreeningContacts(a, row.profile)};
  }
  async updateApplicationFields(a:Actor,id:string,input:unknown){const {ConfiguredRecruiting}=await import('../business-config/recruiting.js');return new ConfiguredRecruiting(this.identity).application(a,id,input);}
  async transition(a: Actor, id: string, input: unknown) {
    const b = parse(transitionInput, input);
    if (!a.roles.some((r) => writers.includes(r as any))) {
      // Screening grants carry one forward step only, from the board, on a live grant.
      if (b.to !== "screened" || b.interaction !== "drag")
        fail(403, "screening_scope_limited");
      const allowed = (
        await this.db.query(
          "SELECT a.id FROM applications a JOIN jobs j ON j.id=a.job_id WHERE a.id=$1 AND a.deleted_at IS NULL AND a.status='screening' AND j.open AND EXISTS(SELECT 1 FROM active_job_screening_grants g WHERE g.job_id=a.job_id AND g.user_id=$2)",
          [id, a.id],
        )
      ).rowCount;
      if (!allowed) fail(403, "screening_scope_limited");
      return this.db.tx((c) => this.transitionTx(c, a, id, b));
    }
    requireRole(a, ...writers);
    return this.db.tx((c) => this.transitionTx(c, a, id, b));
  }
  async batchTransition(a: Actor, input: unknown) {
    requireRole(a, ...writers);
    const b = parse(batchTransitionInput, input);
    if(new Set(b.items.map(item=>item.id)).size!==b.items.length)fail(422,'duplicate_application');
    const results: { id: string; ok: boolean; error?: string; ccReminder?: unknown }[] = [];
    for (const item of b.items) {
      const appId=item.id;
      try {
        const row=(await this.db.query('SELECT status FROM applications WHERE id=$1 AND deleted_at IS NULL',[appId])).rows[0];
        if(!row)fail(404,'not_found');
        if(row.status===b.to)fail(409,'same_stage');
        const moved=await this.transition(a, appId, {
          version: item.version, to: b.to, interaction: "form", reason: b.reason,
          opinion: b.opinion, confirm: b.confirm,
          ccTemplateRef:item.ccTemplateRef,ccRecipientIds:item.ccRecipientIds,ccMethod:b.ccMethod,
          rejectReason: "", rejectDetail: "", termReason: "", termDetail: "",
        });
        results.push({ id: appId, ok: true, ccReminder:moved.ccReminder });
      } catch (e: any) {
        results.push({ id: appId, ok: false, error: e?.code || e?.message || "transition_failed" });
      }
    }
    const succeeded = results.filter((x) => x.ok).length;
    await this.identity.audit(this.db.sql, a.id, "application.batch_transition", null, {
      to: b.to, total: b.items.length, succeeded,
    });
    return { to: b.to, results, succeeded, failed: results.length - succeeded };
  }
  async transitionTx(
    c: Sql,
    a: Actor,
    id: string,
    b: ReturnType<typeof transitionInput.parse>,
  ) {
    await c.query('SELECT j.id FROM jobs j JOIN applications a ON a.job_id=j.id WHERE a.id=$1 FOR SHARE OF j',[id]);
    found(
      (
        await c.query(
          "SELECT c.id FROM candidates c JOIN applications a ON a.candidate_id=c.id WHERE a.id=$1 AND c.deleted_at IS NULL FOR UPDATE OF c",
          [id],
        )
      ).rows[0],
    );
    const row = found(
      (
        await c.query(
          "SELECT * FROM applications WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
          [id],
        )
      ).rows[0],
    );
    if (row.version !== b.version) fail(409, "version_conflict");
    gateTransition(a, row, b,await this.reasonOptions(a,row,b));
    await stageBusinessGates(c,row,b.to);
    const cc = await ccForTransition(this.identity,c,a,row.job_id,b.to,b);
    const result = (
      await c.query(
        "UPDATE applications SET status=$2,reject_reason=$3,reject_detail=$4,term_reason=$5,term_detail=$6,version=version+1,updated_at=now() WHERE id=$1 RETURNING *",
        [
          id,
          b.to,
          b.to === "rejected" ? b.rejectReason : null,
          b.to === "rejected" ? b.rejectDetail : null,
          b.to === "terminated" ? b.termReason : null,
          b.to === "terminated" ? b.termDetail : null,
        ],
      )
    ).rows[0];
    await c.query(
      "INSERT INTO application_events(application_id,actor_id,from_state,to_state,reason,rejection_reason,opinion,term_reason,term_detail,cc,cc_snapshot,from_job_id,to_job_id,interaction,rejection_detail) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13,$14)",
      [
        id,
        a.id,
        row.status,
        b.to,
        b.to === "rejected"
          ? b.rejectReason + ": " + b.rejectDetail
          : b.reason || "看板拖拽",
        b.to === "rejected" ? b.rejectReason : null,
        b.opinion,
        b.to === "terminated" ? b.termReason : null,
        b.to === "terminated" ? b.termDetail : null,
        cc.cc,
        cc.snapshot,
        row.job_id,
        b.interaction,
        b.to === "rejected" ? b.rejectDetail : null,
      ],
    );
    await this.identity.audit(c, a.id, "application.transition", id, {
      from: row.status,
      to: b.to,
    });
    return {
      ...result,
      ccReminder: cc.reminder,
    };
  }
  async transferPreview(a: Actor, id: string, input: unknown) {
    requireRole(a, ...writers);
    const b = parse(transferPreviewRequest, input);
    const current = await this.application(a, id);
    if (current.version !== b.version || !current.is_current)
      fail(409, "version_conflict");
    if (current.job_id === b.targetJobId) fail(422, "same_job");
    const target = found(
      (
        await this.db.query(
          "SELECT id,name,open,version FROM jobs WHERE id=$1",
          [b.targetJobId],
        )
      ).rows[0],
    );
    if (!target.open) fail(409, "job_closed");
    return {
      applicationId: id,
      version: current.version,
      fromJobId: current.job_id,
      target,
      proposedStage: carryStage(current.status),
      internalTransfer: current.status === "hired",
      historyPreserved: true,
      parallelApplication: false,
    };
  }
  async transfer(a: Actor, id: string, input: unknown) {
    requireRole(a, ...writers);
    const b = parse(transferRequest, input);
    if (!b.confirm) fail(409, "transfer_confirmation");
    return this.db.tx(async (c) => {
      const head=found((await c.query('SELECT candidate_id FROM applications WHERE id=$1',[id])).rows[0]);
      await lockMatchingCandidateJobs(c,[head.candidate_id],[b.targetJobId]);
      found(
        (
          await c.query(
            "SELECT p.id FROM candidates p JOIN applications a ON a.candidate_id=p.id WHERE a.id=$1 AND p.deleted_at IS NULL FOR UPDATE OF p",
            [id],
          )
        ).rows[0],
      );
      const row = await this.identity.applicationAccess(a, id, true, c);
      const locked = found(
        (
          await c.query("SELECT * FROM applications WHERE id=$1 FOR UPDATE", [
            id,
          ])
        ).rows[0],
      );
      if (locked.version !== b.version) fail(409, "version_conflict");
      if (!locked.is_current) fail(409, "historical_application");
      if (row.job_id === b.targetJobId) fail(422, "same_job");
      if (row.status === "hired") {
        if (!b.reason.trim()) fail(422, "internal_transfer_reason");
      }
      if (!b.reason.trim()) fail(422, "flow_reason_required");
      if (b.opinion.trim().length < 5) fail(422, "flow_opinion_required");
      const status = b.to || carryStage(locked.status);
      const { targetJobId: _, ...flow } = b;
      const command = parse(transitionInput, { ...flow, to: status });
      gateTransition(
        a,
        { ...locked, status: carryStage(locked.status) },
        command,
        await this.reasonOptions(a,locked,command),
      );
      // Carrying an offered/hired stage is not itself evidence of approval.
      // Require the recorded nodes and preserve their source on the new attempt.
      const inheritedOfferGates=await stageBusinessGates(c,locked,status);
      await c.query(
        "UPDATE applications SET is_current=false,version=version+1,updated_at=now() WHERE id=$1",
        [id],
      );
      const result = await this.applyTx(
        c,
        a,
        {
          candidateId: row.candidate_id,
          jobId: b.targetJobId,
          resumeVersionId: row.resume_version_id || undefined,
          source: row.source,
        },
        status,
      );
      if(inheritedOfferGates)await c.query('UPDATE applications SET configuration_refs=configuration_refs||$2::jsonb WHERE id=$1',[result.id,{toolkit:{offerGates:inheritedOfferGates,offerGateInheritance:{applicationId:id,jobId:locked.job_id,applicationVersion:locked.version}}}]);
      await c.query(
        "UPDATE applications SET transfer_from_id=$2,reject_reason=$3,reject_detail=$4,term_reason=$5,term_detail=$6,collected_at=$7 WHERE id=$1",
        [
          result.id,
          id,
          status === "rejected" ? b.rejectReason : null,
          status === "rejected" ? b.rejectDetail : null,
          status === "terminated" ? b.termReason : null,
          status === "terminated" ? b.termDetail : null,
          locked.collected_at,
        ],
      );
      await c.query("UPDATE applications SET transfer_to_id=$2 WHERE id=$1", [
        id,
        result.id,
      ]);
      const cc = await ccForTransition(this.identity,c,a,b.targetJobId,status,{...b,interaction:"form"});
      await c.query(
        "UPDATE application_events SET from_state=$2,from_job_id=$3,to_job_id=$4,reason=$5,opinion=$6,cc=$7,cc_snapshot=$8,term_reason=$9,term_detail=$10,interaction=$11,rejection_reason=$12,rejection_detail=$13 WHERE application_id=$1",
        [
          result.id,
          locked.status,
          locked.job_id,
          b.targetJobId,
          b.reason,
          b.opinion,
          cc.cc,
          cc.snapshot,
          status === "terminated" ? b.termReason : null,
          status === "terminated" ? b.termDetail : null,
          "transfer",
          status === "rejected" ? b.rejectReason : null,
          status === "rejected" ? b.rejectDetail : null,
        ],
      );
      await this.identity.audit(c, a.id, "application.transfer", result.id, {
        fromApplication: id,
        reason: b.reason,
      });
      return (
        await c.query("SELECT * FROM applications WHERE id=$1", [result.id])
      ).rows[0];
    });
  }
  private async reasonOptions(a:Actor,row:any,b:ReturnType<typeof transitionInput.parse>){
    const d=new BusinessDictionaryService(this.identity);
    if(b.to==='rejected'){
      const items=(await d.dictionary(a,'rejection_reasons')).options;
      if(items.some(o=>o.id===b.rejectReason))validateOption(items,b.rejectReason,row.reject_reason);
    }
    if(b.to!=='terminated')return [];
    const items=(await d.dictionary(a,'termination_reasons')).options;
    const selected=items.find(o=>o.id===b.termReason);
    if(selected?.coreCode==='other'&&!b.termDetail.trim())fail(422,'termination_required');
    return items.filter(o=>o.active||o.id===row.term_reason).map(o=>o.id);
  }
  async collectionCompletion(a: Actor, id: string, input: unknown) {
    requireRole(a, ...writers);
    const b = parse(collectionCompletionRequest, input);
    return this.db.tx(async (c) => {
      await this.identity.applicationAccess(a, id, true, c);
      const row = found(
        (
          await c.query(
            "SELECT * FROM applications WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
            [id],
          )
        ).rows[0],
      );
      if (row.version !== b.version) fail(409, "version_conflict");
      if (!row.is_current) fail(409, "historical_application");
      const checklist=await new ChecklistService(this.identity).completion(a,id,'collecting',c);if(b.completed&&checklist.checklistId&&!checklist.complete)fail(409,'checklist_incomplete');
      const r = (
        await c.query(
          "UPDATE applications SET collected_at=CASE WHEN $2 THEN now() ELSE NULL END,version=version+1,updated_at=now() WHERE id=$1 RETURNING *",
          [id, b.completed],
        )
      ).rows[0];
      await this.identity.audit(c, a.id, "application.collection", id, {
        completed: b.completed,
      });
      return r;
    });
  }
  async useResume(a: Actor, id: string, input: unknown) {
    requireRole(a, ...writers);
    const b = parse(useResumeRequest, input);
    return this.db.tx(async (c) => {
      const row = await this.identity.applicationAccess(a, id, true, c);
      await lockMatchingCandidateJobs(c,[row.candidate_id],[row.job_id]);
      if (!row.is_current) fail(409, "historical_application");
      if (
        !(
          await c.query(
            "SELECT 1 FROM resume_versions WHERE id=$1 AND candidate_id=$2",
            [b.resumeVersionId, row.candidate_id],
          )
        ).rowCount
      )
        fail(422, "resume_candidate_mismatch");
      const r = (
        await c.query(
          "UPDATE applications SET resume_version_id=$3,version=version+1,updated_at=now() WHERE id=$1 AND version=$2 AND is_current RETURNING *",
          [id, b.version, b.resumeVersionId],
        )
      ).rows[0];
      if (!r) fail(409, "version_conflict");
      await queueMatch(this.identity,c,id,a.id);
      await this.identity.audit(c, a.id, "application.resume", id, {
        resumeVersionId: b.resumeVersionId,
      });
      return r;
    });
  }
  async removeCandidate(a: Actor, id: string, input: unknown) {
    requireRole(a, ...writers);
    const b = parse(deleteRequest, input);
    if (b.restore) requireRole(a, "admin", "manager");
    return this.db.tx(async (c) => {
      const row = found(
        (await c.query("SELECT * FROM candidates WHERE id=$1 FOR UPDATE", [id]))
          .rows[0],
      );
      if (row.merged_into_id) fail(409, "candidate_merged");
      if (row.version !== b.version || !!row.deleted_at !== b.restore)
        fail(409, "version_conflict");
      if (
        !b.restore &&
        (
          await c.query(
            "SELECT 1 FROM applications WHERE candidate_id=$1 AND deleted_at IS NULL LIMIT 1",
            [id],
          )
        ).rowCount
      )
        fail(409, "candidate_has_applications");
      const result = (
        await c.query(
          "UPDATE candidates SET deleted_at=CASE WHEN $2 THEN NULL ELSE now() END,version=version+1,updated_at=now() WHERE id=$1 RETURNING *",
          [id, b.restore],
        )
      ).rows[0];
      await this.identity.profileVersion(c, a.id, result);
      await this.identity.audit(
        c,
        a.id,
        b.restore ? "candidate.restore" : "candidate.delete",
        id,
        { reason: b.reason },
      );
      return result;
    });
  }
  async removeApplication(a: Actor, id: string, input: unknown) {
    requireRole(a, ...writers);
    const b = parse(deleteRequest, input);
    if (b.restore) requireRole(a, "admin", "manager");
    return this.db.tx(async (c) => {
      // Use the same person-before-application order as apply/restore.
      const candidate = found(
        (
          await c.query(
            "SELECT c.* FROM candidates c JOIN applications a ON a.candidate_id=c.id WHERE a.id=$1 FOR UPDATE OF c",
            [id],
          )
        ).rows[0],
      );
      const row = found(
        (
          await c.query("SELECT * FROM applications WHERE id=$1 FOR UPDATE", [
            id,
          ])
        ).rows[0],
      );
      if (row.version !== b.version || !!row.deleted_at !== b.restore)
        fail(409, "version_conflict");
      if (b.restore && candidate.deleted_at) fail(409, "candidate_deleted");
      const result = (
        await c.query(
          "UPDATE applications SET deleted_at=CASE WHEN $2 THEN NULL ELSE now() END,version=version+1,updated_at=now() WHERE id=$1 RETURNING *",
          [id, b.restore],
        )
      ).rows[0];
      await this.identity.audit(
        c,
        a.id,
        b.restore ? "application.restore" : "application.delete",
        id,
        { reason: b.reason },
      );
      return result;
    });
  }
  async jobs(a: Actor) {
    return new Jobs(this.identity).list(a);
  }
  async candidates(a: Actor, input: unknown) {
    requireRole(a, ...writers);
    const q = parse(candidatesRequest, input),definition=await legacyDefinition(this.identity,a,'resume'),searchColumns=profileSearchColumns(definition,a);
    if (q.deleted) requireRole(a, "admin", "manager");
    const params = [
      "%" + q.query.replace(/[\\%_]/g, "\\$&") + "%",
      q.pageSize,
      (q.page - 1) * q.pageSize,
    ];
    return this.db.tx(async (c) => {
      await c.query(
        // Field ACL reads take FOR SHARE locks on published definitions. Keep the
        // consistent snapshot while allowing those locks; this path performs no writes.
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ",
      );
      const where =
        (q.lifecycle === "all" ? "" : `(${candidateLifecycleSql})='${q.lifecycle}' AND `) +
        "(c.deleted_at IS NOT NULL)=$2 AND "+(searchColumns.length?"concat_ws(' ',"+searchColumns.join(',')+")":"''")+" ILIKE $1";
      const total = (
        await c.query(
          "SELECT count(*)::int total FROM candidates c WHERE " + where,
          [params[0], q.deleted],
        )
      ).rows[0].total;
      const rows = (
        await c.query(
          `SELECT c.*,${candidateLifecycleSql} lifecycle,(SELECT count(*) FROM applications a WHERE a.candidate_id=c.id AND a.deleted_at IS NULL)::int application_count FROM candidates c WHERE ` +
            where +
            " ORDER BY c.created_at DESC,c.id LIMIT $3 OFFSET $4",
          [params[0], q.deleted, params[1], params[2]],
        )
      ).rows;
      const matches=await inboxMatchesFor(this.identity,a,rows.filter(r=>r.lifecycle==='inbox'&&!r.deleted_at).map(r=>r.id),c);
      return { items: rows.map(r=>({...r,profile:projectLegacyCore(definition,a,r.profile),...(r.lifecycle==='inbox'?{inboxMatch:matches.get(r.id)||{kind:'pending',label:'岗位待确认'}}:{})})), total, page: q.page };
    });
  }
  async applications(a: Actor, input: unknown) {
    return readApplications(this.identity, a, input);
  }
}
