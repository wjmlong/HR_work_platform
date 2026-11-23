import test from 'node:test';import assert from 'node:assert/strict';
import {compareProfile} from '../src/parsing/match.js';import {parseProfile} from '../src/parsing/profile.js';import {applyCorrections} from '../src/parsing/corrections.js';
import {defaultMatchTemplate,validateMatchTemplate,compareConfiguredProfile} from '../src/business-config/match-template.js';
import {configFixture} from './business-config-fixture.js';
const dict={ref:{configId:'10000000-0000-4000-8000-000000000001',version:1},aliases:{python:'Python',docker:'Docker',torch:'PyTorch',pytorch:'PyTorch'}};
const leaf=(id:string,skill:string)=>({id,type:'skill',skill,note:'有原文或人工核对依据'});
const template=(mode='any',extra:any={})=>validateMatchTemplate({...defaultMatchTemplate(),mode:'custom',key:'match.synthetic',label:'合成专业条件',groups:[{id:'g1',label:'专业技能',mode,weight:1,required:true,items:[leaf('r1','Python'),leaf('r2','Docker')]}],...extra});
test('compat_scores_unchanged: PRD 60/25/15 baselines and evidence stay frozen',()=>{for(const raw of ['', '技能：Python\n5年工作经验\n学历：本科']){const parsed=parseProfile(raw),job={skills:raw?['Python','Docker']:[]},old=compareProfile(parsed,raw,job),now=compareConfiguredProfile(parsed,raw,job,defaultMatchTemplate(),dict);assert.deepEqual(now.score,old.score);assert.deepEqual(now.skills,old.skills);assert.deepEqual(now.experience,old.experience);assert.equal(now.algorithmVersion,old.algorithmVersion);}const empty=compareConfiguredProfile(parseProfile(''),'',{skills:[]},defaultMatchTemplate(),dict);assert.equal(empty.score.value,67);assert.deepEqual(empty.score.baselines,{skills:42,experience:13,education:12});});
test('custom_any_all_explained: degree-based group scoring, missing evidence is provisional',()=>{const raw='技能：Python',parsed=parseProfile(raw),any=compareConfiguredProfile(parsed,raw,{skills:[]},template('any'),dict),all=compareConfiguredProfile(parsed,raw,{skills:[]},template('all'),dict);assert.equal(any.skillPoints,30);assert.equal(all.skillPoints,30);assert.equal(all.groups[0].allSatisfied,false);assert.equal(any.groups[0].satisfied,true);const hit=any.skills.find(s=>s.requirement==='Python')!;assert.ok(hit.evidence.length);assert.equal(raw.slice(hit.evidence[0].start,hit.evidence[0].end),hit.evidence[0].text);const unknown=compareConfiguredProfile(parseProfile(''),'',{skills:[]},template(),dict);assert.equal(unknown.score.provisional,true);assert.ok(unknown.score.unknownFields.includes('skills'));assert.equal(unknown.skills[0].status,'unknown');});
test('match_sources_allowlist: protected attributes or arbitrary configured fields never become scoring sources',()=>{for(const type of ['age','gender','salary','customField'])assert.throws(()=>template('any',{groups:[{id:'g',label:'不允许',mode:'any',weight:1,items:[{id:'r',type,fieldId:'custom.age'}]}]}));assert.throws(()=>template('any',{weights:{skills:60,experience:25,education:15,age:1}}));assert.throws(()=>template('any',{weights:{skills:-1,experience:86,education:15}}));assert.throws(()=>template('any',{weights:{skills:20,experience:20,education:20}}));assert.throws(()=>template('any',{thresholds:{green:30,orange:50}}));assert.throws(()=>template('any',{groups:[{id:'g',label:'空组',mode:'any',weight:1,items:[]}]}));assert.throws(()=>template('any',{groups:[{id:'g',label:'重复',mode:'all',weight:1,items:[leaf('a','Python'),leaf('b','Python')]}]}));});
test('custom hand calculations cover unknown education, zero weights, range overflow and no invented fact',()=>{const raw='人工核对',parsed=applyCorrections(parseProfile(raw),[{field:'experienceYears',value:5,actorId:'synthetic-author',reason:'合成核对经验依据',at:'2026-10-21T00:00:00Z'},{field:'education',value:'bachelor',actorId:'synthetic-author',reason:'合成核对学历依据',at:'2026-10-21T00:00:00Z'}]);const t=template('any',{weights:{skills:0,experience:60,education:40},groups:[]});const result=compareConfiguredProfile(parsed,raw,{skills:[],experienceYears:10,education:'master'},t,dict);assert.equal(result.skillPoints,0);assert.equal(result.experience.points,24);assert.equal(result.education.points,19);assert.equal(result.score.value,43);const over=compareConfiguredProfile(parsed,raw,{skills:[],experienceYears:1,experienceMaxYears:3},template('any',{groups:[]}),dict);assert.equal(over.experience.status,'not_matched');assert.equal(over.experience.points,25);const unsupported=structuredClone(parseProfile(''));unsupported.profile.experienceYears=20;unsupported.profile.education='doctor';const noProof=compareConfiguredProfile(unsupported,'',{skills:[],experienceYears:10,education:'master'},t,dict);assert.equal(noProof.experience.actual,null);assert.equal(noProof.education.points,0);assert.equal(noProof.score.provisional,true);});
test('pinned aliases preserve exact spans and human overrides; cross-group duplicate weighting is explicit',()=>{const raw='技能：torch',t=template('any',{groups:[{id:'one',label:'第一组',mode:'any',weight:2,items:[leaf('a','PyTorch')]},{id:'two',label:'第二组',mode:'all',weight:1,items:[leaf('b','PyTorch')]}]}),r=compareConfiguredProfile(parseProfile(raw),raw,{skills:[]},t,dict);assert.equal(r.skillPoints,60);assert.ok(r.skills[0].evidence.some(e=>e.text==='torch'));assert.deepEqual(r.duplicateSkills,['PyTorch']);assert.deepEqual(r.configurationRefs.dictionary,dict.ref);const corrected=applyCorrections(parseProfile(raw),[{field:'skills',value:['Docker'],actorId:'human',reason:'实际仅确认 Docker',at:'2026-10-21T00:00:00Z'}]);assert.equal(compareConfiguredProfile(corrected,raw,{skills:[]},t,dict).skillPoints,0);});
test('published PRD compatibility template is immutable while custom templates publish as separate versions',async t=>{const f=await configFixture(t),catalog=await f.configs.catalog(f.admin),base=catalog.find(c=>c.key==='match.prd_default');assert.ok(base);const original:any=await f.configs.version(f.admin,{configId:base.id,version:base.published_version});await assert.rejects(f.configs.saveDraft(f.admin,{key:base.key,baseVersion:base.published_version,document:{...original,label:'覆盖默认模板'}}),/immutable/);const custom=template(),draft=await f.configs.saveDraft(f.admin,{key:custom.key,baseVersion:0,document:custom}),ref=await f.configs.publish(f.admin,await f.configs.preview(f.admin,draft.id));assert.equal(ref.version,1);await f.configs.seed();assert.deepEqual(await f.configs.version(f.admin,{configId:base.id,version:base.published_version}),original);});

