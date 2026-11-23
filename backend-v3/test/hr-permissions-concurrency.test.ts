import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {configFixture,publishDefinition} from './business-config-fixture.js';
import {actor,httpSession} from './helpers.js';
import {RecruitingService} from '../src/recruiting/service.js';
import {InterviewService} from '../src/interviews/service.js';
import {InterviewReviewService,MINUTES_ITEMS,REVIEW_CHECKLIST} from '../src/interview-assistant/review.js';
import {toolkitRoutes} from '../src/toolkit/routes.js';
import {referralRoutes} from '../src/referrals/routes.js';
import {EvaluationUpgradeService} from '../src/business-config/evaluation-versions.js';
import {ApiError} from '../src/http/errors.js';

async function fixture(t:any){
 const f=await configFixture(t),r=new RecruitingService(f.identity),iv=new InterviewService(f.identity);
 const interviewer=await actor(f.db,['interviewer']),other=await actor(f.db,['interviewer']),restricted=await actor(f.db,['recruiter']);
 const job=await r.createJob(f.admin,{name:'Synthetic permission job',level:'P5',salaryRange:'PRIVATE SALARY'});
 const candidate=await r.createCandidate(f.admin,{name:'王先生'}),application=await r.apply(f.admin,{candidateId:candidate.id,jobId:job.id});
 const create=(round:number,applicationId=application.id)=>iv.create(f.admin,{applicationId,round,startsAt:'2030-01-01T09:00:00Z',form:'online',durationMinutes:45,interviewerIds:[interviewer.id,other.id],primaryInterviewerId:interviewer.id});
 const first=await create(1),second=await create(2),review=new InterviewReviewService(f.identity);
 const app=Fastify();app.decorateRequest('actor',null);app.addHook('preHandler',async req=>{req.actor=req.headers['x-actor']==='restricted'?restricted:f.admin;});
 toolkitRoutes(app,f.identity);referralRoutes(app,f.identity);await app.ready();t.after(()=>app.close());
 return {...f,r,iv,interviewer,other,restricted,job,candidate,application,first,second,review,app,create};
}
const input=(expectedVersion=1)=>({expectedVersion,minutes:Object.fromEntries(MINUTES_ITEMS.map(k=>[k,'人工确认 '+k])),checked:Object.fromEntries(REVIEW_CHECKLIST.map(c=>[c.id,true])),notValidWhen:'未覆盖的场景'});
const referral=(extra:any={})=>({referrerName:'推荐人',referrerDept:'研发',referrerJob:'工程师',referrerPhone:'13900000001',candidateName:'合成候选人',candidatePhone:'13800000000',targetJob:'工程师',grade:'初级',education:'本科',currentOrg:'合成公司',reason:'完整推荐材料',signedAt:'2026-11-13',...extra});
async function restrict(f:any,entity:string,keys:string[]){const current=await f.configs.effective(f.admin,entity),doc:any=await f.configs.version(f.admin,current.ref);await publishDefinition(f,{...doc,fields:doc.fields.map((x:any)=>keys.includes(x.coreKey)?{...x,access:{...x.access,read:['admin'],write:['admin'],export:['admin']}}:x)});}

test('review respects draft authorship, authorized applications and current evaluation fields',async t=>{
 const f=await fixture(t);
 await f.iv.evaluate(f.other,f.first.id,{version:0,status:'draft',data:{summary:'PRIVATE OTHER DRAFT'}});
 const candidate=await f.r.createCandidate(f.admin,{name:'他人候选人'}),application=await f.r.apply(f.admin,{candidateId:candidate.id,jobId:f.job.id});
 const unrelated=await f.iv.create(f.admin,{applicationId:application.id,round:1,startsAt:'2030-01-02T09:00:00Z',form:'online',durationMinutes:45,interviewerIds:[f.other.id]});
 // Immutable submitted fixture avoids conflating review visibility with submit validation.
 const ev=(await f.db.query("INSERT INTO evaluations(interview_id,author_id,status,data) VALUES($1,$2,'submitted',$3) RETURNING *",[unrelated.id,f.other.id,{summary:'UNAUTHORIZED APPLICATION'}])).rows[0];
 await f.db.query("INSERT INTO evaluation_versions(evaluation_id,version,status,data,editor_id) VALUES($1,1,'submitted',$2,$3)",[ev.id,ev.data,f.other.id]);
 const card=await f.review.contextCard(f.interviewer,f.second.id);
 assert.equal(JSON.stringify(card).includes('PRIVATE OTHER DRAFT'),false);
 assert.equal(JSON.stringify(card).includes('UNAUTHORIZED APPLICATION'),false);
 await restrict(f,'evaluation',['summary']);
 const restricted=f.restricted;
 assert.equal(JSON.stringify(await f.review.contextCard(restricted,f.second.id)).includes('UNAUTHORIZED APPLICATION'),false);
});

