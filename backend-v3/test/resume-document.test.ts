import test from 'node:test';import assert from 'node:assert/strict';
import {configFixture} from './business-config-fixture.js';import {TaskService} from '../src/tasks/service.js';import {Worker} from '../src/tasks/worker.js';import {FileStore} from '../src/files/storage.js';
import {isClearlyNonResume} from '../src/parsing/document.js';
test('a resume mentioning company procedures remains eligible, and a title without corroboration remains uncertain',()=>{
 assert.equal(isClearlyNonResume('张小明-制度建设经验简历.pdf','个人简历\n姓名：张小明\n负责公司制度建设与解决方案'),false);
 assert.equal(isClearlyNonResume('通知.pdf','姓名：张小明\n求职意向：工程师'),false);
 assert.equal(isClearlyNonResume('某公司介绍2023(1).pdf','关于公司\n解决方案\nCONTENTS'),true);
 assert.equal(isClearlyNonResume('王小明-环球周刊编辑.pdf','姓名：王小明\n电话：13800000000\n求职意向：编辑\n工作经历：环球周刊，负责行业资讯采编'),false);
});
test('a clearly titled publication is archived as non-resume instead of creating a person from example names',async t=>{
 const f=await configFixture(t),tasks=new TaskService(f.identity,new FileStore(f.config.storageRoot)),worker=new Worker(f.identity,new FileStore(f.config.storageRoot),'non-resume-fixture');
 const task=await tasks.upload(f.admin,{name:'雇员风险管理月刊2026年8月.txt',data:Buffer.from('2026年8月刊\n本月热点\n行业资讯\n姓名：文章举例人员\n这是一份行业期刊，不是个人履历。'),newCandidatesOnly:true});await worker.once();
 const result=await tasks.get(f.admin,task.id);assert.equal(result.state,'succeeded');assert.equal(result.result.skippedNonResume,true);assert.equal((await f.db.query('SELECT count(*)::int n FROM candidates')).rows[0].n,0);
});
