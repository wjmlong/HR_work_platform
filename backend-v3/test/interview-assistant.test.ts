import test from 'node:test';import assert from 'node:assert/strict';
import {testDatabase,actor} from './helpers.js';import {Identity} from '../src/identity/service.js';import {FeishuProvider} from '../src/identity/provider.js';import {RecruitingService} from '../src/recruiting/service.js';import {InterviewService} from '../src/interviews/service.js';import {InterviewAssistant} from '../src/interview-assistant/service.js';
test('durable assistant enforces assigned access, deduplicates segments, rejects edits after finish',async t=>{
 const {db,config,cleanup}=await testDatabase();t.after(cleanup);config.feishu={...config.feishu,tenant:'company',appId:'app'};const a=await actor(db),i=await actor(db,['interviewer']),other=await actor(db,['interviewer']),id=new Identity(db,config,new FeishuProvider(config)),r=new RecruitingService(id),s=new InterviewAssistant(id);
 const job=await r.createJob(a,{level:'P5',name:'自动化开发'}),c=await r.createCandidate(a,{name:'合成测试候选人'}),ap=await r.apply(a,{candidateId:c.id,jobId:job.id}),meeting=await new InterviewService(id).create(a,{applicationId:ap.id,round:1,startsAt:'2026-10-28T10:00:00+08:00',durationMinutes:60,form:'线上',interviewerIds:[i.id]});
 await assert.rejects(s.start(other,meeting.id,{consent:true}),/forbidden/);
 await assert.rejects(s.start(i,meeting.id,{consent:false}));
 const session=await s.start(i,meeting.id,{consent:true});assert.equal(session.state,'active');
 await db.query('UPDATE users SET version=version+1 WHERE id=$1',[i.id]);
 await assert.rejects(s.read(i,meeting.id,session.id),/membership_changed/);
 await db.query('UPDATE users SET version=version-1 WHERE id=$1',[i.id]);
 const segment={id:'chunk-1',sequence:1,source:'meeting',speaker:'candidate',text:'我独立做过自动化项目',startMs:0,endMs:4000};
 await s.append(i,meeting.id,session.id,segment);await s.append(i,meeting.id,session.id,segment);
 assert.equal((await s.read(i,meeting.id,session.id)).segments.length,1);
 await assert.rejects(s.append(i,meeting.id,session.id,{...segment,text:'覆盖原文'}),/segment_conflict/);
 await assert.rejects(s.read(other,meeting.id,session.id),/forbidden/);
 await assert.rejects(s.append(a,meeting.id,session.id,{...segment,id:'admin'}),/session_owner/);
 await s.setSpeaker(i,meeting.id,session.id,{segmentId:'chunk-1',speaker:'unknown',revision:2});
 assert.equal((await s.read(i,meeting.id,session.id)).segments[0].speaker,'unknown');
 await assert.rejects(s.saveAnalysis(i,meeting.id,session.id,3,{},true),/assistant_evidence_invalid/);
 await assert.rejects(s.setSpeaker(i,meeting.id,session.id,{segmentId:'chunk-1',speaker:'candidate',revision:2}),/transcript_changed/);
 await s.setSpeaker(i,meeting.id,session.id,{segmentId:'chunk-1',speaker:'candidate',revision:3});
 const current=await s.read(i,meeting.id,session.id);
 const analysis={suggestions:[],dimensions:current.basis.dimensions.map((d:any,n:number)=>({dimensionId:d.id,status:n===0?'evidence':'not_covered',summary:n===0?'提及项目，待追问':'未覆盖',evidence:n===0?[{segmentId:'chunk-1',quote:'我独立做过自动化项目'}]:[]})),nextSteps:[]};
 await s.saveAnalysis(i,meeting.id,session.id,current.revision,analysis,true);
 assert.equal((await s.read(i,meeting.id,session.id)).state,'finished');
 await assert.rejects(s.append(i,meeting.id,session.id,{...segment,id:'late'}),/session_finished/);
 const draft=await s.adopt(i,meeting.id,session.id,{confirmed:true,version:0});
 assert.equal(draft.status,'draft');assert.match(draft.data.evidenceNotes,/我独立做过自动化项目/);
 await assert.rejects(s.adopt(i,meeting.id,session.id,{confirmed:true,version:0}),/version_conflict/);
 await assert.rejects(s.adopt(i,meeting.id,session.id,{confirmed:true,version:draft.version}),/already_adopted/);
 assert.equal((await r.application(a,ap.id)).status,'screening');
 const stranded=await s.start(i,meeting.id,{consent:true});
 await db.query('DELETE FROM interviewers WHERE interview_id=$1 AND user_id=$2',[meeting.id,i.id]);
 await assert.rejects(s.abandon(other,meeting.id,stranded.id,{revision:1,reason:'重新安排面试官'}),/forbidden/);
 await s.abandon(a,meeting.id,stranded.id,{revision:1,reason:'重新安排面试官'});
 assert.equal((await s.read(a,meeting.id,stranded.id)).state,'abandoned');
 assert.notEqual((await s.start(a,meeting.id,{consent:true})).id,stranded.id);
});