test('AI review context, evidence and output enforce stored source keys',async t=>{
 const f=await fixture(t);
 await f.db.query("INSERT INTO interview_assistant_sessions(interview_id,owner_id,state,basis,analysis) VALUES($1,$2,'finished',$3,$4)",[f.second.id,f.admin.id,{jobId:f.job.id,sourceKeys:['salaryRange'],dimensions:[{id:'skill',label:'技能'}]},{dimensions:[{dimensionId:'skill',status:'evidence',summary:'PRIVATE AI',evidence:[{segmentId:'s1',quote:'PRIVATE AI'}]}]}]);
 await restrict(f,'job',['salaryRange']);
 const restricted=f.restricted;
 for(const read of [()=>f.review.contextCard(restricted,f.second.id),()=>f.review.evidence(restricted,f.second.id),()=>f.review.outputReview(restricted,f.second.id)])await assert.rejects(read(),/material_source_forbidden/);
});

test('toolkit and referrals project configured fields including copied contact and notes',async t=>{
 const f=await fixture(t);
 assert.equal((await f.app.inject({method:'POST',url:'/api/v4/referrals',payload:referral()})).statusCode,200);
 await restrict(f,'job',['level','salaryRange']);await restrict(f,'lead',['contact','note']);
 const toolkit=(await f.app.inject({url:'/api/v4/toolkit/overview',headers:{'x-actor':'restricted'}})).json();
 assert.equal(toolkit.jobMaterials[0].salary_range,undefined);assert.equal(toolkit.jobMaterials[0].level,undefined);
 const overview=(await f.app.inject({url:'/api/v4/referrals/overview',headers:{'x-actor':'restricted'}})).json();
 for(const secret of ['13800000000','13900000001','完整推荐材料'])assert.equal(JSON.stringify(overview).includes(secret),false);
});

test('real names require a current version and preserve immutable profile history',async t=>{
 const f=await fixture(t),payload={scope:'candidate',id:f.candidate.id,kind:'realName',version:1,payload:{value:'王合成'}};
 const responses=await Promise.all([f.app.inject({method:'POST',url:'/api/v4/toolkit/record',payload}),f.app.inject({method:'POST',url:'/api/v4/toolkit/record',payload:{...payload,payload:{value:'王并发'}}})]);
 assert.deepEqual(responses.map(x=>x.statusCode).sort(),[200,409]);
 const row=(await f.db.query('SELECT * FROM candidates WHERE id=$1',[f.candidate.id])).rows[0];assert.equal(row.version,2);
 assert.equal((await f.db.query('SELECT count(*)::int n FROM candidate_profile_versions WHERE candidate_id=$1',[row.id])).rows[0].n,2);
 await assert.rejects(f.r.editCandidate(f.admin,row.id,{version:1,profile:f.candidate.profile}),/version_conflict/);
});

test('toolkit levels enforce configured write access and dictionary choices',async t=>{
 const f=await fixture(t),payload={scope:'job',id:f.job.id,kind:'level',version:f.job.version,payload:{value:'not-a-level'}};
 assert.equal((await f.app.inject({method:'POST',url:'/api/v4/toolkit/record',payload})).statusCode,422);
 await restrict(f,'job',['level']);
 assert.equal((await f.app.inject({method:'POST',url:'/api/v4/toolkit/record',headers:{'x-actor':'restricted'},payload:{...payload,payload:{value:'P6'}}})).statusCode,403);
});

