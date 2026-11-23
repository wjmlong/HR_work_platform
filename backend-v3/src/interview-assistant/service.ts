import {sourceFieldAccess} from '../business-config/bindings.js';
import {Identity,requireRole,type Actor} from '../identity/service.js';
import {fail,found} from '../http/errors.js';
import {parse,z} from '../http/validation.js';
import {EvaluationUpgradeService} from '../business-config/evaluation-versions.js';
import {InterviewService} from '../interviews/service.js';
import {segmentSchema,validateAnalysis,type TranscriptSegment} from './contracts.js';
export class InterviewAssistant {
 constructor(readonly identity:Identity){}
 get db(){return this.identity.db;}
 async access(a:Actor,interviewId:string){
  a=await this.identity.interviewActor(a,interviewId);
  const interview=found((await this.db.query('SELECT * FROM interviews WHERE id=$1 AND deleted_at IS NULL',[interviewId])).rows[0]);
  return interview;
 }
 async list(a:Actor,interviewId:string){a=await this.identity.interviewActor(a,interviewId);await this.access(a,interviewId);return (await this.db.query('SELECT id,state,owner_id,revision,created_at FROM interview_assistant_sessions WHERE interview_id=$1 ORDER BY created_at DESC LIMIT 30',[interviewId])).rows;}
 async read(a:Actor,interviewId:string,sessionId:string){a=await this.identity.interviewActor(a,interviewId);await this.access(a,interviewId);const row=found((await this.db.query("SELECT s.*,EXISTS(SELECT 1 FROM audit_events a WHERE a.kind='interview.assistant.adopt' AND a.entity_id=s.id::text) adopted FROM interview_assistant_sessions s WHERE s.id=$1 AND s.interview_id=$2",[sessionId,interviewId])).rows[0]);await this.sourceAccess(a,row.basis);return row;}
 async sourceAccess(a:Actor,basis:any){if(!basis.jobId)return;const job=found((await this.db.query('SELECT j.*,v.requirements FROM jobs j JOIN job_versions v ON v.job_id=j.id AND v.version=j.requirements_version WHERE j.id=$1',[basis.jobId])).rows[0]);const access=await sourceFieldAccess(this.identity,a,{kind:'job',id:job.id},job);if((basis.sourceKeys||[]).some((key:string)=>!access.keys.has(key)))fail(403,'material_source_forbidden');}

