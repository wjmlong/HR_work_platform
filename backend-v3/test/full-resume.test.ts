import test from 'node:test';import assert from 'node:assert/strict';
import {resumeRules,parseFullResume,fullModelResult} from '../src/parsing/full-resume.js';
import {bodyIsApplication} from '../src/mailbox/update.js';
const raw='林女士投递了您的职位「薪酬专家」\n林女士\n工作11年\n本科\n现居 杭州\n工作经历\n合成测试有限公司\n负责薪酬核算。\n教育经历\n合成测试大学\n物流管理 · 本科\n个人优势\n具备集团薪酬管理经验。\n去回复\n本邮件由系统发送勿回复。';
test('platform resume preserves salutation and personal description without contacts or model',async()=>{
 let called=false;const r=await parseFullResume({modelConfigFile:'configured'} as any,raw,undefined,async()=>{called=true;throw Error('unexpected');});assert.equal(called,false);assert.equal(r.profile.name,'林女士');assert.equal(r.profile.summary,'具备集团薪酬管理经验。');assert.equal(r.profile.major,'物流管理');assert.equal(r.profile.experienceYears,11);assert.equal(r.profile.phone,'');assert.equal(r.profile.email,'');assert.equal(r.profile.intent,'薪酬专家');
});
test('sparse rule output sends complete text once and validates grounded JSON',async()=>{
 const text='姓名：林小雨\n'+('负责项目。'.repeat(90));let calls=0;
 const r=await parseFullResume({modelConfigFile:'configured'} as any,text,undefined,async(_c,s)=>{calls++;assert.equal(s,text);return {content:JSON.stringify({profile:{name:'林小雨',summary:'负责项目。'},evidence:[{field:'name',quote:'姓名：林小雨'},{field:'summary',quote:'负责项目。'}]}),model:'test',tokens:20,elapsedMs:1};});assert.equal(calls,1);assert.equal(r.profile.summary,'负责项目。');assert.equal(r.provenance.method,'model');
});
test('reject invented fields, ungrounded values and injected extra properties',()=>{
 for(const profile of [{phone:'13800000000'},{name:'不存在的人'},{summary:'编造经历'},{roles:['admin']}])assert.throws(()=>fullModelResult(JSON.stringify({profile,evidence:[{field:Object.keys(profile)[0],quote:raw}]}),raw));
});
test('platform body without contacts is accepted only with substantive resume sections',()=>{
 assert.equal(bodyIsApplication({body:raw+'\n'+('薪酬工作内容。'.repeat(30)),attachments:[]}),true);assert.equal(bodyIsApplication({body:'林女士投递了您的职位「薪酬专家」',attachments:[]}),false);
});

test("school and major in one HTML row remain distinct",()=>{assert.equal(resumeRules(raw.replace("合成测试大学\n物流管理", "合成测试大学  物流管理")).profile.major,"物流管理");});
