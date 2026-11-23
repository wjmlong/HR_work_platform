import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {configFixture} from './business-config-fixture.js';
import {parseMoney,interpretSalary,compareMoney} from '../src/business-config/money.js';
import {SalaryMigrationService} from '../src/business-config/salary-migration.js';
import {RecruitingService} from '../src/recruiting/service.js';
import {TaskService} from '../src/tasks/service.js';
import {Worker} from '../src/tasks/worker.js';
import {FileStore} from '../src/files/storage.js';
import {readFieldValues} from '../src/business-config/fields.js';

test('money preserves exact decimals, zero and composition and rejects implicit currency or period comparisons',()=>{
 assert.equal(parseMoney({min:'9007199254740993.20'}).min,'9007199254740993.2');
 assert.equal(parseMoney({min:'0'}).min,'0');
 for(const input of [{min:'-1'},{min:'30',max:'20'},{min:'1e6'},{min:9007199254740992},{currency:'not a currency'},{salaryMonths:0}])assert.throws(()=>parseMoney(input),/money_invalid/);
 const a=parseMoney({min:'100000',currency:'CNY',includesBonus:'no',includesEquity:'no'});
 assert.equal(compareMoney(a,parseMoney({...a,min:'90000'})),1);
 for(const b of [{...a,currency:'USD'},{...a,period:'monthly'},{...a,includesBonus:'yes'},{...a,includesEquity:'unknown'}])assert.throws(()=>compareMoney(a,parseMoney(b)),/money_not_comparable/);
});

test('money_preserves_unknown_basis: monthly salary without months and mixed components are never guessed into annual cash',()=>{
 assert.equal(interpretSalary('20k').proposedAnnual,null);
 assert.equal(interpretSalary('月薪20k').proposedAnnual,null);
 assert.equal(interpretSalary('面议').raw,'面议');
 assert.equal(interpretSalary('年薪税后30万').proposedAnnual,null);
 assert.equal(interpretSalary('年包30万+期权10万').proposedAnnual,null);
 const annual=interpretSalary('期望年包：30-40万');
 assert.equal(annual.classification,'annual_explicit');assert.equal(annual.proposed.min,'300000');assert.equal(annual.proposed.max,'400000');
 const monthly=interpretSalary('月薪20k，14薪');
 assert.equal(monthly.classification,'monthly_with_months');assert.equal(monthly.proposedAnnual,'280000');assert.equal(monthly.proposed.salaryMonths,14);
});

async function fixture(t:any){
 const f=await configFixture(t),dir=await mkdtemp(path.join(os.tmpdir(),'configured-salary-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 f.config.storageRoot=dir;
 const r=new RecruitingService(f.identity),tasks=new TaskService(f.identity,new FileStore(dir)),worker=new Worker(f.identity,new FileStore(dir),'salary-test');
 const job=await r.createJob(f.admin,{name:'Synthetic salary role',level:'P5',salaryRange:'年包35-45万'});
 const raw='姓名：合成薪酬人员\n本科，三年工作经验\n期望年包：30-40万\n技能：Python';
 const task=await tasks.upload(f.admin,{name:'synthetic-salary.txt',data:Buffer.from(raw),jobId:job.id});while(await worker.once()){}
 const done=await tasks.get(f.admin,task.id),app=await r.application(f.admin,done.result.applicationId);
 const source=await tasks.raw(f.admin,app.resume_version_id);
 return {...f,r,tasks,job,app,source,raw,migration:new SalaryMigrationService(f.identity)};
}
test('salary_preview_requires_adoption: preview changes no facts and confirmed migration forks a resume without adopting it',async t=>{
 const f=await fixture(t),before=(await f.db.query('SELECT count(*) n FROM resume_versions')).rows[0].n;
 const preview=await f.migration.previewSalaryMigration(f.admin,{entity:'resume',ids:[f.source.resumeVersionId]});
 assert.equal(preview.items.length,1);assert.equal(preview.items[0].proposedAnnual,'300000');
 assert.equal((await f.db.query('SELECT count(*) n FROM resume_versions')).rows[0].n,before);
 const applied=await f.migration.applySalaryMigration(f.admin,{receipt:preview.receipt,selectedIds:[f.source.resumeVersionId]});
 assert.equal(applied.applied,1);assert.equal(applied.conflicts.length,0);
 const newId=applied.versions[0].resumeVersionId;assert.notEqual(newId,f.source.resumeVersionId);
 const newer=await f.tasks.raw(f.admin,newId);
 assert.equal(newer.raw,f.raw);assert.deepEqual(newer.profile,f.source.profile);
 assert.equal((await f.r.application(f.admin,f.app.id)).resume_version_id,f.source.resumeVersionId);
 const values=await readFieldValues(f.identity,f.admin,{kind:'resume',id:newId},f.db.sql);
 assert.equal((values['builtin.resume.expectedCompensation'] as any).min,'300000');
 assert.deepEqual(await readFieldValues(f.identity,f.admin,{kind:'resume',id:f.source.resumeVersionId},f.db.sql),{});
 assert.deepEqual(await f.migration.applySalaryMigration(f.admin,{receipt:preview.receipt,selectedIds:[f.source.resumeVersionId]}),applied);
});

test('salary migration guards changed application observations and keeps resume expectation separate from application negotiation',async t=>{
 const f=await fixture(t),preview=await f.migration.previewSalaryMigration(f.admin,{entity:'application',ids:[f.app.id]});
 await f.db.query('UPDATE applications SET version=version+1 WHERE id=$1',[f.app.id]);
 await assert.rejects(f.migration.applySalaryMigration(f.admin,{receipt:preview.receipt,selectedIds:[f.app.id]}),/salary_preview_stale/);
 const fresh=await f.migration.previewSalaryMigration(f.admin,{entity:'application',ids:[f.app.id]});
 const applied=await f.migration.applySalaryMigration(f.admin,{receipt:fresh.receipt,selectedIds:[f.app.id]});assert.equal(applied.applied,1);
 const values=await readFieldValues(f.identity,f.admin,{kind:'application',id:f.app.id},f.db.sql);
 assert.equal((values['builtin.application.expectedCompensation'] as any).min,'300000');
 assert.deepEqual((await f.tasks.raw(f.admin,f.source.resumeVersionId)).profile,f.source.profile);
 const job=await f.migration.previewSalaryMigration(f.admin,{entity:'job',field:'salaryRange',ids:[f.job.id]});
 await f.migration.applySalaryMigration(f.admin,{receipt:job.receipt,selectedIds:[f.job.id]});
 assert.equal((await f.r.jobs(f.admin)).find((j:any)=>j.id===f.job.id).salary_range,'年包35-45万');
 assert.ok(!JSON.stringify(await f.r.publicJob(f.admin,f.job.id)).includes('350000'));
});
