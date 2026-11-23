import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {testDatabase,actor} from './helpers.js';
import {loadConfig} from '../src/config.js';
import {Database} from '../src/db.js';
import {Identity} from '../src/identity/service.js';
import {FeishuProvider} from '../src/identity/provider.js';
import {RecruitingService} from '../src/recruiting/service.js';
import {StatisticsService} from '../src/statistics/service.js';
import {CampusService} from '../src/campus/service.js';
import {SourcingService} from '../src/sourcing/service.js';
import {migrateLegacy,safe} from '../src/operations/migration.js';
import {FileStore} from '../src/files/storage.js';

test('review: connection query overrides are rejected and effective copy options are authoritative without connecting',async()=>{
 const env={RECRUIT_V4_DATABASE_URL:'postgresql://u:p@127.0.0.1:55434/recruit_v4',RECRUIT_V4_SECRET:'s'.repeat(48)};
 for(const suffix of ['?host=example.invalid&port=55433','?options=-c%20search_path%3Dpublic','?dbname=recruit_v3','?sslmode=disable','#override'])
  assert.throws(()=>loadConfig({...env,RECRUIT_V4_DATABASE_URL:env.RECRUIT_V4_DATABASE_URL+suffix}),/isolated database/);
 const config={...loadConfig(env),schema:'recruit_test_importprobe'},db=new Database(config);
 try{const client=new pg.Client(db.pool.options as any),p=(client as any).connectionParameters;
 assert.equal(p.host,'127.0.0.1');assert.equal(String(p.port),'55434');assert.equal(p.database,'recruit_v4');
 assert.match(p.options,/search_path=recruit_test_importprobe,public/);assert.match(p.options,/statement_timeout=15000/);
 assert.throws(()=>new Database({...config,databaseUrl:env.RECRUIT_V4_DATABASE_URL+'?options=-c%20search_path%3Dpublic'}),/isolated database/);
 }finally{await db.close();}
});
async function fixture(t:any){const f=await testDatabase();t.after(f.cleanup);const a=await actor(f.db),identity=new Identity(f.db,f.config,new FeishuProvider(f.config));return {...f,a,identity,r:new RecruitingService(identity)};}
test('review: transfer rejection survives reactivation and rejection statistics use its category',async t=>{
 const f=await fixture(t),j=await f.r.createJob(f.a,{name:'Synthetic source',level:'P5'}),j2=await f.r.createJob(f.a,{name:'Synthetic destination',level:'P5'}),p=await f.r.createCandidate(f.a,{name:'Synthetic history'}),old=await f.r.apply(f.a,{candidateId:p.id,jobId:j.id});
 const app=await f.r.transfer(f.a,old.id,{version:old.version,targetJobId:j2.id,to:'rejected',confirm:true,reason:'岗位匹配调整',opinion:'人工确认此项流程调整',rejectReason:'专业能力不匹配',rejectDetail:'已核对具体岗位项目证据'});
 const s=new StatisticsService(f.identity),q={from:'2000-01-01T00:00:00Z',to:'2100-01-01T00:00:00Z'};
 assert.equal((await s.report(f.a,q)).rejections['专业能力不匹配'],1);
 await f.r.transition(f.a,app.id,{version:app.version,to:'screening',confirm:true,reason:'重新考虑',opinion:'人工复核后重新进入流程'});
 const event=(await f.db.query("SELECT * FROM application_events WHERE application_id=$1 AND to_state='rejected'",[app.id])).rows[0];
 assert.equal(event.rejection_reason,'专业能力不匹配');assert.equal(event.rejection_detail,'已核对具体岗位项目证据');assert.equal(event.reason,'岗位匹配调整');
});
test('review: closed legacy jobs and supplied half-step interview scores remain usable with explicit provenance',async t=>{
 const f=await fixture(t),dir=await mkdtemp(path.join(os.tmpdir(),'review-import-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const bundle={jobs:[{id:'j',name:'Synthetic closed',open:false,headcount:7,salaryNote:'Synthetic salary note',closeReason:'Synthetic closure',closedAt:'2026-01-02T00:00:00Z'}],talents:[{id:'p',name:'Synthetic',jobId:'j',status:'初筛通过',raw:'姓名：Synthetic\n技能：Python'}],interviews:[{candId:'p',round:1,who:'Old subject',date:'2026-01-01',time:'10:00',status:'已通过',way:'视频',scores:{d1:4.5,d2:3,d3:2.2,d4:null},cover:'专业案例已覆盖',fb:'历史反馈'}]};
 const mapping={'Old subject':f.a.id},store=new FileStore(dir);
 const conflict=structuredClone(bundle);Object.assign(conflict.jobs[0],{status:'在招',count:1});
 assert.equal((await migrateLegacy(f.db,store,f.a,conflict,true,mapping)).ready,false);
 await migrateLegacy(f.db,store,f.a,bundle,false,mapping);
 const job=(await f.db.query('SELECT * FROM jobs')).rows[0];assert.equal(job.open,false);assert.equal(job.headcount,7);assert.equal(job.salary_note,'Synthetic salary note');assert.equal(job.close_reason,'Synthetic closure');assert.equal(job.closed_at.toISOString(),'2026-01-02T00:00:00.000Z');
 const e=(await f.db.query('SELECT * FROM evaluations')).rows[0];assert.ok(e);assert.equal(e.author_id,f.a.id);assert.equal(e.last_editor_id,f.a.id);assert.equal(e.status,'submitted');
 assert.equal(e.data.professional,4.5);assert.equal(e.data.communication,3);assert.equal(e.data.logicalThinking,undefined);assert.equal(e.data.culturalFit,undefined);assert.equal(e.data.questionCoverage,'专业案例已覆盖');assert.equal(e.data.conclusion,undefined);assert.equal(e.data.legacyProvenance.originalOperator,'unknown');
 assert.equal((await f.db.query('SELECT count(*)::int n FROM evaluation_versions')).rows[0].n,1);
 assert.equal(safe('Synthetic 🧪 𠀀\ud800'),'Synthetic 🧪 𠀀�');
});
test('review: statistics counts only latest submitted primary evaluation as of the requested boundary',async t=>{
 const f=await fixture(t),other=await actor(f.db,['interviewer']),j=await f.r.createJob(f.a,{name:'Synthetic scores',level:'P5'}),p=await f.r.createCandidate(f.a,{name:'Synthetic scores'}),app=await f.r.apply(f.a,{candidateId:p.id,jobId:j.id});
 const i=(await f.db.query("INSERT INTO interviews(application_id,round,starts_at,duration_minutes,form,created_by,primary_interviewer_id) VALUES($1,1,now(),60,'视频',$2,$2) RETURNING id",[app.id,f.a.id])).rows[0];
 for(const [author,score] of [[f.a.id,4],[other.id,1]] as const){const e=(await f.db.query("INSERT INTO evaluations(interview_id,author_id,status,data,version) VALUES($1,$2,'draft','{}',2) RETURNING id",[i.id,author])).rows[0];await f.db.query("INSERT INTO evaluation_versions(evaluation_id,version,data,status,at) VALUES($1,1,$2,'submitted','2026-01-01'),($1,2,$3,'draft','2026-01-02'),($1,3,$3,'submitted','2090-01-01')",[e.id,{professional:score},{professional:5}]);}
 const report=await new StatisticsService(f.identity).report(f.a,{from:'2000-01-01T00:00:00Z',to:'2100-01-01T00:00:00Z',asOf:'2080-01-01T00:00:00Z'});assert.equal(report.professionalScoreSamples,1);assert.equal(report.meanProfessionalScore,4);
});
test('review: credential reveal requires current metadata version and a shared user rate limit',async t=>{
 const f=await fixture(t),dir=await mkdtemp(path.join(os.tmpdir(),'review-vault-'));t.after(()=>rm(dir,{recursive:true,force:true}));f.config.campusKeyFile=path.join(dir,'keys.json');const s=new CampusService(f.identity);
 const row=await s.create(f.a,{school:'Synthetic',credentials:{password:{action:'replace',value:'Synthetic secret'}}});
 await assert.rejects((s.reveal as any)(f.a,row.id,{}),/invalid_input/);
 const next=await s.update(f.a,row.id,{version:row.version,note:'metadata changed'});
 await assert.rejects((s.reveal as any)(f.a,row.id,{version:row.version}),/version_conflict/);
 for(let i=0;i<9;i++)assert.equal((await (s.reveal as any)(f.a,row.id,{version:next.version})).password,'Synthetic secret');
 const shared=new CampusService(new Identity(f.db,f.config,new FeishuProvider(f.config)));
 await assert.rejects((shared.reveal as any)(f.a,row.id,{version:next.version}),/rate_limited/);
 assert.ok(!JSON.stringify((await f.db.query('SELECT * FROM rate_limits')).rows).includes('Synthetic secret'));
});
test('review: selecting trimmed skill and direction facets includes records containing only padded source tokens',async t=>{
 const f=await fixture(t),s=new SourcingService(f.identity);await f.db.query("INSERT INTO leads(name,org,skills,direction,source,line,owner_id) VALUES('Synthetic','Synthetic',ARRAY[' Python '],' AI ','其他','high',$1)",[f.a.id]);
 const all=await s.query(f.a,{});assert.equal(all.facets.direction.find((x:any)=>x.value==='AI')?.count,1);
 assert.equal((await s.query(f.a,{filters:{skills:['Python'],direction:['AI']}})).total,1);
});
