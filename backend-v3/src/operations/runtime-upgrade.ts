import {meetingStageOptions} from '../business-config/meeting-stages.js';
import {createHash} from 'node:crypto';
import {readFile,stat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import type {Database} from '../db.js';
import {FileStore} from '../files/storage.js';
import {readArchive} from './backup.js';
import {CURRENT_TABLES,LEGACY_V4_TABLES,CONFIGURATION_V13_TABLES,CONFIGURATION_V15_TABLES,CONFIGURATION_V16_TABLES,CONFIGURATION_V17_TABLES,CONFIGURATION_V20_TABLES,CONFIGURATION_V21_TABLES,CONFIGURATION_V26_TABLES} from './archive-schema.js';
import {schemaRevision,upgradeBusinessConfiguration} from './business-config-upgrade.js';
import {compensationFields} from '../business-config/defaults.js';
import type {EntityKind} from '../business-config/types.js';
import {v4AliasPolicy} from '../dictionary/data.js';
const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const normalize=(v:any):any=>v instanceof Date?v.toISOString():Buffer.isBuffer(v)?'\\x'+v.toString('hex'):Array.isArray(v)?v.map(normalize):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,normalize(v[k])])):v;
const rowsHash=(rows:any[])=>hash(JSON.stringify(rows.map(normalize).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b),'en'))));
const encode=(r:any)=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,Buffer.isBuffer(v)?'\\x'+v.toString('hex'):v]));
async function runtimeRows(db:Database,readOnly=true){return db.tx(async c=>{if(readOnly)await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');const actual=(await c.query('SELECT tablename FROM pg_tables WHERE schemaname=$1',[db.config.schema])).rows.map(r=>r.tablename).sort();const shape=[LEGACY_V4_TABLES,CONFIGURATION_V13_TABLES,CONFIGURATION_V15_TABLES,CONFIGURATION_V16_TABLES,CONFIGURATION_V17_TABLES,CONFIGURATION_V20_TABLES,CONFIGURATION_V21_TABLES,CONFIGURATION_V26_TABLES,CURRENT_TABLES].find(t=>JSON.stringify([...t].sort())===JSON.stringify(actual));if(!shape)throw Error('runtime_schema_mismatch');const data:Record<string,any[]>={};for(const t of shape)data[t]=(await c.query('SELECT * FROM '+t)).rows.map(encode).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b),'en'));return data;});}
async function fileProof(data:Record<string,any[]>,store:FileStore){const files=[];for(const key of [...new Set(data.resume_documents.map(r=>r.blob_key))].sort()){const bytes=await store.read(key);if(hash(bytes)!==key)throw Error('runtime_file_hash_mismatch');files.push({key,size:bytes.length,hash:hash(bytes)});}return files;}
export async function inspectRuntimeDatabase(db:Database,store:FileStore){const data=await runtimeRows(db);return {schemaRevision:await schemaRevision(db),tables:Object.fromEntries(Object.entries(data).map(([t,rows])=>[t,{count:rows.length,hash:hash(JSON.stringify(rows))}])),files:await fileProof(data,store)};}
async function requireOffline(db:Database,archiveDirectory:string){
 if(db.config.schema.startsWith('recruit_test_'))return;
 const privateRoot=path.resolve(db.config.storageRoot,'..'),runtime=path.resolve(privateRoot,'..'),homeRuntime=path.join(process.env.HOME||'','Library/Application Support/RecruitWorkbenchV4');
 if(runtime!==homeRuntime||await realpath(runtime)!==runtime)throw Error('offline_runtime_path_invalid');
 const marker=path.join(privateRoot,'maintenance.json'),info=await stat(marker);
 if(!info.isFile()||info.mode&0o077||info.uid!==process.getuid?.())throw Error('offline_maintenance_required');
 const receipt=JSON.parse(await readFile(marker,'utf8'));
 if(receipt.phase!=='maintenance'||path.resolve(receipt.backup?.directory||'')!==path.resolve(archiveDirectory))throw Error('offline_maintenance_backup_required');
 for(const role of ['api-a','api-b','worker-a','worker-b','backup']){try{execFileSync('launchctl',['print','gui/'+process.getuid?.()+'/com.hzpc.recruit.v4.'+role],{stdio:'pipe'});}catch{continue;}throw Error('offline_writer_still_loaded:'+role);}
}
export async function offlineUpgrade(db:Database,store:FileStore,archiveDirectory:string){
 await requireOffline(db,archiveDirectory);
 // The exact old table shape is inspected before migrations. No old writer may
 // still be loaded, and the archived bytes must equal this database snapshot.
 const before=await runtimeRows(db),{manifest,tables:archive}=await readArchive(db,store,archiveDirectory),files=await fileProof(before,store);
 for(const [table,rows] of Object.entries(before)){const expected=manifest.tables[table];if(expected&&(expected.count!==rows.length||expected.hash!==hash(JSON.stringify(rows))))throw Error('consistent_backup_mismatch:'+table);if(!expected&&rows.length&&table!=='schema_migrations')throw Error('consistent_backup_mismatch:'+table);}
 if(JSON.stringify([...manifest.files].sort((a,b)=>a.key.localeCompare(b.key)))!==JSON.stringify(files))throw Error('consistent_backup_mismatch:files');
 const additions=new Map<string,any>();
 if(!before.schema_migrations.some(r=>r.version===1003))for(const header of before.business_configs||[]){if(header.kind!=='fields')continue;const old=before.business_config_versions.find(r=>r.config_id===header.id&&r.version===header.published_version)?.document;if(!old)continue;const fields=compensationFields(header.entity as EntityKind).filter(f=>!old.fields.some((p:any)=>p.fieldId===f.fieldId));for(const f of fields)if(old.fields.some((p:any)=>p.label===f.label))f.label+='（结构化）';if(fields.length)additions.set(header.id,{...old,fields:[...old.fields,...fields]});}
 const stageAdditions=new Map<string,{document:any;version:number}>();
 if(!before.schema_migrations.some(r=>r.version===1004))for(const header of before.business_configs||[]){if(header.key!=='dictionary.recruiting_statuses')continue;const versions=before.business_config_versions.filter(r=>r.config_id===header.id),old=versions.find(r=>r.version===header.published_version)?.document;if(!old)continue;const added=meetingStageOptions.filter(o=>!old.options.some((p:any)=>p.id===o.id));if(added.length)stageAdditions.set(header.id,{document:{...old,options:[...old.options,...added]},version:Math.max(...versions.map(r=>r.version))+1});}
 return db.tx(async()=>{const upgraded=await upgradeBusinessConfiguration(db),after=await runtimeRows(db,false),recovered=new Set(upgraded.recoveredTasks.map(t=>t.oldTaskId)),dictionaryInitialized=!before.schema_migrations.some(r=>r.version===1002);
 for(const [table,rows] of Object.entries(before)){
  if(table==='schema_migrations'){for(const row of rows)if(!after[table].some(r=>r.version===row.version&&normalize(r.applied_at)===normalize(row.applied_at)))throw Error('upgrade_original_invariant_failed:'+table);continue;}
  if(dictionaryInitialized&&['skills','skill_aliases','dictionary_versions'].includes(table)){
   const policy=new Map(v4AliasPolicy.map(([alias,skill])=>[alias.toLowerCase(),skill]));
   for(const row of rows){const expected=table==='skill_aliases'&&policy.has(row.alias)?{...row,skill:policy.get(row.alias)}:row,actual=after[table].find(r=>table==='skills'?r.name===row.name:table==='skill_aliases'?r.alias===row.alias:r.id===row.id);if(table==='dictionary_versions'){if(!actual||actual.version<row.version||actual.version>row.version+1)throw Error('upgrade_dictionary_invariant_failed');}else if(rowsHash([expected])!==rowsHash([actual]))throw Error('upgrade_dictionary_invariant_failed');}continue;
  }
  const keys=rows[0]?Object.keys(rows[0]):[];
  if(table==='business_configs'){for(const row of rows){const actual=after[table].find(r=>r.id===row.id),expected=stageAdditions.has(row.id)?{...row,published_version:stageAdditions.get(row.id)!.version,version:row.version+1}:additions.has(row.id)?{...row,published_version:row.published_version+1,version:row.version+1}:row;if(rowsHash([expected])!==rowsHash([actual]))throw Error('upgrade_original_invariant_failed:'+table);if(stageAdditions.has(row.id)){const version=after.business_config_versions.find(r=>r.config_id===row.id&&r.version===expected.published_version);if(rowsHash([version?.document])!==rowsHash([stageAdditions.get(row.id)!.document]))throw Error('upgrade_stage_append_mismatch');}if(additions.has(row.id)){const version=after.business_config_versions.find(r=>r.config_id===row.id&&r.version===expected.published_version);if(rowsHash([version?.document])!==rowsHash([additions.get(row.id)]))throw Error('upgrade_compensation_append_mismatch');}}continue;}
  if(['business_config_versions','business_template_bindings'].includes(table)){for(const row of rows)if(!after[table].some(r=>rowsHash([row])===rowsHash([r])))throw Error('upgrade_original_invariant_failed:'+table);continue;}
  if(table==='tasks'){for(const row of rows){const actual=after.tasks.find(r=>r.id===row.id),allowed=recovered.has(row.id)?['state','error_code','lease_until','claim_token','updated_at']:[];const project=(r:any)=>Object.fromEntries(keys.filter(k=>!allowed.includes(k)).map(k=>[k,r?.[k]]));if(rowsHash([project(row)])!==rowsHash([project(actual)]))throw Error('upgrade_original_invariant_failed:tasks');}continue;}
  const actual=table==='audit_events'?after[table].filter(r=>rows.some(o=>o.id===r.id)):after[table];
  if(rowsHash(rows)!==rowsHash(actual.map(r=>Object.fromEntries(keys.map(k=>[k,r[k]])))))throw Error('upgrade_original_invariant_failed:'+table);
 }
 return {...upgraded,preservedOriginalColumns:true,dictionaryInitialization:dictionaryInitialized?'applied_once_preserving_old_business_snapshots':'already_initialized',compensationInitialization:[...additions.keys()],stageInitialization:[...stageAdditions.keys()],sourceHash:manifest.databaseHash,sourceRevision:manifest.schemaRevision??Math.max(...archive.schema_migrations.map((r:any)=>r.version).filter((n:number)=>n<1000)),files,tableCounts:Object.fromEntries(Object.entries(after).map(([t,rows])=>[t,rows.length]))};});
}
