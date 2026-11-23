import {createHash} from 'node:crypto';
import {Identity,requireRole,type Actor} from '../identity/service.js';
import {fail,found} from '../http/errors.js';
import {decodeJSON,encodeJSON} from '../parsing/json.js';
import {decodeRaw} from '../parsing/profile.js';
import type {HumanCorrection} from '../parsing/corrections.js';
import {BusinessConfigService} from '../business-config/service.js';
import {BindingService,loadDictionarySnapshot,pinnedParsed,queueMatch} from '../business-config/bindings.js';
import {normalizeDictionaryAliases} from '../business-config/dictionary-aliases.js';
import {validateDocument} from '../business-config/schema.js';
import {inheritResumeFields} from '../business-config/fields.js';

const stable=(value:any):any=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])):value;
const hash=(value:any)=>createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const reason='恢复旧版备份中的结构化字段；原操作人未提供';
const signature=(c:HumanCorrection)=>hash([c.field,c.value,c.actorId,c.reason,c.at]);
// A matching reason alone is insufficient: callers supply verified recovery ancestors.
export function markLegacySkillCorrections(corrections:HumanCorrection[],origins:HumanCorrection[]) {
 const known=new Set(origins.filter(c=>c.field==='skills'&&c.reason===reason&&c.actorId&&Number.isFinite(new Date(c.at).getTime())).map(signature));
 return corrections.map(c=>c.field==='skills'&&!c.source&&known.has(signature(c))?{...c,source:'legacy_import' as const}:c);
}

