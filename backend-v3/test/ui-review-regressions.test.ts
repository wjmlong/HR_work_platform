import test from 'node:test';import assert from 'node:assert/strict';
import {testDatabase,actor,httpSession} from './helpers.js';
import {Identity} from '../src/identity/service.js';import {FeishuProvider} from '../src/identity/provider.js';import {RecruitingService} from '../src/recruiting/service.js';import {InterviewService} from '../src/interviews/service.js';import {SourcingService} from '../src/sourcing/service.js';
async function fixture(){const f=await testDatabase(),session=await httpSession(f.db,f.config),id=new Identity(f.db,f.config,new FeishuProvider(f.config));return {...f,...session,id,r:new RecruitingService(id),interviews:new InterviewService(id),sourcing:new SourcingService(id)}}
test('UI review: candidate search covers school and skills and board counts include records beyond the visible page',async t=>{
 const f=await fixture();t.after(async()=>{await f.app.close();await f.cleanup()});const a=f.actor,j=await f.r.createJob(a,{level:"P5",name:'范围岗位'}),p=await f.r.createCandidate(a,{name:'范围人',school:'验收大学',skills:['Python']});
 assert.equal((await f.r.candidates(a,{query:'验收大学'})).total,1);assert.equal((await f.r.candidates(a,{query:'Python'})).total,1);
 await f.db.query("INSERT INTO candidates(profile) SELECT jsonb_build_object('name','合成'||n) FROM generate_series(1,100) n");
 await f.db.query("INSERT INTO applications(candidate_id,job_id,status,created_at) SELECT id,$1,CASE WHEN id=$2 THEN 'hired' ELSE 'screening' END,CASE WHEN id=$2 THEN now()-interval '1 day' ELSE now() END FROM candidates",[j.id,p.id]);
 const q:any=await f.r.applications(a,{pageSize:100});assert.equal(q.total,101);assert.equal(q.stageCounts.hired,1);assert.equal(q.stageCounts.screening,100);
 assert.equal((await f.r.applications(a,{status:'hired'})).total,1);
});
test('UI review: pending ingest decisions survive hundreds of recomputations and interviews after row 1000 remain discoverable',async t=>{
 const f=await fixture();t.after(async()=>{await f.app.close();await f.cleanup()});const a=f.actor,j=await f.r.createJob(a,{level:"P5",name:'分页岗位'}),p=await f.r.createCandidate(a,{name:'分页验收'}),ap=await f.r.apply(a,{candidateId:p.id,jobId:j.id});
 await f.db.query("INSERT INTO tasks(kind,state,payload,actor_id,created_at) VALUES('ingest','needs_text','{}',$1,now()-interval '1 day')",[a.id]);
 await f.db.query("INSERT INTO tasks(kind,state,payload,actor_id) SELECT 'recompute','succeeded','{}',$1 FROM generate_series(1,250)",[a.id]);
 const q=await f.app.inject({method:'POST',url:'/api/v4/tasks/query',headers:f.headers,payload:{kind:'ingest',view:'actionable'}});assert.equal(q.statusCode,200,q.body);assert.equal(q.json().data.total,1);assert.equal(q.json().data.items[0].state,'needs_text');
 await f.db.query("INSERT INTO interviews(application_id,round,starts_at,duration_minutes,form,created_by) SELECT $1,n,now()+make_interval(days=>n),60,'合成',$2 FROM generate_series(1,1001) n",[ap.id,a.id]);
 await f.db.query('INSERT INTO interviewers SELECT id,$1 FROM interviews',[a.id]);
 const list=await f.app.inject({method:'POST',url:'/api/v4/interviews/query',headers:f.headers,payload:{page:41,pageSize:25,query:'分页验收'}});assert.equal(list.statusCode,200,list.body);assert.equal(list.json().data.total,1001);assert.equal(list.json().data.items.length,1);
});
test('UI review: historical submitted evaluation can be discovered after a newer private draft without leaking that draft',async t=>{
 const f=await fixture();t.after(async()=>{await f.app.close();await f.cleanup()});const reviewer=await actor(f.db,['interviewer']),j=await f.r.createJob(f.actor,{level:"P5",name:'评估岗位'}),p=await f.r.createCandidate(f.actor,{name:'评估验收'}),ap=await f.r.apply(f.actor,{candidateId:p.id,jobId:j.id}),meeting=await f.interviews.create(f.actor,{applicationId:ap.id,round:1,startsAt:'2030-01-01T09:00:00Z',durationMinutes:60,form:'合成',interviewerIds:[reviewer.id]});
 const data={professional:4,problemSolving:4,communication:4,evidenceNotes:'合成事实',summary:'可见提交',conclusion:'hold'};
 const first=await f.interviews.evaluate(reviewer,meeting.id,{version:0,status:'submitted',data});await f.interviews.evaluate(reviewer,meeting.id,{version:1,status:'draft',data:{...data,summary:'私有草稿'}});
 const q=await f.app.inject({url:`/api/v4/applications/${ap.id}/evaluation-history`,headers:f.headers});assert.equal(q.statusCode,200,q.body);assert.equal(q.json().data[0].id,first.id);assert.ok(!q.body.includes('私有草稿'));assert.equal((await f.interviews.evaluationVersions(f.actor,first.id)).length,1);
});
test('UI review: owner and follow-up author names are visible and recoverable leads can be found in a guarded recycle view',async t=>{
 const f=await fixture();t.after(async()=>{await f.app.close();await f.cleanup()});const other=await actor(f.db,['recruiter']);await f.db.query("UPDATE users SET name='合成负责人' WHERE id=$1",[other.id]);
 const l=await f.sourcing.create(f.actor,{name:'回收验收',org:'合成',direction:'工程',source:'其他',line:'high',ownerId:other.id});
 const followed=await f.sourcing.followup(f.actor,l.id,{version:1,kind:'note',note:'合成跟进',occurredAt:new Date(Date.now()-1000).toISOString()});
 const detail=await f.app.inject({url:'/api/v4/leads/'+l.id,headers:f.headers});assert.equal(detail.json().data.owner_name,'合成负责人');assert.equal(detail.json().data.followups[0].actor_name,f.actor.name);
 await f.sourcing.remove(f.actor,l.id,followed.version);const trash=await f.sourcing.query(f.actor,{deleted:true} as any);assert.equal(trash.total,1);assert.equal(trash.items[0].owner_name,'合成负责人');assert.equal((await f.sourcing.query(f.actor,{})).total,0);await f.sourcing.remove(f.actor,l.id,trash.items[0].version,true);assert.equal((await f.sourcing.query(f.actor,{})).total,1);
});
test('UI review: a selected directory member beyond page one can be retrieved without widening directory fields',async t=>{
 const f=await fixture();t.after(async()=>{await f.app.close();await f.cleanup()});const members=await f.db.query("INSERT INTO users(tenant,app_id,open_id,name,status,roles) SELECT 'company','app','ou_page'||n,'合成'||lpad(n::text,3,'0'),'active',ARRAY['viewer']::text[] FROM generate_series(1,105)n RETURNING id,name");
 const selected=members.rows.at(-1)!;const q=await f.app.inject({url:'/api/v4/assignment-members?role=viewer&ids='+selected.id,headers:f.headers});assert.equal(q.statusCode,200,q.body);assert.equal(q.json().data.items.length,1);assert.equal(q.json().data.items[0].id,selected.id);assert.ok(!q.body.includes('open_id'));
});
test('PRD closure: candidate empty pages preserve matching total and broad search projects accepted fragments back to their source fields',async t=>{
 const f=await fixture();t.after(async()=>{await f.app.close();await f.cleanup()});
 await f.r.createCandidate(f.actor,{name:'末页核对'});
 const empty=await f.r.candidates(f.actor,{query:'末页核对',page:2,pageSize:25});assert.equal(empty.items.length,0);assert.equal(empty.total,1);
});
test('PRD closure: broad Chinese record coverage highlights the source fields even when each field is below threshold',async t=>{
 const f=await fixture();t.after(async()=>{await f.app.close();await f.cleanup()});
 const lead=await f.sourcing.create(f.actor,{name:'机器',org:'合成',direction:'学习',source:'其他',line:'high'});
 const result=await f.sourcing.query(f.actor,{query:'机器学习系统'} as any);assert.equal(result.total,1);assert.equal(result.items[0].id,lead.id);
 for(const [key,text] of [['name','机器'],['direction','学习']]){const hit=result.items[0].hits[key];assert.equal(hit.matched,true);assert.equal(hit.kind,'broad');assert.equal(hit.ranges[0].text,text);assert.equal(result.items[0][key].slice(hit.ranges[0].start,hit.ranges[0].end),text);}
});
