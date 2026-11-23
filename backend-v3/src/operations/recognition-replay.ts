import {createHash} from 'node:crypto';
import {Identity,type Actor} from '../identity/service.js';
import {FileStore} from '../files/storage.js';
import {adaptRecognition,RECOGNIZED_FIELDS,RECOGNITION_VERSION} from '../parsing/recognition.js';
import {encodeRaw} from '../parsing/profile.js';
import {encodeJSON} from '../parsing/json.js';
import {profileInput} from '../recruiting/schema.js';
import {inheritResumeFields} from '../business-config/fields.js';
import {lockMatchingCandidateJobs} from '../business-config/bindings.js';
import {Worker} from '../tasks/worker.js';

const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export async function replayRecognitions(identity:Identity,store:FileStore,results:Map<string,any>,options:{runId:string;apply?:boolean;fingerprint?:string}){
 if(!/^[a-zA-Z0-9_-]{1,100}$/.test(options.runId))throw Error('invalid_replay_id');
 const dataHash=hash([...results].sort(([a],[b])=>a.localeCompare(b))),receipt=hash(['recognition-replay',identity.config.schema,options.runId]);
 return identity.db.tx(async sql=>{
  await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['recognition-replay:'+identity.config.schema]);
  const prior=(await sql.query('SELECT manifest FROM migration_receipts WHERE source_sha256=$1',[receipt])).rows[0]?.manifest;
  if(prior){if(prior.dataHash!==dataHash)throw Error('replay_data_changed');return prior.result;}
  if(options.apply){
   const ids=(await sql.query('SELECT id FROM candidates WHERE deleted_at IS NULL ORDER BY id')).rows.map(r=>r.id);
   await lockMatchingCandidateJobs(sql,ids);
   await sql.query('SELECT id FROM candidates WHERE deleted_at IS NULL ORDER BY id FOR UPDATE');
  }
  const rows=(await sql.query(`SELECT r.*,p.document_id,p.profile parsed_profile,p.human_corrections,d.sha256,d.blob_key,
    c.version candidate_version,c.profile candidate_profile,
    (SELECT configuration_refs FROM candidate_profile_versions WHERE candidate_id=c.id AND version=c.version) candidate_refs
    FROM resume_versions r JOIN candidates c ON c.id=r.candidate_id JOIN parse_results p ON p.id=r.parse_result_id JOIN resume_documents d ON d.id=p.document_id
    WHERE c.deleted_at IS NULL AND r.id IN (
      SELECT DISTINCT ON (candidate_id) id FROM resume_versions ORDER BY candidate_id,created_at DESC,id DESC
    ) OR c.deleted_at IS NULL AND r.id IN (SELECT resume_version_id FROM applications WHERE is_current AND deleted_at IS NULL)
    ORDER BY r.created_at,r.id ${options.apply?'FOR UPDATE OF r':''}`)).rows;
  const apps=(await sql.query(`SELECT * FROM applications WHERE is_current AND deleted_at IS NULL AND resume_version_id=ANY($1::uuid[]) ORDER BY id ${options.apply?'FOR UPDATE':''}`,[rows.map(r=>r.id)])).rows;
  const fingerprint=hash({dataHash,rows,apps}),prepared=new Map<string,ReturnType<typeof adaptRecognition>>(),skipped:{resumeId:string;reason:string}[]=[];
  for(const row of rows){
   const result=results.get(row.sha256);if(!result||result.status!=='ok'||result.source_sha256!==row.sha256)throw Error('replay_missing_or_invalid_source:'+row.sha256);
   // Validate every source and adaptation before the first business write.
   await store.read(row.blob_key);const parsed=adaptRecognition(result);
   if(!['resume','cover_letter'].includes(parsed.documentType)||!parsed.raw.trim()){skipped.push({resumeId:row.id,reason:parsed.documentType});continue;}
   prepared.set(row.id,parsed);
  }
  const preview={applied:false,runId:options.runId,fingerprint,resumes:rows.length,eligibleResumes:prepared.size,skipped,updatedCandidates:0,refreshedApplications:0};
  if(!options.apply)return preview;
  if(options.fingerprint!==fingerprint)throw Error('replay_preview_stale');
  const actor=(await sql.query("SELECT * FROM users WHERE status='active' AND directory_active AND 'admin'=ANY(roles) ORDER BY created_at,id LIMIT 1")).rows[0] as Actor;
  if(!actor)throw Error('replay_admin_unavailable');
  const created=new Map<string,string>(),candidateSources=new Map<string,any>(),worker=new Worker(identity,store,'recognition-replay');
  for(const row of rows){
   const parsed=prepared.get(row.id);if(!parsed)continue;
   const facts=Object.fromEntries(RECOGNIZED_FIELDS.map(k=>[k,parsed.profile[k]]));
   const profile=profileInput.parse({...row.parsed_profile,...facts});
   const corrections=(row.human_corrections||[]).filter((x:any)=>!RECOGNIZED_FIELDS.includes(x.field));
   const p=(await sql.query('INSERT INTO parse_results(document_id,raw_bytes,profile,evidence,parser_version,human_corrections,recognition) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',[row.document_id,encodeRaw(parsed.raw),profile,encodeJSON(parsed.evidence),RECOGNITION_VERSION,JSON.stringify(corrections),parsed.recognition])).rows[0];
   const {inboxMatch,...refs}=row.configuration_refs||{};
   const r=(await sql.query('INSERT INTO resume_versions(candidate_id,parse_result_id,created_by,parent_id,configuration_refs,created_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()) RETURNING id',[row.candidate_id,p.id,actor.id,row.id,{...refs,recognitionRun:options.runId}])).rows[0];
   await inheritResumeFields(identity,actor,row.id,r.id,sql);created.set(row.id,r.id);
   // The active application owns candidate facts; otherwise use the newest resume.
   if(!candidateSources.has(row.candidate_id)||!apps.some(a=>a.resume_version_id===candidateSources.get(row.candidate_id).id))candidateSources.set(row.candidate_id,{...row,facts});
   await identity.audit(sql,null,'resume.recognition_replay',r.id,{runId:options.runId,parentId:row.id,sourceSha256:row.sha256,parserVersion:RECOGNITION_VERSION,...parsed.provenance});
  }
  for(const [id,row] of candidateSources){
   const profile=profileInput.parse({...row.candidate_profile,...row.facts});
   const candidate=(await sql.query('UPDATE candidates SET profile=$2,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',[id,profile])).rows[0];
   await sql.query('INSERT INTO candidate_profile_versions(candidate_id,version,profile,actor_id,configuration_refs) VALUES($1,$2,$3,NULL,$4)',[id,candidate.version,profile,row.candidate_refs||{}]);
  }
  let refreshedApplications=0;
  for(const app of apps){const next=created.get(app.resume_version_id);if(!next)continue;
   await sql.query('UPDATE applications SET resume_version_id=$2,version=version+1,updated_at=now() WHERE id=$1',[app.id,next]);
   const match=await worker.recompute(sql,app.id);if(match.skipped||match.stale)throw Error('replay_match_failed');refreshedApplications++;
  }
  const result={...preview,applied:true,updatedCandidates:candidateSources.size,refreshedApplications};
  await sql.query('INSERT INTO migration_receipts(source_sha256,source_revision,manifest) VALUES($1,$2,$3)',[receipt,RECOGNITION_VERSION,{kind:'recognition-replay',dataHash,result}]);
  await identity.audit(sql,null,'operations.recognition_replay',null,{...result,skipped:skipped.length});
  return result;
 });
}
