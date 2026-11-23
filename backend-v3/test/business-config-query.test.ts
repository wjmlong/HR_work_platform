import test from 'node:test';import assert from 'node:assert/strict';
import {configFixture,fieldDefinition,publishDefinition} from './business-config-fixture.js';
import {ConfiguredRecruiting} from '../src/business-config/recruiting.js';
import {ConfiguredQueryService,compileFieldQuery} from '../src/business-config/query.js';
import {SavedViewService} from '../src/business-config/views.js';
import {actor,httpSession} from './helpers.js';
import {Identity} from '../src/identity/service.js';import {Database} from '../src/db.js';
async function fixture(t:any){const f=await configFixture(t),d=await f.configs.effective(f.admin,'job'),doc=await f.configs.version(f.admin,d.ref);await publishDefinition(f,{...doc,fields:[...doc.fields,fieldDefinition({fieldId:'custom.years',label:'相关年数',type:'number'}),fieldDefinition({fieldId:'custom.team',label:'岗位族',type:'select',options:[{id:'a',label:'A'},{id:'b',label:'B'}]}),fieldDefinition({fieldId:'custom.confirmed',label:'已核对',type:'boolean'}),fieldDefinition({fieldId:'custom.deadline',label:'计划日期',type:'date'})]});const def=await f.configs.effective(f.admin,'job');return {...f,def,query:new ConfiguredQueryService(f.identity),recruit:new ConfiguredRecruiting(f.identity)};}
const q=(def:any,extra:any={})=>({definitionVersion:def.ref.version,definitionRevision:def.aclRevision,columns:['core.job.name','custom.years','custom.team'],filters:[],sort:[],facets:[],query:'',page:1,pageSize:25,...extra});
test('batched typed joins preserve missing values, false and zero, repeated filters and self-excluding facets',async t=>{const f=await fixture(t);for(const [name,customFields] of [['zero',{'custom.years':0,'custom.confirmed':false,'custom.team':'a'}],['one',{'custom.years':1,'custom.confirmed':true,'custom.team':'b'}],['missing',{}]] as const)await f.recruit.job(f.admin,null,{name,level:'P5',definitionVersion:f.def.ref.version,definitionRevision:f.def.aclRevision,customFields});const run=(extra:any)=>f.query.query(f.admin,'job',q(f.def,extra));assert.equal((await run({filters:[{fieldId:'custom.years',op:'empty'}]})).total,1);assert.equal((await run({filters:[{fieldId:'custom.years',op:'not_empty'}]})).total,2);assert.equal((await run({filters:[{fieldId:'custom.confirmed',op:'eq',value:false}]})).total,1);const result=await run({filters:[{fieldId:'custom.years',op:'range',value:[0,1]},{fieldId:'custom.years',op:'eq',value:0}],facets:['custom.years','custom.confirmed'],sort:[{fieldId:'custom.years',direction:'asc'}]});assert.equal(result.total,1);assert.equal(result.items[0].fieldValues['custom.years'],0);assert.deepEqual(result.facets['custom.years'],[{value:0,count:1},{value:1,count:1}]);assert.deepEqual(result.facets['custom.confirmed'],[{value:false,count:1}]);});
test('typed_filter_count_export_same_scope: own-exclusion facets, pagination and filtered all-results export share the same SQL scope',async t=>{
 const f=await fixture(t);
 for(let n=0;n<36;n++)await f.recruit.job(f.admin,null,{name:n===10?'=SUM(1,2)':'Synthetic '+n,level:'P5',definitionVersion:f.def.ref.version,definitionRevision:f.def.aclRevision,customFields:{'custom.years':n,'custom.team':n%2?'b':'a','custom.confirmed':n%2===0,'custom.deadline':'2026-11-'+String(n%28+1).padStart(2,'0')}});
 const input=q(f.def,{filters:[{fieldId:'custom.years',op:'range',value:[10,30]},{fieldId:'custom.team',op:'in',value:['a']}],sort:[{fieldId:'custom.years',direction:'asc'}],facets:['custom.team'],pageSize:5});
 const result=await f.query.query(f.admin,'job',input);assert.equal(result.total,11);assert.equal(result.items.length,5);assert.equal(result.items[0].fieldValues['custom.years'],10);
 assert.deepEqual(result.facets['custom.team'],[{value:'a',count:11},{value:'b',count:10}]);
 const csv=await f.query.exportFields(f.admin,'job','filtered',input);assert.ok(csv.startsWith('\uFEFF'));assert.match(csv,/'=SUM/);const lines=csv.trim().split('\r\n');assert.equal(lines.length-2,result.total);for(const row of result.items)assert.ok(csv.includes(row.id));
 assert.equal((await f.query.query(f.admin,'job',q(f.def,{filters:[{fieldId:'custom.confirmed',op:'eq',value:false},{fieldId:'custom.deadline',op:'range',value:['2026-11-01','2026-11-28']}]}))).total,18);
 assert.equal((await f.db.query('SELECT count(*)::int n FROM jobs')).rows[0].n,36);
});
test('view_invalidated_not_broadened: views persist across pools, ownership/shared policy and disabled fields fail closed',async t=>{
 const f=await fixture(t),s=new SavedViewService(f.identity),input=q(f.def,{filters:[{fieldId:'custom.team',op:'in',value:['a']}]}),view=await s.save(f.admin,{entity:'job',name:'岗位族 A',scope:'personal',query:input});
 const pool=new Database({...f.config,instance:'configuration-query-second'});t.after(()=>pool.close());const second=new SavedViewService(new Identity(pool,f.config,f.identity.provider));assert.deepEqual(await second.resolve(f.admin,view.id),input);
 const other=await actor(f.db,['recruiter']);await assert.rejects(second.resolve(other,view.id),/forbidden/);await assert.rejects(s.save(other,{entity:'job',name:'不允许的共享',scope:'shared',query:input}),/forbidden/);
 const doc=await f.configs.version(f.admin,f.def.ref);doc.fields.find((x:any)=>x.fieldId==='custom.team').active=false;await publishDefinition(f,doc);
 await assert.rejects(s.resolve(f.admin,view.id),/view_invalid/);
 await assert.rejects(f.query.query(f.admin,'job',q(f.def,{columns:["x') OR TRUE --"]})),/field_query_forbidden|invalid_input|configuration_changed/);
 assert.throws(()=>compileFieldQuery(f.def,f.admin,q(f.def),'o; DROP TABLE jobs',0),/query_alias_invalid/);
});
test('salary and private fields cannot be inferred through search, counts, facets, sorting or export',async t=>{
 const f=await fixture(t),doc=await f.configs.version(f.admin,f.def.ref);doc.fields.push(fieldDefinition({fieldId:'custom.private',label:'私有业务说明',access:{read:['admin'],write:['admin'],export:['admin']}}));await publishDefinition(f,doc);const def=await f.configs.effective(f.admin,'job');
 const j=await f.recruit.job(f.admin,null,{name:'Visible synthetic role',level:'P5',definitionVersion:def.ref.version,definitionRevision:def.aclRevision,customFields:{'custom.private':'PRIVATE_SEARCH_MARKER'}}),viewer=await actor(f.db,['viewer']),person=(await f.db.query("INSERT INTO candidates(profile) VALUES('{\"name\":\"Synthetic viewer\"}') RETURNING id")).rows[0],app=(await f.db.query('INSERT INTO applications(candidate_id,job_id) VALUES($1,$2) RETURNING id',[person.id,j.id])).rows[0];await f.db.query('INSERT INTO application_grants(application_id,user_id) VALUES($1,$2)',[app.id,viewer.id]);
 const vd=await f.configs.effective(viewer,'job'),safe=q(vd,{columns:['core.job.name'],query:'PRIVATE_SEARCH_MARKER'});assert.equal((await f.query.query(viewer,'job',safe)).total,0);
 for(const extra of [{filters:[{fieldId:'custom.private',op:'contains',value:'MARKER'}]},{sort:[{fieldId:'custom.private',direction:'asc'}]},{facets:['custom.private']},{columns:['custom.private']}])await assert.rejects(f.query.query(viewer,'job',{...safe,...extra}),/field_query_forbidden/);
 await assert.rejects(f.query.exportFields(viewer,'job','all',q(vd,{columns:['core.job.name']})),/field_query_forbidden|forbidden/);
});

test('money comparison keeps zero exact, excludes incomparable components and conditional hidden values from facets',async t=>{
 const f=await fixture(t),doc=await f.configs.version(f.admin,f.def.ref);doc.fields.push(fieldDefinition({fieldId:'custom.optional',label:'条件备注',visibleWhen:{fieldId:'custom.confirmed',op:'eq',value:true}}));await publishDefinition(f,doc);const def=await f.configs.effective(f.admin,'job');
 const money={min:'0',currency:'CNY',period:'annual',includesBonus:'no',includesEquity:'no'},rows=[];
 for(const [n,m] of [{...money,min:'0'},{...money,min:'100000'},{...money,min:'100000',currency:'USD'},{...money,min:'100000',includesBonus:'unknown'}].entries())rows.push(await f.recruit.job(f.admin,null,{name:'Synthetic money '+n,level:'P5',definitionVersion:def.ref.version,definitionRevision:def.aclRevision,customFields:{'builtin.job.salaryCompensation':m,'custom.confirmed':true,'custom.optional':'same'}}));
 const context={currency:'CNY',period:'annual',includesBonus:'no',includesEquity:'no'},input=q(def,{columns:['core.job.name','builtin.job.salaryCompensation'],filters:[{fieldId:'builtin.job.salaryCompensation',op:'range',value:['0','100000'],money:context}],sort:[{fieldId:'builtin.job.salaryCompensation',direction:'asc',money:context}]});
 const result=await f.query.query(f.admin,'job',input);assert.equal(result.total,2);assert.equal(result.items[0].fieldValues['builtin.job.salaryCompensation'].min,'0');
 await assert.rejects(f.query.query(f.admin,'job',{...input,filters:[{fieldId:'builtin.job.salaryCompensation',op:'range',value:['0','100000']}]}),/money_context_required/);
 await f.recruit.job(f.admin,rows[0].id,{version:rows[0].version,definitionVersion:def.ref.version,definitionRevision:def.aclRevision,customFields:{'custom.confirmed':false}});
 const hidden=await f.query.query(f.admin,'job',q(def,{columns:['core.job.name','custom.optional'],filters:[{fieldId:'custom.optional',op:'not_empty'}],facets:['custom.optional']}));assert.equal(hidden.total,3);assert.deepEqual(hidden.facets['custom.optional'],[{value:'same',count:3}]);
});

test('configured native HTTP aliases and CSV carry real rows; resume lists stay tied to the adopted version',async t=>{
 const f=await fixture(t),h=await httpSession(f.db,f.config);t.after(()=>h.app.close());const def=await f.configs.effective(h.actor,'job');
 await f.recruit.job(f.admin,null,{name:'Synthetic HTTP query',level:'P5',definitionVersion:f.def.ref.version,definitionRevision:f.def.aclRevision});
 const payload=q(def,{columns:['core.job.name']}),result=await h.app.inject({method:'POST',url:'/api/v4/jobs/query',headers:h.headers,payload});assert.equal(result.statusCode,200,result.body);assert.equal(result.json().data.total,1);
 const csv=await h.app.inject({method:'POST',url:'/api/v4/jobs/export',headers:h.headers,payload:{scope:'filtered',query:payload}});assert.equal(csv.statusCode,200,csv.body);assert.ok(csv.body.startsWith('\uFEFF'));assert.match(csv.body,/Synthetic HTTP query/);
 const ad=await f.configs.effective(h.actor,'application'),apps=await h.app.inject({method:'POST',url:'/api/v4/applications/query',headers:h.headers,payload:{fieldQuery:q(ad,{columns:['core.application.source']})}});assert.equal(apps.statusCode,200,apps.body);
 const rd=await f.configs.effective(f.admin,'resume');const resumes=await f.query.query(f.admin,'resume',q(rd,{columns:['core.resume.name']}));assert.equal(resumes.total,0);
});

test('legacy search/facets and fixed exports obey tightened core-field permissions too',async t=>{
 const f=await configFixture(t),{RecruitingService}=await import('../src/recruiting/service.js'),{SourcingService}=await import('../src/sourcing/service.js'),{CampusService}=await import('../src/campus/service.js');
 const r=new RecruitingService(f.identity),s=new SourcingService(f.identity),campus=new CampusService(f.identity);
 const person=await r.createCandidate(f.admin,{name:'Synthetic privacy',phone:'PRIVATE_PHONE_MARKER'});await s.create(f.admin,{name:'Synthetic privacy lead',org:'Lab',direction:'Research',source:'顶会论文',line:'high',contact:'PRIVATE_PHONE_MARKER',raw:'PRIVATE_PHONE_MARKER'});await campus.create(f.admin,{school:'Synthetic privacy school',note:'PRIVATE_PHONE_MARKER'});
 for(const [kind,key] of [['resume','phone'],['lead','contact'],['campus','note']]){const d=await f.configs.effective(f.admin,kind as any),doc=await f.configs.version(f.admin,d.ref),field=doc.fields.find((x:any)=>x.coreKey===key);field.access.read=['manager'];field.access.write=['manager'];field.access.export=['manager'];await publishDefinition(f,doc);}
 assert.equal((await r.candidates(f.admin,{query:'PRIVATE_PHONE_MARKER'})).total,0);
 const leads=await s.query(f.admin,{query:'PRIVATE_PHONE_MARKER'} as any);assert.equal(leads.total,0);assert.ok(!Object.hasOwn(leads.facets,'contactAvailability'));
 await assert.rejects(s.csv(f.admin,{} as any),/field_query_forbidden/);
 assert.equal((await campus.query(f.admin,{query:'PRIVATE_PHONE_MARKER'})).total,0);
 assert.ok(!JSON.stringify(await r.candidates(f.admin,{})).includes('PRIVATE_PHONE_MARKER'));
});

test('legacy interview rows do not expose a hidden feedback field',async t=>{
 const f=await configFixture(t),{RecruitingService}=await import('../src/recruiting/service.js'),{InterviewService}=await import('../src/interviews/service.js'),r=new RecruitingService(f.identity),i=new InterviewService(f.identity);
 const job=await r.createJob(f.admin,{name:'Synthetic feedback role',level:'P5'}),person=await r.createCandidate(f.admin,{name:'Synthetic feedback person'}),app=await r.apply(f.admin,{candidateId:person.id,jobId:job.id});await i.create(f.admin,{applicationId:app.id,round:1,startsAt:'2030-01-01T09:00:00Z',durationMinutes:30,form:'online',interviewerIds:[f.admin.id],feedback:'PRIVATE_MEETING'});
 const d=await f.configs.effective(f.admin,'interview'),doc=await f.configs.version(f.admin,d.ref),field=doc.fields.find((x:any)=>x.coreKey==='feedback');field.access.read=['manager'];field.access.write=['manager'];field.access.export=['manager'];await publishDefinition(f,doc);
 assert.ok(!JSON.stringify(await i.list(f.admin)).includes('PRIVATE_MEETING'));assert.ok(!JSON.stringify(await i.query(f.admin,{})).includes('PRIVATE_MEETING'));
});

test('configured keyword search follows authorized display labels and aliases while preserving stable option values',async t=>{const f=await fixture(t),doc:any=await f.configs.version(f.admin,f.def.ref);const option=doc.fields.find((f:any)=>f.fieldId==='custom.team').options[0];option.label='业务甲组';option.aliases=['简称甲'];await publishDefinition(f,doc);const def=await f.configs.effective(f.admin,'job');await f.recruit.job(f.admin,null,{name:'合成标签检索岗位',level:'P5',definitionVersion:def.ref.version,definitionRevision:def.aclRevision,customFields:{'custom.team':'a','custom.years':1}});for(const term of ['业务甲组','简称甲'])assert.equal((await f.query.query(f.admin,'job',q(def,{query:term}))).total,1,term);assert.equal((await f.db.query("SELECT option_values[1] value FROM custom_field_values WHERE field_id='custom.team'")).rows[0].value,'a');});
