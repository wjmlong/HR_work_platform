import test from 'node:test';
import assert from 'node:assert/strict';
import {configFixture,fieldDefinition,publishDefinition} from './business-config-fixture.js';
import {httpSession} from './helpers.js';
import {ConfiguredRecruiting} from '../src/business-config/recruiting.js';
import {RecruitingService} from '../src/recruiting/service.js';
import {TaskService} from '../src/tasks/service.js';
import {FileStore} from '../src/files/storage.js';
import {Worker} from '../src/tasks/worker.js';
async function add(f:any,kind:string,fields:any[]){const old=await f.configs.effective(f.admin,kind);const doc=await f.configs.version(f.admin,old.ref);await publishDefinition(f,{...doc,fields:[...doc.fields,...fields]});return f.configs.effective(f.admin,kind);}
const meta=(d:any)=>({definitionVersion:d.ref.version,definitionRevision:d.aclRevision});
test('job_and_resume_config_roundtrip: configured core/custom writes are atomic, stale clients fail and rename preserves SQL values',async t=>{
 const f=await configFixture(t),c=new ConfiguredRecruiting(f.identity),r=new RecruitingService(f.identity);
 let def=await add(f,'job',[fieldDefinition({required:true})]);
 await assert.rejects(c.job(f.admin,null,{name:'Synthetic',level:'P5',...meta(def)}),/field_required/);
 assert.equal((await f.db.query('SELECT count(*)::int n FROM jobs')).rows[0].n,0);
 const j=await c.job(f.admin,null,{name:'Synthetic',level:'P5',...meta(def),customFields:{'custom.portfolio':'链接已核对'}});
 assert.equal(j.customFields['custom.portfolio'],'链接已核对');
 const doc=await f.configs.version(f.admin,def.ref);doc.fields.find((x:any)=>x.fieldId==='custom.portfolio').label='交付案例';await publishDefinition(f,doc);
 await assert.rejects(c.job(f.admin,j.id,{version:j.version,name:'不会提交',...meta(def)}),/configuration_changed/);
 const list=await c.jobs(f.admin);assert.equal(list[0].customFields['custom.portfolio'],'链接已核对');
 const h=await httpSession(f.db,f.config);t.after(()=>h.app.close());
 const old=await h.app.inject({method:'POST',url:'/api/v4/jobs',headers:{...h.headers,'idempotency-key':'old-unversioned-job'},payload:{name:'Old client',level:'P5'}});
 assert.equal(old.statusCode,409,old.body);
});
test('correction_keeps_adopted_version and configured application fields never propagate to resume facts',async t=>{
 const f=await configFixture(t),r=new RecruitingService(f.identity),c=new ConfiguredRecruiting(f.identity),tasks=new TaskService(f.identity,new FileStore(f.config.storageRoot)),worker=new Worker(f.identity,new FileStore(f.config.storageRoot),'configured-fixture');
 const j=await r.createJob(f.admin,{name:'Synthetic role',level:'P5'}),task=await tasks.upload(f.admin,{name:'configured.txt',data:Buffer.from('姓名：合成人员\n本科，3年经验\n技能：Python'),jobId:j.id});while(await worker.once()){}
 const app=await r.application(f.admin,(await tasks.get(f.admin,task.id)).result.applicationId),raw=await tasks.raw(f.admin,app.resume_version_id);
 const d=await add(f,'resume',[fieldDefinition()]);
 const newer=await c.correct(f.admin,app.resume_version_id,{baseParseResultId:raw.parseResultId,reason:'依据候选人补充资料核对',corrections:{},...meta(d),customFields:{'custom.portfolio':'真实交付说明'}});
 assert.equal((await r.application(f.admin,app.id)).resume_version_id,app.resume_version_id);
 const source=(await f.db.query('SELECT source,actor_id FROM custom_field_value_versions WHERE object_id=$1',[newer.resumeVersionId])).rows[0];assert.equal(source.actor_id,f.admin.id);assert.match(source.source.reason,/补充资料/);
 const ad=await add(f,'application',[fieldDefinition({fieldId:'custom.startDate',label:'可到岗日',type:'date'})]);
 const updated=await c.application(f.admin,app.id,{version:app.version,...meta(ad),customFields:{'custom.startDate':'2026-11-01'}});
 assert.equal(updated.status,app.status);assert.equal(updated.customFields['custom.startDate'],'2026-11-01');
 assert.deepEqual((await tasks.raw(f.admin,app.resume_version_id)).profile,raw.profile);
 const attempts=await Promise.allSettled([c.application(f.admin,app.id,{version:updated.version,...meta(ad),customFields:{'custom.startDate':'2026-11-02'}}),c.application(f.admin,app.id,{version:updated.version,...meta(ad),customFields:{'custom.startDate':'2026-11-03'}})]);
 assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1,'one version can be changed only once');
});
test('configured mutation replay rechecks present core/custom permissions instead of returning cached secrets',async t=>{
 const f=await configFixture(t),h=await httpSession(f.db,f.config);t.after(()=>h.app.close());
 let def=await add({...f,admin:h.actor},'job',[fieldDefinition({fieldId:'custom.private',label:'私有备注'})]);
 const req={method:'POST' as const,url:'/api/v4/jobs',headers:{...h.headers,'idempotency-key':'configured-private-write'},payload:{name:'Synthetic replay',level:'P5',...meta(def),customFields:{'custom.private':'do-not-leak'}}};
 const first=await h.app.inject(req);assert.equal(first.statusCode,200,first.body);assert.match(first.body,/do-not-leak/);
 const doc=await f.configs.version(h.actor,def.ref),field=doc.fields.find((x:any)=>x.fieldId==='custom.private');field.access.read=['manager'];field.access.write=['manager'];field.access.export=['manager'];
 await publishDefinition({...f,admin:h.actor},doc);
 const replay=await h.app.inject(req);assert.equal(replay.statusCode,200,replay.body);assert.ok(!replay.body.includes('do-not-leak'));
 assert.equal((await f.db.query("SELECT count(*)::int n FROM jobs WHERE name='Synthetic replay'")).rows[0].n,1);
 const receipt=(await f.db.query('SELECT response FROM idempotency_keys WHERE actor_id=$1 AND key=$2',[h.actor.id,'configured-private-write'])).rows[0].response;
 assert.ok(!JSON.stringify(receipt).includes('do-not-leak'));
});
test('a configured personnel name edit persists on reread and rejects a stale confirmation',async t=>{
 const f=await configFixture(t),h=await httpSession(f.db,f.config);t.after(()=>h.app.close());
 const r=new RecruitingService(f.identity),person=await r.createCandidate(h.actor,{name:'待确认',summary:'保留的初始描述',phone:'13800000005',intent:'岗位待确认'}),def=await f.configs.effective(h.actor,'resume');
 const profile={...person.profile,name:'人工确认姓名'},request={method:'PATCH' as const,url:'/api/v4/candidates/'+person.id,headers:{...h.headers,'idempotency-key':'personnel-name-confirmation'},payload:{version:person.version,profile,...meta(def),customFields:{}}};
 const saved=await h.app.inject(request);assert.equal(saved.statusCode,200,saved.body);
 const read=await h.app.inject({method:'GET',url:request.url,headers:h.headers});assert.equal(read.statusCode,200,read.body);assert.deepEqual(read.json().data.profile,profile);
 const conflict=await h.app.inject({...request,headers:{...h.headers,'idempotency-key':'stale-personnel-confirmation'}});assert.equal(conflict.statusCode,409,conflict.body);
 assert.equal((await r.candidate(h.actor,person.id)).profile.name,'人工确认姓名');
});
test('confirming a missing resume name fills the personnel name, while independent manual names remain protected',async t=>{
 const f=await configFixture(t),r=new RecruitingService(f.identity),c=new ConfiguredRecruiting(f.identity),tasks=new TaskService(f.identity,new FileStore(f.config.storageRoot)),worker=new Worker(f.identity,new FileStore(f.config.storageRoot),'confirmed-name-fixture');
 const task=await tasks.upload(f.admin,{name:'missing-name.txt',newCandidatesOnly:true,data:Buffer.from('这份资料属于赵小明\n手机：13800000017\n本科\n技能：Python')});await worker.once();
 const person=await r.candidate(f.admin,(await tasks.get(f.admin,task.id)).result.candidateId),resume=person.resumes[0],raw=await tasks.raw(f.admin,resume.id),def=await f.configs.effective(f.admin,'resume');
 const fixed=await c.correct(f.admin,resume.id,{baseParseResultId:raw.parseResultId,reason:'按原件核对姓名',corrections:{name:'赵小明'},...meta(def)});
 assert.equal(fixed.candidateNameUpdated,true);assert.equal((await r.candidate(f.admin,person.id)).profile.name,'赵小明');
 assert.deepEqual((await tasks.raw(f.admin,resume.id)).profile,raw.profile,'immutable original parse remains');
 const now=await r.candidate(f.admin,person.id);await r.editCandidate(f.admin,person.id,{version:now.version,profile:{...now.profile,name:'独立人工姓名'}});
 const next=await tasks.raw(f.admin,fixed.resumeVersionId),conflict=await c.correct(f.admin,fixed.resumeVersionId,{baseParseResultId:next.parseResultId,reason:'另一份简历事实',corrections:{name:'另一个姓名'},...meta(def)});
 assert.equal(conflict.candidateNameConflict,true);assert.equal((await r.candidate(f.admin,person.id)).profile.name,'独立人工姓名');
});
test('the correction HTTP response and its idempotent replay report personnel-name synchronization',async t=>{
 const f=await configFixture(t),h=await httpSession(f.db,f.config);t.after(()=>h.app.close());
 const tasks=new TaskService(f.identity,new FileStore(f.config.storageRoot)),worker=new Worker(f.identity,new FileStore(f.config.storageRoot),'confirmed-name-http');
 const task=await tasks.upload(f.admin,{name:'source.txt',newCandidatesOnly:true,data:Buffer.from('这份资料属于林小华\n手机：13800000018\n本科')});await worker.once();
 const result=(await tasks.get(f.admin,task.id)).result,raw=await tasks.raw(h.actor,result.resumeVersionId),def=await f.configs.effective(h.actor,'resume');
 const req={method:'POST' as const,url:'/api/v4/resumes/'+result.resumeVersionId+'/corrections',headers:{...h.headers,'idempotency-key':'confirmed-personnel-name'},payload:{baseParseResultId:raw.parseResultId,reason:'已核对原始简历姓名',corrections:{name:'林小华'},...meta(def)}};
 const first=await h.app.inject(req);assert.equal(first.statusCode,200,first.body);assert.equal(first.json().data.candidateNameUpdated,true);
 const replay=await h.app.inject(req);assert.equal(replay.statusCode,200,replay.body);assert.deepEqual(replay.json().data,first.json().data);
 assert.equal((await f.db.query('SELECT count(*)::int n FROM resume_versions WHERE candidate_id=$1',[result.candidateId])).rows[0].n,2);
});
