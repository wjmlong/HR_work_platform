import {resolveJobMatching,queueMatches} from '../business-config/bindings.js';
import {createHash} from 'node:crypto';
import type {Sql} from '../db.js';
import {Identity,requireRole,type Actor} from '../identity/service.js';
import {Dictionary} from '../dictionary/service.js';
import {jobInput,jobPatch,jobLevel} from './schema.js';
import {parse,z,version,uuid} from '../http/validation.js';
import {fail,found} from '../http/errors.js';
import {BusinessDictionaryService,validateOption} from '../business-config/dictionaries.js';
const writers=['admin','manager','recruiter'] as const;
const salaryColumns=['salary_range','market_salary','market_source','salary_note','market_reference_date'];
export const closeJobRequest=z.object({version}).strict();
export const salaryGrantRequest=z.object({userId:uuid,allow:z.boolean()}).strict();
const internalSalary=(b:any)=>({salaryRange:b.salary_range,marketSalary:b.market_salary,marketSource:b.market_source,salaryNote:b.salary_note,marketReferenceDate:b.market_reference_date});
export class Jobs {
 constructor(readonly identity:Identity){}
 private async validate(a:Actor,b:any,old?:any){
  if(!jobLevel.safeParse(b.level).success)fail(422,'job_level_required');
  const d=new BusinessDictionaryService(this.identity);
  validateOption((await d.dictionary(a,'job_levels')).options,b.level,old?.level);
  validateOption((await d.dictionary(a,'urgency')).options,b.urgency,old?.urgency);
  const departments=(await d.dictionary(a,'departments')).options;
  if(b.department&&departments.some(o=>o.id===b.department))validateOption(departments,b.department,old?.department);
  if(b.market_salary.trim()&&!b.market_source.trim())fail(422,'market_source_required');
  const r=b.requirements;
  if(r.experienceYears!=null&&r.experienceMaxYears!=null&&r.experienceMaxYears<r.experienceYears)fail(422,'experience_range_invalid');
 }
 async create(a:Actor,input:unknown){
  requireRole(a,...writers);const b=parse(jobInput,input);
  if(!String(b.level||'').trim())fail(422,'job_level_required');
  const salary={salary_range:b.salaryRange,market_salary:b.marketSalary,market_source:b.marketSource,salary_note:b.salaryNote,market_reference_date:b.marketReferenceDate};
  return this.identity.db.tx(async c=>{
   await this.validate(a,{...b,...salary});
   b.requirements.skills=await new Dictionary(this.identity.db).normalize(b.requirements.skills,c);
   const row=(await c.query('INSERT INTO jobs(name,department,urgency,headcount,level,salary_range,market_salary,market_source,salary_note,market_reference_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',[b.name,b.department,b.urgency,b.headcount,b.level,...salaryColumns.map(k=>(salary as any)[k])])).rows[0];
   await c.query('INSERT INTO job_versions(job_id,version,requirements,actor_id,level,internal_salary) VALUES($1,1,$2,$3,$4,$5)',[row.id,b.requirements,a.id,b.level,internalSalary(row)]);
   const binding=await resolveJobMatching(this.identity,c,row.id),refs={...row.configuration_refs,matching:{templateRef:binding.templateRef,dictionaryRef:binding.dictionaryRef,bindingVersion:binding.version}};
   await c.query('UPDATE jobs SET configuration_refs=$2 WHERE id=$1',[row.id,refs]);await c.query('UPDATE job_versions SET configuration_refs=$2 WHERE job_id=$1 AND version=1',[row.id,refs]);
   await this.identity.audit(c,a.id,'job.create',row.id);return {...row,requirements:b.requirements};
  });
 }
 private async active(c:Sql,id:string){
  const rows=(await c.query("SELECT a.id,a.version,a.status,p.profile->>'name' name FROM applications a JOIN candidates p ON p.id=a.candidate_id WHERE a.job_id=$1 AND a.is_current AND a.deleted_at IS NULL AND p.deleted_at IS NULL AND a.status NOT IN ('hired','rejected','terminated','hired_other') ORDER BY a.id",[id])).rows;
  return {count:rows.length,candidates:rows.slice(0,50),hash:createHash('sha256').update(JSON.stringify(rows.map(r=>[r.id,r.version]))).digest('hex')};
 }
 async closePreview(a:Actor,id:string,input:unknown){
  requireRole(a,...writers);const b=parse(closeJobRequest,input);
  return this.identity.db.tx(async c=>{const job=found((await c.query('SELECT id,version FROM jobs WHERE id=$1 FOR SHARE',[id])).rows[0]);if(job.version!==b.version)fail(409,'version_conflict');return {jobId:id,version:b.version,...await this.active(c,id)};});
 }
 async update(a:Actor,id:string,input:unknown){
  requireRole(a,...writers);const b=parse(jobPatch,input);
  return this.identity.db.tx(async c=>{
   const old=found((await c.query('SELECT j.*,v.requirements FROM jobs j JOIN job_versions v ON v.job_id=j.id AND v.version=j.requirements_version WHERE j.id=$1 FOR UPDATE OF j',[id])).rows[0]);
   if(old.version!==b.version)fail(409,'version_conflict');
   const requirements=b.requirements||old.requirements;
   if(b.requirements)requirements.skills=await new Dictionary(this.identity.db).normalize(requirements.skills,c);
   const next={...old,name:b.name??old.name,department:b.department??old.department,urgency:b.urgency??old.urgency,headcount:b.headcount??old.headcount,open:b.open??old.open,level:b.level??old.level,requirements,salary_range:b.salaryRange??old.salary_range,market_salary:b.marketSalary??old.market_salary,market_source:b.marketSource??old.market_source,salary_note:b.salaryNote??old.salary_note,market_reference_date:b.marketReferenceDate??old.market_reference_date};
   if(next.open&&!old.open&&!String(next.level||'').trim())fail(422,'job_level_required');
   await this.validate(a,next,old);
   if(old.open&&!next.open){const preview=await this.active(c,id);if(preview.count&&(!b.closeConfirm||b.closePreviewHash!==preview.hash))fail(409,'job_close_confirmation');}
   const changed=JSON.stringify(requirements)!==JSON.stringify(old.requirements);
   const row=(await c.query("UPDATE jobs SET name=$2,department=$3,urgency=$4,headcount=$5,open=$6,level=$7,salary_range=$8,market_salary=$9,market_source=$10,salary_note=$11,market_reference_date=$12,requirements_version=CASE WHEN $13 THEN version+1 ELSE requirements_version END,close_reason=CASE WHEN $6 THEN NULL ELSE $14 END,closed_at=CASE WHEN $6 THEN NULL ELSE coalesce(closed_at,now()) END,version=version+1,updated_at=now() WHERE id=$1 RETURNING *",[id,next.name,next.department,next.urgency,next.headcount,next.open,next.level,...salaryColumns.map(k=>next[k]),changed,b.closeReason??old.close_reason])).rows[0];
   await c.query('INSERT INTO job_versions(job_id,version,requirements,actor_id,level,internal_salary) VALUES($1,$2,$3,$4,$5,$6)',[id,row.version,requirements,a.id,next.level,internalSalary(row)]);
   await c.query('UPDATE job_versions SET configuration_refs=$3 WHERE job_id=$1 AND version=$2',[id,row.version,row.configuration_refs]);
   if(changed){const ids=(await c.query('SELECT id FROM applications WHERE job_id=$1 AND is_current AND resume_version_id IS NOT NULL AND deleted_at IS NULL ORDER BY id',[id])).rows.map(r=>r.id);await queueMatches(this.identity,c,ids,a.id,{reason:'job_requirements_edit'});}
   await this.identity.audit(c,a.id,'job.edit',id,{version:row.version,requirementsChanged:changed});
   return {...row,requirements};
  });
 }
 async list(a:Actor){
  requireRole(a,...writers,'interviewer','viewer');const all=a.roles.some(r=>writers.includes(r as any));
  const rows=(await this.identity.db.query(`SELECT j.*,v.requirements,($1 OR EXISTS(SELECT 1 FROM job_salary_grants g WHERE g.job_id=j.id AND g.user_id=$2)) salary_visible,(SELECT count(*)::int FROM applications x JOIN candidates p ON p.id=x.candidate_id WHERE x.job_id=j.id AND x.is_current AND x.deleted_at IS NULL AND p.deleted_at IS NULL) resume_count FROM jobs j JOIN job_versions v ON v.job_id=j.id AND v.version=j.requirements_version WHERE $1 OR EXISTS(SELECT 1 FROM job_salary_grants g WHERE g.job_id=j.id AND g.user_id=$2) OR EXISTS(SELECT 1 FROM applications x WHERE x.job_id=j.id AND x.deleted_at IS NULL AND (EXISTS(SELECT 1 FROM application_grants g WHERE g.application_id=x.id AND g.user_id=$2) OR EXISTS(SELECT 1 FROM interviews i JOIN interviewers ir ON ir.interview_id=i.id WHERE i.application_id=x.id AND i.deleted_at IS NULL AND i.status<>'cancelled' AND ir.user_id=$2 AND NOT ir.temporary_access))) ORDER BY j.created_at DESC,j.id`,[all,a.id])).rows;
  // 硬性技能：优先用岗位已绑定的技能组（字典 label 可读），模板一改列表自动跟着变；
  // 无技能组时回退到 requirements.skills；归档岗位再回退到同名在招岗位。
  const binds=(await this.identity.db.query("SELECT b.object_id,v.document FROM business_template_bindings b JOIN business_config_versions v ON v.config_id=b.config_id AND v.version=b.template_version WHERE b.object_kind='job' AND b.purpose='matching'")).rows;
  const dictRow=(await this.identity.db.query("SELECT v.document FROM business_configs c JOIN business_config_versions v ON v.config_id=c.id AND v.version=c.published_version WHERE c.key='dictionary.skills'")).rows[0] as any;
  const labels=new Map<string,string>();
  for(const o of dictRow?.document?.options||[])labels.set(String(o.id),String(o.label||o.id));
  const groupSkills=new Map<string,string[]>();
  for(const b of binds as any[]){
   const found:string[]=[];
   const walk=(g:any)=>{for(const it of g?.items||[]){if(it?.items)walk(it);else if(it?.skill)found.push(String(it.skill));}};
   for(const g of b.document?.groups||[])walk(g);
   if(found.length)groupSkills.set(String(b.object_id),[...new Set(found)].map(s=>labels.get(s)||s));
  }
  const readable=(list:any[])=>[...new Set((list||[]).map(s=>labels.get(String(s))||String(s)))];
  const out:any[]=[];
  for(const row of rows){
   delete row.question_bank;
   if(!row.salary_visible)for(const key of salaryColumns)delete row[key];
   let hard=groupSkills.get(String(row.id))||readable(row.requirements?.skills||[]);
   if(!hard.length){
    const base=String(row.name||'').replace(/（已合并归档）$/,'');
    if(base!==row.name){
     const twin:any=rows.find((r:any)=>r.name===base&&r.open);
     if(twin)hard=groupSkills.get(String(twin.id))||readable(twin.requirements?.skills||[]);
    }
   }
   out.push({...row,hard_skills:hard});
  }
  return out;
 }
 async publicJob(a:Actor,id:string){
  const row=found((await this.list(a)).find(r=>r.id===id));
  return {id:row.id,name:row.name,department:row.department,skills:row.requirements.skills||[],experienceYears:row.requirements.experienceYears??null,experienceMaxYears:row.requirements.experienceMaxYears??null,education:row.requirements.education??null,description:row.requirements.description||''};
 }
 async grant(a:Actor,id:string,input:unknown){
  requireRole(a,'admin','manager');const b=parse(salaryGrantRequest,input);
  return this.identity.db.tx(async c=>{
   found((await c.query('SELECT id FROM jobs WHERE id=$1',[id])).rows[0]);
   found((await c.query("SELECT id FROM users WHERE id=$1 AND status='active' AND directory_active",[b.userId])).rows[0]);
   if(b.allow)await c.query('INSERT INTO job_salary_grants(job_id,user_id,granted_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[id,b.userId,a.id]);
   else await c.query('DELETE FROM job_salary_grants WHERE job_id=$1 AND user_id=$2',[id,b.userId]);
   await this.identity.audit(c,a.id,'job.salary_grant',id,{userId:b.userId,allow:b.allow});return {jobId:id,userId:b.userId,allow:b.allow};
  });
 }
}
