import test from 'node:test';import assert from 'node:assert/strict';
import {configFixture} from './business-config-fixture.js';
import {TaskService} from '../src/tasks/service.js';import {Worker} from '../src/tasks/worker.js';import {FileStore} from '../src/files/storage.js';import {RecruitingService} from '../src/recruiting/service.js';
import {repairCandidateNames} from '../src/operations/repair-names.js';import {parseResumeProfile} from '../src/parsing/resume.js';
import {publishDefinition} from './business-config-fixture.js';
async function legacyPerson(f:any,raw:string){
 const tasks=new TaskService(f.identity,new FileStore(f.config.storageRoot)),worker=new Worker(f.identity,new FileStore(f.config.storageRoot),'name-repair-test');
 const task=await tasks.upload(f.admin,{name:'synthetic.txt',data:Buffer.from(raw),newCandidatesOnly:true});await worker.once();
 const id=(await tasks.get(f.admin,task.id)).result.candidateId;
 await f.db.query("UPDATE candidates SET profile=jsonb_set(profile,'{name}','\"待确认\"') WHERE id=$1",[id]);
 await f.db.query("UPDATE candidate_profile_versions SET profile=jsonb_set(profile,'{name}','\"待确认\"') WHERE candidate_id=$1",[id]);return id;
}
test('name repair changes only an untouched automatic name, keeps manual edits and is idempotent',async t=>{
 const f=await configFixture(t),r=new RecruitingService(f.identity);
 const first=await legacyPerson(f,'姓  名：杜小明\n电话：13800000001\n本科\n求职意向：品牌总监'),second=await legacyPerson(f,'姓 名：张小华\n电话：13800000002');
 const p=await r.candidate(f.admin,second);await r.editCandidate(f.admin,second,{version:p.version,profile:{...p.profile,summary:'人工更新描述'}});
 const before=(await f.db.query('SELECT * FROM candidates WHERE id=$1',[first])).rows[0],manual=(await f.db.query('SELECT * FROM candidates WHERE id=$1',[second])).rows[0];
 const resumes=(await f.db.query('SELECT md5(row_to_json(r)::text) hash FROM resume_versions r ORDER BY id')).rows;
 const preview=await repairCandidateNames(f.identity,f.admin,{apply:false});assert.equal(preview.resolved,1);assert.equal((await r.candidate(f.admin,first)).profile.name,'待确认');
 const result=await repairCandidateNames(f.identity,f.admin,{apply:true});assert.equal(result.changed,1);assert.equal(result.rules,1);assert.equal(result.model,0);
 const after=(await f.db.query('SELECT * FROM candidates WHERE id=$1',[first])).rows[0];
 assert.deepEqual({...after,profile:{...after.profile,name:before.profile.name},version:before.version,updated_at:before.updated_at},before);
 assert.deepEqual((await f.db.query('SELECT * FROM candidates WHERE id=$1',[second])).rows[0],manual);
 assert.deepEqual((await f.db.query('SELECT md5(row_to_json(r)::text) hash FROM resume_versions r ORDER BY id')).rows,resumes);
 assert.equal((await repairCandidateNames(f.identity,f.admin,{apply:true})).changed,0);
 assert.equal((await f.db.query("SELECT count(*)::int n FROM audit_events WHERE kind='candidate.name.repair'")).rows[0].n,1);
});
test('a concurrent HR edit between name resolution and writing is never overwritten',async t=>{
 const f=await configFixture(t),r=new RecruitingService(f.identity),id=await legacyPerson(f,'姓名：赵小华\n电话：13800000003');
 const result=await repairCandidateNames(f.identity,f.admin,{apply:true,ids:[id]},async(...args)=>{
  const resolved=await parseResumeProfile(...args),p=await r.candidate(f.admin,id);await r.editCandidate(f.admin,id,{version:p.version,profile:{...p.profile,name:'HR已确认姓名'}});return resolved;
 });
 assert.equal(result.changed,0);assert.equal(result.concurrentSkipped,1);assert.equal((await r.candidate(f.admin,id)).profile.name,'HR已确认姓名');
});
test('a new human-corrected resume appearing during resolution fences the stale repair',async t=>{
 const f=await configFixture(t),id=await legacyPerson(f,'姓名：赵小华\n电话：13800000004'),tasks=new TaskService(f.identity,new FileStore(f.config.storageRoot));
 const result=await repairCandidateNames(f.identity,f.admin,{apply:true,ids:[id]},async(...args)=>{
  const parsed=await parseResumeProfile(...args),resume=(await f.db.query('SELECT id FROM resume_versions WHERE candidate_id=$1',[id])).rows[0],raw=await tasks.raw(f.admin,resume.id);
  await tasks.correctResume(f.admin,resume.id,{baseParseResultId:raw.parseResultId,reason:'人工确认姓名',corrections:{name:'人工核对姓名'}});return parsed;
 });
 assert.equal(result.changed,0);assert.equal(result.concurrentSkipped,1);assert.equal((await f.db.query('SELECT profile FROM candidates WHERE id=$1',[id])).rows[0].profile.name,'人工核对姓名');
});
test('a role allowed to read resume names but denied name writes cannot apply a repair',async t=>{
 const f=await configFixture(t),id=await legacyPerson(f,'姓名：周小华\n电话：13800000006'),def=await f.configs.effective(f.admin,'resume'),doc=await f.configs.version(f.admin,def.ref),name=doc.fields.find((x:any)=>x.coreKey==='name');
 name.access.write=['manager'];await publishDefinition(f,doc);
 await assert.rejects(repairCandidateNames(f.identity,f.admin,{apply:true,ids:[id]}),/field_forbidden/);
 assert.equal((await f.db.query('SELECT version FROM candidates WHERE id=$1',[id])).rows[0].version,1);
});