test('stored job context becomes inaccessible when current field read permission is revoked',async t=>{
 const {configFixture,publishDefinition}=await import('./business-config-fixture.js');const f=await configFixture(t),i=await actor(f.db,['interviewer']),r=new RecruitingService(f.identity),s=new InterviewAssistant(f.identity);
 const job=await r.createJob(f.admin,{level:'P5',name:'Synthetic restricted job'}),c=await r.createCandidate(f.admin,{name:'Synthetic ACL candidate'}),ap=await r.apply(f.admin,{candidateId:c.id,jobId:job.id}),meeting=await new InterviewService(f.identity).create(f.admin,{applicationId:ap.id,round:1,startsAt:'2026-10-28T10:00:00+08:00',durationMinutes:60,form:'线上',interviewerIds:[i.id]});
 const session=await s.start(i,meeting.id,{consent:true});assert.ok(session.basis.sourceKeys.includes('name'));
 const base:any=await f.configs.version(f.admin,(await f.configs.effective(f.admin,'job')).ref);
 await publishDefinition(f,{...base,fields:base.fields.map((x:any)=>x.coreKey==='name'?{...x,access:{...x.access,read:['admin']}}:x)});
 await assert.rejects(s.read(i,meeting.id,session.id),/material_source_forbidden/);
 await assert.rejects(s.start(i,meeting.id,{consent:true}),/material_source_forbidden/);
});

