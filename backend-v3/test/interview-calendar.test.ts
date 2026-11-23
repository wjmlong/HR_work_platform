import test from 'node:test';
import assert from 'node:assert/strict';
import {actor,testDatabase} from './helpers.js';
import {Identity} from '../src/identity/service.js';
import {FeishuProvider} from '../src/identity/provider.js';
import {RecruitingService} from '../src/recruiting/service.js';
import {InterviewService} from '../src/interviews/service.js';
import {configFixture,publishDefinition} from './business-config-fixture.js';

test('calendar week range returns every page while preserving assignment and deletion permissions',async t=>{
  const f=await testDatabase();t.after(f.cleanup);
  const admin=await actor(f.db),interviewer=await actor(f.db,['interviewer']),other=await actor(f.db,['interviewer']);
  const identity=new Identity(f.db,f.config,new FeishuProvider(f.config)),recruiting=new RecruitingService(identity),service=new InterviewService(identity);
  const job=await recruiting.createJob(admin,{name:'Calendar fixture',level:'P5'}),candidate=await recruiting.createCandidate(admin,{name:'Synthetic calendar candidate'}),application=await recruiting.apply(admin,{candidateId:candidate.id,jobId:job.id});
  const add=async(start:string,who=interviewer.id,deleted=false,status='pending')=>{
    const row=(await f.db.query("INSERT INTO interviews(application_id,round,starts_at,duration_minutes,form,created_by,primary_interviewer_id,deleted_at,status) VALUES($1,1,$2,30,'online',$3,$4,$5,$6) RETURNING id",[application.id,start,admin.id,who,deleted?new Date():null,status])).rows[0];
    await f.db.query('INSERT INTO interviewers(interview_id,user_id) VALUES($1,$2)',[row.id,who]);return row.id;
  };
  const ids=[];for(let i=0;i<57;i++)ids.push(await add(new Date(Date.UTC(2030,0,7,0,i)).toISOString()));
  const next=await add('2030-01-14T00:00:00Z');await add('2030-01-06T23:59:59Z');await add('2030-01-08T00:00:00Z',other.id);await add('2030-01-08T01:00:00Z',interviewer.id,true);await add('2030-01-08T02:00:00Z',interviewer.id,false,'cancelled');
  const range={startsFrom:'2030-01-07T00:00:00Z',startsBefore:'2030-01-14T00:00:00Z',pageSize:25},found=[];
  for(let page=1;page<=3;page++) {const result=await service.query(interviewer,{...range,page});assert.equal(result.total,57);found.push(...result.items.map((r:any)=>r.id));}
  assert.deepEqual(new Set(found),new Set(ids));assert.equal(found.length,57);
  assert.equal((await service.query(admin,range)).total,59);
  assert.deepEqual((await service.query(interviewer,{startsFrom:range.startsBefore,startsBefore:'2030-01-21T00:00:00Z'})).items.map((r:any)=>r.id),[next]);
  await assert.rejects(service.query(interviewer,{...range,deleted:true}),/forbidden/);
  await assert.rejects(service.query(admin,{startsFrom:range.startsBefore,startsBefore:range.startsFrom}),/invalid_input/);
});

test('calendar ranges cannot infer interview dates hidden by field permissions',async t=>{
  const f=await configFixture(t),interviewer=await actor(f.db,['interviewer']);
  const definition=await f.configs.effective(f.admin,'interview'),base:any=await f.configs.version(f.admin,definition.ref);
  await publishDefinition(f,{...base,fields:base.fields.map((field:any)=>field.coreKey==='startsAt'?{...field,access:{...field.access,read:['admin'],write:['admin'],export:['admin']}}:field)});
  const service=new InterviewService(f.identity);
  await assert.rejects(service.query(interviewer,{startsFrom:'2030-01-07T00:00:00Z',startsBefore:'2030-01-14T00:00:00Z'}),/field_query_forbidden/);
});
