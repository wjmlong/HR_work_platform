import test from 'node:test';
import assert from 'node:assert/strict';
import {actor,testDatabase} from './helpers.js';
import {Identity} from '../src/identity/service.js';
import {RecruitingService} from '../src/recruiting/service.js';
import {Jobs} from '../src/recruiting/jobs.js';
import {readApplications} from '../src/recruiting/query.js';

const provider={
 configured:()=>true,
 authorizeUrl:()=>'',
 identity:async()=>{throw Error('unused');},
 contact:async(openId:string)=>({tenant:'company',appId:'app',openId,name:openId,active:true}),
};

test('a screening grant reads one job only and moves it exactly one step forward',async t=>{
 const db=await testDatabase();t.after(db.cleanup);
 const identity=new Identity(db.db,db.config,provider as any),recruiting=new RecruitingService(identity);
 const admin=await actor(db.db),screener=await actor(db.db,['viewer']);
 const job=await recruiting.createJob(admin,{name:'合成筛选岗位',level:'P5'}),
  other=await recruiting.createJob(admin,{name:'合成其他岗位',level:'P5'}),
  first=await recruiting.createCandidate(admin,{name:'合成甲',phone:'13800000000',email:'a@example.com'}),
  second=await recruiting.createCandidate(admin,{name:'合成乙'}),
  granted=await recruiting.apply(admin,{jobId:job.id,candidateId:first.id}),
  elsewhere=await recruiting.apply(admin,{jobId:other.id,candidateId:second.id});

 // Without a grant the viewer sees nothing and cannot open the application.
 assert.equal((await readApplications(identity,screener,{lifecycle:'active'})).items.length,0);
 await assert.rejects(identity.applicationAccess(screener,granted.id),/forbidden/);

 await db.db.query(
  "INSERT INTO job_screening_grants(job_id,user_id,expires_at,created_by) VALUES($1,$2,now()+interval '14 days',$3)",
  [job.id,screener.id,admin.id],
 );
 const scoped={...screener,screeningScope:[job.id]};
 const list=await readApplications(identity,scoped,{lifecycle:'active'});
 assert.deepEqual(list.items.map((r:any)=>r.id),[granted.id]);
 // Contacts are masked for a grant-only reader; the rest of the resume stays readable.
 assert.equal(list.items[0].profile.phone,'***');
 assert.equal(list.items[0].profile.email,'***');
 assert.equal(list.items[0].profile.name,'合成甲');
 // Other jobs stay out of the list, the job list and application access.
 assert.equal((await readApplications(identity,scoped,{lifecycle:'active',jobId:other.id})).items.length,0);
 await assert.rejects(identity.applicationAccess(screener,elsewhere.id),/forbidden/);
 assert.deepEqual((await new Jobs(identity).list(screener)).map((j:any)=>j.id),[job.id]);

 // One step forward is allowed, every other target and every form path is refused.
 await assert.rejects(recruiting.transition(screener,granted.id,{version:granted.version,to:'interviewing',interaction:'drag'}),/screening_scope_limited/);
 await assert.rejects(recruiting.transition(screener,granted.id,{version:granted.version,to:'screened',interaction:'form',reason:'表格',opinion:'手动填写理由'}),/screening_scope_limited/);
 const moved=await recruiting.transition(screener,granted.id,{version:granted.version,to:'screened',interaction:'drag'});
 assert.equal(moved.status,'screened');
 const event=(await db.db.query("SELECT actor_id,from_state,to_state,interaction FROM application_events WHERE application_id=$1 ORDER BY at DESC,id DESC LIMIT 1",[granted.id])).rows[0];
 assert.deepEqual([event.actor_id,event.from_state,event.to_state,event.interaction],[screener.id,'screening','screened','drag']);

 // A revoked or expired grant closes the door immediately.
 await db.db.query("UPDATE job_screening_grants SET expires_at=now()-interval '1 minute' WHERE job_id=$1 AND user_id=$2",[job.id,screener.id]);
 assert.equal((await readApplications(identity,screener,{lifecycle:'active'})).items.length,0);
 await assert.rejects(identity.applicationAccess(screener,granted.id),/forbidden/);
});
