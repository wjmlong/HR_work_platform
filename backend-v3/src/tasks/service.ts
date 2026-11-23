import {RecruitingService} from '../recruiting/service.js';
import {assertLegacySource,legacyDefinition,legacyKeys} from '../business-config/legacy-fields.js';
import {sourceFieldAccess,projectComparisonSource,resolveJobMatching,currentMatchSql,matchingReadAccess,queueMatch,lockMatchingCandidateJobs} from '../business-config/bindings.js';
import { createHash } from "node:crypto";
import { Identity, requireRole, type Actor } from "../identity/service.js";
import { FileStore, type Kind } from "../files/storage.js";
import { parse, z, uuid, version } from "../http/validation.js";
import { fail, found } from "../http/errors.js";
import { ALGORITHM } from "../parsing/match.js";
import { parseProfile, encodeRaw, decodeRaw } from "../parsing/profile.js";
import type { Sql } from "../db.js";
import { encodeJSON, decodeJSON } from "../parsing/json.js";
import { Dictionary } from "../dictionary/service.js";
import {BusinessConfigService} from '../business-config/service.js';
import {loadDefinition} from '../business-config/fields.js';
import {inheritResumeFields,writeFieldValues} from '../business-config/fields.js';
import { education } from "../recruiting/schema.js";
import {
  applyCorrections,
  type HumanCorrection,
} from "../parsing/corrections.js";
const writers = ["admin", "manager", "recruiter"] as const;
export const supplyTextRequest = z
  .object({
    text: z
      .string()
      .trim()
      .min(1)
      .max(2 * 1024 * 1024),
  })
  .strict();
export const duplicateRequest = z
  .object({
    choice: z.enum(["skip", "new_version", "replace", "keep_separate"]),
    candidateId: uuid.optional(),
    candidateVersion: version.optional(),
  })
  .strict();
export const correctionRequest = z
  .object({
    baseParseResultId: uuid,
    application: z.object({id:uuid,version,candidateVersion:version}).strict().optional(),
    confirmNameOverwrite:z.boolean().optional(),
    definitionVersion:z.number().int().positive().optional(),
    definitionRevision:z.string().max(100).optional(),
    customFields:z.record(z.string().max(100),z.unknown()).optional(),
    reason: z.string().trim().min(1).max(2000),
    corrections: z
      .object({
        name: z.string().trim().min(1).max(1000).optional(),
        phone: z.string().max(100).optional(),
        email: z.string().max(300).optional(),
        location: z.string().max(300).optional(),
        bachelorSchool: z.string().max(300).optional(),
        companies: z.array(z.string().max(300)).max(100).optional(),
        intent: z.string().max(1000).optional(),
        expectedSalary: z.string().max(1000).optional(),
        summary: z.string().max(10000).optional(),
        education: education.nullable().optional(),
        experienceYears: z.number().min(0).max(80).nullable().optional(),
        firstEmployment: z.string().max(30).nullable().optional(),
        school: z.string().max(300).optional(),
        major: z.string().max(300).optional(),
        skills: z.array(z.string().min(1).max(100)).max(100).optional(),
      })
      .strict().default({}),
  })
  .strict().refine(v=>Object.keys(v.corrections).length>0||Object.keys(v.customFields||{}).length>0);
export const tasksQuery = z
  .object({
    kind: z.enum(["ingest", "recompute"]).default("ingest"),
    view: z.enum(["actionable", "history"]).default("actionable"),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(100).default(25),
    query: z.string().max(200).default(""),
  })
  .strict();
