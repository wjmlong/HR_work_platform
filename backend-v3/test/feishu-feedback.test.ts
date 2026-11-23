import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {actor,testDatabase} from './helpers.js';
import {Identity} from '../src/identity/service.js';
import {RecruitingService} from '../src/recruiting/service.js';
import {InterviewService} from '../src/interviews/service.js';
import {InterviewFeedback} from '../src/feishu-feedback/service.js';
import {EventDispatcher,LoggerLevel} from '@larksuiteoapi/node-sdk';

async function fixture(t:any){
 const f=await testDatabase();t.after(f.cleanup);
 f.config.feishu={...f.config.feishu,appId:'app',tenant:'company',appSecret:'isolated-secret'};
 f.config.feishuFeedback={enabled:true};
 const provider={configured:()=>true,authorizeUrl:()=>'',identity:async()=>({} as any),contact:async(openId:string)=>({tenant:'company',appId:'app',openId,name:openId,active:true})};
 const identity=new Identity(f.db,f.config,provider),hr=await actor(f.db),member=await actor(f.db,['interviewer']);
 const r=new RecruitingService(identity),interviews=new InterviewService(identity);
 const job=await r.createJob(hr,{name:'反馈测试岗位',level:'P5'}),candidate=await r.createCandidate(hr,{name:'不应发往卡片的姓名'});
 const application=await r.apply(hr,{jobId:job.id,candidateId:candidate.id});
 const interview=await interviews.create(hr,{applicationId:application.id,round:1,startsAt:'2030-01-01T09:00:00Z',durationMinutes:45,form:'online',interviewerIds:[member.id]});
 const deliveries:any[]=[];
 const sender={send:async(openId:string,uuid:string,card:unknown)=>{deliveries.push({openId,uuid,card});return {messageId:'om_'+uuid};}};
 const service=new InterviewFeedback(identity,()=>sender);
 return {...f,identity,hr,member,interviews,interview,service,sender,deliveries};
}
function click(f:any,decision='accepted',reason='',extra:any={}){
 const sent=f.deliveries.at(-1),form=sent.card.body.elements.find((x:any)=>x.tag==='form');
 const button=form.elements.find((x:any)=>x.tag==='button'&&x.behaviors[0].value.decision===decision);
 return {schema:'2.0',event_id:randomUUID(),event_type:'card.action.trigger',app_id:'app',tenant_key:'company',operator:{open_id:f.member.open_id,tenant_key:'company'},host:'im_message',context:{open_message_id:'om_'+sent.uuid},action:{tag:'button',value:button.behaviors[0].value,form_value:{reason}},...extra};
}
test('sending records delivery separately; feedback is bound to the selected interviewer and contains no candidate details',async t=>{
 const f=await fixture(t),sent=await f.service.send(f.hr,f.interview.id,{version:1,confirmed:true});
 assert.equal(sent.items[0].delivery,'sent');assert.equal(sent.items[0].decision,'pending');
 assert.doesNotMatch(JSON.stringify(f.deliveries),/不应发往卡片的姓名|candidate|salary|resume|contact/);
 assert.equal(f.deliveries[0].openId,f.member.open_id);
 await f.service.send(f.hr,f.interview.id,{version:1,confirmed:true});assert.equal(f.deliveries.length,1);
 const response=await f.service.handleCardAction(click(f));assert.equal(response.toast.type,'success');
 assert.equal((await f.service.status(f.hr,f.interview.id)).items[0].decision,'accepted');
 assert.equal((await f.db.query('SELECT status,version FROM interviews WHERE id=$1',[f.interview.id])).rows[0].status,'pending');
});
test('tenant, app, forwarded card operator, token and message mismatch cannot change feedback',async t=>{
 const f=await fixture(t);await f.service.send(f.hr,f.interview.id,{version:1,confirmed:true});
 const good=click(f);
 for(const change of [{tenant_key:'other'},{app_id:'other'},{operator:{open_id:f.hr.open_id,tenant_key:'company'}},{operator:{open_id:f.member.open_id,tenant_key:'other'}},{context:{open_message_id:'om_forwarded'}},{action:{...good.action,value:{...good.action.value,token:'forged'}}}]){
  assert.equal((await f.service.handleCardAction({...good,...change,event_id:randomUUID()})).toast.type,'error');
 }
 assert.equal((await f.service.status(f.hr,f.interview.id)).items[0].decision,'pending');
});
test('decline requires a submitted reason; duplicate callbacks are idempotent and competing decisions do not replace it',async t=>{
 const f=await fixture(t);await f.service.send(f.hr,f.interview.id,{version:1,confirmed:true});
 assert.equal((await f.service.handleCardAction(click(f,'declined','  '))).toast.type,'error');
 const event=click(f,'declined','时间冲突，请 HR 协调');
 const [one,two]=await Promise.all([f.service.handleCardAction(event),f.service.handleCardAction(event)]);assert.deepEqual(one,two);
 const status=await f.service.status(f.hr,f.interview.id);assert.equal(status.needsCoordination,true);assert.equal(status.items[0].reason,'时间冲突，请 HR 协调');
 assert.equal((await f.service.handleCardAction(click(f))).toast.type,'error');
 assert.equal((await f.db.query('SELECT count(*)::int n FROM feishu_interview_callback_receipts')).rows[0].n,1);
 assert.equal((await f.db.query('SELECT status FROM interviews WHERE id=$1',[f.interview.id])).rows[0].status,'pending');
});
test('old arrangement, removed participant, disabled member and revoked temporary assignment cannot respond',async t=>{
 const f=await fixture(t);await f.service.send(f.hr,f.interview.id,{version:1,confirmed:true});const old=click(f);
 await f.interviews.update(f.hr,f.interview.id,{version:1,startsAt:'2030-01-02T09:00:00Z'});
 assert.equal((await f.service.handleCardAction(old)).toast.type,'error');
 assert.equal((await f.service.status(f.hr,f.interview.id)).items[0].stale,true);
 await f.service.send(f.hr,f.interview.id,{version:2,confirmed:true});
 await f.db.query("UPDATE users SET status='disabled' WHERE id=$1",[f.member.id]);
 assert.equal((await f.service.handleCardAction(click(f))).toast.type,'error');
 await f.db.query("UPDATE users SET status='active' WHERE id=$1",[f.member.id]);
 await f.db.query('UPDATE interviewers SET temporary_access=true WHERE interview_id=$1',[f.interview.id]);
 assert.equal((await f.service.handleCardAction(click(f))).toast.type,'error');
 await f.db.query('DELETE FROM interviewers WHERE interview_id=$1',[f.interview.id]);
 assert.equal((await f.service.handleCardAction(click(f))).toast.type,'error');
});
test('failed delivery remains retryable with the same upstream UUID and cannot be mistaken for acceptance',async t=>{
 const f=await fixture(t),send=f.sender.send;f.sender.send=async(...args)=>{await send(...args);throw Error('lost response secret');};
 let status=await f.service.send(f.hr,f.interview.id,{version:1,confirmed:true});assert.equal(status.items[0].delivery,'failed');assert.equal(status.items[0].decision,'pending');
 assert.doesNotMatch(JSON.stringify(status),/secret|token|open_id/);
 f.sender.send=send;status=await f.service.send(f.hr,f.interview.id,{version:1,confirmed:true});
 assert.equal(f.deliveries[0].uuid,f.deliveries[1].uuid);assert.equal(status.items[0].delivery,'sent');assert.equal(status.items[0].decision,'pending');
});
test('disabled feature and non-HR callers cannot send, and status never reads evaluation drafts',async t=>{
 const f=await fixture(t);
 await f.db.query("INSERT INTO evaluations(interview_id,author_id,status,data) VALUES($1,$2,'draft',$3)",[f.interview.id,f.member.id,{private:'不得展示的私人草稿'}]);
 await assert.rejects(f.service.send(f.member,f.interview.id,{version:1,confirmed:true}),/forbidden/);
 await assert.rejects(f.service.status(f.member,f.interview.id),/forbidden/);
 f.config.feishuFeedback!.enabled=false;
 await assert.rejects(f.service.send(f.hr,f.interview.id,{version:1,confirmed:true}),/feedback_not_enabled/);
 assert.equal(f.deliveries.length,0);assert.doesNotMatch(JSON.stringify(await f.service.status(f.hr,f.interview.id)),/私人草稿/);
});
test('official SDK long-connection event flattening retains application, operator and card context',async t=>{
 const f=await fixture(t);await f.service.send(f.hr,f.interview.id,{version:1,confirmed:true});const e=click(f);
 const dispatcher=new EventDispatcher({loggerLevel:LoggerLevel.error}).register({'card.action.trigger':(data:unknown)=>f.service.handleCardAction(data)});
 const result=await dispatcher.invoke({schema:'2.0',header:{event_id:e.event_id,event_type:e.event_type,app_id:e.app_id,tenant_key:e.tenant_key,create_time:'1900000000000000'},event:{operator:e.operator,action:e.action,host:e.host,context:e.context}},{needCheck:false});
 assert.equal(result.toast.type,'success');assert.equal((await f.service.status(f.hr,f.interview.id)).items[0].decision,'accepted');
});
test('same event id with a changed decision is rejected, and a cancelled interview cannot receive confirmation',async t=>{
 const f=await fixture(t);await f.service.send(f.hr,f.interview.id,{version:1,confirmed:true});const e=click(f);
 await f.service.handleCardAction(e);const changed=click(f,'declined','后来发现冲突',{event_id:e.event_id});assert.equal((await f.service.handleCardAction(changed)).toast.type,'error');
 assert.equal((await f.service.status(f.hr,f.interview.id)).items[0].decision,'accepted');
 await f.interviews.update(f.hr,f.interview.id,{version:1,status:'cancelled'});
 assert.equal((await f.service.handleCardAction(e)).toast.type,'error');await assert.rejects(f.service.send(f.hr,f.interview.id,{version:2,confirmed:true}),/feedback_interview_unavailable/);
});
test('concurrent opposite decisions have exactly one winner and never cancel the interview',async t=>{
 const f=await fixture(t);await f.service.send(f.hr,f.interview.id,{version:1,confirmed:true});
 const results=await Promise.all([f.service.handleCardAction(click(f)),f.service.handleCardAction(click(f,'declined','时间冲突'))]);
 assert.equal(results.filter(r=>r.toast.type==='success').length,1);
 assert.equal((await f.db.query('SELECT count(*)::int n FROM feishu_interview_callback_receipts')).rows[0].n,1);
 assert.equal((await f.db.query('SELECT status FROM interviews WHERE id=$1',[f.interview.id])).rows[0].status,'pending');
});
test('HTTP feedback endpoint requires HR session and CSRF and preserves the disabled outbound gate',async t=>{
 const f=await fixture(t),{httpSession}=await import('./helpers.js');f.config.feishuFeedback!.enabled=false;
 const h=await httpSession(f.db,f.config);t.after(()=>h.app.close());
 const url='/api/v4/interviews/'+f.interview.id+'/feishu-feedback';
 const status=await h.app.inject({method:'GET',url,headers:h.headers});assert.equal(status.statusCode,200);assert.equal(status.json().data.enabled,false);
 assert.doesNotMatch(status.body,/synthetic-secret|open_id|token|私人草稿/);
 const denied=await h.app.inject({method:'POST',url,headers:{...h.headers,'x-csrf-token':'invalid'},payload:{version:1,confirmed:true}});assert.equal(denied.statusCode,403);
 const disabled=await h.app.inject({method:'POST',url,headers:h.headers,payload:{version:1,confirmed:true}});assert.equal(disabled.statusCode,503);assert.equal(disabled.json().error.code,'feedback_not_enabled');
 const member=await httpSession(f.db,f.config,['interviewer']);t.after(()=>member.app.close());
 assert.equal((await member.app.inject({method:'GET',url,headers:member.headers})).statusCode,403);
});
test('outbound send refuses an outer transaction so transport receipts cannot be rolled back',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.db.tx(()=>f.service.send(f.hr,f.interview.id,{version:1,confirmed:true})),/feedback_outer_transaction/);
 assert.equal(f.deliveries.length,0);assert.equal((await f.db.query('SELECT count(*)::int n FROM feishu_interview_confirmations')).rows[0].n,0);
});
