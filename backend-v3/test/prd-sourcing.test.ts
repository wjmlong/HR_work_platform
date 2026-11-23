import test from 'node:test';
import assert from 'node:assert/strict';
import {testDatabase,actor,httpSession} from './helpers.js';
import {Identity} from '../src/identity/service.js';
import {FeishuProvider} from '../src/identity/provider.js';
import {SourcingService} from '../src/sourcing/service.js';
import {Dictionary} from '../src/dictionary/service.js';
import {searchEvidence} from '../src/sourcing/search.js';

test('PRD institution markers anywhere prevent false recall, short Chinese terms broaden and non-English terms remain substrings',()=>{
 for(const [record,query] of [['合肥工业大学博士后','浙江工业大学博士后'],['建设银行博士后','招商银行博士后'],['合肥学校招生','浙江学校招生'],['浙江科学院研究员','中国科学院研究员']])assert.equal(searchEvidence(record,query).matched,false,query);
 assert.equal(searchEvidence('浙江工业大学博士后','浙江工业大学博士后').matched,true);
 assert.equal(searchEvidence('模型','大模型').matched,true);
 assert.equal(searchEvidence('智能','智能机器人平台').matched,false);
 assert.equal(searchEvidence('智能机器人','智能机器人平台').matched,true);
 assert.equal(searchEvidence('abcC++bar','C++').matched,true);
 assert.equal(searchEvidence('JavaScript','Java').matched,false);
});

test('PRD SQL retrieval, highlighting, facet counts and filtered export share institution and short-term semantics',async t=>{
 const f=await testDatabase();t.after(f.cleanup);const a=await actor(f.db),s=new SourcingService(new Identity(f.db,f.config,new FeishuProvider(f.config)));
 for(const [name,school,direction] of [['合成甲','浙江工业大学','博士后'],['合成乙','合肥工业大学','博士后'],['合成丙','','模型']])await s.create(a,{name,org:'Synthetic employer',school,direction,source:'其他',line:'high'});
 assert.equal((await s.query(a,{query:'浙江工业大学博士后'})).total,0); // The complete institution segment is not present across field boundaries.
 const school=await s.query(a,{query:'浙江工业大学 博士后',pageSize:1});assert.equal(school.total,1);assert.equal(school.items[0].name,'合成甲');assert.ok(school.items[0].hits.school.ranges.every((r:any)=>r.text==='浙江工业大学'));
 assert.equal((await s.query(a,{query:'工业大学'})).total,2);
 const short=await s.query(a,{query:'大模型'});assert.equal(short.total,1);assert.equal(short.items[0].name,'合成丙');assert.equal(short.items[0].hits.direction.kind,'broad');
 const csv=await s.csv(a,{query:'大模型',pageSize:1},'filtered');assert.ok(csv.includes('合成丙'));assert.ok(!csv.includes('合成甲'));
 const zero=await s.query(a,{filters:{school:['不存在']}});assert.equal(zero.facets.school.find((r:any)=>r.value==='不存在').count,0);
 assert.ok(!zero.facets.source.some((r:any)=>r.count===0));
 await assert.rejects(s.query(a,{filters:{contactAvailability:['present','missing']}}),/invalid_input/);
});

test('PRD default dictionary covers about sixty skills, exact normalization examples, unknown preservation and editable extension',async t=>{
 const f=await testDatabase();t.after(f.cleanup);const d=new Dictionary(f.db);await d.seed();
 assert.ok((await d.list()).length>=60);
 assert.deepEqual(await d.normalize(['torch','pytorch','Pytorch','LLM','大语言模型','基座模型','自然语言处理','智能体','multi-agent','k8s','容器化','六西格玛','IATF16949','未收录技能']),['PyTorch','大模型','NLP','Agent','Docker','质量管理','未收录技能']);
 await d.update('合成扩充技能',['synthetic-custom'],'custom');assert.deepEqual(await d.normalize(['synthetic-custom']),['合成扩充技能']);
 await d.update('PyTorch',['pytorch'],'人工智能');await d.seed();assert.deepEqual(await d.normalize(['torch']),['torch']); // Never resurrect a deliberately removed alias on restart.
});