export class TaskService {
  readonly db;
  constructor(
    readonly identity: Identity,
    readonly store: FileStore,
  ) {
    this.db = identity.db;
  }
  async upload(
    a: Actor,
    input: {
      name: string;
      data: Buffer;
      jobId?: string;
      newCandidatesOnly?: boolean;
      initialDescription?: string;
      initialPosition?: string;
      paste?: boolean;
      source?: string;
      note?: string;
    },
  ) {
    requireRole(a, ...writers);
    if(input.jobId)parse(uuid,input.jobId);
    else if(!input.newCandidatesOnly)fail(422,'job_required');
    if (input.jobId&&
      !(
        await this.db.query("SELECT 1 FROM jobs WHERE id=$1 AND open", [
          input.jobId,
        ])
      ).rowCount
    )
      fail(409, "job_closed");
    const f = await this.store.put(
      input.name,
      input.data,
      input.paste ? "paste" : undefined,
    );
    return this.db.tx(async (c) => {
      const doc = (
        await c.query(
          "INSERT INTO resume_documents(blob_key,sha256,file_name,file_size,kind,owner_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
          [f.blobKey, f.sha256, f.name, f.size, f.kind, a.id],
        )
      ).rows[0];
      const task = (
        await c.query(
          "INSERT INTO tasks(kind,payload,actor_id) VALUES('ingest',$1,$2) RETURNING *",
          [
            {
              documentId: doc.id,
              jobId: input.jobId,
              source: input.source || "手动上传",
              note: input.note || "",
              ...(input.newCandidatesOnly?{newCandidatesOnly:true,initialDescription:input.initialDescription||'',initialPosition:input.initialPosition||''}:{}),
            },
            a.id,
          ],
        )
      ).rows[0];
      await this.identity.audit(c, a.id, "upload.enqueue", task.id, {
        size: f.size,
        kind: f.kind,
      });
      return task;
    });
  }
  async projectTask(a:Actor,row:any){const out=structuredClone(row);if(out.payload)delete out.payload.rawBase64;
   if(out.payload?.source&&!legacyKeys(await legacyDefinition(this.identity,a,'application'),a).has('source'))delete out.payload.source;
   if(out.result?.duplicates){try{await assertLegacySource(this.identity,a,['resume','job']);}catch(e){if((e as any).statusCode!==403)throw e;out.result={requiresSourceAccess:true};}}
   return out;
  }
  async get(a: Actor, id: string) {
    requireRole(a, ...writers);
    return this.db.tx(async (c) => {
      const task = found(
        (await c.query("SELECT * FROM tasks WHERE id=$1", [id])).rows[0],
      );
      if (task.state !== "awaiting_duplicate_decision") return this.projectTask(a,task);
      await assertLegacySource(this.identity,a,['resume','job']);
      const incoming = found(
        (
          await c.query(
            "SELECT p.profile,d.file_name,j.name job_name FROM parse_results p JOIN resume_documents d ON d.id=p.document_id LEFT JOIN jobs j ON j.id=$2 WHERE p.id=$1",
            [task.result.parseResultId, task.payload.jobId],
          )
        ).rows[0],
      );
      const candidates = (
        await c.query(
          "SELECT id,version,profile FROM candidates WHERE id=ANY($1::uuid[]) AND deleted_at IS NULL",
          [task.result.duplicates.map((d: any) => d.candidateId)],
        )
      ).rows;
      const applications = (
        await c.query(
          "SELECT a.candidate_id,a.status,a.is_current,j.name job_name FROM applications a JOIN jobs j ON j.id=a.job_id WHERE a.candidate_id=ANY($1::uuid[]) AND a.deleted_at IS NULL ORDER BY a.is_current DESC,a.created_at DESC",
          [candidates.map((p) => p.id)],
        )
      ).rows;
      return {
        ...await this.projectTask(a,task),
        comparison: {
          incoming,
          candidates: candidates.map((p) => ({
            ...p,
            applications: applications.filter(
              (app) => app.candidate_id === p.id,
            ),
            changedSinceDetection:
              task.result.duplicates.find((d: any) => d.candidateId === p.id)
                ?.candidateVersion !== p.version,
          })),
        },
      };
    });
  }
  async list(a: Actor) {
    requireRole(a, ...writers);
    return Promise.all((
      await this.db.query(
        "SELECT t.*,d.file_name FROM tasks t LEFT JOIN resume_documents d ON d.id=(t.payload->>'documentId')::uuid ORDER BY t.created_at DESC,t.id LIMIT 200",
      )
    ).rows.map(r=>this.projectTask(a,r)));
  }
  async query(a: Actor, input: unknown) {
    requireRole(a, ...writers);
    const q = parse(tasksQuery, input);
    return this.db.tx(async (c) => {
      await c.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ",
      );
      const where =
          "t.kind=$1 AND ($2='history' OR t.state NOT IN ('succeeded','cancelled')) AND coalesce(d.file_name,'') ILIKE $3",
        params = [
          q.kind,
          q.view,
          "%" + q.query.replace(/[\\%_]/g, "\\$&") + "%",
        ];
      const counts = (
          await c.query(
            "SELECT count(*) total,count(*) FILTER(WHERE t.state IN ('queued','running')) active FROM tasks t LEFT JOIN resume_documents d ON d.id=(t.payload->>'documentId')::uuid WHERE " +
              where,
            params,
          )
        ).rows[0],
        total = Number(counts.total);
      const items = (
        await c.query(
          "SELECT t.*,d.file_name FROM tasks t LEFT JOIN resume_documents d ON d.id=(t.payload->>'documentId')::uuid WHERE " +
            where +
            " ORDER BY t.created_at " +
            (q.view === "history" ? "DESC" : "ASC") +
            ",t.id LIMIT $4 OFFSET $5",
          [...params, q.pageSize, (q.page - 1) * q.pageSize],
        )
      ).rows;
      return {
        items:await Promise.all(items.map(r=>this.projectTask(a,r))),
        total,
        active: Number(counts.active),
        page: q.page,
        pageSize: q.pageSize,
      };
    });
  }
  async cancel(a: Actor, id: string) {
    requireRole(a, ...writers);
    return this.db.tx(async (c) => {
      const r = (
        await c.query(
          "UPDATE tasks SET state='cancelled',claim_token=claim_token+1,lease_until=NULL,updated_at=now() WHERE id=$1 AND state IN ('queued','running','needs_text','awaiting_duplicate_decision','failed') RETURNING *",
          [id],
        )
      ).rows[0];
      if (!r) fail(409, "task_state_conflict");
      await this.identity.audit(c, a.id, "task.cancel", id);
      return r;
    });
  }
  async retry(a: Actor, id: string) {
    requireRole(a, ...writers);
    const r = (
      await this.db.query(
        "UPDATE tasks SET state='queued',attempts=0,claim_token=claim_token+1,error_code=NULL,updated_at=now() WHERE id=$1 AND state='failed' RETURNING *",
        [id],
      )
    ).rows[0];
    if (!r) fail(409, "task_state_conflict");
    return r;
  }
  async supplyText(a: Actor, id: string, input: unknown) {
    requireRole(a, ...writers);
    const b = parse(supplyTextRequest, input);
    const r = (
      await this.db.query(
        "UPDATE tasks SET state='queued',payload=payload||$2::jsonb,attempts=0,claim_token=claim_token+1,error_code=NULL,updated_at=now() WHERE id=$1 AND state='needs_text' RETURNING *",
        [
          id,
          {
            rawBase64: Buffer.from(JSON.stringify(b.text), "utf8").toString(
              "base64",
            ),
          },
        ],
      )
    ).rows[0];
    if (!r) fail(409, "task_state_conflict");
    return r;
  }
  async resolveDuplicate(a: Actor, id: string, input: unknown) {
    requireRole(a, ...writers);await assertLegacySource(this.identity,a,['resume','application'],true);
    const b = parse(duplicateRequest, input);
    return this.db.tx(async (c) => {
      await c.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('ingest-duplicate-discovery',0))",
      );
      const task = found(
        (await c.query("SELECT * FROM tasks WHERE id=$1 FOR UPDATE", [id]))
          .rows[0],
      );
      if (task.state !== "awaiting_duplicate_decision")
        fail(409, "task_state_conflict");
      if(task.payload.newCandidatesOnly&&['new_version','replace'].includes(b.choice))fail(409,'mailbox_existing_immutable');
      if (b.choice === "skip") {
        await c.query(
          "UPDATE tasks SET state='cancelled',result=$2,updated_at=now() WHERE id=$1",
          [id, { skipped: true }],
        );
        await this.identity.audit(c, a.id, "duplicate.skip", id);
        return { skipped: true };
      }
      await lockMatchingCandidateJobs(c,b.candidateId?[b.candidateId]:[],[task.payload.jobId].filter(Boolean));
      let candidateId: string | undefined;
      if (["new_version", "replace"].includes(b.choice)) {
        if (
          !b.candidateId ||
          !b.candidateVersion ||
          !task.result.duplicates.some(
            (d: any) => d.candidateId === b.candidateId,
          )
        )
          fail(422, "duplicate_target_required");
        const candidate = found(
          (
            await c.query(
              "SELECT * FROM candidates WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
              [b.candidateId],
            )
          ).rows[0],
        );
        if (candidate.version !== b.candidateVersion)
          fail(409, "version_conflict");
        candidateId = candidate.id;
        const updated = (
          await c.query(
            "UPDATE candidates SET profile=CASE WHEN $2 THEN (SELECT profile FROM parse_results WHERE id=$3) ELSE profile END,version=version+1,updated_at=now() WHERE id=$1 RETURNING *",
            [candidateId, b.choice === "replace", task.result.parseResultId],
          )
        ).rows[0];
        await this.identity.profileVersion(c, a.id, updated);
      }
      const result = await this.finalize(
        c,
        a,
        task,
        task.result.parseResultId,
        candidateId,
        b.choice === "replace",
      );
      if(result.applicationId)await queueMatch(this.identity,c,result.applicationId,a.id);
      await c.query(
        "UPDATE tasks SET state='succeeded',result=$2,updated_at=now() WHERE id=$1",
        [id, result],
      );
      await this.identity.audit(c, a.id, "duplicate.resolve", id, {
        choice: b.choice,
      });
      return result;
    });
  }
  async finalize(
    c: Sql,
    a: Actor,
    task: any,
    parseResultId: string,
    candidateId?: string,
    adopt = false,
  ) {
    if(task.payload.newCandidatesOnly&&candidateId)fail(409,'mailbox_existing_immutable');
    const parsed = found(
      (
        await c.query("SELECT * FROM parse_results WHERE id=$1", [
          parseResultId,
        ])
      ).rows[0],
    );
    if (!candidateId) {
      const initialProfile=task.payload.newCandidatesOnly?{...parsed.profile,intent:task.payload.initialPosition||parsed.profile.intent,summary:[parsed.profile.summary,task.payload.initialDescription?'来信描述：'+task.payload.initialDescription:''].filter(Boolean).join('\n\n').slice(0,10000)}:parsed.profile;
      const person = (
        await c.query(
          "INSERT INTO candidates(profile) VALUES($1) RETURNING *",
          [initialProfile],
        )
      ).rows[0];
      candidateId = person.id;
      await this.identity.profileVersion(c, a.id, person);
    }
    const resume = (
      await c.query(
        "INSERT INTO resume_versions(candidate_id,parse_result_id,origin_task_id,created_by) VALUES($1,$2,$3,$4) ON CONFLICT(origin_task_id) DO UPDATE SET origin_task_id=EXCLUDED.origin_task_id RETURNING *",
        [candidateId, parseResultId, task.id, a.id],
      )
    ).rows[0];
    // File ingestion preserves extracted facts; required human-only extensions remain unfilled.
    await new BusinessConfigService(this.identity).seed();
    const resumeDefinition=await loadDefinition(this.identity,'resume',c,a);
    await c.query('UPDATE resume_versions SET configuration_refs=$2 WHERE id=$1',[resume.id,{fields:resumeDefinition.ref,origin:'document_ingestion'}]);
    if(task.payload.newCandidatesOnly){
      await this.identity.audit(c,a.id,'resume.create',resume.id,{candidateId,applicationId:null,pendingJob:true});
      return {candidateId,resumeVersionId:resume.id,applicationId:null,parseResultId,pendingJob:true,transferRequired:false,resumeAdopted:false};
    }
    let app = (
      await c.query(
        "SELECT * FROM applications WHERE candidate_id=$1 AND is_current AND deleted_at IS NULL FOR UPDATE",
        [candidateId],
      )
    ).rows[0];
    if (!app) {
      const job = found(
        (
          await c.query("SELECT * FROM jobs WHERE id=$1 FOR SHARE", [
            task.payload.jobId,
          ])
        ).rows[0],
      );
      if (!job.open) fail(409, "job_closed");
      app = (
        await c.query(
          "INSERT INTO applications(candidate_id,job_id,resume_version_id,source,note) VALUES($1,$2,$3,$4,$5) RETURNING *",
          [
            candidateId,
            task.payload.jobId,
            resume.id,
            task.payload.source || "手动上传",
            task.payload.note || "",
          ],
        )
      ).rows[0];
      await c.query(
        "INSERT INTO application_events(application_id,actor_id,to_state,reason) VALUES($1,$2,'screening','用户上传新申请')",
        [app.id, a.id],
      );
    }
    if (adopt && app.resume_version_id !== resume.id)
      app = (
        await c.query(
          "UPDATE applications SET resume_version_id=$2,version=version+1,updated_at=now() WHERE id=$1 RETURNING *",
          [app.id, resume.id],
        )
      ).rows[0];
    await this.identity.audit(c, a.id, "resume.create", resume.id, {
      candidateId,
      applicationId: app.id,
    });
    return {
      candidateId,
      resumeVersionId: resume.id,
      applicationId: app.id,
      parseResultId,
      transferRequired: app.job_id !== task.payload.jobId,
      requestedJobId: task.payload.jobId,
      resumeAdopted: app.resume_version_id === resume.id,
    };
  }
  async correctResume(a: Actor, resumeId: string, input: unknown) {
    requireRole(a, ...writers);
    const b = parse(correctionRequest, input);
    return this.db.tx(async (c) => {
      const old = found(
        (
          await c.query(
            "SELECT r.*,p.document_id,p.raw_bytes,p.human_corrections,p.profile original_profile,p.evidence original_evidence,c.profile candidate_profile,c.version candidate_version FROM resume_versions r JOIN parse_results p ON p.id=r.parse_result_id JOIN candidates c ON c.id=r.candidate_id WHERE r.id=$1 AND c.deleted_at IS NULL FOR UPDATE OF c",
            [resumeId],
          )
        ).rows[0],
      );
      if (old.parse_result_id !== b.baseParseResultId)
        fail(409, "version_conflict");
      if(b.application){
        const app=await this.identity.applicationAccess(a,b.application.id,true,c);
        if(app.candidate_id!==old.candidate_id||app.resume_version_id!==resumeId||app.version!==b.application.version||old.candidate_version!==b.application.candidateVersion||app.is_current===false||app.deleted_at)fail(409,'version_conflict');
        if(b.corrections.name&&b.corrections.name!==old.candidate_profile.name&&old.candidate_profile.name!=='待确认'&&old.candidate_profile.name!==old.original_profile.name&&!b.confirmNameOverwrite)fail(409,'candidate_name_conflict');
      }
      const dictionary = new Dictionary(this.db);
      if (b.corrections.skills)
        b.corrections.skills = await dictionary.normalize(
          b.corrections.skills,
          c,
        );
      const aliases = (await dictionary.list()).map((x) => ({
        name: x.name,
        aliases: x.aliases,
      }));
      const previous = old.human_corrections as HumanCorrection[],
        at = new Date().toISOString();
      const facts = [
        ...previous.filter((x) => !(x.field in b.corrections)),
        ...Object.entries(b.corrections).map(([field, value]) => ({
          field,
          value,
          actorId: a.id,
          reason: b.reason,
          at,
        })),
      ];
      const raw = decodeRaw(old.raw_bytes),base={...parseProfile(raw,aliases),profile:structuredClone(old.original_profile),evidence:decodeJSON(old.original_evidence) as any[]};
      const parsed=applyCorrections(base,facts);
      const p = Object.keys(b.corrections).length?(
        await c.query(
          "INSERT INTO parse_results(document_id,raw_bytes,profile,evidence,parser_version,human_corrections) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
          [
            old.document_id,
            encodeRaw(raw),
            parsed.profile,
            encodeJSON(parsed.evidence),
            parsed.parserVersion,
            JSON.stringify(facts),
          ],
        )
      ).rows[0]:(await c.query('INSERT INTO parse_results(document_id,raw_bytes,profile,evidence,parser_version,human_corrections) SELECT document_id,raw_bytes,profile,evidence,parser_version,human_corrections FROM parse_results WHERE id=$1 RETURNING id',[old.parse_result_id])).rows[0];
      const r = (
        await c.query(
          "INSERT INTO resume_versions(candidate_id,parse_result_id,created_by,parent_id) VALUES($1,$2,$3,$4) RETURNING id",
          [old.candidate_id, p.id, a.id, resumeId],
        )
      ).rows[0];
      await inheritResumeFields(this.identity,a,resumeId,r.id,c);
      if(b.customFields&&Object.keys(b.customFields).length)await writeFieldValues(this.identity,a,{kind:'resume',id:r.id},{definitionVersion:b.definitionVersion!,definitionRevision:b.definitionRevision,customFields:b.customFields,evidenceBasis:b.reason},c);
      await this.identity.audit(c, a.id, "resume.correct", r.id, {
        parentId: resumeId,
        fields: [...Object.keys(b.corrections),...Object.keys(b.customFields||{})],
      });
      let candidateNameUpdated=false,candidateNameConflict=false;
      if(b.application&&Object.keys(b.corrections).length){
        const person=(await c.query('UPDATE candidates SET profile=profile||$2::jsonb,version=version+1,updated_at=now() WHERE id=$1 AND version=$3 RETURNING *',[old.candidate_id,JSON.stringify(b.corrections),old.candidate_version])).rows[0];
        if(!person)fail(409,'version_conflict');
        await this.identity.profileVersion(c,a.id,person);await this.identity.audit(c,a.id,'candidate.edit',person.id,{resumeVersionId:r.id,fields:Object.keys(b.corrections),reason:b.reason});
        candidateNameUpdated=Object.hasOwn(b.corrections,'name')&&b.corrections.name!==old.candidate_profile.name;
      }else if(Object.hasOwn(b.corrections,'name')&&b.corrections.name!==old.candidate_profile.name){
       if(old.candidate_profile.name==='待确认'||old.candidate_profile.name===old.original_profile.name||(b.application&&b.confirmNameOverwrite)){
        const person=(await c.query("UPDATE candidates SET profile=jsonb_set(profile,'{name}',to_jsonb($2::text)),version=version+1,updated_at=now() WHERE id=$1 AND version=$3 RETURNING *",[old.candidate_id,b.corrections.name,old.candidate_version])).rows[0];
        if(!person)fail(409,'version_conflict');
        await this.identity.profileVersion(c,a.id,person);await this.identity.audit(c,a.id,'candidate.name.confirm',person.id,{resumeVersionId:r.id,parseResultId:p.id});candidateNameUpdated=true;
       }else candidateNameConflict=true;
      }
      if(b.application)await new RecruitingService(this.identity).useResume(a,b.application.id,{version:b.application.version,resumeVersionId:r.id});
      return {
        resumeVersionId: r.id,
        parseResultId: p.id,
        parentId: resumeId,
        candidateId: old.candidate_id,
        candidateNameUpdated,candidateNameConflict,applicationUpdated:!!b.application,
      };
    });
  }
  async matches(a: Actor, applicationId: string) {
    const app=await this.identity.applicationAccess(a,applicationId);
    const binding=await this.db.tx(c=>resolveJobMatching(this.identity,c,app.job_id));
    const current=(await this.db.query(`SELECT m.id FROM match_snapshots m JOIN applications a ON a.id=m.application_id JOIN jobs j ON j.id=a.job_id WHERE a.id=$1 AND ${currentMatchSql('m','a','j')} ORDER BY m.created_at DESC,m.id LIMIT 1`,[applicationId])).rows[0];
    const rows=(await this.db.query('SELECT m.*,p.profile source_profile,v.requirements source_requirements FROM match_snapshots m JOIN applications a ON a.id=m.application_id JOIN resume_versions r ON r.id=m.resume_version_id JOIN parse_results p ON p.id=r.parse_result_id LEFT JOIN job_versions v ON v.job_id=a.job_id AND v.version=m.job_version WHERE m.application_id=$1 ORDER BY m.created_at DESC,m.id',[applicationId])).rows;
    const cache=new Map<string,Promise<any>>(),history:Record<string,any>[]=[];
    for(const row of rows){const {source_profile,source_requirements,...snapshot}=row,access=await matchingReadAccess(this.identity,a,{id:app.job_id,requirements:source_requirements||{}},{id:row.resume_version_id,profile:source_profile},this.db.sql,cache);const sourceAccess=await sourceFieldAccess(this.identity,a,{kind:'resume',id:row.resume_version_id},source_profile),jobAccess=await sourceFieldAccess(this.identity,a,{kind:'job',id:app.job_id},{requirements:source_requirements||{}});history.push({...snapshot,data:access.allowed?projectComparisonSource(decodeJSON(row.data),sourceAccess.full&&jobAccess.full,sourceAccess.keys.has('school')&&sourceAccess.keys.has('bachelorSchool')&&jobAccess.keys.has('requirements.schoolPreferences')):{statement:'当前字段权限不允许查看专业对照内容'},reference_score:access.allowed?row.reference_score:null,readable:access.allowed,legacyProvenanceUnknown:!row.reference_score?.inputs});}
    const latest=history.find(m=>m.id===current?.id)||history[0]||null;
    return {latest,history,stale:!app.is_current||!current,binding,legacyProvenanceUnknown:!!latest?.legacyProvenanceUnknown};
  }
  async raw(a: Actor, resumeId: string,projected=false) {
    const r = found(
      (
        await this.db.query(
          "SELECT v.*,p.raw_bytes,p.evidence,p.profile,p.document_id,p.human_corrections FROM resume_versions v JOIN parse_results p ON p.id=v.parse_result_id WHERE v.id=$1",
          [resumeId],
        )
      ).rows[0],
    );
    if (!a.roles.some((x) => writers.includes(x as any))) {
      const apps = (
        await this.db.query(
          "SELECT a.id FROM applications a WHERE a.deleted_at IS NULL AND (a.resume_version_id=$1 OR EXISTS(SELECT 1 FROM match_snapshots m WHERE m.application_id=a.id AND m.resume_version_id=$1))",
          [resumeId],
        )
      ).rows;
      let allowed = false;
      for (const app of apps) {
        try {
          await this.identity.applicationAccess(a, app.id);
          allowed = true;
          break;
        } catch {}
      }
      if (!allowed) fail(403, "forbidden");
    } else requireRole(a, ...writers);
    const source=await sourceFieldAccess(this.identity,a,{kind:'resume',id:resumeId},r.profile);
    if(!projected&&!source.full)fail(403,'source_fields_forbidden');
    const professional=(key:string)=>source.keys.has(key)&&['skills','education','experienceYears','firstEmployment','school','bachelorSchool','major','name'].includes(key);
    return {
      resumeVersionId: resumeId,
      sourceAccess:{fullResume:source.full,resumeKeys:[...source.keys]},
      parseResultId: r.parse_result_id,
      raw: source.full?decodeRaw(r.raw_bytes):'',
      profile: source.full?r.profile:Object.fromEntries(Object.entries(r.profile).filter(([key])=>source.keys.has(key))),
      evidence: source.full?decodeJSON(r.evidence):(decodeJSON(r.evidence) as any[]).filter(e=>professional(e.field.startsWith('skill:')?'skills':e.field)).map(({context,...e})=>e),
      documentId: r.document_id,
      humanCorrections: source.full?r.human_corrections:(decodeJSON(r.human_corrections||[]) as any[]).filter(e=>professional(e.field)).map(e=>({...e,reason:'依据原记录；当前权限仅显示该专业事实'})),
    };
  }
}
