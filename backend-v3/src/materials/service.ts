import {ConfiguredEntities} from '../business-config/entities.js';
import {BusinessDictionaryService,validateOption} from '../business-config/dictionaries.js';
import {resolveJobTemplate,loadTemplate} from '../business-config/selections.js';
import {generateTemplateQuestions,type QuestionTemplate} from '../business-config/question-template.js';
import {matchingReadAccess,sourceFieldAccess,projectComparisonSource} from '../business-config/bindings.js';
import { Identity, requireRole, type Actor } from "../identity/service.js";
import { FileStore } from "../files/storage.js";
import { TaskService } from "../tasks/service.js";
import { InterviewService } from "../interviews/service.js";
import { modelCapability } from "./catalog.js";
import { groupedQuestions, questionStatement } from "./question-groups.js";
import { parse, z, version, text, uuid } from "../http/validation.js";
import { fail, found } from "../http/errors.js";
import type { Sql } from "../db.js";
import { encodeJSON, decodeJSON } from "../parsing/json.js";
import { isDeepStrictEqual } from "node:util";
export const questionGenerationRequest=z.object({family:z.string().trim().min(1).max(300).optional(),round:z.number().int().min(1).max(50).optional()}).strict();
const question = z
  .object({
    id: text,
    group: z.string().min(1).max(300).optional(),
    groupId:z.string().max(100).optional(),questionId:z.string().max(100).optional(),coverageGap:z.boolean().optional(),skillGroups:z.array(z.object({id:z.string().max(100),label:z.string().max(300),satisfied:z.boolean()}).strict()).max(100).optional(),
    skill: text,
    prompt: z.string().min(1).max(4000),
    followups: z.array(z.string().min(1).max(2000)).max(20),
    referencePoints: z.array(z.string().min(1).max(2000)).max(30),
    source: z
      .object({
        kind: z.enum(["rule_catalog", "generic_template", "human", "question_template"]),
        configId:uuid.optional(),sourceText:z.string().max(2000).optional(),
        id: text.optional(),
        version: z.number().int().positive().optional(),
        authorId: uuid.optional(),
      })
      .strict(),
    coverage: z.enum(["specialized", "generic", "human"]).optional(),
    basis: z.enum(["matched", "not_matched", "unknown", "not_applicable"]),
    evidence: z.array(z.unknown()).max(100),
  })
  .strict();
export const editQuestionsRequest = z
  .object({ version, questions: z.array(question).max(100) })
  .strict();
export const concludeRequest = z
  .object({ version, conclusion: z.string().trim().min(1).max(10000) })
  .strict();
