import test from 'node:test';import assert from 'node:assert/strict';import {testDatabase,httpSession} from './helpers.js';
test('assistant capabilities require login and do not claim missing providers',async t=>{const {db,config,cleanup}=await testDatabase();t.after(cleanup);config.modelConfigFile=undefined;config.speechConfigFile=undefined;const {app,headers}=await httpSession(db,config);t.after(()=>app.close());const no=await app.inject({url:'/api/v4/interview-assistant/capabilities'});assert.notEqual(no.statusCode,200);const yes=await app.inject({url:'/api/v4/interview-assistant/capabilities',headers});assert.equal(yes.statusCode,200);assert.deepEqual(yes.json().data,{analysis:false,speech:false,realtime:false,speechProvider:'未配置',audioStorage:false});});
test('nested assistant session routes accept both identifiers and recheck access on every request',async t=>{
 const {db,config,cleanup}=await testDatabase();t.after(cleanup);const {app,headers,actor:a}=await httpSession(db,config);t.after(()=>app.close());
 const job=(await db.query("INSERT INTO jobs(name) VALUES('合成API岗位') RETURNING id")).rows[0];
 const candidate=(await db.query("INSERT INTO candidates(profile) VALUES('{\"name\":\"合成API候选人\"}') RETURNING id")).rows[0];
 const application=(await db.query('INSERT INTO applications(candidate_id,job_id) VALUES($1,$2) RETURNING id',[candidate.id,job.id])).rows[0];
 const interview=(await db.query("INSERT INTO interviews(application_id,round,starts_at,duration_minutes,form,created_by,primary_interviewer_id) VALUES($1,1,now(),60,'线上',$2,$2) RETURNING id",[application.id,a.id])).rows[0];
 await db.query("INSERT INTO interview_assistant_sessions(interview_id,owner_id,basis) VALUES($1,$2,'{\"dimensions\":[{\"id\":\"professional\"}]}')",[interview.id,a.id]);
 const session=(await db.query('SELECT id FROM interview_assistant_sessions WHERE interview_id=$1',[interview.id])).rows[0];
 const url='/api/v4/interviews/'+interview.id+'/assistant/'+session.id;
 const read=await app.inject({url,headers});assert.equal(read.statusCode,200,read.body);
 const body={id:'http-one',sequence:1,source:'manual',speaker:'candidate',text:'我独立做过自动化项目',startMs:0,endMs:3000};
 const saved=await app.inject({method:'POST',url:url+'/segments',headers,payload:body});assert.equal(saved.statusCode,200,saved.body);assert.equal(saved.json().data.segments.length,1);
 const replay=await app.inject({method:'POST',url:url+'/segments',headers,payload:body});assert.equal(replay.statusCode,200);assert.equal(replay.json().data.segments.length,1);
 const outsider=await httpSession(db,config,['interviewer']);t.after(()=>outsider.app.close());const denied=await outsider.app.inject({method:'POST',url:url+'/segments',headers:outsider.headers,payload:body});assert.equal(denied.statusCode,403);
});