test('referral normalization serializes concurrent registrations and complete material wins',async t=>{
 const f=await fixture(t);
 const responses=await Promise.all(Array.from({length:5},(_,i)=>f.app.inject({method:'POST',url:'/api/v4/referrals',payload:referral({candidatePhone:i%2?'138-0000-0000':'13800000000',referrerName:'推荐人'+i})})));
 assert.ok(responses.every(x=>x.statusCode===200),responses.map(x=>x.body).join('\n'));
 assert.equal(responses.map(x=>x.json()).filter(x=>!x.duplicateOf).length,1);
 const incomplete=await f.app.inject({method:'POST',url:'/api/v4/referrals',payload:referral({candidatePhone:'13800000002',reason:''})});
 const complete=await f.app.inject({method:'POST',url:'/api/v4/referrals',payload:referral({candidatePhone:'13800000002'})});
 assert.equal(complete.json().duplicateOf,null);
 const old=(await f.db.query("SELECT configuration_refs->'toolkit'->'referral' r FROM leads WHERE id=$1",[incomplete.json().id])).rows[0].r;
 assert.equal(old.duplicateOf,complete.json().id);
});

test('concurrent referral updates return exactly one success with one audit',async t=>{
 const f=await fixture(t),created=(await f.app.inject({method:'POST',url:'/api/v4/referrals',payload:referral()})).json();
 await f.db.query("CREATE FUNCTION slow_referral_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.15); RETURN NEW; END $$");
 await f.db.query('CREATE TRIGGER slow_referral_update BEFORE UPDATE ON leads FOR EACH ROW EXECUTE FUNCTION slow_referral_update()');
 const responses=await Promise.all(['approved','rejected'].map(review=>f.app.inject({method:'PATCH',url:'/api/v4/referrals/'+created.id,payload:{version:1,review}})));
 assert.deepEqual(responses.map(x=>x.statusCode).sort(),[200,409]);
 assert.equal((await f.db.query("SELECT count(*)::int n FROM audit_events WHERE kind='referral.update' AND entity_id=$1",[created.id])).rows[0].n,1);
});

test('export projections enforce export-only restrictions and leave audited reads usable',async t=>{
 const f=await fixture(t);
 await f.app.inject({method:'POST',url:'/api/v4/referrals',payload:referral()});
 for(const [entity,keys] of [['job',['salaryRange','level']],['lead',['name','contact','note']]] as const){
   const doc:any=await f.configs.version(f.admin,(await f.configs.effective(f.admin,entity)).ref);
   await publishDefinition(f,{...doc,fields:doc.fields.map((x:any)=>(keys as readonly string[]).includes(x.coreKey)?{...x,access:{...x.access,export:['admin']}}:x)});
 }
 const headers={'x-actor':'restricted'};
 assert.equal((await f.app.inject({url:'/api/v4/toolkit/overview',headers})).json().jobMaterials[0].salary_range,'PRIVATE SALARY');
 const exported=(await f.app.inject({url:'/api/v4/toolkit/overview?mode=export',headers})).json();
 assert.equal(exported.jobMaterials[0].salary_range,undefined);assert.equal(exported.jobMaterials[0].level,undefined);
 const ledger=(await f.app.inject({url:'/api/v4/referrals/overview?mode=export',headers})).json();
 for(const secret of ['13800000000','13900000001','完整推荐材料','合成候选人'])assert.equal(JSON.stringify(ledger).includes(secret),false);
 assert.equal((await f.db.query("SELECT count(*)::int n FROM audit_events WHERE kind IN ('toolkit.export','referral.export')")).rows[0].n,2);
});

test('temporary interview grants cannot view other rounds or other people drafts and revoke immediately',async t=>{
 const f=await fixture(t),temp=await actor(f.db,[]);
 f.config.feishu={...f.config.feishu,appId:'app',tenant:'company'};
 await f.db.query("INSERT INTO interview_access_grants(interview_id,user_id,role,expires_at,created_by) VALUES($1,$2,'interviewer',now()+interval '1 hour',$3)",[f.second.id,temp.id,f.admin.id]);
 await f.iv.evaluate(f.other,f.first.id,{version:0,status:'draft',data:{summary:'PRIVATE PREVIOUS ROUND'}});
 await f.review.saveReview(f.admin,f.second.id,input());
 const card=await f.review.contextCard(temp,f.second.id);assert.deepEqual(card.priorRounds,[]);assert.deepEqual(card.historySamples,[]);
 const saved=await f.review.outputReview(temp,f.second.id);assert.equal(JSON.stringify(saved.state).includes('人工确认'),false);
 await assert.rejects(f.review.contextCard(temp,f.first.id),/forbidden/);
 await f.db.query('UPDATE interview_access_grants SET revoked_at=now() WHERE user_id=$1',[temp.id]);
 for(const read of [()=>f.review.contextCard(temp,f.second.id),()=>f.review.evidence(temp,f.second.id),()=>f.review.outputReview(temp,f.second.id)])await assert.rejects(read(),/forbidden/);
});