test('PRD personal collection setup is available to every approved role, defaults to thirty and never claims execution',async t=>{
 const f=await testDatabase();t.after(f.cleanup);const a=await actor(f.db,['viewer']),s=new SourcingService(new Identity(f.db,f.config,new FeishuProvider(f.config)));
 await assert.rejects(s.setup(a,{line:'high'}),/invalid_input/);
 const saved=await s.setup(a,{targetJob:'合成目标岗位',targetJobs:['合成目标岗位'],line:'high',lines:['high'],saveTemplate:true});
 assert.equal(saved.limit,30);assert.equal((await s.getSetup(a)).saveTemplate,true);
 assert.equal((await s.request(a)).execution_status,'not_configured');
 await new Dictionary(f.db).seed();const {app,headers}=await httpSession(f.db,f.config,['viewer']);t.after(()=>app.close());
 const dictionary=await app.inject({url:'/api/v4/dictionary',headers});assert.equal(dictionary.statusCode,200,dictionary.body);assert.ok(dictionary.json().data.length>=60);
 await assert.rejects(s.create(a,{name:'No authority',org:'Synthetic',direction:'Synthetic',source:'Synthetic',line:'high'}),/forbidden/);
});

test('PRD dictionary upgrade adds new defaults and specified grouping rules without restoring unrelated removed aliases',async t=>{
 const f=await testDatabase();t.after(f.cleanup);
 await f.db.query("INSERT INTO skills(name,category) VALUES('PyTorch','old'),('Kubernetes','old'),('Docker','old'),('IATF16949','old')");
 await f.db.query("INSERT INTO skill_aliases(alias,skill) VALUES('pytorch','PyTorch'),('k8s','Kubernetes'),('iatf16949','IATF16949')");
 await f.db.query('INSERT INTO schema_migrations(version) VALUES(1001)');
 const d=new Dictionary(f.db);await d.seed();assert.deepEqual(await d.normalize(['torch','k8s','IATF16949']),['torch','Docker','质量管理']);
 const version=(await f.db.query('SELECT version FROM dictionary_versions WHERE id=1')).rows[0].version;assert.equal(version,2);
 await d.seed();assert.equal((await f.db.query('SELECT version FROM dictionary_versions WHERE id=1')).rows[0].version,2);
});

test('PRD sourcing KPI counts all six statuses with resume_received plus uploaded as conversion',async t=>{
 const f=await testDatabase();t.after(f.cleanup);const a=await actor(f.db),s=new SourcingService(new Identity(f.db,f.config,new FeishuProvider(f.config)));
 for(const [index,state] of ['uncontacted','contacted','replied','resume_received','uploaded','declined'].entries()){
  const lead=await s.create(a,{name:'Synthetic '+state,org:'Synthetic',direction:'研究',source:index<3?'顶会论文':'内推',line:'high'});
  await f.db.query('UPDATE leads SET state=$2 WHERE id=$1',[lead.id,state]);
 }
 const metrics=await s.metrics(a,{line:'high'});assert.equal(metrics.total,6);assert.equal(metrics.following,3);assert.equal(metrics.acquired,2);assert.equal(metrics.conversionRate,1/3);
 assert.equal(metrics.channels.find((r:any)=>r.source==='内推').conversionRate,2/3);
});

test('recruiter can choose either filtered or full visible export; CSV retains eleven readable columns',async t=>{
 const f=await testDatabase();t.after(f.cleanup);const a=await actor(f.db,['recruiter']),s=new SourcingService(new Identity(f.db,f.config,new FeishuProvider(f.config)));
 for(const name of ['Synthetic export A','Synthetic export B'])await s.create(a,{name,org:'Synthetic',direction:'Synthetic',source:'内推',line:'focus'});
 const filtered=await s.csv(a,{query:'export A'},'filtered');assert.equal(filtered.trim().split('\r\n').length,2);
 const all=await s.csv(a,{query:'export A'},'all');assert.equal(all.trim().split('\r\n').length,3);assert.equal(all.split('\r\n')[0].split(',').length,11);assert.ok(all.includes('未联系'));
});

test('PRD offers all eleven source categories, rejects a new unknown source and keeps an unchanged historical source editable',async t=>{
 const f=await testDatabase();t.after(f.cleanup);const a=await actor(f.db),s=new SourcingService(new Identity(f.db,f.config,new FeishuProvider(f.config))),body={name:'Synthetic sources',org:'Synthetic',direction:'Synthetic',line:'high'};
 for(const source of ['顶会论文','导师主页','实验室官网','领英','脉脉','内推','校友引荐','工厂/展会','论坛/社区','抖音/社媒','其他'])await s.create(a,{...body,source});
 await assert.rejects(s.create(a,{...body,source:'new unsupported source'}),/invalid_input/);
 const lead=(await f.db.query("UPDATE leads SET source='Historical source' WHERE id=(SELECT id FROM leads LIMIT 1) RETURNING *")).rows[0];
 const edited=await s.update(a,lead.id,{version:lead.version,source:lead.source,note:'Preserve historical category'});assert.equal(edited.source,lead.source);
 await assert.rejects(s.update(a,lead.id,{version:edited.version,source:'another unsupported source'}),/invalid_source/);
});
