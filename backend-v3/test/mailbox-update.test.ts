import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {testDatabase,actor} from './helpers.js';
import {Identity} from '../src/identity/service.js';
import {FeishuProvider} from '../src/identity/provider.js';
import {TaskService} from '../src/tasks/service.js';
import {Worker} from '../src/tasks/worker.js';
import {FileStore} from '../src/files/storage.js';
import {RecruitingService} from '../src/recruiting/service.js';

test('mailbox Update only appends new people; manual profile, job and resume history survive later applications',async t=>{
 const {db,config,cleanup}=await testDatabase();t.after(cleanup);const dir=await mkdtemp(path.join(os.tmpdir(),'mailbox-new-only-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const a=await actor(db),identity=new Identity(db,config,new FeishuProvider(config)),tasks=new TaskService(identity,new FileStore(dir)),worker=new Worker(identity,new FileStore(dir),'mailbox-update-test'),recruiting=new RecruitingService(identity);
 const raw='姓名：合成新人\n邮箱：original@example.invalid\n电话：13800138000\n求职意向：待确认岗位\n技能：Python\n5年工作经验';
 const first=await tasks.upload(a,{name:'new.txt',data:Buffer.from(raw),newCandidatesOnly:true,initialDescription:'我希望做 Python 服务研发。',initialPosition:'Python 服务研发'});await worker.once();
 const added=await tasks.get(a,first.id);assert.equal(added.state,'succeeded');assert.equal(added.result.pendingJob,true);assert.equal(added.result.applicationId,null);
 const person=await recruiting.candidate(a,added.result.candidateId);
 assert.match(person.profile.summary,/我希望做 Python 服务研发/);assert.equal(person.profile.intent,'Python 服务研发');
 await recruiting.editCandidate(a,person.id,{version:person.version,profile:{...person.profile,name:'HR人工确认姓名',email:'corrected@example.invalid',phone:'13900139000',summary:'人工修改的描述',intent:'人工确认岗位'}});
 const before=(await db.query('SELECT * FROM candidates WHERE id=$1',[person.id])).rows[0],versions=Number((await db.query('SELECT count(*) FROM resume_versions WHERE candidate_id=$1',[person.id])).rows[0].count);
 const second=await tasks.upload(a,{name:'later-new-version.txt',data:Buffer.from(raw+'\n新增项目：这是再次投递的新简历'),newCandidatesOnly:true});await worker.once();
 const skipped=await tasks.get(a,second.id);assert.equal(skipped.state,'succeeded');assert.equal(skipped.result.skippedExisting,true);
 assert.deepEqual((await db.query('SELECT * FROM candidates WHERE id=$1',[person.id])).rows[0],before);assert.equal(Number((await db.query('SELECT count(*) FROM resume_versions WHERE candidate_id=$1',[person.id])).rows[0].count),versions);
 assert.equal(Number((await db.query('SELECT count(*) FROM candidates')).rows[0].count),1);
 const third=await tasks.upload(a,{name:'another.txt',data:Buffer.from('姓名：另一个合成人\n邮箱：new-person@example.invalid\n电话：13700137000\n技能：Java'),newCandidatesOnly:true});await worker.once();
 assert.equal((await tasks.get(a,third.id)).state,'succeeded');assert.equal(Number((await db.query('SELECT count(*) FROM candidates')).rows[0].count),2);
});


test('mail with an exact job match stays in inbox and never creates an application automatically',async t=>{
 const {db,config,cleanup}=await testDatabase();t.after(cleanup);const dir=await mkdtemp(path.join(os.tmpdir(),'mail-intake-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const a=await actor(db),identity=new Identity(db,config,new FeishuProvider(config)),tasks=new TaskService(identity,new FileStore(dir)),worker=new Worker(identity,new FileStore(dir),'intake-match'),recruiting=new RecruitingService(identity);
 const job=await recruiting.createJob(a,{name:'合成测试岗位',level:'P5',requirements:{}});
 const task=await tasks.upload(a,{name:'resume.txt',data:Buffer.from('姓名：合成新人甲\n邮箱：intake@example.invalid\n电话：13800138001\n技能：Python\n5年工作经验'),jobId:job.id,newCandidatesOnly:true,initialPosition:job.name});
 await worker.once();const result=await tasks.get(a,task.id);assert.equal(result.state,'succeeded');assert.equal(result.result.applicationId,null);
 assert.equal((await db.query('SELECT count(*)::int n FROM applications')).rows[0].n,0);
 assert.equal((await recruiting.candidate(a,result.result.candidateId)).lifecycle,'inbox');
});
