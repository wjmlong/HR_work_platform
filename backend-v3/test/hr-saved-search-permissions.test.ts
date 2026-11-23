import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {configFixture,publishDefinition} from './business-config-fixture.js';
import {actor} from './helpers.js';
import {SourcingService} from '../src/sourcing/service.js';
import {toolkitRoutes} from '../src/toolkit/routes.js';

async function fixture(t:any){
  const f=await configFixture(t),recruiter=await actor(f.db,['recruiter']),viewer=await actor(f.db,['viewer']),interviewer=await actor(f.db,['interviewer']);
  const actors={recruiter,viewer,interviewer},app=Fastify();
  app.decorateRequest('actor',null);
  app.addHook('preHandler',async req=>{req.actor=actors[req.headers['x-actor'] as keyof typeof actors]||recruiter;});
  toolkitRoutes(app,f.identity);await app.ready();t.after(()=>app.close());
  return {...f,app,recruiter,viewer,interviewer};
}
const request={name:'Synthetic saved search',query:{search:'PRIVATE SEARCH TERM',filters:{}}};
const save=(f:any,payload=request,headers={})=>f.app.inject({method:'POST',url:'/api/v4/toolkit/saved-searches',headers,payload});
async function changeField(f:any,key:string,change:any){
  const current=await f.configs.effective(f.admin,'lead'),doc:any=await f.configs.version(f.admin,current.ref);
  await publishDefinition(f,{...doc,fields:doc.fields.map((field:any)=>field.coreKey===key?{...field,...change}:field)});
}

test('saved searches count new authorized leads and reject non-sourcing roles on all routes',async t=>{
  const f=await fixture(t);
  assert.equal((await save(f)).statusCode,200);
  await new SourcingService(f.identity).create(f.admin,{name:'PRIVATE SEARCH TERM',org:'Synthetic company',direction:'Engineering',source:'其他',line:'high'});
  const read=await f.app.inject({url:'/api/v4/toolkit/saved-searches'});
  assert.equal(read.statusCode,200,read.body);assert.equal(read.json().items[0].newMatches,1);
  for(const role of ['viewer','interviewer']){
    const headers={'x-actor':role};
    for(const denied of [
      await f.app.inject({url:'/api/v4/toolkit/saved-searches',headers}),
      await save(f,request,headers),
      await f.app.inject({method:'POST',url:'/api/v4/toolkit/saved-searches/remove',headers,payload:{name:request.name}}),
    ])assert.equal(denied.statusCode,403,denied.body);
  }
});

for(const key of ['name','org','school','major'])test('saved search counts reauthorize hidden lead '+key+' without persisting denied edits',async t=>{
  const f=await fixture(t);
  assert.equal((await save(f)).statusCode,200);
  const doc:any=await f.configs.version(f.admin,(await f.configs.effective(f.admin,'lead')).ref),field=doc.fields.find((field:any)=>field.coreKey===key);
  await changeField(f,key,{access:{...field.access,read:['admin'],write:['admin'],export:['admin']}});
  const read=await f.app.inject({url:'/api/v4/toolkit/saved-searches'});
  assert.equal(read.statusCode,403,read.body);assert.match(read.body,/field_query_forbidden/);
  const denied=await save(f,{...request,name:'Denied replacement'});
  assert.equal(denied.statusCode,403,denied.body);
  const setup=(await f.db.query('SELECT data FROM sourcing_setups WHERE user_id=$1',[f.recruiter.id])).rows[0].data;
  assert.deepEqual(setup.savedSearches.map((s:any)=>s.name),[request.name]);
});

test('saved search counts reject unsearchable fields and conditional visibility',async t=>{
  const f=await fixture(t);
  await changeField(f,'major',{searchable:false});
  const unsearchable=await save(f);assert.equal(unsearchable.statusCode,403,unsearchable.body);
  await changeField(f,'major',{searchable:true,visibleWhen:{fieldId:'core.lead.org',op:'eq',value:'Visible company'}});
  const conditional=await save(f);assert.equal(conditional.statusCode,409,conditional.body);assert.match(conditional.body,/configured_query_required/);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM sourcing_setups WHERE user_id=$1',[f.recruiter.id])).rows[0].n,0);
});
