import {readFile} from 'node:fs/promises';
import {BusinessConfigService} from '../src/business-config/service.js';
import {ConfiguredEntities} from '../src/business-config/entities.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {testDatabase,actor} from './helpers.js';
import {Identity} from '../src/identity/service.js';
import {FeishuProvider} from '../src/identity/provider.js';
import {InterviewService} from '../src/interviews/service.js';
import {ConfiguredRecruiting} from '../src/business-config/recruiting.js';
import {RecruitingService} from '../src/recruiting/service.js';

test('new people remain in inbox until manual progression or explicit archive; repeated recruitment preserves history',async t=>{
 const {db,config,cleanup}=await testDatabase();t.after(cleanup);
 const a=await actor(db),service=new RecruitingService(new Identity(db,config,new FeishuProvider(config)));
 const person=await service.createCandidate(a,{name:'合成收件人',summary:'人工描述保留'});
 const ids=async(lifecycle:string)=>(await service.candidates(a,{lifecycle})).items.map((p:any)=>p.id);
 assert.deepEqual(await ids('inbox'),[person.id]);assert.deepEqual(await ids('archive'),[]);
 await service.archiveCandidate(a,person.id,{version:person.version,reason:'本轮暂不推进，仅留档'});
 assert.deepEqual(await ids('inbox'),[]);assert.deepEqual(await ids('archive'),[person.id]);
 const job=await service.createJob(a,{name:'合成岗位',level:'P5',requirements:{}});
 const first=await service.apply(a,{candidateId:person.id,jobId:job.id,source:'主动投递'});
 assert.deepEqual(await ids('active'),[person.id]);assert.deepEqual(await ids('archive'),[]);
 const interviewDef=await new BusinessConfigService(service.identity).effective(a,'interview');
 const interview=await new ConfiguredEntities(service.identity).write(a,'interview',null,{definitionVersion:interviewDef.ref.version,definitionRevision:interviewDef.aclRevision,applicationId:first.id,round:1,startsAt:'2030-01-01T01:00:00Z',durationMinutes:30,form:'线上',interviewerIds:[a.id],status:'no_show'});
 assert.equal(interview.status,'no_show');assert.deepEqual(await ids('active'),[person.id]);
 const p=(await service.candidate(a,person.id));
 await assert.rejects(service.archiveCandidate(a,person.id,{version:p.version,reason:'不能隐去正在推进的申请'}),/active_workflow_exists/);
 const ended=await service.transition(a,first.id,{version:first.version,to:'rejected',reason:'人工结束本轮',opinion:'人工复核后结束本轮',rejectReason:'专业经验',rejectDetail:'本轮岗位经验未匹配'});
 assert.deepEqual(await ids('archive'),[person.id]);
 await assert.rejects(service.apply(a,{candidateId:person.id,jobId:job.id}),/current_workflow_exists/);
 const appDef=await new BusinessConfigService(service.identity).effective(a,"application");
 const next=await new ConfiguredRecruiting(service.identity).apply(a,{definitionVersion:appDef.ref.version,definitionRevision:appDef.aclRevision,candidateId:person.id,jobId:job.id,startNew:true});
 assert.notEqual(next.id,ended.id);assert.deepEqual(await ids('active'),[person.id]);
 const previous=(await db.query('SELECT * FROM applications WHERE id=$1',[ended.id])).rows[0];
 assert.equal(previous.is_current,false);assert.equal(previous.status,'rejected');
 assert.equal((await service.candidate(a,person.id)).profile.summary,'人工描述保留');
});


