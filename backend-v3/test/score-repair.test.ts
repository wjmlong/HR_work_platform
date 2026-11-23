import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {configFixture} from './business-config-fixture.js';
import {RecruitingService} from '../src/recruiting/service.js';import {TaskService} from '../src/tasks/service.js';import {Worker} from '../src/tasks/worker.js';import {FileStore} from '../src/files/storage.js';
import {RepairMatchInputs} from '../src/operations/repair-match-inputs.js';
import {encodeRaw} from '../src/parsing/profile.js';
import {encodeJSON,decodeJSON} from '../src/parsing/json.js';
test('new dictionary drafts split aliases and catch ownership conflicts without rewriting published history',async t=>{
 const f=await configFixture(t);const catalog=await f.configs.catalog(f.admin),entry=catalog.find(x=>x.key==='dictionary.skills')!;
 const old:any=await f.configs.version(f.admin,{configId:entry.id,version:entry.published_version});
 const doc=structuredClone(old);doc.options.push({id:'fixture.salary',label:'合成薪酬设计',aliases:['宽带薪酬、薪酬带宽，range'],active:true,order:900});
 const draft=await f.configs.saveDraft(f.admin,{key:'dictionary.skills',baseVersion:entry.published_version,document:doc});
 assert.deepEqual((draft.document as any).options.at(-1).aliases,['宽带薪酬','薪酬带宽','range']);
 assert.deepEqual(await f.configs.version(f.admin,{configId:entry.id,version:entry.published_version}),old);
 doc.options.push({id:'fixture.other',label:'其他合成技能',aliases:['另一词、range'],active:true,order:901});
 await assert.rejects(f.configs.saveDraft(f.admin,{key:'dictionary.skills',baseVersion:entry.published_version,document:doc}),/alias_conflict/);
});
async function fixture(t:any){
 const f=await configFixture(t),dir=await mkdtemp(path.join(os.tmpdir(),'score-repair-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=new FileStore(dir),tasks=new TaskService(f.identity,store),worker=new Worker(f.identity,store,'score-repair-fixture'),recruit=new RecruitingService(f.identity);
 const job=await recruit.createJob(f.admin,{name:'合成修复岗位',level:'P5',requirements:{skills:['Python'],education:'bachelor',experienceYears:3}});
 const task=await tasks.upload(f.admin,{name:'fixture.txt',data:Buffer.from('姓名：合成验证\n邮箱：score@example.invalid\n技能：Python\n学历：本科\n5年工作经验'),jobId:job.id});await worker.once();const done=await tasks.get(f.admin,task.id);const app=await recruit.application(f.admin,done.result.applicationId);
 const r=(await f.db.query('SELECT r.*,p.profile,p.human_corrections FROM resume_versions r JOIN parse_results p ON p.id=r.parse_result_id WHERE r.id=$1',[app.resume_version_id])).rows[0];
 const correction={field:'skills',value:['培训'],actorId:f.admin.id,reason:'恢复旧版备份中的结构化字段；原操作人未提供',at:'2026-10-19T00:00:00Z'};
 // Manufacture an old recovery artifact only in this disposable fixture schema.
 await f.db.query("UPDATE parse_results SET parser_version='legacy-fact-recovery-4.0.0',profile=jsonb_set(profile,'{skills}','[\"培训\"]'),human_corrections=$2 WHERE id=$1",[r.parse_result_id,encodeJSON([correction])]);
 await f.db.query("UPDATE candidates SET profile=jsonb_set(profile,'{skills}','[\"培训\"]') WHERE id=$1",[app.candidate_id]);
 await f.db.query("INSERT INTO migration_receipts(source_sha256,source_revision,manifest) VALUES('fixture-archive','fixture','{}')");
 await f.db.query("INSERT INTO legacy_archives(source_sha256,kind,source_key,data_bytes) VALUES('fixture-archive','bundle','all',$1),('fixture-archive','mapping','fixture',$2)",[encodeRaw('{}'),encodeRaw(JSON.stringify({candidateId:app.candidate_id,applicationId:app.id}))]);
 await f.db.query('DELETE FROM match_snapshots WHERE application_id=$1',[app.id]);
 await f.db.tx(c=>worker.recompute(c,app.id));
 return {...f,worker,tasks,recruit,job,app,r,correction,repair:new RepairMatchInputs(f.identity)};
}
test('repair creates new provenance and scoring versions, preserves old snapshots and state, and is idempotent',async t=>{
 const f=await fixture(t),oldMatches=(await f.db.query('SELECT * FROM match_snapshots ORDER BY id')).rows;
 assert.equal(oldMatches[0].reference_score.value,40);
 const oldParse=(await f.db.query('SELECT * FROM parse_results WHERE id=$1',[f.r.parse_result_id])).rows[0];
 const preview=await f.repair.preview(f.admin);assert.equal(preview.resumesToRepair,1,JSON.stringify(preview));
 const result=await f.repair.apply(f.admin,preview.hash);assert.equal(result.repairedResumes,1);
 while(await f.worker.once()){}
 const app=await f.recruit.application(f.admin,f.app.id);assert.notEqual(app.resume_version_id,f.app.resume_version_id);assert.equal(app.status,f.app.status);
 const matches=await f.tasks.matches(f.admin,app.id);assert.equal(matches.latest!.data.skillPoints,60);assert.equal(matches.stale,false);
 assert.deepEqual((await f.db.query('SELECT * FROM match_snapshots WHERE id=ANY($1::uuid[]) ORDER BY id',[oldMatches.map(x=>x.id)])).rows,oldMatches);
 assert.deepEqual((await f.db.query('SELECT * FROM parse_results WHERE id=$1',[f.r.parse_result_id])).rows[0],oldParse);
 const p=(await f.db.query('SELECT p.human_corrections FROM resume_versions r JOIN parse_results p ON p.id=r.parse_result_id WHERE r.id=$1',[app.resume_version_id])).rows[0];assert.equal(decodeJSON(p.human_corrections)[0].source,'legacy_import');
 const next=await f.repair.preview(f.admin);assert.equal(next.resumesToRepair,0);assert.equal((await f.repair.apply(f.admin,next.hash)).taskIds.length,0);
});
test('repair rejects a stale preview and never classifies an unverified correction by reason text alone',async t=>{
 const f=await fixture(t),preview=await f.repair.preview(f.admin);
 await f.db.query('UPDATE applications SET version=version+1 WHERE id=$1',[f.app.id]);
 await assert.rejects(f.repair.apply(f.admin,preview.hash),/repair_preview_stale/);
 await f.db.query("DELETE FROM legacy_archives WHERE kind='mapping'");
 assert.equal((await f.repair.preview(f.admin)).resumesToRepair,0);
});

test('repair publishes a new alias version and adopts it without mutating historical dictionary or scores',async t=>{
 const f=await fixture(t),header=(await f.db.query("SELECT * FROM business_configs WHERE key='dictionary.skills'")).rows[0];
 const original=(await f.db.query('SELECT document FROM business_config_versions WHERE config_id=$1 AND version=1',[header.id])).rows[0].document;
 const broken=structuredClone(original);broken.options.find((o:any)=>o.id==='Python').aliases.push('fixture-py、fixture-lang');
 await f.db.query('INSERT INTO business_config_versions(config_id,version,document) VALUES($1,2,$2)',[header.id,broken]);
 await f.db.query('UPDATE business_configs SET published_version=2,version=version+1 WHERE id=$1',[header.id]);
 await f.db.query("UPDATE business_template_bindings SET dictionary_ref=$2 WHERE object_id=$1",[f.job.id,{ref:{configId:header.id,version:2}}]);
 const preview=await f.repair.preview(f.admin);assert.equal(preview.dictionaryChanged,true);assert.equal(preview.jobsToAdopt,1);
 const result=await f.repair.apply(f.admin,preview.hash);assert.equal(result.dictionaryRef.version,3);assert.equal(result.adoptedJobs,1);
 while(await f.worker.once()){}
 const current=await f.tasks.matches(f.admin,f.app.id);assert.equal(current.stale,false);assert.equal(current.latest!.dictionary_version,3);
 assert.deepEqual((await f.db.query('SELECT document FROM business_config_versions WHERE config_id=$1 AND version=2',[header.id])).rows[0].document,broken);
 const fixed=(await f.db.query('SELECT document FROM business_config_versions WHERE config_id=$1 AND version=3',[header.id])).rows[0].document;
 assert.ok(fixed.options.find((o:any)=>o.id==='Python').aliases.includes('fixture-py'));assert.ok(fixed.options.find((o:any)=>o.id==='Python').aliases.includes('fixture-lang'));
});

test('a later real human correction survives repair of its verified migration ancestor',async t=>{
 const f=await fixture(t),human={...f.correction,value:['培训'],reason:'HR 已核对实际技能',at:'2026-11-11T01:00:00Z'};
 const p=(await f.db.query(`INSERT INTO parse_results(document_id,raw_bytes,profile,evidence,parser_version,human_corrections) SELECT document_id,raw_bytes,profile,evidence,'rules-4.0.2',$2 FROM parse_results WHERE id=$1 RETURNING id`,[f.r.parse_result_id,encodeJSON([f.correction,human])])).rows[0];
 const r=(await f.db.query('INSERT INTO resume_versions(candidate_id,parse_result_id,created_by,parent_id) VALUES($1,$2,$3,$4) RETURNING id',[f.app.candidate_id,p.id,f.admin.id,f.app.resume_version_id])).rows[0];
 await f.db.query('UPDATE applications SET resume_version_id=$2,version=version+1 WHERE id=$1',[f.app.id,r.id]);
 const preview=await f.repair.preview(f.admin);assert.equal(preview.resumesToRepair,1);await f.repair.apply(f.admin,preview.hash);
 while(await f.worker.once()){}
 const latest=(await f.tasks.matches(f.admin,f.app.id)).latest!;assert.equal(latest.data.skillPoints,0);assert.equal(latest.data.skills[0].assertions.at(-1).reason,human.reason);
});
