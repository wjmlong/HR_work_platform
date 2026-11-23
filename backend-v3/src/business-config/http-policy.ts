import {JobQuestions} from '../materials/job-questions.js';
import {assertLegacySource} from './legacy-fields.js';
import {CandidateTools} from '../recruiting/tools.js';
import {EvaluationUpgradeService,evaluationUpgradePreview} from './evaluation-versions.js';
import {ChecklistService,checklistUpgradePreview} from '../recruiting/checklists.js';
import {checklistStage} from './checklist-template.js';
import {TemplateSelections,selectionPreviewRequest} from './selections.js';
import {BindingService,bindingPreviewRequest} from './bindings.js';
import {parse} from '../http/validation.js';
import {MaterialService} from '../materials/service.js';
import {FileStore} from '../files/storage.js';
import {TaskService} from '../tasks/service.js';
import type {FastifyRequest} from 'fastify';
import {Identity,requireRole} from '../identity/service.js';
import type {CommandResponsePolicy} from '../http/commands.js';
import {BusinessConfigService} from './service.js';
import {SalaryMigrationService} from './salary-migration.js';
import {ConfiguredEntities} from './entities.js';
import {found} from '../http/errors.js';
import {ConfiguredRecruiting} from './recruiting.js';
import {assertObjectAccess} from './access.js';
import {fail} from '../http/errors.js';
export function configurationPolicy(identity:Identity,req:FastifyRequest,route:string):CommandResponsePolicy<any>|undefined{
 const c=new ConfiguredRecruiting(identity),a=req.actor,id=(req.params as any)?.id;
 const mode=req.method+' '+route;
 const tools=new CandidateTools(identity);
 if(mode==='POST /api/v4/candidates/tools/merge-preview')return {authorize:async()=>{requireRole(a,'admin','manager','recruiter');await assertLegacySource(identity,a,['resume','application']);},toReceipt:()=>({input:req.body}),fromReceipt:(r:any)=>tools.mergePreview(a,r.input)};
 if(mode==='POST /api/v4/candidates/tools/reparse-preview')return {authorize:async()=>{requireRole(a,'admin','manager','recruiter');await assertLegacySource(identity,a,['resume','application']);},toReceipt:r=>({id:r.id}),fromReceipt:(r:any)=>tools.readReparsePreview(a,r.id)};
 if(['POST /api/v4/candidates/tools/merge','POST /api/v4/candidates/tools/reparse-apply','POST /api/v4/tasks/:id/duplicate'].includes(mode))return {authorize:async()=>{requireRole(a,'admin','manager','recruiter');await assertLegacySource(identity,a,['resume','application'],true);},toReceipt:r=>r,fromReceipt:async(r:any)=>r};
 if(['POST /api/v4/uploads/text','POST /api/v4/tasks/:id/cancel','POST /api/v4/tasks/:id/retry','POST /api/v4/tasks/:id/text'].includes(mode))return {authorize:async()=>{requireRole(a,'admin','manager','recruiter');},toReceipt:r=>({id:r.id}),fromReceipt:(r:any)=>new TaskService(identity,new FileStore(identity.config.storageRoot)).get(a,r.id)};

 if(['POST /api/v4/jobs/:id/question-bank','POST /api/v4/jobs/:id/question-bank/learn'].includes(mode))return {authorize:async()=>{await new JobQuestions(identity).get(a,id);},toReceipt:r=>r,fromReceipt:async r=>r};
 const checks=new ChecklistService(identity);
 if(['POST /api/v4/applications/:id/checklists/open','PATCH /api/v4/applications/:id/checklist-items/:itemId'].includes(mode))return {authorize:async()=>{requireRole(a,'admin','manager','recruiter');await identity.applicationAccess(a,id,true);},toReceipt:r=>({applicationId:id,stage:r.stage}),fromReceipt:(r:any)=>checks.completion(a,r.applicationId,r.stage)};
 if(mode==='POST /api/v4/applications/:id/checklists/:stage/upgrade-preview')return {authorize:async()=>{requireRole(a,'admin','manager','recruiter');await identity.applicationAccess(a,id,true);},toReceipt:()=>({input:req.body,stage:(req.params as any).stage}),fromReceipt:(r:any)=>checks.previewUpgrade(a,id,parse(checklistStage,r.stage),parse(checklistUpgradePreview,r.input).target)};
 if(mode==='POST /api/v4/business-config/checklists/adopt')return {authorize:()=>checks.authorize(a,req.body),toReceipt:r=>({applicationId:r.applicationId,stage:r.stage}),fromReceipt:(r:any)=>checks.completion(a,r.applicationId,r.stage)};
 const evaluations=new EvaluationUpgradeService(identity);
 if(mode==='POST /api/v4/interviews/:id/evaluation-template/preview')return {authorize:async()=>{requireRole(a,'admin','manager','recruiter','interviewer');await identity.applicationAccess(a,(await identity.db.query('SELECT application_id FROM interviews WHERE id=$1',[id])).rows[0]?.application_id);},toReceipt:()=>({input:req.body}),fromReceipt:(r:any)=>{const b=parse(evaluationUpgradePreview,r.input);return evaluations.preview(a,id,b.target,b.forPrimary);}};
 if(mode==='POST /api/v4/business-config/evaluations/adopt'){let bounded=a;return {authorize:async()=>{bounded=await evaluations.authorize(a,req.body);},toReceipt:r=>({id:r.id,version:r.version}),fromReceipt:(r:any)=>new ConfiguredEntities(identity).evaluationVersion(bounded,r.id,r.version)};}
 const selections=new TemplateSelections(identity);
 if(mode==='POST /api/v4/business-config/templates/preview')return {authorize:async()=>{requireRole(a,'admin','manager','recruiter');const b=parse(selectionPreviewRequest,req.body);await assertObjectAccess(identity,a,{kind:'job',id:b.jobId},'write',identity.db.sql);},toReceipt:()=>({scope:req.body}),fromReceipt:(r:any)=>{const b=parse(selectionPreviewRequest,r.scope);return selections.preview(a,b.jobId,b.purpose,b.target);}};
 if(mode==='POST /api/v4/business-config/templates/adopt')return {authorize:()=>selections.authorize(a,req.body),toReceipt:r=>r,fromReceipt:async(r:any)=>r};
 const bindings=new BindingService(identity);
 if(mode==='POST /api/v4/business-config/bindings/preview')return {authorize:async()=>{requireRole(a,'admin','manager','recruiter');const b=parse(bindingPreviewRequest,req.body);await assertObjectAccess(identity,a,b.object,'write',identity.db.sql);},toReceipt:()=>({scope:req.body}),fromReceipt:(r:any)=>{const b=parse(bindingPreviewRequest,r.scope);return bindings.preview(a,b.object,b.purpose,b.target,b.dictionaryRef);}};
 if(mode==='POST /api/v4/business-config/bindings/adopt')return {authorize:()=>bindings.authorizeAdoption(a,req.body),toReceipt:r=>r,fromReceipt:async(r:any)=>r};
 const materials=new MaterialService(identity,new FileStore(identity.config.storageRoot));
 if(mode==='POST /api/v4/applications/:id/recompute')return {authorize:async()=>{requireRole(a,'admin','manager','recruiter');await identity.applicationAccess(a,id,true);},toReceipt:r=>({id:r.id}),fromReceipt:(r:any)=>new TaskService(identity,new FileStore(identity.config.storageRoot)).get(a,r.id)};
 const materialKind=route==='/api/v4/applications/:id/questions'||route==='/api/v4/questions/:id'?'questions':route==='/api/v4/applications/:id/briefs'||route==='/api/v4/briefs/:id/conclusion'?'briefs':null;
 if(materialKind&&['POST','PATCH'].includes(req.method))return {authorize:async()=>{if(route==='/api/v4/briefs/:id/conclusion')requireRole(a,'admin','manager','recruiter');else requireRole(a,'admin','manager','recruiter','interviewer');if(route.startsWith('/api/v4/applications/'))await materials.assertApplicationRead(a,id);else await materials.assertMaterialAccess(a,materialKind,id);},toReceipt:r=>({id:r.id}),fromReceipt:(r:any)=>materials.get(a,materialKind,r.id)};

 if(mode==='POST /api/v4/business-config/drafts/:id/preview')return {authorize:async()=>{requireRole(a,'admin');},toReceipt:()=>({draftId:id}),fromReceipt:(r:any)=>new BusinessConfigService(identity).preview(a,r.draftId)};
 if(mode==='POST /api/v4/business-config/salary/preview')return {authorize:async()=>{requireRole(a,'admin');},toReceipt:()=>({scope:req.body}),fromReceipt:(r:any)=>new SalaryMigrationService(identity).previewSalaryMigration(a,r.scope)};

 const entity=route==='/api/v4/leads'||route==='/api/v4/leads/:id'?'lead':route==='/api/v4/campus'||route==='/api/v4/campus/:id'?'campus':route==='/api/v4/interviews'||route==='/api/v4/interviews/:id'?'interview':null;
 const general=new ConfiguredEntities(identity);
 if(['POST /api/v4/leads/:id/transition','POST /api/v4/leads/:id/followups'].includes(mode))return {authorize:async()=>{requireRole(a,'admin','manager','recruiter');await assertObjectAccess(identity,a,{kind:'lead',id},'write',identity.db.sql);},toReceipt:r=>({id:r.id}),fromReceipt:(r:any)=>general.project(a,'lead',r.id)};
 if(['POST /api/v4/applications/:id/transition','POST /api/v4/applications/:id/transfer','POST /api/v4/applications/:id/collection-completion','POST /api/v4/applications/:id/resume'].includes(mode))return {authorize:async()=>{requireRole(a,'admin','manager','recruiter');await identity.applicationAccess(a,id,true);},toReceipt:r=>({id:r.id,...(r.ccReminder!==undefined?{ccReminder:r.ccReminder}:{})}),fromReceipt:async(r:any)=>({...await c.projectApplication(a,r.id),...(r.ccReminder!==undefined?{ccReminder:r.ccReminder}:{})})};
 // Deletion receipts contain identity and state only, including after deletion
 // makes the ordinary read path unavailable. Never cache the returned full row.
 if(mode==='POST /api/v4/candidates/:id/archive')return {authorize:async()=>{requireRole(a,'admin','manager','recruiter');},toReceipt:r=>r,fromReceipt:async(r:any)=>r};
 if(['POST /api/v4/interviews/:id/delete','POST /api/v4/leads/:id/delete','POST /api/v4/campus/:id/delete','POST /api/v4/candidates/:id/delete','POST /api/v4/applications/:id/delete'].includes(mode))return {authorize:async()=>{requireRole(a,'admin','manager','recruiter');},toReceipt:r=>({id:r.id,version:r.version,deleted_at:r.deleted_at}),fromReceipt:async(r:any)=>r};

 if(entity&&['POST','PATCH'].includes(req.method))return {authorize:async()=>{requireRole(a,'admin','manager','recruiter');if(id)await assertObjectAccess(identity,a,{kind:entity,id},'write',identity.db.sql);},toReceipt:r=>({id:r.id,...(entity==='interview'?{interviewerIds:r.interviewerIds,overlaps:r.overlaps}:{})}),fromReceipt:async(r:any)=>({...await general.project(a,entity,r.id),...(entity==='interview'?{interviewerIds:r.interviewerIds,overlaps:r.overlaps}:{})})};
 if(mode==='PUT /api/v4/interviews/:id/evaluation'){let bounded=a;return {authorize:async()=>{
  bounded=await identity.evaluationActor(bounded,id,(req.body as any).forPrimary===true);
  const a=bounded;
  requireRole(a,'admin','manager','recruiter','interviewer');const meeting=found((await identity.db.query('SELECT * FROM interviews WHERE id=$1',[id])).rows[0]);await identity.applicationAccess(a,meeting.application_id);
  const writer=a.roles.some(r=>['admin','manager','recruiter'].includes(r)),body=req.body as any;
  if(body.forPrimary&&meeting.primary_interviewer_id!==a.id&&!writer)fail(403,'forbidden');
  if(!body.forPrimary&&!a.temporaryScope&&!(await identity.db.query('SELECT 1 FROM interviewers WHERE interview_id=$1 AND user_id=$2 AND NOT temporary_access',[id,a.id])).rowCount)fail(403,'forbidden');
 },toReceipt:r=>({id:r.id,version:r.version}),fromReceipt:(r:any)=>general.evaluationVersion(bounded,r.id,r.version)};}

 let kind:'job'|'application'|'resume'|'person'|undefined;
 if(['POST /api/v4/jobs','PATCH /api/v4/jobs/:id'].includes(mode))kind='job';
 if(['POST /api/v4/applications','PATCH /api/v4/applications/:id/fields'].includes(mode))kind='application';
 if(['POST /api/v4/candidates','PATCH /api/v4/candidates/:id'].includes(mode))kind='person';
 if(mode==='POST /api/v4/resumes/:id/corrections')kind='resume';
 if(!kind)return;
 return {
  authorize:async()=>{requireRole(a,'admin','manager','recruiter');if(id&&kind!=='person')await assertObjectAccess(identity,a,{kind:kind!,id},kind==='resume'?'read':'write',identity.db.sql);if(id&&kind==='person')await c.r.candidate(a,id);},
  toReceipt:r=>kind==='resume'?{resumeVersionId:r.resumeVersionId,parseResultId:r.parseResultId,candidateId:r.candidateId,candidateNameUpdated:!!r.candidateNameUpdated,candidateNameConflict:!!r.candidateNameConflict,applicationUpdated:!!r.applicationUpdated}:{id:r.id},
  fromReceipt:async(receipt:any)=>{if(kind==='job')return c.projectJob(a,receipt.id);if(kind==='application')return c.projectApplication(a,receipt.id);if(kind==='person')return c.person(a,receipt.id);
   if(!receipt.resumeVersionId)fail(409,'client_update_required');await assertObjectAccess(identity,a,{kind:'resume',id:receipt.resumeVersionId},'read',identity.db.sql);return receipt;},
 };
}
