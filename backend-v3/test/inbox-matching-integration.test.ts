import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';
import {loadConfig,readEnvironment} from '../src/config.js';
import {Database} from '../src/db.js';
import {actor} from './helpers.js';
import {publishDefinition} from './business-config-fixture.js';
import {Identity} from '../src/identity/service.js';
import {FeishuProvider} from '../src/identity/provider.js';
import {BusinessConfigService} from '../src/business-config/service.js';
import {RecruitingService} from '../src/recruiting/service.js';
import {Worker} from '../src/tasks/worker.js';
import {TaskService} from '../src/tasks/service.js';
import {FileStore} from '../src/files/storage.js';
import {parseProfile,encodeRaw} from '../src/parsing/profile.js';
import {enqueueInboxMatches,inboxMatchesFor} from '../src/recruiting/inbox-matching.js';
import {previewInboxMaintenance,applyInboxMaintenance} from '../src/recruiting/inbox-maintenance.js';
import {registerInboxMatching} from '../src/recruiting/matching-flow.js';

const raw='姓名：合成测试人员\n邮箱：fixture@example.invalid\n技能：Python\n5年工作经验\n过去五年负责 Python 服务开发和数据库优化，独立维护支付服务。';
const quote='过去五年负责 Python 服务开发和数据库优化，独立维护支付服务。';
async function fixture(t:any,intent=''){
 const dir=await mkdtemp(path.join(os.tmpdir(),'inbox-match-test-'));
 const config=loadConfig({...readEnvironment(),RECRUIT_V4_SCHEMA:'recruit_test_inboxmatch20261116',RECRUIT_V4_STORAGE:path.join(dir,'files'),RECRUIT_V4_MODEL_CONFIG_FILE:'',RECRUIT_V4_ENV:'test'}),db=new Database(config);
 await db.migrate();t.after(async()=>{assert.equal(config.schema,'recruit_test_inboxmatch20261116');await db.query('DROP SCHEMA "recruit_test_inboxmatch20261116" CASCADE');await db.close();await rm(dir,{recursive:true,force:true});});
 const admin=await actor(db),recruiter=await actor(db,['recruiter']),identity=new Identity(db,config,new FeishuProvider(config)),configs=new BusinessConfigService(identity);await configs.seed();
 const r=new RecruitingService(identity),job=await r.createJob(admin,{name:'后端工程师',level:'P5',requirements:{skills:['Python'],description:'负责 Python 服务研发和数据库优化'}}),candidate=await r.createCandidate(admin,{name:'合成测试人员',intent});
 const parsed=parseProfile(raw),doc=(await db.query("INSERT INTO resume_documents(sha256,blob_key,file_name,kind,file_size,owner_id) VALUES($1,'fixture','fixture.txt','txt',$2,$3) RETURNING id",['a'.repeat(64),Buffer.byteLength(raw),admin.id])).rows[0];
 const p=(await db.query('INSERT INTO parse_results(document_id,raw_bytes,profile,evidence,parser_version) VALUES($1,$2,$3,$4,$5) RETURNING id',[doc.id,encodeRaw(raw),parsed.profile,JSON.stringify(parsed.evidence),parsed.parserVersion])).rows[0];
 const origin=(await db.query("INSERT INTO tasks(kind,payload,actor_id,state,result) VALUES('ingest',$1,$2,'succeeded',$3) RETURNING id",[{documentId:doc.id,newCandidatesOnly:true,mailboxId:'fixture',mailMessageKey:'a'.repeat(64),mailBody:'希望加入贵公司。',initialPosition:intent},admin.id,{candidateId:candidate.id}])).rows[0];
 const resume=(await db.query('INSERT INTO resume_versions(candidate_id,parse_result_id,origin_task_id,created_by) VALUES($1,$2,$3,$4) RETURNING id',[candidate.id,p.id,origin.id,admin.id])).rows[0];
 let calls=0;const request=async()=>{calls++;assert.equal(db.sql,db.pool,'model must run outside a transaction');return {content:JSON.stringify({status:'matched',kind:'recommended',jobId:job.id,confidence:'high',evidence:[{source:'resume',quote}]}),model:'fixture-model',tokens:1,elapsedMs:1};};
 const worker=new Worker(identity,new FileStore(config.storageRoot),'inbox-fixture',undefined,request);
 const view=async()=> (await inboxMatchesFor(identity,recruiter,[candidate.id])).get(candidate.id);
 return {db,config,dir,admin,recruiter,identity,configs,r,job,candidate,resume,origin,worker,view,request,calls:()=>calls};
}
test('existing inbox gets a background semantic recommendation without overwriting intent or creating application; reads do not call model',async t=>{
 const f=await fixture(t,'简历');assert.equal((await f.view()).kind,'pending');assert.equal((await f.view()).intent,'');assert.equal(f.calls(),0);
 assert.equal(await enqueueInboxMatches(f.identity),1);assert.equal(await enqueueInboxMatches(f.identity),0);await f.worker.once();
 const recommendation=await f.view();assert.equal(recommendation.kind,'recommended');assert.equal(recommendation.jobId,f.job.id);assert.equal(recommendation.evidence[0].quote,quote);assert.equal(f.calls(),1);
 const businessState=async()=> (await f.db.query("SELECT (SELECT count(*) FROM tasks) tasks,(SELECT count(*) FROM applications) applications,(SELECT count(*) FROM candidate_profile_versions) profiles,(SELECT count(*) FROM business_template_bindings) bindings,(SELECT configuration_refs FROM resume_versions WHERE id=$1) resume_refs",[f.resume.id])).rows[0];
 const beforeRead=await businessState();assert.equal((await f.r.candidates(f.recruiter,{lifecycle:'inbox'})).items[0].inboxMatch.kind,'recommended');assert.equal(f.calls(),1);assert.deepEqual(await businessState(),beforeRead,'listing only reads matching state and must not enqueue, mutate profiles, bind templates or create applications');
 assert.equal((await f.db.query('SELECT profile FROM candidates WHERE id=$1',[f.candidate.id])).rows[0].profile.intent,'简历');assert.equal((await f.db.query('SELECT count(*)::int n FROM applications')).rows[0].n,0);assert.equal(await enqueueInboxMatches(f.identity),0);
});
test('candidate edits and closed jobs immediately invalidate display and adoption of old recommendations',async t=>{
 const f=await fixture(t);await enqueueInboxMatches(f.identity);await f.worker.once();const match=await f.view();
 await f.r.editCandidate(f.admin,f.candidate.id,{version:1,profile:{...f.candidate.profile,summary:'人工核对后的新描述'}});
 assert.equal((await f.view()).kind,'pending');await assert.rejects(f.r.apply(f.recruiter,{candidateId:f.candidate.id,jobId:f.job.id,resumeVersionId:f.resume.id,inboxMatchHash:match.inputHash}),/inbox_match_stale/);
 await enqueueInboxMatches(f.identity);await f.worker.once();const fresh=await f.view();assert.notEqual(fresh.inputHash,match.inputHash);
 await f.db.query('UPDATE jobs SET open=false,version=version+1 WHERE id=$1',[f.job.id]);assert.equal((await f.view()).kind,'pending');
 await assert.rejects(f.r.apply(f.recruiter,{candidateId:f.candidate.id,jobId:f.job.id,resumeVersionId:f.resume.id,inboxMatchHash:fresh.inputHash}),/job_closed/);
});
test('recommendation permissions reflect actual model job inputs and revoke hidden resume evidence',async t=>{
 const f=await fixture(t);await enqueueInboxMatches(f.identity);await f.worker.once();assert.equal((await f.view()).kind,'recommended');
 const restrict=async(kind:string,key:string)=>{const ref=await f.configs.effective(f.admin,kind),document:any=await f.configs.version(f.admin,ref.ref);await publishDefinition(f,{...document,fields:document.fields.map((field:any)=>field.coreKey===key?{...field,access:{...field.access,read:['admin'],write:['admin'],export:['admin']}}:field)});};
 await restrict('job','salaryRange');assert.equal((await f.view()).kind,'recommended');
 await restrict('resume','summary');const hidden=await f.view();assert.equal(hidden.kind,'pending');assert.equal(hidden.evidence,undefined);assert.equal(hidden.jobId,null);
});
test('preview adopts a current recommendation with a version token and rechecks professional field permissions',async t=>{
 const f=await fixture(t);await enqueueInboxMatches(f.identity);await f.worker.once();
 const app=Fastify();app.decorateRequest('actor',null);app.addHook('preHandler',async req=>{req.actor=f.recruiter;});registerInboxMatching(app,f.identity);t.after(()=>app.close());
 const reply=await app.inject({method:'POST',url:'/api/v4/candidates/matching/preview',payload:{threshold:0}});assert.equal(reply.statusCode,200,reply.body);const item=reply.json().items[0];assert.equal(item.matchKind,'recommended');assert.match(item.inboxMatchHash,/^[a-f0-9]{64}$/);
 const created=await f.r.apply(f.recruiter,{candidateId:item.candidateId,jobId:item.jobId,resumeVersionId:item.resumeVersionId,inboxMatchHash:item.inboxMatchHash});assert.equal(created.job_id,f.job.id);
});
test('model failure is a terminal pending result for one fingerprint, never an automatic retry loop',async t=>{
 const f=await fixture(t);let calls=0;const worker=new Worker(f.identity,new FileStore(f.config.storageRoot),'failure-fixture',undefined,async()=>{calls++;throw Error('resume_model_timeout');});
 await enqueueInboxMatches(f.identity);await worker.once();assert.equal((await f.view()).reason,'model_unavailable');assert.equal(await enqueueInboxMatches(f.identity),0);assert.equal(calls,1);assert.equal((await f.db.query('SELECT count(*)::int n FROM applications')).rows[0].n,0);
});
test('ordinary ingestion and matching have priority over an older inbox model backlog',async t=>{
 const f=await fixture(t);await enqueueInboxMatches(f.identity);
 const upload=(await f.db.query("INSERT INTO tasks(kind,payload,actor_id) VALUES('ingest',$1,$2) RETURNING id",[{documentId:'10000000-0000-4000-8000-000000000099'},f.admin.id])).rows[0];
 assert.equal((await f.worker.claim()).id,upload.id);
});
test('legacy body beyond 4000 characters is read from the archive without making its saved result perpetually stale',async t=>{
 const f=await fixture(t),body='旧邮件开头内容。'.repeat(600)+'\n'+quote,folder=path.join(f.dir,'mailboxes','fixture','messages','a'.repeat(64));await mkdir(folder,{recursive:true});
 await writeFile(path.join(folder,'message.json'),JSON.stringify({id:'a'.repeat(64),mailboxId:'fixture',subject:'求职简历',senderName:'合成',senderEmail:'fixture@example.invalid',receivedAt:'2026-11-16',archivedAt:'2026-11-16',messageId:'fixture',rawSize:1,rawSha256:'b'.repeat(64),body,attachments:[]}));
 await f.db.query("UPDATE tasks SET payload=(payload-'mailBody')||$2::jsonb WHERE id=$1",[f.origin.id,{initialDescription:body.slice(0,4000)}]);
 const worker=new Worker(f.identity,new FileStore(f.config.storageRoot),'legacy-body-fixture',undefined,async(_config,input)=>{assert.ok(JSON.parse(input).candidate.body.endsWith(quote));return {content:JSON.stringify({status:'matched',kind:'recommended',jobId:f.job.id,confidence:'high',evidence:[{source:'body',quote}]}),model:'fixture-model',tokens:1,elapsedMs:1};});
 await enqueueInboxMatches(f.identity);await worker.once();assert.equal((await f.view()).kind,'recommended');assert.equal((await f.view()).evidence[0].source,'body');assert.equal(await enqueueInboxMatches(f.identity),0);
 assert.equal((await f.db.query("SELECT payload ? 'mailBody' full FROM tasks WHERE id=$1",[f.origin.id])).rows[0].full,false);
});
test('legacy truncated declarations cannot bypass complete-source matching; later HR-confirmed intent takes precedence',async t=>{
 const f=await fixture(t,'后端工程师');await f.r.createJob(f.admin,{name:'产品经理',level:'P5'});
 const body='求职意向：后端工程师\n'+'旧邮件开头内容。'.repeat(600)+'\n求职意向：产品经理',folder=path.join(f.dir,'mailboxes','fixture','messages','a'.repeat(64));await mkdir(folder,{recursive:true});
 await writeFile(path.join(folder,'message.json'),JSON.stringify({id:'a'.repeat(64),mailboxId:'fixture',subject:'求职简历',senderName:'合成',senderEmail:'fixture@example.invalid',receivedAt:'2026-11-16',archivedAt:'2026-11-16',messageId:'fixture',rawSize:1,rawSha256:'b'.repeat(64),body,attachments:[]}));
 await f.db.query("UPDATE tasks SET payload=(payload-'mailBody')||$2::jsonb WHERE id=$1",[f.origin.id,{initialDescription:body.slice(0,4000)}]);
 assert.equal((await f.view()).kind,'pending');await enqueueInboxMatches(f.identity);await f.worker.once();assert.equal((await f.view()).kind,'pending');assert.equal((await f.view()).reason,'ambiguous_intent');
 await f.r.editCandidate(f.admin,f.candidate.id,{version:1,profile:{...f.candidate.profile,intent:'产品经理'}});await enqueueInboxMatches(f.identity);await f.worker.once();assert.equal((await f.view()).kind,'explicit');assert.equal((await f.view()).jobName,'产品经理');
});
test('maintenance preview is read-only, repairs only proven unchanged generic intent, and rejects stale version',async t=>{
 const f=await fixture(t,'简历'),scope={candidateIds:[f.candidate.id],repairGenericIntent:true,forceRecompute:false};
 const before=await previewInboxMaintenance(f.identity,scope);assert.equal(before.items[0].repair?.from,'简历');assert.equal((await f.db.query('SELECT version FROM candidates WHERE id=$1',[f.candidate.id])).rows[0].version,1);
 await f.r.editCandidate(f.admin,f.candidate.id,{version:1,profile:{...f.candidate.profile,name:'人工确认姓名'}});
 await assert.rejects(applyInboxMaintenance(f.identity,f.admin,scope,before.previewHash),/inbox_maintenance_preview_stale/);
 const plan=await previewInboxMaintenance(f.identity,scope),applied=await applyInboxMaintenance(f.identity,f.admin,scope,plan.previewHash);assert.equal(applied.repaired,1);
 const candidate=(await f.db.query('SELECT * FROM candidates WHERE id=$1',[f.candidate.id])).rows[0];assert.equal(candidate.version,3);assert.equal(candidate.profile.name,'人工确认姓名');assert.equal(candidate.profile.intent,'');
 assert.equal((await f.db.query('SELECT count(*)::int n FROM candidate_profile_versions WHERE candidate_id=$1',[candidate.id])).rows[0].n,3);
 assert.equal((await f.db.query("SELECT count(*)::int n FROM audit_events WHERE kind='inbox.intent.repair'")).rows[0].n,1);
});
test('archive history and manually changed intentions are excluded from automatic repairs and inbox queue',async t=>{
 const f=await fixture(t,'简历');await f.r.editCandidate(f.admin,f.candidate.id,{version:1,profile:{...f.candidate.profile,intent:'产品经理'}});
 const plan=await previewInboxMaintenance(f.identity,{candidateIds:[f.candidate.id],repairGenericIntent:true,forceRecompute:false});assert.equal(plan.items[0].repair,null);
 const application=await f.r.apply(f.admin,{candidateId:f.candidate.id,jobId:f.job.id});await f.db.query("UPDATE applications SET is_current=false,status='rejected' WHERE id=$1",[application.id]);
 assert.equal((await f.r.candidates(f.recruiter,{lifecycle:'inbox'})).items.length,0);assert.equal(await enqueueInboxMatches(f.identity),0);
});
test('a corrected resume invalidates old recommendations and sends adopted professional corrections with the original mail source',async t=>{
 const f=await fixture(t);await enqueueInboxMatches(f.identity);await f.worker.once();const old=await f.view();assert.equal(old.kind,'recommended');
 const parseId=(await f.db.query('SELECT parse_result_id FROM resume_versions WHERE id=$1',[f.resume.id])).rows[0].parse_result_id;
 const corrected=await new TaskService(f.identity,new FileStore(f.config.storageRoot)).correctResume(f.admin,f.resume.id,{baseParseResultId:parseId,reason:'人工核对原始职责后校正专业资料',corrections:{skills:['Java'],summary:'实际只负责Java服务，旧Python职责需重新核对'}});
 assert.equal((await f.view()).kind,'pending');assert.notEqual(corrected.resumeVersionId,f.resume.id);
 let seen=false;const worker=new Worker(f.identity,new FileStore(f.config.storageRoot),'corrected-fixture',undefined,async(_config,input)=>{const source=JSON.parse(input).candidate;seen=true;assert.equal(source.body,'希望加入贵公司。');assert.deepEqual(source.professionalConstraints.resumeProfile.skills,['Java']);assert.ok(source.professionalConstraints.corrections.some((c:any)=>c.field==='skills'&&c.value[0]==='Java'));return {content:JSON.stringify({status:'no_match',kind:null,jobId:null,confidence:'low',evidence:[]}),model:'fixture-model',tokens:1,elapsedMs:1};});
 await enqueueInboxMatches(f.identity);await worker.once();assert.equal(seen,true);assert.equal((await f.view()).kind,'pending');assert.equal((await f.view()).reason,'no_match');
 await assert.rejects(f.r.apply(f.recruiter,{candidateId:f.candidate.id,jobId:f.job.id,resumeVersionId:f.resume.id,inboxMatchHash:old.inputHash}),/inbox_match_stale/);
});
