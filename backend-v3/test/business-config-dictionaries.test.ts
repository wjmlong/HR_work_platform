import test from 'node:test';
import assert from 'node:assert/strict';
import {configFixture} from './business-config-fixture.js';
import {BusinessDictionaryService,validateOption} from '../src/business-config/dictionaries.js';
import {RecruitingService} from '../src/recruiting/service.js';
import {SourcingService} from '../src/sourcing/service.js';
import {CampusService} from '../src/campus/service.js';
import {Dictionary} from '../src/dictionary/service.js';
import {httpSession} from './helpers.js';

async function amend(f:any,key:string,change:(options:any[])=>any[]){
 const d=new BusinessDictionaryService(f.identity),old=await d.dictionary(f.admin,key),document:any=await f.configs.version(f.admin,old.ref);
 const draft=await f.configs.saveDraft(f.admin,{key:document.key,baseVersion:old.ref.version,document:{...document,options:change(document.options)}});
 const ref=await f.configs.publish(f.admin,await f.configs.preview(f.admin,draft.id));
 return {ref,old,d};
}
test('dictionary_deactivation_and_no_resurrection: renamed grades retain stable values and new custom grades are accepted',async t=>{
 const f=await configFixture(t),r=new RecruitingService(f.identity),job=await r.createJob(f.admin,{name:'Synthetic grade',level:'P5'});
 const oldDefinition=await f.configs.effective(f.admin,'job');
 const {d}=await amend(f,'job_levels',options=>[...options.map(o=>o.id==='P5'?{...o,label:'专业五级',active:false}:o),{id:'expert_track',label:'专家通道',active:true,aliases:[],order:30}]);
 assert.equal((await r.updateJob(f.admin,job.id,{version:job.version,department:'技术'})).level,'P5');
 await assert.rejects(r.createJob(f.admin,{name:'Synthetic inactive',level:'P5'}),/option_inactive|job_level_required/);
 assert.equal((await r.createJob(f.admin,{name:'Synthetic new grade',level:'expert_track'})).level,'expert_track');
 await f.configs.seed();await new Dictionary(f.db).seed();
 assert.equal((await d.dictionary(f.admin,'job_levels')).options.find(o=>o.id==='P5')?.active,false);
 const next=await f.configs.effective(f.admin,'job');
 assert.notEqual(next.aclRevision,oldDefinition.aclRevision);
 assert.equal(next.fields.find(x=>x.coreKey==='level')?.options.find(x=>x.id==='P5')?.label,'专业五级');
});

test('configured sourcing channels and campus region options are used by actual business services',async t=>{
 const f=await configFixture(t);
 await amend(f,'lead_sources',options=>[...options,{id:'industry_day',label:'产业人才交流日',active:true,aliases:[],order:99}]);
 const lead=await new SourcingService(f.identity).create(f.admin,{name:'Synthetic lead',org:'Synthetic org',direction:'控制',source:'industry_day',line:'high'});
 assert.equal(lead.source,'industry_day');
 await amend(f,'campus_regions',options=>[...options,{id:'custom_region',label:'科教园区',active:true,aliases:[],order:99}]);
 const campus=await new CampusService(f.identity).create(f.admin,{school:'Synthetic custom region',region:'custom_region'});
 assert.equal(campus.region,'custom_region');
 assert.equal((await new CampusService(f.identity).query(f.admin,{region:'custom_region'})).items.length,1);
});

test('dictionary_core_codes_and_aliases: status meanings and education ranks cannot change with display order',async t=>{
 const f=await configFixture(t),d=new BusinessDictionaryService(f.identity),doc:any=await f.configs.version(f.admin,(await d.dictionary(f.admin,'recruiting_statuses')).ref);
 await assert.rejects(amend(f,'recruiting_statuses',options=>[...options,{id:'invented_stage',label:'新增阶段',active:true,aliases:[],order:30}]),/core_dictionary_codes/);
 await assert.rejects(amend(f,'education',options=>options.map(o=>o.id==='bachelor'?{...o,rank:99}:o)),/education_rank_immutable/);
 const updated=await amend(f,'education',options=>options.map(o=>o.id==='bachelor'?{...o,label:'本科及同等学历',order:99}:o));
 assert.equal((await d.dictionary(f.admin,'education',updated.ref)).options.find(o=>o.id==='bachelor')?.rank,2);
 assert.ok(doc.options.some((o:any)=>o.id==='screening'));
 assert.equal(validateOption([{id:'专业服务',label:'专业服务',aliases:[],active:true,order:0}],'专业服务'),'专业服务');
});

test('skill normalization can replay an old dictionary and publishing aliases never queues automatic recomputation',async t=>{
 const f=await configFixture(t),normalizer=new Dictionary(f.db),d=new BusinessDictionaryService(f.identity),old=await d.dictionary(f.admin,'skills');
 assert.deepEqual(await normalizer.normalize(['torch'],f.db.sql,old.ref),['PyTorch']);
 const before=Number((await f.db.query('SELECT count(*) n FROM tasks')).rows[0].n);
 await amend(f,'skills',options=>options.map(o=>o.id==='PyTorch'?{...o,aliases:o.aliases.filter((a:string)=>a!=='torch')}:o));
 assert.deepEqual(await normalizer.normalize(['torch']),['torch']);
 assert.deepEqual(await normalizer.normalize(['torch'],f.db.sql,old.ref),['PyTorch']);
 assert.equal(Number((await f.db.query('SELECT count(*) n FROM tasks')).rows[0].n),before);
 await assert.rejects(amend(f,'skills',options=>options.map(o=>o.id==='Python'?{...o,aliases:[...o.aliases,'torch']}:o.id==='Java'?{...o,aliases:[...o.aliases,'TORCH']}:o)),/alias_conflict/);
 await normalizer.seed();assert.deepEqual(await normalizer.normalize(['torch']),['torch']);
});

test('legacy skill write route directs clients to versioned publication instead of changing live rules',async t=>{
 const f=await configFixture(t),h=await httpSession(f.db,f.config);t.after(()=>h.app.close());
 const response=await h.app.inject({method:'PUT',url:'/api/v4/dictionary',headers:{...h.headers,'idempotency-key':'legacy-skill-write'},payload:{name:'Synthetic term',category:'custom',aliases:[]}});
 assert.equal(response.statusCode,426);
 assert.equal((await f.db.query("SELECT count(*) n FROM skills WHERE name='Synthetic term'")).rows[0].n,'0');
});
