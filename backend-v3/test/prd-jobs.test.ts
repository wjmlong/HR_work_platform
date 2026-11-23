import test from 'node:test';
import assert from 'node:assert/strict';
import {testDatabase,actor} from './helpers.js';
import {Identity} from '../src/identity/service.js';
import {FeishuProvider} from '../src/identity/provider.js';
import {RecruitingService} from '../src/recruiting/service.js';
import {Commands} from '../src/http/commands.js';
async function context(t:any){const f=await testDatabase();t.after(f.cleanup);const a=await actor(f.db);return {...f,a,r:new RecruitingService(new Identity(f.db,f.config,new FeishuProvider(f.config)))};}

test('PRD job saves require one of ten grades and an explicit source for any market salary; legacy ungraded remains readable',async t=>{
 const f=await context(t);
 await assert.rejects(f.r.createJob(f.a,{name:'Missing grade'}),/invalid_input|job_level_required/);
 for(const level of ['P4','P5','P6','P7','P8','P9','M1','M2','M3','专业服务']){
  const job=await f.r.createJob(f.a,{name:'Synthetic grade '+level,level});assert.equal(job.level,level);
 }
 await assert.rejects(f.r.createJob(f.a,{name:'Unsourced reference',level:'P6',marketSalary:'Synthetic only'}),/market_source_required|invalid_input/);
 const old=(await f.db.query("INSERT INTO jobs(name) VALUES('Legacy ungraded') RETURNING *")).rows[0];
 await f.db.query("INSERT INTO job_versions(job_id,version,requirements,actor_id) VALUES($1,1,'{}',$2)",[old.id,f.a.id]);
 assert.equal((await f.r.jobs(f.a)).find((x:any)=>x.id===old.id).level,null);
 await assert.rejects(f.r.updateJob(f.a,old.id,{version:1,name:'Legacy edited'}),/job_level_required/);
 const updated=await f.r.updateJob(f.a,old.id,{version:1,level:'P4',salaryRange:'Synthetic range'});
 assert.equal(updated.level,'P4');assert.equal(updated.salary_range,'Synthetic range');
});

test('PRD salary privacy: internal fields stay out of unprivileged jobs and external JD, with explicit departmental read grant',async t=>{
 const f=await context(t),viewer=await actor(f.db,['viewer']);
 const job=await f.r.createJob(f.a,{name:'Synthetic private salary',level:'P6',salaryRange:'INTERNAL_RANGE',marketSalary:'MARKET_ANCHOR',marketSource:'SYNTHETIC_SOURCE',salaryNote:'PRIVATE_NOTE',requirements:{description:'Public responsibilities and requirements'}});
 const candidate=await f.r.createCandidate(f.a,{name:'Synthetic assigned reader'}),application=await f.r.apply(f.a,{candidateId:candidate.id,jobId:job.id});
 await f.db.query('INSERT INTO application_grants(application_id,user_id) VALUES($1,$2)',[application.id,viewer.id]);
 let visible=(await f.r.jobs(viewer)).find((x:any)=>x.id===job.id);
 assert.ok(visible);assert.equal(visible.salary_range,undefined);assert.equal(visible.market_salary,undefined);assert.equal(visible.salary_note,undefined);
 const jd=await f.r.publicJob(f.a,job.id);
 assert.equal(jd.description,'Public responsibilities and requirements');
 for(const secret of ['INTERNAL_RANGE','MARKET_ANCHOR','SYNTHETIC_SOURCE','PRIVATE_NOTE'])assert.ok(!JSON.stringify(jd).includes(secret));
 await assert.rejects(f.r.salaryGrant(viewer,job.id,{userId:viewer.id,allow:true}),/forbidden/);
 await f.r.salaryGrant(f.a,job.id,{userId:viewer.id,allow:true});
 visible=(await f.r.jobs(viewer)).find((x:any)=>x.id===job.id);assert.equal(visible.salary_range,'INTERNAL_RANGE');
 await f.r.salaryGrant(f.a,job.id,{userId:viewer.id,allow:false});
 assert.equal((await f.r.jobs(viewer)).find((x:any)=>x.id===job.id).salary_range,undefined);
 const detail=await f.r.application(viewer,application.id);assert.ok(!JSON.stringify(detail).includes('INTERNAL_RANGE'));
});

