import {historyAllowed} from './history.js';
import {sourceFieldAccess} from './bindings.js';
import {EvaluationUpgradeService} from './evaluation-versions.js';
import {Identity,requireRole,type Actor} from '../identity/service.js';
import {SourcingService} from '../sourcing/service.js';
import {CampusService} from '../campus/service.js';
import {InterviewService} from '../interviews/service.js';
import {leadInput,leadPatch} from '../sourcing/schema.js';
import {campusInput,campusPatch} from '../campus/schema.js';
import {interviewInput,interviewPatch,evaluationInput} from '../interviews/schema.js';
import {parse} from '../http/validation.js';
import {fail,found} from '../http/errors.js';
import {stripMetadata,prepareObjectWrite,finishObjectWrite,projectCore} from './object-fields.js';
import {assertObjectAccess,hasSalaryAccess} from './access.js';
import {loadDefinition,currentValues,projectFieldValues} from './fields.js';
export type ConfiguredEntity='lead'|'campus'|'interview';
export const entityCore=(kind:ConfiguredEntity,row:any)=>kind==='interview'?{...row,startsAt:row.starts_at instanceof Date?row.starts_at.toISOString():row.starts_at,durationMinutes:row.duration_minutes,meetingUrl:row.meeting_url}:kind==='lead'?{...row,ownerId:row.owner_id}:row;
export class ConfiguredEntities{
 readonly leads;readonly campus;readonly interviews;
 constructor(readonly identity:Identity){this.leads=new SourcingService(identity);this.campus=new CampusService(identity);this.interviews=new InterviewService(identity);}
 async project(a:Actor,kind:ConfiguredEntity,id:string){
  await assertObjectAccess(this.identity,a,{kind,id},'read',this.identity.db.sql);
  const table={lead:'leads',campus:'campuses',interview:'interviews'}[kind],row=found((await this.identity.db.query(`SELECT * FROM ${table} WHERE id=$1`,[id])).rows[0]);
  const p=await projectCore(this.identity,a,kind,entityCore(kind,row),{kind,id}),result={...p.core,customFields:p.customFields,definition:p.definition};
  if(kind==='lead'&&!(await sourceFieldAccess(this.identity,a,{kind,id},entityCore(kind,row))).full)delete result.raw;
  if(kind==='campus'){delete result.account_cipher;delete result.password_cipher;result.hasAccount=!!row.account_cipher;result.hasPassword=!!row.password_cipher;}
  if(kind==='interview')for(const [camel,snake] of Object.entries({startsAt:'starts_at',durationMinutes:'duration_minutes',meetingUrl:'meeting_url'})){if(Object.hasOwn(result,camel))result[snake]=result[camel];else delete result[snake];delete result[camel];}
  return result;
 }
 async write(a:Actor,kind:ConfiguredEntity,id:string|null,input:any,verifiedIds:ReadonlySet<string>=new Set()){return this.identity.db.tx(async()=>{
  requireRole(a,'admin','manager','recruiter');
  const bare=stripMetadata(input),schema=kind==='lead'?(id?leadPatch:leadInput):kind==='campus'?(id?campusPatch:campusInput):(id?interviewPatch:interviewInput);
  const old=id?await this.project(a,kind,id):null,body:any=parse<any>(schema,bare),coreOld=old?entityCore(kind,old):{},next={...coreOld,...body};
  const p=await prepareObjectWrite(this.identity,a,kind,id?{kind,id}:null,input,next,coreOld,id?'edit':'create'),wire=Object.fromEntries(Object.entries(p.core).filter(([key])=>Object.hasOwn(body,key)));
  const service=kind==='lead'?this.leads:kind==='campus'?this.campus:this.interviews;
  const row=id?(kind==='interview'?await this.interviews.update(a,id,wire,verifiedIds):await service.update(a,id,wire)):await service.create(a,wire,verifiedIds);await finishObjectWrite(this.identity,a,{kind,id:row.id},p);
  return {...await this.project(a,kind,row.id),...(kind==='interview'?{interviewerIds:row.interviewerIds,overlaps:row.overlaps}:{})};
 });}
 async evaluate(a:Actor,interviewId:string,input:any){return this.identity.db.tx(async c=>{
  const b=parse(evaluationInput,stripMetadata(input)),meeting=found((await c.query('SELECT * FROM interviews WHERE id=$1',[interviewId])).rows[0]);await this.identity.applicationAccess(a,meeting.application_id,false,c);
  a=await this.identity.evaluationActor(a,interviewId,b.forPrimary,c);
  const owner=b.forPrimary?meeting.primary_interviewer_id:a.id,old=(await c.query('SELECT * FROM evaluations WHERE interview_id=$1 AND author_id=$2',[interviewId,owner])).rows[0];
  if(old)await assertObjectAccess(this.identity,a,{kind:'evaluation',id:old.id},'write',c);
  const shown=await new EvaluationUpgradeService(this.identity).effective(a,interviewId,b.forPrimary);if(shown.template.mode==='custom'&&!b.templateRef)fail(409,'client_update_required');
  const p=await prepareObjectWrite(this.identity,a,'evaluation',old?{kind:'evaluation',id:old.id}:null,{...input,...b.data},{...old?.data,...b.data},old?.data||{},b.status==='draft'?'draft':'submit');
  const row=await this.interviews.evaluate(a,interviewId,b);await finishObjectWrite(this.identity,a,{kind:'evaluation',id:row.id},p);
  const values=await currentValues({kind:'evaluation',id:row.id},c);
  await c.query('UPDATE evaluation_versions SET configuration_refs=configuration_refs||$3::jsonb WHERE evaluation_id=$1 AND version=$2',[row.id,row.version,{fields:p.def.ref,fieldSnapshot:p.def.fields,values}]);
  return this.evaluationVersion(a,row.id,row.version);
 });}
 async evaluationVersion(a:Actor,id:string,version:number){
  const row=await this.interviews.evaluationVersion(a,id,version),p=await projectCore(this.identity,a,'evaluation',row.data),def=await loadDefinition(this.identity,'evaluation',this.identity.db.sql,a),snapshot=row.configuration_refs||{},salary=await hasSalaryAccess(this.identity,a,{kind:'evaluation',id},this.identity.db.sql);
  const full={...Object.fromEntries(def.fields.filter(f=>f.coreKey).map(f=>[f.fieldId,row.data[f.coreKey!]])),...snapshot.values};
  const saved=snapshot.fieldSnapshot||(snapshot.fields?(await this.identity.db.query('SELECT document FROM business_config_versions WHERE config_id=$1 AND version=$2',[snapshot.fields.configId,snapshot.fields.version])).rows[0]?.document?.fields:undefined),permitted=def.fields.filter(f=>historyAllowed(def,f,a,full,salary)),historical=(saved||[]).filter((f:any)=>permitted.some(p=>p.fieldId===f.fieldId));
  const projected=Object.fromEntries(Object.entries(full).filter(([id])=>permitted.some(f=>f.fieldId===id))),core=structuredClone(row.data);
  for(const f of def.fields.filter(f=>f.coreKey)){const path=f.coreKey!.split('.'),key=path.pop()!,parent=path.reduce((v,k)=>v?.[k],core);if(parent&&!Object.hasOwn(projected,f.fieldId))delete parent[key];}
  return {...row,id,last_editor_id:row.editor_id,interview_id:row.interview_id,data:core,template:snapshot.evaluationTemplate?{...snapshot.evaluationTemplate.document,ref:snapshot.evaluationTemplate.ref}:null,configuration_refs:{fields:snapshot.fields,evaluationTemplate:snapshot.evaluationTemplate},customFields:Object.fromEntries(Object.entries(projected).filter(([id])=>def.fields.some(f=>f.fieldId===id&&!f.coreKey))),fieldDefinition:{ref:snapshot.fields||null,fields:historical,optionLabelsRecorded:!!snapshot.fieldSnapshot,notice:saved?'当时保存的字段定义；按当前权限展示':'当时字段名称未记录'}};
 }
 async currentEvaluation(a:Actor,interviewId:string){const row=await this.interviews.evaluationForInterview(a,interviewId);return row?this.evaluationVersion(a,row.id,row.version):null;}
}
