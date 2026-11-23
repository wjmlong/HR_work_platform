import test from 'node:test';
import assert from 'node:assert/strict';
import {adaptRecognition} from '../src/parsing/recognition.js';
import {pinnedParsed} from '../src/business-config/bindings.js';
import {profileInput} from '../src/recruiting/schema.js';
import {compareProfile} from '../src/parsing/match.js';
import {compareConfiguredProfile,defaultMatchTemplate} from '../src/business-config/match-template.js';
import {FileStore} from '../src/files/storage.js';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('model facts and valid source spans survive wrapped text without rule-filled intent or years',()=>{
 const r=adaptRecognition({status:'ok',source_text:'姓名：测试甲\n本科 甲大学\n熟练使用 Excel\n2026应届\n岗位要求：Python',prediction:{document_type:'resume',profile:{name:'测试甲',education:'bachelor',school:'甲大学',skills:['Excel'],intent:null,experienceYears:null},evidence:[{field:'name',quote:'姓名：测试甲'},{field:'education',quote:'本科'},{field:'school',quote:'甲大学'},{field:'skills',quote:'熟练使用\nExcel'}],warnings:[]},calls:[],seconds:1});
 assert.equal(r.profile.name,'测试甲');assert.equal(r.profile.intent,'');assert.equal(r.profile.experienceYears,null);assert.deepEqual(r.profile.skills,['Excel']);
 assert.ok(r.evidence.some((x:any)=>x.field==='skill:Excel'));
 for(const e of r.evidence)assert.equal(r.raw.slice(e.start,e.end),e.text);
});
test('non-resume documents cannot become candidate facts',()=>{
 const r=adaptRecognition({status:'ok',source_text:'公司介绍',prediction:{document_type:'other',profile:{name:'某公司'},evidence:[],warnings:[]},calls:[]});
 assert.equal(r.documentType,'other');assert.equal(r.profile.name,'待确认');
});
test('matching keeps model-extracted skills instead of reintroducing keywords from job descriptions',()=>{
 const raw='本人熟练使用 Excel。岗位要求 Python。';
 const r=pinnedParsed({profile:profileInput.parse({name:'测试甲',skills:['Excel']}),evidence:[{id:'e',field:'skill:Excel',start:7,end:12,text:'Excel',line:1}],parser_version:'deepseek-vision-1.0.0',human_corrections:[]},raw,{aliases:{Excel:'Excel',Python:'Python'}} as any);
 assert.deepEqual(r.profile.skills,['Excel']);assert.ok(!r.evidence.some(e=>e.field==='skill:Python'));
 assert.equal(compareProfile(r,raw,{skills:['Python']}).skills[0].status,'not_matched');
});
test('image and legacy Word sources enter the normal file store with content signature validation',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'recognition-formats-'));t.after(()=>rm(dir,{recursive:true,force:true}));const store=new FileStore(dir);
 assert.equal((await store.put('scan.png',Buffer.from('89504e470d0a1a0a00000000','hex'))).kind,'png');
 assert.equal((await store.put('resume.doc',Buffer.from('d0cf11e0a1b11ae100000000','hex'))).kind,'doc');
 await assert.rejects(store.put('fake.png',Buffer.from('not an image')),/invalid_document/);
});

test('confirmed model skill phrases map to dictionary skills without mining unrelated resume keywords',()=>{
 const raw='技能：熟练使用 Excel。岗位要求：Python。其他描述：JavaScript。';
 const r=adaptRecognition({status:'ok',source_text:raw,prediction:{document_type:'resume',profile:{name:'测试甲',skills:['熟练使用 Excel','JavaScript']},evidence:[{field:'skills',quote:'熟练使用 Excel'},{field:'skills',quote:'JavaScript'}],warnings:[]}});
 const dictionary={aliases:{excel:'Excel',python:'Python',java:'Java',javascript:'JavaScript'},ref:{configId:'10000000-0000-4000-8000-000000000001',version:1}};
 const result=compareConfiguredProfile(r,raw,{skills:['Excel','Python','Java']},defaultMatchTemplate(),dictionary);
 assert.deepEqual(result.skills.map(s=>s.status),['matched','not_matched','not_matched']);
 assert.equal(result.skills[0].evidence[0].text,'熟练使用 Excel');
 assert.ok(r.evidence.some(e=>e.field==='skill:熟练使用 Excel'),'normalization must not mutate source facts');
});