export class MaterialService {
  readonly db;
  readonly tasks;
  constructor(
    readonly identity: Identity,
    store: FileStore,
  ) {
    this.db = identity.db;
    this.tasks = new TaskService(identity, store);
  }
  async assertApplicationRead(a:Actor,applicationId:string,snapshotId?:string){
    const app=await this.identity.applicationAccess(a,applicationId),job=found((await this.db.query('SELECT j.*,v.requirements FROM jobs j JOIN job_versions v ON v.job_id=j.id AND v.version=j.requirements_version WHERE j.id=$1',[app.job_id])).rows[0]);
    const source=snapshotId?(await this.db.query('SELECT m.resume_version_id,p.profile,v.requirements FROM match_snapshots m JOIN applications a ON a.id=m.application_id JOIN resume_versions r ON r.id=m.resume_version_id JOIN parse_results p ON p.id=r.parse_result_id LEFT JOIN job_versions v ON v.job_id=a.job_id AND v.version=m.job_version WHERE m.id=$1 AND m.application_id=$2',[snapshotId,applicationId])).rows[0]:null;
    const resume=source?{id:source.resume_version_id,profile:source.profile}:app.resume_version_id?(await this.db.query('SELECT r.id,p.profile FROM resume_versions r JOIN parse_results p ON p.id=r.parse_result_id WHERE r.id=$1',[app.resume_version_id])).rows[0]:{id:app.candidate_id,profile:(await this.db.query('SELECT profile FROM candidates WHERE id=$1',[app.candidate_id])).rows[0].profile};
    if(!(await matchingReadAccess(this.identity,a,source?{id:job.id,requirements:source.requirements||{}}:job,resume)).allowed)fail(403,'matching_inputs_forbidden');
    return {resume:await sourceFieldAccess(this.identity,a,{kind:'resume',id:resume.id},resume.profile),job:await sourceFieldAccess(this.identity,a,{kind:'job',id:job.id},{...job,requirements:source?.requirements||job.requirements})};
  }
  async assertMaterialAccess(a:Actor,kind:'questions'|'briefs',id:string){
    const table=kind==='questions'?'question_sets':'briefs',row=found((await this.db.query('SELECT application_id,inputs,data FROM '+table+' WHERE id=$1',[id])).rows[0]),access=await this.assertApplicationRead(a,row.application_id,row.inputs.matchSnapshotId),scope=row.inputs.sourceAccess;
    if(!scope){if(!access.resume.full||!access.job.full)fail(403,'material_source_forbidden');}
    else if(scope.fullResume&&!access.resume.full||scope.fullJob&&!access.job.full||(scope.resumeKeys||[]).some((key:string)=>!access.resume.keys.has(key))||(scope.jobKeys||[]).some((key:string)=>!access.job.keys.has(key)))fail(403,'material_source_forbidden');
    if(kind==='briefs')for(const source of decodeJSON(row.data).evaluations||[]){if(!Object.hasOwn(source,'summary'))continue;const current=await new ConfiguredEntities(this.identity).evaluationVersion(a,source.citation.evaluationId,source.citation.version);if(!Object.hasOwn(current.data,'summary'))fail(403,'material_source_forbidden');}
  }
  private async context(a: Actor, applicationId: string) {
    const app = await this.identity.applicationAccess(a, applicationId),
      matches = await this.tasks.matches(a, applicationId);
    if (!app.resume_version_id) fail(409, "resume_required");
    if (matches.stale || !matches.latest) fail(409, "matching_in_progress");
    if(!matches.latest.readable)fail(403,'matching_inputs_forbidden');
    const raw = await this.tasks.raw(a, app.resume_version_id,true),
      evaluationSources = await new InterviewService(this.identity).evaluations(a,applicationId,true),
      evaluations:Record<string,any>[]=await Promise.all(evaluationSources.map(async e=>({...e,...await new ConfiguredEntities(this.identity).evaluationVersion(a,e.id,e.version)})));
    const inputs = {
      jobVersion: matches.latest.job_version,
      resumeVersionId: app.resume_version_id,
      dictionaryVersion: matches.latest.dictionary_version,
      matchSnapshotId: matches.latest.id,
      matching: matches.latest.reference_score?.inputs?{templateRef:matches.latest.reference_score.inputs.templateRef,dictionaryRef:matches.latest.reference_score.inputs.dictionaryRef,algorithmVersion:matches.latest.algorithm_version}:null,
      legacyMatchingProvenanceUnknown:!!matches.latest.legacyProvenanceUnknown,
      sourceAccess:raw.sourceAccess,
      evaluationVersions: evaluations
        .filter((e) => e.status === "submitted")
        .map((e) => ({ id: e.id, version: e.version })),
    };
    return { app, match: matches.latest.data, raw, evaluations, inputs };
  }
  private writer(a: Actor) {
    requireRole(a, "admin", "manager", "recruiter", "interviewer");
  }
  private async revision(c: Sql, kind: string, row: any, a: Actor) {
    await c.query(
      "INSERT INTO material_versions(kind,material_id,version,data,actor_id) VALUES($1,$2,$3,$4,$5)",
      [
        kind,
        row.id,
        row.version,
        encodeJSON({
          data: decodeJSON(row.data),
          humanConclusion: row.human_conclusion ?? null,
        }),
        a.id,
      ],
    );
  }
  async questions(a: Actor, applicationId: string,input:unknown={}) {
    const request=parse(questionGenerationRequest,input);if(request.family)validateOption((await new BusinessDictionaryService(this.identity).dictionary(a,'job_families')).options,request.family);
    this.writer(a);
    return this.db.tx(async (c) => {
      const ctx = await this.context(a, applicationId),
        requirements = ctx.match.skills as any[];
      await c.query('SELECT id FROM jobs WHERE id=$1 FOR SHARE',[ctx.app.job_id]);
      const binding=await resolveJobTemplate(this.identity,c,ctx.app.job_id,'questions'),template=await loadTemplate(this.identity,'questions',binding.templateRef,c),doc=template.document as QuestionTemplate;
      const source=await this.assertApplicationRead(a,applicationId,ctx.inputs.matchSnapshotId),job=found((await c.query('SELECT name,level,version,question_bank FROM jobs WHERE id=$1',[ctx.app.job_id])).rows[0]),context:Record<string,unknown>={};
      const put=(placeholder:string,key:string,value:unknown,kind:'resume'|'job')=>{if(source[kind].keys.has(key))context[placeholder]=value??null;};
      put('candidate.name','name',ctx.raw.profile.name,'resume');put('candidate.skills','skills',ctx.raw.profile.skills,'resume');put('candidate.education','education',ctx.raw.profile.education,'resume');put('candidate.experienceYears','experienceYears',ctx.raw.profile.experienceYears,'resume');put('job.name','name',job.name,'job');put('job.level','level',job.level,'job');put('job.skills','requirements.skills',requirements.map(r=>r.requirement),'job');
      // Family and round are not inferred from a title or interview history.
      context['job.family']=request.family??null;context['interview.round']=request.round??null;
      const comparison=projectComparisonSource(ctx.match,false,false),questions=generateTemplateQuestions(doc,comparison,context,binding.templateRef);
      const learned=(job.question_bank?.learned||[]).slice(0,Math.max(0,100-questions.length));for(const q of learned)questions.push({id:q.id,group:q.group,skill:'岗位实际面试沉淀',prompt:q.prompt,followups:q.followups,referencePoints:q.referencePoints,source:{...q.source,id:q.id},coverage:'human',basis:'not_applicable',evidence:[]});
      const placeholderMap:Record<string,string>={'candidate.name':'name','candidate.skills':'skills','candidate.education':'education','candidate.experienceYears':'experienceYears','job.name':'name','job.skills':'requirements.skills','job.level':'level'},used=new Set<string>();
      if(doc.mode==='custom')for(const g of doc.groups)for(const q of g.questions)for(const text of [q.prompt,...q.followups,...q.referencePoints])for(const m of text.matchAll(/\{\{([^{}]+)\}\}/g))used.add(m[1].trim());
      const inputs={...ctx.inputs,jobQuestionBankVersion:job.question_bank?.version??null,questionContext:request,questionJobVersion:job.version,sourceAccess:{fullResume:false,fullJob:false,resumeKeys:[...new Set(['skills','education','experienceYears',...[...used].filter(k=>k.startsWith('candidate.')).map(k=>placeholderMap[k]).filter(Boolean)])],jobKeys:[...new Set(['requirements.skills','requirements.education','requirements.experienceYears','requirements.experienceMaxYears',...[...used].filter(k=>k.startsWith('job.')).map(k=>placeholderMap[k]).filter(Boolean)])]},questionTemplate:{ref:binding.templateRef,document:doc}};
      const row = (
        await c.query(
          "INSERT INTO question_sets(application_id,provider,inputs,data,actor_id) VALUES($1,'rules',$2,$3,$4) RETURNING *",
          [
            applicationId,
            inputs,
            encodeJSON({
              questions,
              coverageGaps:questions.filter(q=>q.coverageGap).map(q=>({groupId:q.groupId,questionId:q.id})),
              missingSkills: [
                ...new Set(
                  questions
                    .filter(
                      (q) => q.group === "专业深挖" && q.coverage === "generic",
                    )
                    .map((q) => q.skill),
                ),
              ],
              statement: questionStatement,
              coverageStatement:
                "规则题单需人工核对；generic_template 表示专业题库尚未覆盖。",
              model: modelCapability,
            }),
            a.id,
          ],
        )
      ).rows[0];
      await this.revision(c, "questions", row, a);
      await this.identity.audit(c, a.id, "questions.create", row.id);
      return { ...row, data: decodeJSON(row.data) };
    });
  }
  async editQuestions(a: Actor, id: string, input: unknown) {
    await this.assertMaterialAccess(a,'questions',id);
    this.writer(a);
    const b = parse(editQuestionsRequest, input);
    return this.db.tx(async (c) => {
      const old = found(
        (
          await c.query("SELECT * FROM question_sets WHERE id=$1 FOR UPDATE", [
            id,
          ])
        ).rows[0],
      );
      await this.identity.applicationAccess(a, old.application_id);
      if (old.version !== b.version) fail(409, "version_conflict");
      const data = decodeJSON(old.data),
        seen = new Set<string>();
      const questions = b.questions.map((q) => {
        if (seen.has(q.id)) fail(422, "duplicate_question_id");
        seen.add(q.id);
        const original = data.questions.find((x: any) => x.id === q.id);
        if (!original) {
          if (
            q.source.kind !== "human" ||
            !q.id.startsWith("human:") ||
            q.evidence.length ||
            q.basis !== "unknown"
          )
            fail(422, "citation_immutable");
          return {
            ...q,
            coverage: "human",
            source: { kind: "human", id: q.id, version: 1, authorId: a.id },
            evidence: [],
          };
        }
        if (
          ["group", "groupId", "questionId", "coverageGap", "skillGroups", "skill", "source", "coverage", "basis", "evidence"].some(
            (k) => !isDeepStrictEqual((q as any)[k], original[k]),
          )
        )
          fail(422, "citation_immutable");
        return q;
      });
      const row = (
        await c.query(
          "UPDATE question_sets SET data=$2,version=version+1 WHERE id=$1 RETURNING *",
          [id, encodeJSON({ ...data, questions })],
        )
      ).rows[0];
      await this.revision(c, "questions", row, a);
      await this.identity.audit(c, a.id, "questions.edit", id, {
        version: row.version,
      });
      return { ...row, data: decodeJSON(row.data) };
    });
  }
  async brief(a: Actor, applicationId: string) {
    this.writer(a);
    return this.db.tx(async (c) => {
      const ctx = await this.context(a, applicationId);
      const facts = ctx.raw.evidence
        .filter((e: any) => !["age", "gender"].includes(e.field))
        .map((e: any) => ({
          field: e.field,
          text: e.text,
          citation: {
            parseResultId: ctx.raw.parseResultId,
            resumeVersionId: ctx.raw.resumeVersionId,
            evidenceId: e.id,
            start: e.start,
            end: e.end,
            line: e.line,
          },
        }));
      const evaluations = ctx.evaluations
        .filter((e) => e.status === "submitted")
        .map((e) => ({
          round: e.round,
          authorId: e.author_id,
          summary: e.data.summary,
          humanConclusion: e.data.conclusion,
          citation: {
            evaluationId: e.id,
            version: e.version,
            path: "/api/v4/evaluations/" + e.id + "/versions/" + e.version,
          },
        }));
      const data = {
        nextSteps: [
          ...ctx.match.skills
            .filter((s: any) => s.status !== "matched")
            .map((s: any) => ({
              text:
                "围绕「" +
                s.requirement +
                "」补充可验证案例，再由面试官判断是否达到岗位要求。",
              citation: {
                path: "/api/v4/applications/" + applicationId + "/matches",
                matchSnapshotId: ctx.inputs.matchSnapshotId,
                jobVersion: ctx.inputs.jobVersion,
              },
            })),
          ...evaluations.map((e: any) => ({
            text:
              "复核第 " +
              e.round +
              " 轮人工评估与分歧，是否继续推进由负责人判断。",
            citation: e.citation,
          })),
          ...(!evaluations.length
            ? [
                {
                  text: "尚无已提交面试评估；可先安排人工核实，现有匹配度不构成录用结论。",
                  citation: {
                    path:
                      "/api/v4/applications/" + applicationId + "/evaluations",
                  },
                },
              ]
            : []),
        ],
        risks: [
          ...ctx.match.skills
            .filter((s: any) => s.status !== "matched")
            .map((s: any) => ({
              text:
                "「" +
                s.requirement +
                "」" +
                (s.status === "unknown" ? "字段未识别" : "原文未命中") +
                "；不等于不具备，请查看原句或补充材料。",
              citation: {
                path: "/api/v4/applications/" + applicationId + "/matches",
                matchSnapshotId: ctx.inputs.matchSnapshotId,
              },
            })),
          ...(ctx.match.hardGateHints || []).map((hint: any) => ({
            text: hint.text,
            citation: {
              path: "/api/v4/applications/" + applicationId + "/matches",
              matchSnapshotId: ctx.inputs.matchSnapshotId,
            },
          })),
        ],
        salaryConversation: [
          {
            text: !ctx.raw.sourceAccess.resumeKeys.includes('expectedSalary')?'薪酬信息由有权人核对。':ctx.raw.profile.expectedSalary
              ? "简历注明的期望薪资：" +
                ctx.raw.profile.expectedSalary +
                "。请核实币种、税前税后、月薪/年薪和发薪月数。"
              : "简历未明确期望薪资，请先向候选人核实金额和口径。",
            citation: {
              path: "/api/v4/resumes/" + ctx.raw.resumeVersionId + "/raw",
              resumeVersionId: ctx.raw.resumeVersionId,
              field: "expectedSalary",
            },
          },
          {
            text: "可询问：“您对固定与浮动薪酬、工作职责、发展空间及到岗安排的优先次序是什么？”具体报价由有权人结合获批岗位区间与审批结果确认。",
            citation: {
              path: "/api/v4/jobs/" + ctx.app.job_id + "/public-jd",
              jobVersion: ctx.inputs.jobVersion,
              kind: "rule_template",
              rule: "salary-conversation-v1",
            },
          },
        ],
        facts,
        humanAssertions: (ctx.raw.humanCorrections || []).map((fact: any) => ({
          ...fact,
          kind: "human_assertion",
          citation: {
            parseResultId: ctx.raw.parseResultId,
            resumeVersionId: ctx.raw.resumeVersionId,
            field: fact.field,
          },
        })),
        professionalComparison: ctx.match,
        evaluations,
        questions: ctx.match.skills
          .filter((s: any) => s.status !== "matched")
          .map((s: any) => ({
            skill: s.requirement,
            reason: s.status,
            source: {
              jobVersion: ctx.inputs.jobVersion,
              matchSnapshotId: ctx.inputs.matchSnapshotId,
            },
          })),
        statement:
          "事实与待核实问题。面试官评估为人工意见，最终结论由负责人填写。",
        model: modelCapability,
      };
      const row = (
        await c.query(
          "INSERT INTO briefs(application_id,provider,inputs,data,actor_id) VALUES($1,'rules',$2,$3,$4) RETURNING *",
          [applicationId, ctx.inputs, encodeJSON(data), a.id],
        )
      ).rows[0];
      await this.revision(c, "briefs", row, a);
      await this.identity.audit(c, a.id, "brief.create", row.id);
      return { ...row, data: decodeJSON(row.data) };
    });
  }
  async conclude(a: Actor, id: string, input: unknown) {
    await this.assertMaterialAccess(a,'briefs',id);
    requireRole(a, "admin", "manager", "recruiter");
    const b = parse(concludeRequest, input);
    return this.db.tx(async (c) => {
      const old = found(
        (await c.query("SELECT * FROM briefs WHERE id=$1 FOR UPDATE", [id]))
          .rows[0],
      );
      await this.identity.applicationAccess(a, old.application_id, true, c);
      if (old.version !== b.version) fail(409, "version_conflict");
      const row = (
        await c.query(
          "UPDATE briefs SET human_conclusion=$2,version=version+1 WHERE id=$1 RETURNING *",
          [
            id,
            { text: b.conclusion, actorId: a.id, at: new Date().toISOString() },
          ],
        )
      ).rows[0];
      await this.revision(c, "briefs", row, a);
      await this.identity.audit(c, a.id, "brief.conclude", id, {
        version: row.version,
      });
      return { ...row, data: decodeJSON(row.data) };
    });
  }
  async get(a: Actor, kind: "questions" | "briefs", id: string) {
    await this.assertMaterialAccess(a,kind,id);
    const table = kind === "questions" ? "question_sets" : "briefs",
      row = found(
        (await this.db.query("SELECT * FROM " + table + " WHERE id=$1", [id]))
          .rows[0],
      );
    await this.identity.applicationAccess(a, row.application_id);
    const match = await this.tasks.matches(a, row.application_id),
      versions = await new InterviewService(this.identity).evaluations(a,row.application_id,true);
    const evaluationStale =
      (row.inputs.evaluationVersions || []).some(
        (v: any) =>
          !versions.some((e) => e.id === v.id && e.version === v.version),
      ) || versions.length !== (row.inputs.evaluationVersions || []).length;
    const currentJob=kind==='questions'?(await this.db.query('SELECT version,question_bank FROM jobs WHERE id=$1',[match.binding.object.id])).rows[0]:null,questionJobVersion=currentJob?.version;
    const questionBinding=kind==='questions'?await this.db.tx(c=>resolveJobTemplate(this.identity,c,match.binding.object.id,'questions')):null,storedTemplate=row.inputs.questionTemplate?.ref,templateStale=!!storedTemplate&&!!questionBinding&&(storedTemplate.configId!==questionBinding.templateRef.configId||storedTemplate.version!==questionBinding.templateRef.version);
    return {
      ...row,
      data: decodeJSON(row.data),
      stale:
        templateStale ||
        (kind==='questions'&&row.inputs.jobQuestionBankVersion!==undefined&&row.inputs.jobQuestionBankVersion!==(currentJob?.question_bank?.version??null)) ||
        (kind==='questions'&&row.inputs.questionJobVersion!==undefined&&row.inputs.questionJobVersion!==questionJobVersion) ||
        match.stale ||
        row.inputs.matchSnapshotId !== match.latest?.id ||
        (kind === "briefs" && evaluationStale),
    };
  }
}