test('professional Agent skill is allowed, undeclared skill cannot bypass catalog through a human assertion, and required leaves retain hints',()=>{const tool=template('any',{groups:[{id:'g',label:'Agent 工具',mode:'any',weight:1,items:[leaf('a','Agent')]}]});assert.equal(compareConfiguredProfile(parseProfile('Agent 项目'),'Agent 项目',{skills:[]},tool,{...dict,aliases:{agent:'Agent'}}).skillPoints,60);const unknown=template('any',{groups:[{id:'g',label:'待注册',mode:'any',weight:1,items:[leaf('a','UndeclaredTool')]}]}),p=applyCorrections(parseProfile(''),[{field:'skills',value:['UndeclaredTool'],actorId:'human',reason:'合成确认',at:'2026-10-21T00:00:00Z'}]);assert.throws(()=>compareConfiguredProfile(p,'',{skills:[]},unknown,dict),/unregistered/);const required=template('any',{groups:[{id:'g',label:'任一工具',mode:'any',weight:1,items:[leaf('a','Python'),{...leaf('b','Docker'),required:true}]}]});assert.equal(compareConfiguredProfile(parseProfile('Python'),'Python',{skills:[]},required,dict).hardGateHints.length,1);});

test('custom template labels publish with the version and keep prior labels immutable',async t=>{const f=await configFixture(t),doc=template(),draft=await f.configs.saveDraft(f.admin,{key:doc.key,baseVersion:0,document:doc}),one=await f.configs.publish(f.admin,await f.configs.preview(f.admin,draft.id));assert.equal((await f.configs.catalog(f.admin)).find(c=>c.id===one.configId)!.label,doc.label);const second=await f.configs.saveDraft(f.admin,{key:doc.key,baseVersion:1,document:{...doc,label:'合成模板新版名称'}});await f.configs.publish(f.admin,await f.configs.preview(f.admin,second.id));assert.equal((await f.configs.catalog(f.admin)).find(c=>c.id===one.configId)!.label,'合成模板新版名称');assert.equal((await f.configs.version(f.admin,one) as any).label,doc.label);});