test('existing interview dictionary is upgraded with a new version and user labels remain intact',async t=>{
 const {db,config,cleanup}=await testDatabase();t.after(cleanup);const a=await actor(db),identity=new Identity(db,config,new FeishuProvider(config)),configs=new BusinessConfigService(identity);
 await configs.seed();const cfg=(await db.query("SELECT c.*,v.document FROM business_configs c JOIN business_config_versions v ON v.config_id=c.id AND v.version=c.published_version WHERE c.key='dictionary.interview_statuses'")).rows[0];
 const old={...cfg.document,options:cfg.document.options.filter((o:any)=>o.id!=='no_show').map((o:any)=>o.id==='pending'?{...o,label:'等待约面确认'}:o)};
 await db.query('INSERT INTO business_config_versions(config_id,version,document) VALUES($1,2,$2)',[cfg.id,old]);await db.query('UPDATE business_configs SET published_version=2 WHERE id=$1',[cfg.id]);
 await db.query(await readFile(new URL('../migrations/019.sql',import.meta.url),'utf8'));
 const latest=(await db.query('SELECT v.document,c.published_version FROM business_configs c JOIN business_config_versions v ON v.config_id=c.id AND v.version=c.published_version WHERE c.id=$1',[cfg.id])).rows[0];
 assert.equal(latest.published_version,3);assert.equal(latest.document.options.find((o:any)=>o.id==='pending').label,'等待约面确认');assert.equal(latest.document.options.filter((o:any)=>o.id==='no_show').length,1);
 assert.deepEqual((await db.query('SELECT document FROM business_config_versions WHERE config_id=$1 AND version=2',[cfg.id])).rows[0].document,old);
 assert.ok(latest.document.options.some((o:any)=>o.id==='no_show' && o.active));
 await db.query(await readFile(new URL('../migrations/019.sql',import.meta.url),'utf8'));assert.equal((await db.query('SELECT published_version FROM business_configs WHERE id=$1',[cfg.id])).rows[0].published_version,3);
});

test('HTTP archive and new recruitment commands are permission checked and idempotent',async t=>{
 const {httpSession}=await import('./helpers.js');const {randomUUID}=await import('node:crypto');
 const {db,config,cleanup}=await testDatabase();t.after(cleanup);const session=await httpSession(db,config);t.after(()=>session.app.close());
 const identity=new Identity(db,config,new FeishuProvider(config)),r=new RecruitingService(identity),a=session.actor;
 const person=await r.createCandidate(a,{name:'合成幂等收件人'}),job=await r.createJob(a,{name:'幂等岗位',level:'P5',requirements:{}});
 const archive={method:'POST' as const,url:'/api/v4/candidates/'+person.id+'/archive',headers:{...session.headers,'idempotency-key':randomUUID()},payload:{version:person.version,reason:'人工确认仅留档'}};
 const saved=await session.app.inject(archive),replayed=await session.app.inject(archive);assert.equal(saved.statusCode,200);assert.equal(replayed.statusCode,200);assert.deepEqual(saved.json().data,replayed.json().data);assert.equal(saved.json().data.profile,undefined);
 const first=await r.apply(a,{candidateId:person.id,jobId:job.id,source:'其他'});
 await r.transition(a,first.id,{version:first.version,to:'rejected',reason:'本轮结束',opinion:'人工核对后结束本轮',rejectReason:'专业经验',rejectDetail:'本轮岗位不匹配'});
 const def=await new BusinessConfigService(identity).effective(a,'application');
 const start={method:'POST' as const,url:'/api/v4/applications',headers:{...session.headers,'idempotency-key':randomUUID()},payload:{candidateId:person.id,jobId:job.id,startNew:true,source:'其他',definitionVersion:def.ref.version,definitionRevision:def.aclRevision}};
 const next=await session.app.inject(start),again=await session.app.inject(start);assert.equal(next.statusCode,200,next.body);assert.equal(again.statusCode,200,again.body);assert.equal(next.json().data.id,again.json().data.id);
 assert.equal((await db.query('SELECT count(*)::int n FROM applications WHERE candidate_id=$1',[person.id])).rows[0].n,2);
 const viewer=await httpSession(db,config,['viewer']);t.after(()=>viewer.app.close());
 const denied=await viewer.app.inject({...archive,headers:{...viewer.headers,'idempotency-key':randomUUID()}});assert.equal(denied.statusCode,403);
});
