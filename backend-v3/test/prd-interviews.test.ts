import test from 'node:test';
import assert from 'node:assert/strict';
import {testDatabase,actor,httpSession} from './helpers.js';
import {Identity} from '../src/identity/service.js';
import {FeishuProvider} from '../src/identity/provider.js';
import {RecruitingService} from '../src/recruiting/service.js';
import {InterviewService} from '../src/interviews/service.js';
async function context(t:any){const f=await testDatabase();t.after(f.cleanup);const a=await actor(f.db),identity=new Identity(f.db,f.config,new FeishuProvider(f.config)),r=new RecruitingService(identity),i=new InterviewService(identity),j=await r.createJob(a,{name:'Synthetic interview role',level:'P5'}),p=await r.createCandidate(a,{name:'Synthetic interview candidate'}),application=await r.apply(a,{candidateId:p.id,jobId:j.id});return {...f,a,identity,r,i,j,p,application};}

test('PRD canonical interview evaluation silently discards invalid scores, accepts half steps and never changes the candidate stage',async t=>{
 const f=await context(t),primary=await actor(f.db,['interviewer']),participant=await actor(f.db,['interviewer']);
 const meeting=await f.i.create(f.a,{applicationId:f.application.id,round:1,startsAt:'2030-01-01T09:00:00Z',durationMinutes:45,form:'online',interviewerIds:[primary.id,participant.id],primaryInterviewerId:primary.id});
 const {app,headers,actor:editor}=await httpSession(f.db,f.config);t.after(()=>app.close());
 const definition=(await app.inject({url:'/api/v4/business-config/effective/evaluation',headers})).json().data,fields={definitionVersion:definition.ref.version,definitionRevision:definition.aclRevision};
 const saved=await app.inject({method:'PUT',url:'/api/v4/interviews/'+meeting.id+'/evaluation',headers:{...headers,'idempotency-key':'clean-evaluation'},payload:{...fields,version:0,status:'submitted',forPrimary:true,data:{professional:1,communication:5.5,logicalThinking:3.5,culturalFit:'3',overallScore:4.5,evidenceNotes:'人工核对事实',summary:'人工记录',conclusion:'hold',questionCoverage:'覆盖 6/8 题，追问 2 处需要补充'}}});
 assert.equal(saved.statusCode,200,saved.body);const evaluation=saved.json().data;
 assert.equal(evaluation.author_id,primary.id);assert.equal(evaluation.last_editor_id,editor.id);
 assert.equal(evaluation.data.professional,1);assert.equal(evaluation.data.logicalThinking,3.5);assert.equal(evaluation.data.overallScore,4.5);
 assert.ok(!Object.hasOwn(evaluation.data,'communication'));assert.ok(!Object.hasOwn(evaluation.data,'culturalFit'));
 const row=(await f.db.query('SELECT data FROM evaluations WHERE id=$1',[evaluation.id])).rows[0];assert.deepEqual(row.data,evaluation.data);
 assert.equal((await f.r.application(f.a,f.application.id)).status,'screening');
 const read=await app.inject({url:'/api/v4/interviews/'+meeting.id+'/evaluation',headers});assert.equal(read.statusCode,200,read.body);assert.equal(read.json().data.id,evaluation.id);assert.equal(read.json().data.author_name,primary.name);assert.equal(read.json().data.editor_name,editor.name);
 const changed=await app.inject({method:'PUT',url:'/api/v4/interviews/'+meeting.id+'/evaluation',headers:{...headers,'idempotency-key':'clean-evaluation-2'},payload:{...fields,version:1,status:'submitted',forPrimary:true,data:{professional:2.5,communication:null,logicalThinking:0,culturalFit:6,questionCoverage:'只记录覆盖情况'}}});
 assert.equal(changed.statusCode,200,changed.body);assert.equal(changed.json().data.id,evaluation.id);assert.equal(changed.json().data.version,2);
 assert.equal(changed.json().data.data.summary,'人工记录');
 assert.equal(changed.json().data.data.logicalThinking,3.5); // Discarding a bad replacement must not erase the previous valid score.
 assert.equal((await f.db.query('SELECT count(*)::int n FROM evaluations WHERE interview_id=$1',[meeting.id])).rows[0].n,1);
 assert.equal((await f.r.application(f.a,f.application.id)).version,1);
});