test('a verified zero years satisfies an explicit zero lower bound in custom rules',()=>{const p=applyCorrections(parseProfile(''),[{field:'experienceYears',value:0,actorId:'human',reason:'合成应届经验核对',at:'2026-10-21T00:00:00Z'}]);const r=compareConfiguredProfile(p,'',{skills:[],experienceYears:0,experienceMaxYears:0},template('any',{groups:[]}),dict);assert.equal(r.experience.status,'matched');assert.equal(r.experience.points,25);});
test('dimension weights use whole percentage points so independent rounding cannot exceed a 100 point scale',()=>{assert.throws(()=>template('any',{weights:{skills:33.5,experience:33.5,education:33}}));});

test('two-level groups preserve nested ANY/ALL arithmetic and warn about repeated skill weighting across nested groups',()=>{const inner={id:'inner',label:'内组',mode:'any',items:[leaf('a','Python'),leaf('b','Docker')]},g={id:'outer',label:'外组',mode:'all',weight:1,items:[inner,leaf('again','Python')]},t=template('all',{groups:[g]}),r=compareConfiguredProfile(parseProfile('Python'),'Python',{skills:[]},t,dict);assert.equal(r.skillPoints,45);assert.equal(r.groups[0].allSatisfied,true);assert.deepEqual(r.duplicateSkills,['Python']);assert.throws(()=>template('any',{groups:[{...g,items:[{...inner,items:[{...inner,id:'third'}]}]}]}));});

// —— 2026-11-11 新增：区分度修复口径 ——
// 背景：岗位未配置技能组时，技能维度恒定输出 42 基线，导致同岗位候选人分数完全相同。
// 新口径：技能组未配置 → 技能不计分（未评分）；工作年限未识别 → 经验不计分；
// 经验达标后按年限分档，避免"刚满年限"与"多年经验"同分。
const corrected = (years: number, education = 'bachelor') => applyCorrections(parseProfile(''), [
  {field: 'experienceYears', value: years, actorId: 'synthetic-author', reason: '合成核对经验依据', at: '2026-10-21T00:00:00Z'},
  {field: 'education', value: education, actorId: 'synthetic-author', reason: '合成核对学历依据', at: '2026-10-21T00:00:00Z'},
] as any);

test('unscored_skills_without_groups: 技能组未配置时不再输出 42 基线，标记为未评分', () => {
  const r = compareConfiguredProfile(corrected(6), '', {skills: [], experienceYears: 5, education: 'bachelor'}, template('any', {groups: []}), dict);
  assert.equal(r.skillPoints, null);
  assert.deepEqual(r.score.unscoredDimensions, ['skills']);
  assert.equal(r.score.baselines.skills, 'unscored');
  assert.equal(r.score.value, r.experience.points + r.education.points);
  assert.equal(r.score.color, 'orange');
  assert.equal(r.score.provisional, true);
});

test('experience_tiers: 经验达标后按年限分档，不再一律满分', () => {
  const t = template('any', {groups: []});
  const at = (years: number) => compareConfiguredProfile(corrected(years), '', {skills: [], experienceYears: 5, education: 'bachelor'}, t, dict).experience.points;
  assert.equal(at(5), 15);
  assert.equal(at(6), 15);
  assert.equal(at(9), 20);
  assert.equal(at(13), 25);
  assert.equal(at(22), 25);
  assert.ok(at(9) > at(6) && at(13) > at(9), '年限越长经验分越高');
});

test('unscored_experience_when_unknown: 工作年限未识别时不套用 13 基线分', () => {
  const p = applyCorrections(parseProfile(''), [
    {field: 'education', value: 'bachelor', actorId: 'synthetic-author', reason: '合成核对学历', at: '2026-10-21T00:00:00Z'},
  ] as any);
  const r = compareConfiguredProfile(p, '', {skills: [], experienceYears: 5, education: 'bachelor'}, template('any', {groups: []}), dict);
  assert.equal(r.experience.points, null);
  assert.ok(r.score.unscoredDimensions.includes('experience'));
  assert.equal(r.score.baselines.experience, 'unscored');
});