test('PRD close preview excludes three terminal stages, requires fresh explicit confirmation and retains every job relation',async t=>{
 const f=await context(t),job=await f.r.createJob(f.a,{name:'Synthetic closing role',level:'P5'});
 for(const status of ['screening','collecting','hired','terminated','rejected']){
  const p=await f.r.createCandidate(f.a,{name:'Close '+status});
  await f.db.query('INSERT INTO applications(candidate_id,job_id,status) VALUES($1,$2,$3)',[p.id,job.id,status]);
 }
 const preview=await f.r.closeJobPreview(f.a,job.id,{version:1});
 assert.equal(preview.count,2);assert.deepEqual(preview.candidates.map((x:any)=>x.status).sort(),['collecting','screening']);
 await assert.rejects(f.r.updateJob(f.a,job.id,{version:1,open:false}),/job_close_confirmation/);
 const p=await f.r.createCandidate(f.a,{name:'Arrived after preview'});await f.r.apply(f.a,{candidateId:p.id,jobId:job.id});
 await assert.rejects(f.r.updateJob(f.a,job.id,{version:1,open:false,closeConfirm:true,closePreviewHash:preview.hash}),/job_close_confirmation/);
 const fresh=await f.r.closeJobPreview(f.a,job.id,{version:1});assert.equal(fresh.count,3);
 const closed=await f.r.updateJob(f.a,job.id,{version:1,open:false,closeConfirm:true,closePreviewHash:fresh.hash,closeReason:'Synthetic closure'});
 assert.equal(closed.open,false);assert.ok(closed.closed_at);assert.equal(closed.close_reason,'Synthetic closure');
 assert.equal((await f.db.query('SELECT count(*)::int n FROM applications WHERE job_id=$1',[job.id])).rows[0].n,6);
 await assert.rejects(f.r.apply(f.a,{candidateId:p.id,jobId:job.id}),/job_closed/);
 const reopened=await f.r.updateJob(f.a,job.id,{version:closed.version,open:true});assert.equal(reopened.open,true);assert.equal(reopened.closed_at,null);
});

test('PRD salary edits retain requirement version; actual requirements edit advances matching and queues only current workflows',async t=>{
 const f=await context(t),job=await f.r.createJob(f.a,{name:'Synthetic versioned requirements',level:'P5',requirements:{skills:['Java']}});
 const salary=await f.r.updateJob(f.a,job.id,{version:1,salaryRange:'Synthetic range'});
 assert.equal(salary.requirements_version,1);assert.equal(salary.version,2);
 assert.equal((await f.db.query('SELECT count(*)::int n FROM tasks')).rows[0].n,0);
 const requirement=await f.r.updateJob(f.a,job.id,{version:2,requirements:{skills:['Python']}});
 assert.equal(requirement.requirements_version,3);
 assert.deepEqual((await f.r.jobs(f.a))[0].requirements.skills,['Python']);
});

test('PRD salary revocation: a newly authenticated lesser role cannot replay a cached salary-bearing write response',async t=>{
 const f=await context(t),commands=new Commands(f.db),input={name:'Synthetic cached job',level:'P5',salaryRange:'PRIVATE_CACHED_RANGE'};
 const saved=await commands.run(f.a,'salary-replay',input,()=>f.r.createJob(f.a,input));
 assert.equal(saved.salary_range,'PRIVATE_CACHED_RANGE');
 await f.db.query("UPDATE users SET roles=ARRAY['viewer']::text[],version=version+1 WHERE id=$1",[f.a.id]);
 const restricted={...f.a,version:f.a.version+1,roles:['viewer'] as ['viewer']};
 await assert.rejects(commands.run(restricted,'salary-replay',input,()=>f.r.createJob(restricted,input)),/idempotency_conflict|membership_changed|forbidden/);
});