test('mixed audio originals survive confirmed excerpts and unauthorized realtime context is denied',async t=>{
 const {db,config,cleanup}=await testDatabase();t.after(cleanup);const {httpSession}=await import('./helpers.js');const h=await httpSession(db,config);t.after(()=>h.app.close());const id=new Identity(db,config,h.provider),r=new RecruitingService(id),s=new InterviewAssistant(id),a=h.actor;
 const job=await r.createJob(a,{level:'P5',name:'合成实时面试岗位'}),candidate=await r.createCandidate(a,{name:'合成实时候选人'}),application=await r.apply(a,{candidateId:candidate.id,jobId:job.id}),meeting=await new InterviewService(id).create(a,{applicationId:application.id,round:1,startsAt:'2026-10-29T10:00:00+08:00',durationMinutes:60,form:'线上',interviewerIds:[a.id]}),session=await s.start(a,meeting.id,{consent:true});
 const original={id:'mixed-original',sequence:1,source:'mixed',speaker:'mixed',text:'请介绍项目。我独立完成接口和重试。',startMs:0,endMs:5000};await s.append(a,meeting.id,session.id,original);
 const excerpt={id:'confirmed-excerpt',sequence:2,source:'manual',speaker:'candidate',parentId:original.id,text:'我独立完成接口和重试。',startMs:0,endMs:5000};
 await assert.rejects(s.append(a,meeting.id,session.id,{...excerpt,text:'编造的回答'}),/assistant_excerpt_invalid/);
 const row=await s.append(a,meeting.id,session.id,excerpt);assert.equal(row.segments[0].text,original.text);assert.equal(row.segments[1].parentId,original.id);
 const root='/api/v4/interviews/'+meeting.id+'/assistant/'+session.id;
 const noAuth=await h.app.inject({method:'POST',url:root+'/realtime-context',payload:{mode:'hints'}});assert.notEqual(noAuth.statusCode,200);
 const context=await h.app.inject({method:'POST',url:root+'/realtime-context',headers:h.headers,payload:{mode:'hints'}});assert.equal(context.statusCode,200,context.body);assert.match(context.json().data.instructions,/我独立完成接口和重试/);assert.equal(context.body.includes('apiKey'),false);
 const missing=await h.app.inject({method:'POST',url:root+'/realtime',headers:h.headers,payload:{mode:'hints',offer:'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'}});assert.equal(missing.statusCode,503);
 const report={discussionSummary:[{summary:'讨论项目分工',evidence:[{segmentId:original.id,quote:'请介绍项目'}]}],suggestions:[],dimensions:row.basis.dimensions.map((d:any,n:number)=>({dimensionId:d.id,status:n===0?'evidence':'not_covered',summary:n===0?'项目经历待核实':'未覆盖',evidence:n===0?[{segmentId:excerpt.id,quote:excerpt.text}]:[]})),nextSteps:[]};
 const finished=await s.saveAnalysis(a,meeting.id,session.id,row.revision,report,true);assert.equal(finished.state,'finished');
 const blocked=await h.app.inject({method:'POST',url:root+'/realtime-context',headers:h.headers,payload:{mode:'hints'}});assert.equal(blocked.statusCode,409);
});

test('unattributed session can finish with minutes but cannot adopt absent candidate evidence',async t=>{
 const {db,config,cleanup}=await testDatabase();t.after(cleanup);const a=await actor(db),id=new Identity(db,config,new FeishuProvider(config)),r=new RecruitingService(id),s=new InterviewAssistant(id);
 const job=await r.createJob(a,{level:'P5',name:'会话纪要测试'}),c=await r.createCandidate(a,{name:'合成候选人'}),ap=await r.apply(a,{candidateId:c.id,jobId:job.id}),meeting=await new InterviewService(id).create(a,{applicationId:ap.id,round:1,startsAt:'2026-10-29T10:00:00+08:00',durationMinutes:60,form:'线上',interviewerIds:[a.id]});
 const start=await s.start(a,meeting.id,{consent:true}),row=await s.append(a,meeting.id,start.id,{id:'dialogue',sequence:1,source:'mixed',speaker:'unknown',text:'我们讨论一下接口重试。',startMs:0,endMs:4000});
 const emptyReport={suggestions:[],dimensions:row.basis.dimensions.map((d:any)=>({dimensionId:d.id,status:'not_covered',summary:'未归属个人',evidence:[]})),nextSteps:[]};
 await assert.rejects(s.saveAnalysis(a,meeting.id,row.id,row.revision,emptyReport,true),/assistant_minutes_missing/);assert.equal((await s.read(a,meeting.id,row.id)).state,'active');
 const result=await s.saveAnalysis(a,meeting.id,row.id,row.revision,{suggestions:[],dimensions:row.basis.dimensions.map((d:any)=>({dimensionId:d.id,status:'not_covered',summary:'未归属个人',evidence:[]})),discussionSummary:[{summary:'讨论接口重试。',evidence:[{segmentId:'dialogue',quote:'接口重试'}]}],nextSteps:[]},true);
 assert.equal(result.state,'finished');assert.equal(result.segments[0].speaker,'unknown');await assert.rejects(s.adopt(a,meeting.id,row.id,{confirmed:true,version:0}),/assistant_candidate_evidence_required/);
});