test('review writes lock, reject stale content, preserve unrelated JSON and roll back on audit failure',async t=>{
 const f=await fixture(t);
 await f.db.query("UPDATE interviews SET configuration_refs=configuration_refs||'{\"toolkit\":{\"unrelated\":\"kept\"}}'::jsonb WHERE id=$1",[f.second.id]);
 const results=await Promise.allSettled([f.review.saveReview(f.admin,f.second.id,input()),f.review.archive(f.admin,f.second.id,{...input(),confirmed:true})]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(results.filter(x=>x.status==='rejected'&&/version_conflict/.test(String(x.reason))).length,1);
 const before=(await f.db.query('SELECT * FROM interviews WHERE id=$1',[f.second.id])).rows[0];assert.equal(before.version,2);assert.equal(before.configuration_refs.toolkit.unrelated,'kept');
 const original=f.identity.audit;f.identity.audit=async()=>{throw Error('audit unavailable');};
 await assert.rejects(f.review.saveReview(f.admin,f.second.id,input(2)),/audit unavailable/);f.identity.audit=original;
 const after=(await f.db.query('SELECT * FROM interviews WHERE id=$1',[f.second.id])).rows[0];assert.equal(after.version,2);assert.deepEqual(after.configuration_refs,before.configuration_refs);
});

test('toolkit derived extras, source groups and interview copies obey backing field ACLs',async t=>{
 const f=await fixture(t);
 await f.db.query("UPDATE jobs SET configuration_refs=configuration_refs||$2::jsonb WHERE id=$1",[f.job.id,{toolkit:{jobExtras:{hardestPoint:'PRIVATE JOB DESCRIPTION',triples:['PRIVATE SKILLS'],salaryRange:'PRIVATE EXTRA SALARY'}}}]);
 await f.db.query("UPDATE interviews SET configuration_refs=configuration_refs||$2::jsonb WHERE id=$1",[f.second.id,{toolkit:{minutes:{'结论':'PRIVATE MINUTES'}}}]);
 await restrict(f,'job',['name','salaryRange','requirements.description','requirements.skills']);
 await restrict(f,'application',['source']);await restrict(f,'interview',['round','startsAt','feedback']);
 const headers={'x-actor':'restricted'},read=(await f.app.inject({url:'/api/v4/toolkit/overview',headers})).json();
 for(const secret of ['PRIVATE JOB DESCRIPTION','PRIVATE SKILLS','PRIVATE EXTRA SALARY','PRIVATE MINUTES','Synthetic permission job','手动上传'])assert.equal(JSON.stringify(read).includes(secret),false,secret);
 assert.equal(read.recentInterviews[0].round,undefined);assert.equal(read.recentInterviews[0].starts_at,undefined);
 const denied=await f.app.inject({method:'POST',url:'/api/v4/toolkit/record',headers,payload:{scope:'job',id:f.job.id,version:1,kind:'jobExtras',payload:{salaryRange:'UNAUTHORIZED WRITE'}}});
 assert.equal(denied.statusCode,403);
});

test('saved human output respects current evaluation and interview feedback visibility',async t=>{
 const f=await fixture(t);
 await f.review.archive(f.admin,f.second.id,{...input(),confirmed:true});
 await restrict(f,'evaluation',['summary']);
 await assert.rejects(f.review.outputReview(f.restricted,f.second.id),/review_fields_forbidden/);
 await assert.rejects(f.review.saveReview(f.restricted,f.second.id,input(2)),/review_fields_forbidden/);
 const toolkit=(await f.app.inject({url:'/api/v4/toolkit/overview',headers:{'x-actor':'restricted'}})).json();
 assert.equal(JSON.stringify(toolkit.recentInterviews).includes('人工确认'),false);
});

test('read-only referral checks reauthorize after permission revocation with the same idempotency key',async t=>{
 const f=await fixture(t);
 await f.app.inject({method:'POST',url:'/api/v4/referrals',payload:referral()});
 const http=await httpSession(f.db,f.config,['recruiter']);t.after(()=>http.app.close());
 const request={method:'POST' as const,url:'/api/v4/referrals/check',headers:{...http.headers,'idempotency-key':'hr-referral-read-permission'},payload:{candidateName:'合成候选人',candidatePhone:'13800000000'}};
 const first=await http.app.inject(request);assert.equal(first.statusCode,200,first.body);assert.equal(first.json().data.duplicates[0].target_job,'工程师');
 await restrict(f,'lead',['direction']);
 const second=await http.app.inject(request);assert.equal(second.statusCode,200,second.body);assert.equal(second.json().data.duplicates[0].target_job,undefined);
});

test('partial job extras edits preserve protected fields and require backing write access',async t=>{
 const f=await fixture(t);
 await f.db.query("UPDATE jobs SET configuration_refs=configuration_refs||$2::jsonb WHERE id=$1",[f.job.id,{toolkit:{jobExtras:{hardestPoint:'before',salaryRange:'PROTECTED PAY'}}}]);
 await restrict(f,'job',['salaryRange']);
 const headers={'x-actor':'restricted'};
 const updated=await f.app.inject({method:'POST',url:'/api/v4/toolkit/record',headers,payload:{scope:'job',id:f.job.id,kind:'jobExtras',version:1,payload:{hardestPoint:'after'}}});
 assert.equal(updated.statusCode,200,updated.body);
 const row=(await f.db.query('SELECT * FROM jobs WHERE id=$1',[f.job.id])).rows[0];
 assert.equal(row.configuration_refs.toolkit.jobExtras.hardestPoint,'after');assert.equal(row.configuration_refs.toolkit.jobExtras.salaryRange,'PROTECTED PAY');
 const view=(await f.app.inject({url:'/api/v4/toolkit/overview',headers})).json();assert.equal(view.jobMaterials[0].extrasWritable.salaryRange,false);
});

test('review context never converts template permission denial into a fallback',async t=>{
 const f=await fixture(t),original=EvaluationUpgradeService.prototype.effective;
 EvaluationUpgradeService.prototype.effective=async()=>{throw new ApiError(403,'forbidden');};
 try {await assert.rejects(f.review.contextCard(f.admin,f.second.id),/forbidden/);}finally{EvaluationUpgradeService.prototype.effective=original;}
});

test('private review drafts cannot be overwritten by another assigned interviewer or administrator',async t=>{
 const f=await fixture(t);
 await f.review.saveReview(f.interviewer,f.second.id,input());
 const before=(await f.db.query('SELECT version,configuration_refs FROM interviews WHERE id=$1',[f.second.id])).rows[0];
 for(const reader of [f.other,f.admin]){
   const shown=await f.review.outputReview(reader,f.second.id);
   assert.equal(JSON.stringify(shown.state).includes('人工确认'),false);
   await assert.rejects(f.review.saveReview(reader,f.second.id,{...input(shown.expectedVersion),minutes:Object.fromEntries(MINUTES_ITEMS.map(k=>[k,'']))}),/private_evaluation_draft/);
   await assert.rejects(f.review.archive(reader,f.second.id,{...input(shown.expectedVersion),confirmed:true}),/private_evaluation_draft/);
   assert.equal(shown.readOnly,true);assert.equal(shown.readOnlyReason,'private_evaluation_draft');
 }
 const after=(await f.db.query('SELECT version,configuration_refs FROM interviews WHERE id=$1',[f.second.id])).rows[0];
 assert.deepEqual(after,before);
 assert.equal((await f.db.query("SELECT count(*)::int n FROM audit_events WHERE kind IN ('interview.review.save','interview.review.archive')")).rows[0].n,1);
 // Publishing ends the private edit lock; another authorized participant can start a revision.
 await f.review.archive(f.interviewer,f.second.id,{...input(2),confirmed:true});
 const published=await f.review.outputReview(f.other,f.second.id);assert.equal(published.readOnly,false);
 await f.review.saveReview(f.other,f.second.id,input(published.expectedVersion));
 const revision=await f.review.outputReview(f.other,f.second.id);assert.equal(revision.readOnly,false);
 await f.review.archive(f.other,f.second.id,{...input(revision.expectedVersion),confirmed:true});
 assert.equal((await f.review.outputReview(f.interviewer,f.second.id)).readOnly,false);
});