export class RepairMatchInputs {
 constructor(readonly identity:Identity){}
 get db(){return this.identity.db;}
 private async read(actor:Actor){
  requireRole(actor,'admin');
  const actual=found((await this.db.query('SELECT * FROM users WHERE id=$1 AND directory_active',[actor.id])).rows[0]);
  requireRole(actual as Actor,'admin');if(actual.version!==actor.version)fail(409,'membership_changed');
  const dictionary=found((await this.db.query("SELECT c.id,c.published_version,c.version,v.document FROM business_configs c JOIN business_config_versions v ON v.config_id=c.id AND v.version=c.published_version WHERE c.key='dictionary.skills'")).rows[0]);
  const normalized=validateDocument(normalizeDictionaryAliases(dictionary.document));
  const mappings=(await this.db.query("SELECT m.data_bytes FROM legacy_archives m WHERE m.kind='mapping' AND EXISTS(SELECT 1 FROM legacy_archives b WHERE b.kind='bundle' AND b.source_sha256=m.source_sha256)")).rows;
  const archived=new Set(mappings.map(m=>{try{return JSON.parse(decodeRaw(m.data_bytes)).candidateId;}catch{return null;}}));
  const rows=(await this.db.query(`SELECT a.id application_id,a.version application_version,a.status,a.configuration_refs application_refs,a.job_id,a.candidate_id,a.resume_version_id,
   c.version candidate_version,c.profile candidate_profile,r.configuration_refs resume_refs,p.id parse_id,p.profile,p.raw_bytes,p.evidence,p.human_corrections,p.parser_version,p.created_at parse_created_at,p.document_id,
   (SELECT id FROM resume_versions x WHERE x.candidate_id=c.id ORDER BY x.created_at DESC,x.id DESC LIMIT 1) latest_resume_id
   FROM applications a JOIN candidates c ON c.id=a.candidate_id JOIN resume_versions r ON r.id=a.resume_version_id JOIN parse_results p ON p.id=r.parse_result_id
   WHERE a.is_current AND a.deleted_at IS NULL AND c.deleted_at IS NULL ORDER BY a.id`)).rows;
  const jobs=(await this.db.query(`SELECT j.id,j.version,j.requirements_version,b.config_id,b.template_version,b.dictionary_ref,b.version binding_version FROM jobs j JOIN business_template_bindings b ON b.object_kind='job' AND b.object_id=j.id AND b.purpose='matching' ORDER BY j.id`)).rows;
  const repairs:any[]=[];let unverified=0,held=0;
  for(const row of rows){
   const corrections=decodeJSON(row.human_corrections||[]) as HumanCorrection[];
   if(!corrections.some(c=>c.field==='skills'&&!c.source&&c.reason===reason))continue;
   if(row.application_refs?.matchingHold?.jobVersion===jobs.find(j=>j.id===row.job_id)?.requirements_version){held++;continue;}
   if(!archived.has(row.candidate_id)){unverified++;continue;}
   const ancestors=(await this.db.query(`WITH RECURSIVE chain AS (
    SELECT id,parent_id,parse_result_id,ARRAY[id] path FROM resume_versions WHERE id=$1 AND candidate_id=$2
    UNION ALL SELECT r.id,r.parent_id,r.parse_result_id,ch.path||r.id FROM chain ch JOIN resume_versions r ON r.id=ch.parent_id
    WHERE r.candidate_id=$2 AND NOT r.id=ANY(ch.path) AND cardinality(ch.path)<100)
    SELECT p.id,p.human_corrections FROM chain JOIN parse_results p ON p.id=chain.parse_result_id WHERE p.parser_version='legacy-fact-recovery-4.0.0'`,[row.resume_version_id,row.candidate_id])).rows;
   const marked=markLegacySkillCorrections(corrections,ancestors.flatMap(a=>decodeJSON(a.human_corrections||[])));
   if(hash(marked)===hash(corrections)){unverified++;continue;}
   repairs.push({...row,marked,originParseIds:ancestors.map(a=>a.id)});
  }
  const dictionaryChanged=hash(normalized)!==hash(dictionary.document);
  const adoptionJobs=dictionaryChanged?jobs.filter(j=>j.dictionary_ref.ref.configId===dictionary.id&&j.dictionary_ref.ref.version===dictionary.published_version&&rows.some(r=>r.job_id===j.id)):[];
  const fingerprint=hash({schema:this.db.config.schema,actor:[actor.id,actor.version],dictionary,jobs,rows:rows.map(({raw_bytes,...r})=>({...r,rawHash:createHash('sha256').update(raw_bytes).digest('hex')})),repairProof:repairs.map(r=>[r.application_id,r.marked,r.originParseIds])});
  return {dictionary,normalized,dictionaryChanged,rows,jobs,repairs,adoptionJobs,hash:fingerprint,unverified,held};
 }
 async preview(actor:Actor){
  const p=await this.read(actor);
  return {hash:p.hash,applications:p.rows.length,resumesToRepair:new Set(p.repairs.map(r=>r.resume_version_id)).size,applicationsToRepair:p.repairs.length,dictionaryVersion:p.dictionary.published_version,dictionaryChanged:p.dictionaryChanged,jobsToAdopt:p.adoptionJobs.length,unverified:p.unverified,held:p.held};
 }
 async apply(actor:Actor,expectedHash:string){
  requireRole(actor,'admin');
  return this.db.tx(async sql=>{
   await sql.query("SELECT pg_advisory_xact_lock(hashtextextended('score-input-repair',0))");
   // Follow normal writer order; reject changes made after the read-only preview.
   await sql.query('SELECT id FROM jobs ORDER BY id FOR UPDATE');
   await sql.query('SELECT id FROM candidates WHERE deleted_at IS NULL ORDER BY id FOR UPDATE');
   await sql.query('SELECT id FROM applications WHERE is_current AND deleted_at IS NULL ORDER BY id FOR UPDATE');
   await sql.query("SELECT id FROM business_configs WHERE key='dictionary.skills' FOR UPDATE");
   const p=await this.read(actor);if(p.hash!==expectedHash)fail(409,'repair_preview_stale');
   const configs=new BusinessConfigService(this.identity),bindings=new BindingService(this.identity);
   let dictionaryRef={configId:p.dictionary.id,version:p.dictionary.published_version};
   if(p.dictionaryChanged){const draft=await configs.saveDraft(actor,{key:'dictionary.skills',baseVersion:dictionaryRef.version,document:p.normalized});dictionaryRef=await configs.publish(actor,await configs.preview(actor,draft.id));}
   const dictionary=await loadDictionarySnapshot(this.identity,dictionaryRef,sql),repaired=new Map<string,string>(),receipt:any[]=[],needsQueue=new Set<string>();
   for(const row of p.repairs){
    let resumeId=repaired.get(row.resume_version_id);
    if(!resumeId){
     const parsed=pinnedParsed({...row,human_corrections:row.marked},decodeRaw(row.raw_bytes),dictionary);
     const parseRow=(await sql.query('INSERT INTO parse_results(document_id,raw_bytes,profile,evidence,parser_version,human_corrections) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[row.document_id,row.raw_bytes,parsed.profile,encodeJSON(parsed.evidence),'legacy-skill-provenance-repair-1.0.0',encodeJSON(row.marked)])).rows[0];
     resumeId=(await sql.query('INSERT INTO resume_versions(candidate_id,parse_result_id,created_by,parent_id,configuration_refs) VALUES($1,$2,$3,$4,$5) RETURNING id',[row.candidate_id,parseRow.id,actor.id,row.resume_version_id,{...row.resume_refs,skillProvenanceRepair:{fromParseId:row.parse_id,originParseIds:row.originParseIds}}])).rows[0].id as string;
     await inheritResumeFields(this.identity,actor,row.resume_version_id,resumeId,sql);
     if(row.latest_resume_id===row.resume_version_id&&hash(row.candidate_profile.skills)===hash(row.profile.skills)&&hash(row.candidate_profile.skills)!==hash(parsed.profile.skills)){
      const next=found((await sql.query("UPDATE candidates SET profile=jsonb_set(profile,'{skills}',$2::jsonb),version=version+1,updated_at=now() WHERE id=$1 AND version=$3 RETURNING *",[row.candidate_id,JSON.stringify(parsed.profile.skills),row.candidate_version])).rows[0]);
      await this.identity.profileVersion(sql,actor.id,next);
     }
     repaired.set(row.resume_version_id,resumeId);
    }
    await sql.query('UPDATE applications SET resume_version_id=$2,version=version+1,updated_at=now() WHERE id=$1',[row.application_id,resumeId]);
    needsQueue.add(row.application_id);receipt.push({applicationId:row.application_id,previousResumeId:row.resume_version_id,resumeId,previousParseId:row.parse_id,status:row.status});
   }
   const taskIds:string[]=[];
   for(const job of p.adoptionJobs){
    const selected=p.rows.filter(r=>r.job_id===job.id&&r.application_refs?.matchingHold?.jobVersion!==job.requirements_version).map(r=>r.application_id);
    const preview=await bindings.preview(actor,{kind:'job',id:job.id},'matching',{configId:job.config_id,version:job.template_version},dictionaryRef);
    const result=await bindings.adopt(actor,{receipt:preview.receipt,objectVersion:job.version,selectedIds:selected});
    taskIds.push(...result.taskIds);for(const id of selected)needsQueue.delete(id);
   }
   for(const id of needsQueue){const task=await queueMatch(this.identity,sql,id,actor.id,{reason:'legacy_skill_provenance_repair'});if(task.id)taskIds.push(task.id);}
   const result={repairedResumes:repaired.size,dictionaryRef,dictionaryChanged:p.dictionaryChanged,adoptedJobs:p.adoptionJobs.length,taskIds,unverified:p.unverified,held:p.held};
   if(repaired.size||p.dictionaryChanged){
    const key=this.identity.hash('score-input-repair:'+p.hash);
    await sql.query('INSERT INTO migration_receipts(source_sha256,source_revision,manifest) VALUES($1,$2,$3)',[key,'score-input-repair-1.0.0',{schema:this.db.config.schema,actorId:actor.id,beforeDictionary:{configId:p.dictionary.id,version:p.dictionary.published_version},result,applications:receipt}]);
    await this.identity.audit(sql,actor.id,'matching.input_repair',key,{...result,applications:receipt});
   }
   return result;
  });
 }
}
