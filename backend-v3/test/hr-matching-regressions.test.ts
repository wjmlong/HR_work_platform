import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {compareConfiguredProfile,defaultMatchTemplate,validateMatchTemplate,CONFIGURED_ALGORITHM} from '../src/business-config/match-template.js';
import {parseProfile,encodeRaw} from '../src/parsing/profile.js';
import {applyCorrections} from '../src/parsing/corrections.js';
import {configFixture,publishDefinition} from './business-config-fixture.js';
import {actor} from './helpers.js';
import {RecruitingService} from '../src/recruiting/service.js';
import {ConfiguredRecruiting} from '../src/business-config/recruiting.js';
import {registerInboxMatching} from '../src/recruiting/matching-flow.js';
const dictionary={ref:{configId:'10000000-0000-4000-8000-000000000001',version:1},aliases:{python:'Python'}};
const template=validateMatchTemplate({...defaultMatchTemplate(),mode:'custom',key:'match.regression',groups:[]});
function points(years:number,required:number){const parsed=applyCorrections(parseProfile(''),[{field:'experienceYears',value:years,actorId:'fixture',reason:'合成已核对经验',at:'2026-11-13T00:00:00Z'}]);return compareConfiguredProfile(parsed,'',{skills:[],experienceYears:required},template,dictionary).experience.points;}
test('custom experience never decreases at requirement or tier boundaries and zero years cannot satisfy positive requirements',()=>{
 for(let required=1;required<=20;required++){
  assert.equal(points(0,required),0,`zero experience vs ${required}`);
  for(let years=1;years<=30;years++)assert.ok(points(years,required)>=points(years-1,required),`requirement ${required}, ${years-1} -> ${years}`);
 }
 assert.equal(points(4,5),12);assert.equal(points(5,5),15);
 assert.equal(points(2,3),17);assert.equal(points(3,3),25);
 assert.notEqual(CONFIGURED_ALGORITHM,'professional-config-1.0.0');
});
async function fixture(t:any,skills='Python'){
 const f=await configFixture(t),r=new RecruitingService(f.identity),recruiter=await actor(f.db,['recruiter']);
 const job=await r.createJob(f.admin,{name:'开发工程师',level:'P5',requirements:{skills:['Python']}});
 const candidate=await r.createCandidate(f.admin,{name:'仅用于合成测试的姓名',intent:'开发工程师'}),raw='姓名：仅用于合成测试的姓名\n期望职位：开发工程师\n技能：'+skills+'\n学历：本科\n5年工作经验',p=parseProfile(raw);
 const doc=(await f.db.query("INSERT INTO resume_documents(sha256,blob_key,file_name,kind,file_size,owner_id) VALUES($1,'fixture','fixture.txt','txt',$2,$3) RETURNING id",['a'.repeat(64),Buffer.byteLength(raw),f.admin.id])).rows[0];
 const parsed=(await f.db.query('INSERT INTO parse_results(document_id,raw_bytes,profile,evidence,parser_version) VALUES($1,$2,$3,$4,$5) RETURNING id',[doc.id,encodeRaw(raw),p.profile,JSON.stringify(p.evidence),p.parserVersion])).rows[0];
 const resume=(await f.db.query('INSERT INTO resume_versions(candidate_id,parse_result_id,created_by) VALUES($1,$2,$3) RETURNING id',[candidate.id,parsed.id,f.admin.id])).rows[0];
 const app=Fastify();app.decorateRequest('actor',null);app.addHook('preHandler',async req=>{req.actor=recruiter;});registerInboxMatching(app,f.identity);t.after(()=>app.close());
 return {...f,r,job,candidate,resume,app,recruiter};
}
async function restrict(f:any,kind:string,key:string){const def=await f.configs.effective(f.admin,kind),doc=await f.configs.version(f.admin,def.ref);await publishDefinition(f,{...doc,fields:doc.fields.map((field:any)=>field.coreKey===key?{...field,access:{...field.access,read:['admin'],write:['admin'],export:['admin']}}:field)});}
const preview=async(f:any)=>{const response=await f.app.inject({method:'POST',url:'/api/v4/candidates/matching/preview',payload:{threshold:0}});assert.equal(response.statusCode,200,response.body);return response.json();};
test('inbox preview excludes archived candidates and does not create missing bindings',async t=>{
 const f=await fixture(t);await f.db.query('DELETE FROM business_template_bindings WHERE object_id=$1',[f.job.id]);
 const first=await preview(f),second=await preview(f);assert.deepEqual(first.items,second.items);
 assert.equal((await f.db.query('SELECT count(*)::int n FROM business_template_bindings WHERE object_id=$1',[f.job.id])).rows[0].n,0);
 await f.db.query('UPDATE candidates SET archived_at=now() WHERE id=$1',[f.candidate.id]);assert.equal((await preview(f)).items.length,0);
});
test('cross-job common terms cannot match through canonical IDs while normal job comparisons remain unchanged',async t=>{
 const f=await fixture(t,'融资'),finance=await f.r.createJob(f.admin,{name:'融资岗位',level:'P5',requirements:{skills:['融资']}});
 await f.r.apply(f.admin,{candidateId:f.candidate.id,jobId:f.job.id,resumeVersionId:f.resume.id});
 const response=await f.app.inject({method:'POST',url:'/api/v4/candidates/matching/cross-job',payload:{threshold:60}});assert.equal(response.statusCode,200,response.body);
 assert.equal(response.json().items[0].scores.find((s:any)=>s.jobId===finance.id).score,37);
 const raw='技能：融资\n5年工作经验';assert.equal(compareConfiguredProfile(parseProfile(raw),raw,{skills:['融资']},defaultMatchTemplate(),{...dictionary,aliases:{'融资':'融资'}}).skillPoints,60);
});
test('intent matching prefers exact names and never arbitrarily chooses an ambiguous substring',async t=>{
 const f=await fixture(t);await f.r.createJob(f.admin,{name:'开发',level:'P5'});
 assert.equal((await preview(f)).items[0].jobId,f.job.id);
 await f.r.createJob(f.admin,{name:'高级开发工程师',level:'P5'});
 await f.db.query("UPDATE candidates SET profile=jsonb_set(profile,'{intent}','\"工程师\"') WHERE id=$1",[f.candidate.id]);
 assert.equal((await preview(f)).items.length,0);
});
test('matching previews honor field access for names, intent, scoring inputs and evidence',async t=>{
 const f=await fixture(t);await restrict(f,'resume','name');
 assert.equal((await preview(f)).items[0].name,'未授权姓名');
 await restrict(f,'resume','intent');assert.equal((await preview(f)).items.length,0);
 const a=await f.r.apply(f.admin,{candidateId:f.candidate.id,jobId:f.job.id,resumeVersionId:f.resume.id});
 await restrict(f,'resume','skills');
 const cross=await f.app.inject({method:'POST',url:'/api/v4/candidates/matching/cross-job',payload:{threshold:0,applicationId:a.id}});
 assert.equal(cross.statusCode,200,cross.body);assert.equal(cross.json().items.length,0);
});
test('configured jobs remove derived hard skills when requirements skills are unreadable',async t=>{
 const f=await fixture(t);await restrict(f,'job','requirements.skills');
 const row=await new ConfiguredRecruiting(f.identity).projectJob(f.recruiter,f.job.id);
 assert.equal(row.requirements.skills,undefined);assert.equal(row.hard_skills,undefined);
});
test('cross-job CSV export independently enforces export permissions and records an audit',async t=>{
 const f=await fixture(t);await f.r.apply(f.admin,{candidateId:f.candidate.id,jobId:f.job.id,resumeVersionId:f.resume.id});
 const send=async()=>f.app.inject({method:'POST',url:'/api/v4/candidates/matching/cross-job',payload:{threshold:0,mode:'export'}});
 const first=await send();assert.equal(first.statusCode,200,first.body);assert.equal(first.json().items.length,1);
 const def=await f.configs.effective(f.admin,'resume'),doc:any=await f.configs.version(f.admin,def.ref);
 await publishDefinition(f,{...doc,fields:doc.fields.map((field:any)=>field.coreKey==='skills'?{...field,access:{...field.access,export:['admin']}}:field)});
 const exported=await send();assert.equal(exported.statusCode,200,exported.body);assert.equal(exported.json().items.length,0);
 const read=await f.app.inject({method:'POST',url:'/api/v4/candidates/matching/cross-job',payload:{threshold:0}});assert.equal(read.json().items.length,1);
 assert.ok((await f.db.query("SELECT 1 FROM audit_events WHERE kind='matching.cross_job_export'")).rowCount);
});
test('batch transitions require client versions and preserve stage confirmation and per-item reminders',async t=>{
 const f=await fixture(t),a=await f.r.apply(f.admin,{candidateId:f.candidate.id,jobId:f.job.id});
 await assert.rejects(f.r.batchTransition(f.admin,{ids:[a.id],to:'screened'}));
 const command={items:[{id:a.id,version:a.version}],to:'interviewing',reason:'合成批量阶段调整',opinion:'人工核对后进行批量调整'};
 const skipped=await f.r.batchTransition(f.admin,command);assert.equal(skipped.results[0].ok,false);assert.match(skipped.results[0].error!,/stage_confirmation/);
 await f.db.query('UPDATE applications SET version=version+1 WHERE id=$1',[a.id]);
 const stale=await f.r.batchTransition(f.admin,{...command,confirm:true});assert.equal(stale.results[0].ok,false);assert.match(stale.results[0].error!,/version_conflict/);
 const moved=await f.r.batchTransition(f.admin,{...command,items:[{id:a.id,version:a.version+1}],confirm:true});assert.equal(moved.results[0].ok,true);assert.ok(Object.hasOwn(moved.results[0],'ccReminder'));
});