test('PRD interviewer report hand fixture counts completed outcomes once, excludes private drafts/extra participants and applies ordered training rules',async t=>{
 const f=await context(t),participant=await actor(f.db,['interviewer']),groups=[
  {name:'R1',n:7,pass:6,scores:[2,2,2,2],rule:'R1'},
  {name:'R2',n:5,pass:1,scores:[4.5,4.5,4.5,4.5],rule:'R2'},
  {name:'R3',n:4,pass:2,scores:[4.5,4.5,4.5,4.5],rule:'R3'},
  {name:'R4',n:3,pass:2,scores:[3,4,4,4],rule:'R4'},
  {name:'R5',n:3,pass:2,scores:[4,4,4,4],rule:'R5'},
  {name:'Small',n:2,pass:2,scores:[1,1,1,1],rule:'insufficient'},
  {name:'NoScore',n:3,pass:1,scores:[],rule:'R5'},
 ];
 const ids:Record<string,string>={};let firstEvaluation:string|undefined;
 for(const group of groups){
  const who=await actor(f.db,['interviewer']);ids[group.name]=who.id;await f.db.query('UPDATE users SET name=$2 WHERE id=$1',[who.id,group.name]);
  for(let n=0;n<group.n;n++){
   const interview=(await f.db.query("INSERT INTO interviews(application_id,round,starts_at,duration_minutes,form,status,primary_interviewer_id,created_by) VALUES($1,$2,now()-make_interval(days=>$2),30,'online',$3,$4,$5) RETURNING id",[f.application.id,n+1,n<group.pass?'passed':'failed',who.id,f.a.id])).rows[0];
   await f.db.query('INSERT INTO interviewers(interview_id,user_id) VALUES($1,$2),($1,$3)',[interview.id,who.id,participant.id]);
   if(group.scores.length){
    const data={professional:group.scores[0],communication:group.scores[1],logicalThinking:group.scores[2],culturalFit:group.scores[3],questionCoverage:'人工覆盖记录'};
    const e=(await f.db.query("INSERT INTO evaluations(interview_id,author_id,status,data) VALUES($1,$2,'submitted',$3) RETURNING id",[interview.id,who.id,data])).rows[0];
    await f.db.query("INSERT INTO evaluation_versions(evaluation_id,version,data,status) VALUES($1,1,$2,'submitted')",[e.id,data]);
    if(group.name==='R1'&&n===0)firstEvaluation=e.id;
   }
   // Another participant's submitted opinion remains a real separate source, not a second count for this interview.
   const extra=(await f.db.query("INSERT INTO evaluations(interview_id,author_id,status,data) VALUES($1,$2,'submitted',$3) RETURNING id",[interview.id,participant.id,{professional:5,communication:5,logicalThinking:5,culturalFit:5}])).rows[0];
   await f.db.query("INSERT INTO evaluation_versions(evaluation_id,version,data,status) VALUES($1,1,$2,'submitted')",[extra.id,{professional:5,communication:5,logicalThinking:5,culturalFit:5}]);
  }
 }
 await f.db.query("INSERT INTO evaluation_versions(evaluation_id,version,data,status) VALUES($1,2,$2,'submitted'),($1,3,$3,'draft')",[firstEvaluation,{professional:2,communication:2,logicalThinking:2,culturalFit:2},{professional:5,summary:'PRIVATE_DRAFT_MUST_NOT_APPEAR'}]);
 await f.db.query("UPDATE evaluations SET version=3,status='draft',data=$2 WHERE id=$1",[firstEvaluation,{professional:5,summary:'PRIVATE_DRAFT_MUST_NOT_APPEAR'}]);
 for(const status of ['pending','cancelled','legacy_completed'])await f.db.query("INSERT INTO interviews(application_id,round,starts_at,duration_minutes,form,status,primary_interviewer_id,created_by) VALUES($1,20,now(),30,'online',$2,$3,$4)",[f.application.id,status,ids.R1,f.a.id]);
 const {app,headers}=await httpSession(f.db,f.config);t.after(()=>app.close());
 const result=await app.inject({method:'POST',url:'/api/v4/interviewer-review/query',headers,payload:{}});assert.equal(result.statusCode,200,result.body);
 assert.ok(!result.body.includes('PRIVATE_DRAFT_MUST_NOT_APPEAR'));
 const report=result.json().data;
 assert.deepEqual(report.kpis,{interviewers:7,completed:27,passRate:16/27,averageScore:319/96,scoredSessions:24});
 for(const group of groups){const row=report.interviewers.find((r:any)=>r.id===ids[group.name]);assert.equal(row.completed,group.n);assert.equal(row.passed,group.pass);assert.equal(row.verdict.rule,group.rule);}
 assert.equal(report.interviewers.find((r:any)=>r.id===ids.R1).assigned,10);
 assert.equal(report.interviewers.find((r:any)=>r.id===ids.NoScore).averageScore,null);
 assert.equal(report.interviewers.find((r:any)=>r.id===ids.NoScore).scoredSessions,0);
 assert.ok(report.details.length<=30);assert.equal(report.dimensionSamples.professional,24);
 const filtered=await app.inject({method:'POST',url:'/api/v4/interviewer-review/query',headers,payload:{interviewerId:ids.R2}});assert.equal(filtered.json().data.kpis.completed,5);
 const csv=await app.inject({method:'POST',url:'/api/v4/interviewer-review/export',headers,payload:{}});assert.equal(csv.statusCode,200);assert.ok(csv.rawPayload.subarray(0,3).equals(Buffer.from([239,187,191])));assert.ok(csv.body.includes('专业均分'));assert.ok(!csv.body.includes('PRIVATE_DRAFT_MUST_NOT_APPEAR'));
});

test('PRD completed-sample gate does not invent a second minimum count for scored interviews',async t=>{
 const f=await context(t),who=await actor(f.db,['interviewer']);
 for(let n=0;n<3;n++){
  const meeting=await f.i.create(f.a,{applicationId:f.application.id,round:n+1,startsAt:'2030-01-0'+(n+1)+'T09:00:00Z',durationMinutes:30,form:'online',status:'passed',interviewerIds:[who.id]});
  if(n===0)await f.i.evaluate(who,meeting.id,{version:0,status:'submitted',data:{professional:2,questionCoverage:'人工核对要点'}});
 }
 const {app,headers}=await httpSession(f.db,f.config);t.after(()=>app.close());
 const result=await app.inject({method:'POST',url:'/api/v4/interviewer-review/query',headers,payload:{}});assert.equal(result.statusCode,200,result.body);
 const row=result.json().data.interviewers[0];assert.equal(row.completed,3);assert.equal(row.scoredSessions,1);assert.equal(row.verdict.rule,'R1');
});
