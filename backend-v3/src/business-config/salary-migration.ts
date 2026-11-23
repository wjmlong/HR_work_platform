import {randomUUID,createHash,timingSafeEqual} from 'node:crypto';
import {Identity,requireRole,type Actor} from '../identity/service.js';
import {z,parse,uuid} from '../http/validation.js';
import {fail,found} from '../http/errors.js';
import {decodeRaw} from '../parsing/profile.js';
import {decodeJSON} from '../parsing/json.js';
import {TaskService} from '../tasks/service.js';
import {FileStore} from '../files/storage.js';
import {Jobs} from '../recruiting/jobs.js';
import {BusinessConfigService} from './service.js';
import {readFieldValues,writeFieldValues} from './fields.js';
import {interpretSalary,type MoneyValue} from './money.js';
import {publishRequest} from './schema.js';
import type {ObjectRef,PreviewReceipt} from './types.js';
export const salaryScope=z.object({entity:z.enum(['resume','application','job']).default('resume'),field:z.enum(['expected','salaryRange','marketSalary']).default('expected'),ids:z.array(uuid).max(500).optional(),cursor:uuid.optional(),targetFieldId:z.string().max(100).optional()}).strict();
const scopeSchema=salaryScope;
export const salaryApply=z.object({receipt:publishRequest,selectedIds:z.array(uuid).min(1).max(500)}).strict();
type Scope=z.infer<typeof scopeSchema>;
type Source={object:ObjectRef;objectVersion:number;parseResultId?:string;raw:string;context:string;stamp:string};
export type SalaryMapping=Source&{classification:'annual_explicit'|'monthly_with_months'|'unknown';proposedAnnual:string|null;proposed:MoneyValue|null;basis:string;targetFieldId:string;currentValue:unknown};
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const target=(scope:Scope)=>scope.targetFieldId||`builtin.${scope.entity}.${scope.entity==='job'?(scope.field==='marketSalary'?'marketCompensation':'salaryCompensation'):'expectedCompensation'}`;
export class SalaryMigrationService{
 constructor(readonly identity:Identity){}
 get db(){return this.identity.db;}
 private sourceText(row:any){
  const value=typeof row.profile?.expectedSalary==='string'?row.profile.expectedSalary:'';
  const corrections=decodeJSON(row.human_corrections||[]) as any[];
  if(corrections.some(c=>c.field==='expectedSalary'))return {raw:value,context:value};
  const evidence=(decodeJSON(row.evidence||[]) as any[]).find(e=>e.field==='expectedSalary');
  if(evidence&&row.raw_bytes){const raw=decodeRaw(row.raw_bytes),start=raw.lastIndexOf('\n',evidence.start-1)+1,end=raw.indexOf('\n',evidence.end);return {raw:value,context:raw.slice(start,end<0?raw.length:end)};}
  return {raw:value,context:value};
 }
 private async sources(scope:Scope):Promise<Source[]>{
  const params=[scope.ids||null,scope.cursor||null];
  if(scope.entity==='job'){
   const column=scope.field==='marketSalary'?'market_salary':'salary_range';
   const rows=(await this.db.query(`SELECT id,version,${column} raw FROM jobs WHERE ($1::uuid[] IS NULL OR id=ANY($1)) AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 501`,params)).rows;
   return rows.map(r=>({object:{kind:'job',id:r.id},objectVersion:r.version,raw:r.raw||'',context:r.raw||'',stamp:hash(r)}));
  }
  const rows=scope.entity==='application'?(await this.db.query(`SELECT a.id,a.version,a.resume_version_id,p.profile,p.evidence,p.human_corrections,p.raw_bytes,r.parse_result_id FROM applications a JOIN candidates c ON c.id=a.candidate_id JOIN resume_versions r ON r.id=a.resume_version_id JOIN parse_results p ON p.id=r.parse_result_id WHERE a.is_current AND a.deleted_at IS NULL AND c.deleted_at IS NULL AND ($1::uuid[] IS NULL OR a.id=ANY($1)) AND ($2::uuid IS NULL OR a.id>$2) ORDER BY a.id LIMIT 501`,params)).rows:(await this.db.query(`SELECT r.id,r.parse_result_id,p.profile,p.evidence,p.human_corrections,p.raw_bytes,c.version candidate_version,(SELECT jsonb_agg(jsonb_build_array(a.id,a.version) ORDER BY a.id) FROM applications a WHERE a.is_current AND a.deleted_at IS NULL AND a.resume_version_id=r.id) observations FROM resume_versions r JOIN candidates c ON c.id=r.candidate_id JOIN parse_results p ON p.id=r.parse_result_id WHERE c.deleted_at IS NULL AND EXISTS(SELECT 1 FROM applications a WHERE a.is_current AND a.deleted_at IS NULL AND a.resume_version_id=r.id) AND ($1::uuid[] IS NULL OR r.id=ANY($1)) AND ($2::uuid IS NULL OR r.id>$2) ORDER BY r.id LIMIT 501`,params)).rows;
  return rows.map(r=>({object:{kind:scope.entity,id:r.id},objectVersion:r.version||1,parseResultId:r.parse_result_id,...this.sourceText(r),stamp:hash([r.id,r.version,r.resume_version_id,r.parse_result_id,r.candidate_version,r.observations])}));
 }
 async previewSalaryMigration(a:Actor,input:unknown):Promise<{receipt:PreviewReceipt;items:SalaryMapping[];hasMore:boolean;nextCursor:string|null}>{
  requireRole(a,'admin');const scope=parse(scopeSchema,input),configs=new BusinessConfigService(this.identity),def=await configs.effective(a,scope.entity),targetFieldId=target(scope);
  if(!def.fields.some(f=>f.fieldId===targetFieldId&&f.active&&['money','money_range'].includes(f.type)))fail(422,'salary_target_unavailable');
  const sources=await this.sources(scope),visible=sources.slice(0,500),items:SalaryMapping[]=[];
  for(const source of visible){const p=interpretSalary(source.context),currentValue=(await readFieldValues(this.identity,a,source.object,this.db.sql))[targetFieldId]??null;items.push({...source,...p,raw:source.raw,proposed:p.proposed?{...p.proposed,raw:source.raw}:null,basis:p.basis+(source.context!==source.raw?'；原文依据：'+source.context:''),targetFieldId,currentValue});}
  const body={draftId:randomUUID(),draftVersion:1,baseVersion:def.ref.version,actorId:a.id,inputHash:hash([scope,def.aclRevision]),impactHash:hash(visible.map(s=>[s.object,s.stamp,s.raw]))};
  const receipt={...body,signature:this.identity.hash('salary-preview:'+JSON.stringify(body))};
  await this.db.query('INSERT INTO migration_receipts(source_sha256,source_revision,manifest) VALUES($1,$2,$3)',[this.identity.hash('salary-preview:'+body.draftId),'salary-preview-v1',{kind:'salary-preview',actorId:a.id,actorVersion:a.version,expires:Date.now()+30*60*1000,receipt,scope,definitionRevision:def.aclRevision,items}]);
  return {receipt,items,hasMore:sources.length>500,nextCursor:visible.at(-1)?.object.id||null};
 }
 async applySalaryMigration(a:Actor,input:unknown):Promise<{applied:number;conflicts:string[];versions:any[]}>{
  requireRole(a,'admin');const b=parse(salaryApply,input),{signature,...body}=b.receipt;
  const actual=Buffer.from(signature,'hex'),expected=Buffer.from(this.identity.hash('salary-preview:'+JSON.stringify(body)),'hex');
  if(body.actorId!==a.id||actual.length!==expected.length||!timingSafeEqual(actual,expected))fail(409,'salary_preview_invalid');
  return this.db.tx(async c=>{
   const row=found((await c.query('SELECT manifest FROM migration_receipts WHERE source_sha256=$1 FOR UPDATE',[this.identity.hash('salary-preview:'+body.draftId)])).rows[0]),preview=row.manifest;
   if(preview.kind!=='salary-preview'||preview.actorVersion!==a.version||preview.actorId!==a.id||preview.expires<Date.now()||JSON.stringify(preview.receipt)!==JSON.stringify(b.receipt)){
    // JSONB object ordering is not a signing format; compare the complete receipt by its fields.
    if(preview.kind!=='salary-preview'||preview.actorVersion!==a.version||preview.actorId!==a.id||preview.expires<Date.now()||Object.keys(b.receipt).some(k=>preview.receipt[k]!==((b.receipt as any)[k])))fail(409,'salary_preview_invalid');
   }
   const selected=[...new Set(b.selectedIds)].sort(),selectionHash=hash(selected);
   if(preview.applied){if(preview.selectionHash!==selectionHash)fail(409,'salary_preview_already_applied');return preview.applied;}
   const items=(preview.items as SalaryMapping[]).filter(s=>selected.includes(s.object.id));
   if(items.length!==selected.length||items.some(i=>!i.proposed))fail(422,'salary_manual_mapping_required');
   const scope=preview.scope as Scope,def=await new BusinessConfigService(this.identity).effective(a,scope.entity);
   if(def.aclRevision!==preview.definitionRevision)fail(409,'configuration_changed');
   // Lock every observed business row before checking the preview again.
   const ids=items.map(i=>i.object.id);
   if(scope.entity==='resume'){
    await c.query('SELECT c.id FROM candidates c JOIN resume_versions r ON r.candidate_id=c.id WHERE r.id=ANY($1::uuid[]) ORDER BY c.id FOR UPDATE OF c',[ids]);
    await c.query('SELECT a.id FROM applications a WHERE a.is_current AND a.resume_version_id=ANY($1::uuid[]) ORDER BY a.id FOR UPDATE',[ids]);
   }else await c.query(`SELECT id FROM ${scope.entity==='job'?'jobs':'applications'} WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`,[ids]);
   const current=await this.sources({...scope,ids,cursor:undefined});
   if(items.some(i=>!current.some(s=>s.object.id===i.object.id&&s.stamp===i.stamp&&s.raw===i.raw)))fail(409,'salary_preview_stale');
   const versions:any[]=[];
   for(const item of items){
    if(scope.entity==='resume'){
     const result=await new TaskService(this.identity,new FileStore(this.identity.config.storageRoot)).correctResume(a,item.object.id,{baseParseResultId:item.parseResultId,reason:'人工确认薪酬迁移；'+item.basis,corrections:{},definitionVersion:def.ref.version,definitionRevision:def.aclRevision,customFields:{[item.targetFieldId]:item.proposed}});
     versions.push({sourceId:item.object.id,...result,targetFieldId:item.targetFieldId});
    }else{
     await writeFieldValues(this.identity,a,item.object,{definitionVersion:def.ref.version,definitionRevision:def.aclRevision,customFields:{[item.targetFieldId]:item.proposed},evidenceBasis:'人工确认薪酬迁移；'+item.basis},c);
     const updated=scope.entity==='job'?await new Jobs(this.identity).update(a,item.object.id,{version:item.objectVersion}):(await c.query('UPDATE applications SET version=version+1,updated_at=now() WHERE id=$1 RETURNING id,version',[item.object.id])).rows[0];
     versions.push({sourceId:item.object.id,id:item.object.id,version:updated.version,targetFieldId:item.targetFieldId});
    }
   }
   const applied={applied:versions.length,conflicts:[],versions};
   await c.query('UPDATE migration_receipts SET manifest=$2 WHERE source_sha256=$1',[this.identity.hash('salary-preview:'+body.draftId),{...preview,selectionHash,applied}]);
   await this.identity.audit(c,a.id,'salary_migration.apply',body.draftId,{entity:scope.entity,count:applied.applied});
   return applied;
  });
 }
}