 async start(a:Actor,interviewId:string,input:unknown){
  parse(z.object({consent:z.literal(true)}).strict(),input);
  a=await this.identity.interviewActor(a,interviewId);const interview=await this.access(a,interviewId);if(interview.status==='cancelled')fail(409,'interview_cancelled');
  const effective=await new EvaluationUpgradeService(this.identity).effective(a,interviewId,!a.temporaryScope);
  const context=found((await this.db.query('SELECT j.*,jv.requirements FROM applications a JOIN jobs j ON j.id=a.job_id JOIN job_versions jv ON jv.job_id=j.id AND jv.version=j.requirements_version WHERE a.id=$1',[interview.application_id])).rows[0]);
  const source=await sourceFieldAccess(this.identity,a,{kind:'job',id:context.id},context),requirements:Record<string,unknown>={},sourceKeys:string[]=[];
  for(const key of ['skills','description','experienceYears','experienceMaxYears','education'])if(source.keys.has('requirements.'+key)&&context.requirements[key]!==undefined){requirements[key]=context.requirements[key];sourceKeys.push('requirements.'+key);}
  if(source.keys.has('name'))sourceKeys.push('name');
  const basis={jobId:context.id,sourceKeys,job:source.keys.has('name')?context.name:'',requirements,template:effective.template,dimensions:effective.template.dimensions.filter((d:any)=>d.active).map((d:any)=>({id:d.id,label:d.label,description:d.description}))};
  return this.db.tx(async c=>{
   a=await this.identity.interviewActor(a,interviewId);await this.access(a,interviewId);
   await c.query('SELECT id FROM interviews WHERE id=$1 FOR UPDATE',[interviewId]);
   const old=(await c.query("SELECT * FROM interview_assistant_sessions WHERE interview_id=$1 AND state='active'",[interviewId])).rows[0];
   if(old){await this.sourceAccess(a,old.basis);if(old.owner_id!==a.id)fail(409,'assistant_session_owner');return old;}
   await this.sourceAccess(a,basis);
   const row=(await c.query('INSERT INTO interview_assistant_sessions(interview_id,owner_id,basis) VALUES($1,$2,$3) RETURNING *',[interviewId,a.id,basis])).rows[0];
   await this.identity.audit(c,a.id,'interview.assistant.start',row.id,{interviewId,consent:true});return row;
  });
 }
 async abandon(a:Actor,interviewId:string,sessionId:string,input:unknown){
  const b=parse(z.object({revision:z.number().int().positive(),reason:z.string().trim().min(1).max(500)}).strict(),input);
  return this.db.tx(async c=>{
   a=await this.identity.interviewActor(a,interviewId);await this.access(a,interviewId);
   const row=found((await c.query('SELECT * FROM interview_assistant_sessions WHERE id=$1 AND interview_id=$2 FOR UPDATE',[sessionId,interviewId])).rows[0]);
   if(row.owner_id!==a.id&&!a.roles.some(r=>['admin','manager','recruiter'].includes(r)))fail(403,'assistant_session_owner');
   if(row.state!=='active')fail(409,'assistant_session_finished');if(row.revision!==b.revision)fail(409,'assistant_transcript_changed');
   await c.query("UPDATE interview_assistant_sessions SET state='abandoned',updated_at=now() WHERE id=$1",[sessionId]);
   await this.identity.audit(c,a.id,'interview.assistant.abandon',sessionId,{reason:b.reason,revision:b.revision});return {id:sessionId,state:'abandoned'};
  });
 }
 async append(a:Actor,interviewId:string,sessionId:string,input:unknown){
  const segment=parse(segmentSchema,input);a=await this.identity.interviewActor(a,interviewId);await this.access(a,interviewId);
  return this.db.tx(async c=>{
   a=await this.identity.interviewActor(a,interviewId);await this.access(a,interviewId);
   const row=found((await c.query('SELECT * FROM interview_assistant_sessions WHERE id=$1 AND interview_id=$2 FOR UPDATE',[sessionId,interviewId])).rows[0]);
   await this.sourceAccess(a,row.basis);
   if(row.owner_id!==a.id)fail(403,'assistant_session_owner');if(row.state!=='active')fail(409,'assistant_session_finished');
   const segments:TranscriptSegment[]=row.segments,old=segments.find(s=>s.id===segment.id);
   if(old){if(JSON.stringify(old)!==JSON.stringify(segment)&&Object.keys(segment).some(k=>old[k as keyof TranscriptSegment]!==segment[k as keyof TranscriptSegment]))fail(409,'assistant_segment_conflict');return row;}
   if(segment.parentId){const parent=segments.find(s=>s.id===segment.parentId);if(!parent||parent.speaker!=='mixed'||segment.source!=='manual'||!['candidate','interviewer'].includes(segment.speaker)||!parent.text.includes(segment.text)||segment.startMs!==parent.startMs||segment.endMs!==parent.endMs)fail(422,'assistant_excerpt_invalid');}
   if(segments.some(s=>s.sequence===segment.sequence))fail(409,'assistant_sequence_conflict');
   if(segments.length>=2400||segments.reduce((n,s)=>n+s.text.length,0)+segment.text.length>200000)fail(422,'assistant_transcript_limit');
   segments.push(segment);segments.sort((x,y)=>x.sequence-y.sequence);
   return (await c.query('UPDATE interview_assistant_sessions SET segments=$2,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *',[sessionId,JSON.stringify(segments)])).rows[0];
  });
 }
 async setSpeaker(a:Actor,interviewId:string,sessionId:string,input:unknown){
  const b=parse(z.object({segmentId:z.string().min(1),speaker:z.enum(['candidate','interviewer','unknown','mixed']),revision:z.number().int().positive()}).strict(),input);a=await this.identity.interviewActor(a,interviewId);await this.access(a,interviewId);
  return this.db.tx(async c=>{
   a=await this.identity.interviewActor(a,interviewId);await this.access(a,interviewId);
   const row=found((await c.query('SELECT * FROM interview_assistant_sessions WHERE id=$1 AND interview_id=$2 FOR UPDATE',[sessionId,interviewId])).rows[0]);
   await this.sourceAccess(a,row.basis);
   if(row.owner_id!==a.id)fail(403,'assistant_session_owner');if(row.state!=='active')fail(409,'assistant_session_finished');if(row.revision!==b.revision)fail(409,'assistant_transcript_changed');
   const segment=found((row.segments as TranscriptSegment[]).find(s=>s.id===b.segmentId)),previous=segment.speaker;segment.speaker=b.speaker;
   await this.identity.audit(c,a.id,'interview.assistant.speaker',sessionId,{segmentId:b.segmentId,previous,speaker:b.speaker,revision:b.revision});
   return (await c.query('UPDATE interview_assistant_sessions SET segments=$2,revision=revision+1,analysis=NULL,analysis_revision=NULL,updated_at=now() WHERE id=$1 RETURNING *',[sessionId,JSON.stringify(row.segments)])).rows[0];
  });
 }
 async adopt(a:Actor,interviewId:string,sessionId:string,input:unknown){
  const b=parse(z.object({confirmed:z.literal(true),version:z.number().int().min(0)}).strict(),input);
  return this.db.tx(async c=>{
   a=await this.identity.interviewActor(a,interviewId);await this.access(a,interviewId);
   await c.query('SELECT id FROM interview_assistant_sessions WHERE id=$1 FOR UPDATE',[sessionId]);
   const row=await this.read(a,interviewId,sessionId);if(row.state!=='finished'||!row.analysis||row.analysis_revision!==row.revision)fail(409,'assistant_not_finished');
   const service=new InterviewService(this.identity),old=await service.evaluationForInterview(a,interviewId);
   if((old?.version||0)!==b.version)fail(409,'version_conflict');
   if(row.adopted)fail(409,'assistant_already_adopted');
   const current=await new EvaluationUpgradeService(this.identity).effective(a,interviewId,!a.temporaryScope);
   if(current.template.ref?.configId!==row.basis.template.ref?.configId||current.template.ref?.version!==row.basis.template.ref?.version)fail(409,'configuration_changed');
   const report=validateAnalysis(row.analysis,row.segments,row.basis.dimensions.map((d:any)=>d.id));
   if(!report.dimensions.some(d=>d.status==='evidence'))fail(409,'assistant_candidate_evidence_required');
   const summary=report.dimensions.map(d=>(row.basis.dimensions.find((x:any)=>x.id===d.dimensionId)?.label||d.dimensionId)+'：'+d.summary).join('\n');
   const evidence=report.dimensions.flatMap(d=>d.evidence.map(e=>'['+e.segmentId+'] '+e.quote)).join('\n');
   const append=(prior:string|undefined,text:string)=>[prior,'AI 面试辅助草稿（人工核对后采用；会话 '+sessionId+'）',text].filter(Boolean).join('\n\n');
   const data={summary:append(old?.data?.summary,summary),evidenceNotes:append(old?.data?.evidenceNotes,evidence),risks:append(old?.data?.risks,report.nextSteps.join('\n'))};
   if(Object.values(data).some(v=>v.length>10000))fail(422,'assistant_draft_too_long');
   const saved=await service.evaluate(a,interviewId,{version:b.version,status:'draft',forPrimary:!a.temporaryScope,templateRef:current.template.ref,data});
   await this.identity.audit(c,a.id,'interview.assistant.adopt',sessionId,{evaluationId:saved.id,version:saved.version});return saved;
  });
 }
 async saveAnalysis(a:Actor,interviewId:string,sessionId:string,revision:number,input:unknown,final=false){
  a=await this.identity.interviewActor(a,interviewId);await this.access(a,interviewId);
  return this.db.tx(async c=>{
   a=await this.identity.interviewActor(a,interviewId);await this.access(a,interviewId);
   const row=found((await c.query('SELECT * FROM interview_assistant_sessions WHERE id=$1 AND interview_id=$2 FOR UPDATE',[sessionId,interviewId])).rows[0]);
   await this.sourceAccess(a,row.basis);
   if(row.owner_id!==a.id)fail(403,'assistant_session_owner');if(row.state!=='active')fail(409,'assistant_session_finished');if(row.revision!==revision)fail(409,'assistant_transcript_changed');
   let analysis;try{analysis=validateAnalysis(input,row.segments,row.basis.dimensions.map((d:any)=>d.id));}catch{fail(502,'assistant_evidence_invalid');}
   if(final&&row.segments.some((s:TranscriptSegment)=>s.speaker==='unknown'||s.speaker==='mixed')&&!analysis.discussionSummary?.length)fail(502,'assistant_minutes_missing');
   await c.query('INSERT INTO interview_assistant_analyses(session_id,transcript_revision,data,final) VALUES($1,$2,$3,$4)',[sessionId,revision,analysis,final]);
   const saved=(await c.query("UPDATE interview_assistant_sessions SET analysis=$2,analysis_revision=$3,state=$4,updated_at=now() WHERE id=$1 RETURNING *",[sessionId,analysis,revision,final?'finished':'active'])).rows[0];
   await this.identity.audit(c,a.id,final?'interview.assistant.finish':'interview.assistant.analyze',sessionId,{revision});return saved;
  });
 }
}