test('scored_skills_split_scores: 配置技能组后同岗位候选人分数产生差异', () => {
  const t = template('all', {groups: [{id: 'g1', label: '核心专业能力', mode: 'all', weight: 3, required: true, items: [leaf('a', 'Python'), leaf('b', 'Docker')]}]});
  const rawHit = '技能：Python、Docker';
  const hitParsed = applyCorrections(parseProfile(rawHit), [
    {field: 'experienceYears', value: 6, actorId: 'synthetic-author', reason: '合成核对经验', at: '2026-10-21T00:00:00Z'},
    {field: 'education', value: 'bachelor', actorId: 'synthetic-author', reason: '合成核对学历', at: '2026-10-21T00:00:00Z'},
  ] as any);
  const hit = compareConfiguredProfile(hitParsed, rawHit, {skills: [], experienceYears: 5, education: 'bachelor'}, t, dict);
  const miss = compareConfiguredProfile(corrected(6), '', {skills: [], experienceYears: 5, education: 'bachelor'}, t, dict);
  assert.equal(hit.skillPoints, 60);
  assert.equal(miss.skillPoints, 0);
  assert.ok(hit.score.value > miss.score.value, '命中技能的候选人总分更高');
  assert.deepEqual(hit.score.unscoredDimensions, []);
});


// —— 2026-11-11 新增：按命中程度计分 ——
// 旧口径：any 组取 max，命中一条即满分；改后 any / all 统一采用组内命中比例。
test('degree_scoring: 组内按命中比例计分，命中条数越多分数越高', () => {
  const doc:any={...defaultMatchTemplate(),mode:'custom',key:'match.degree',label:'程度计分',
    groups:[{id:'g',label:'核心',mode:'all',weight:1,required:false,
      items:[leaf('a','Python'),leaf('b','Docker'),leaf('c','PyTorch')]}]};
  const t=validateMatchTemplate(doc);
  const points=(raw:string)=>compareConfiguredProfile(parseProfile(raw),raw,{skills:[]},t,dict).skillPoints;
  assert.equal(points('技能：Python'),20);
  assert.equal(points('技能：Python、Docker'),40);
  assert.equal(points('技能：Python、Docker、torch'),60);
  const anyT=validateMatchTemplate({...doc,groups:[{...doc.groups[0],mode:'any'}]});
  const one=compareConfiguredProfile(parseProfile('技能：Python'),'技能：Python',{skills:[]},anyT,dict);
  assert.equal(one.skillPoints,20,'any 组不再一命中即满分');
  assert.equal(one.groups[0].satisfied,true,'any 组的满足判定仍为「任一命中」');
  assert.equal(one.groups[0].allSatisfied,false);
});

// —— 2026-11-11 新增：命中原因 / 解析方式 / 可读技能名 ——
// 场景：技能字典新增项的 id 是 option_xxx，模板存的是 id；界面必须显示 label，
// 并写明「为什么命中」与「用什么方式解析」。说明文字不参与计分。
const optionKey='option_d957eeed-477d-4bc2-82d9-511d30342a00';
const salaryDict={...dict,
  aliases:{...dict.aliases,[optionKey.toLowerCase()]:optionKey,'薪酬体系设计':optionKey,'薪酬结构':optionKey},
  labels:{[optionKey]:'薪酬体系设计'}};
const salaryTemplate=validateMatchTemplate({...defaultMatchTemplate(),mode:'custom',key:'match.salary',label:'薪酬岗专业条件',
  groups:[{id:'g',label:'核心专业能力',mode:'all',weight:1,required:true,items:[leaf('a',optionKey)]}]});

test('skill_explanation: 字典内部 ID 显示为可读技能名，命中项写明原因与解析方式',()=>{
  const raw='负责薪酬结构设计与落地';
  const r:any=compareConfiguredProfile(parseProfile(raw),raw,{skills:[]},salaryTemplate,salaryDict);
  const s=r.skills[0],item:any=r.groups[0].items[0];
  assert.equal(s.label,'薪酬体系设计');
  assert.equal(s.method,'词典别名命中');
  assert.ok(s.reason.includes('薪酬结构'));
  assert.equal(item.label,'薪酬体系设计');
  assert.equal(item.method,s.method);
  assert.ok(item.reason.includes('薪酬结构'));
  assert.equal(r.skillPoints,60,'说明文字不改变分数');
});

test('skill_explanation_missing: 未命中写明检索范围，未评分维度计入待核实字段',()=>{
  const r:any=compareConfiguredProfile(parseProfile('完全没有相关信息'),'完全没有相关信息',{skills:[]},salaryTemplate,salaryDict);
  assert.equal(r.skills[0].status,'not_matched');
  assert.equal(r.skills[0].method,'原文检索无命中');
  assert.ok(r.skills[0].reason.includes('薪酬体系设计'));
  const unscored:any=compareConfiguredProfile(corrected(6),'',{skills:[],experienceYears:5,education:'bachelor'},template('any',{groups:[]}),dict);
  assert.ok(unscored.summary.pendingFields.includes('skills'));
  assert.ok(unscored.summary.unknown>0,'未识别计数不再恒为 0');
});
