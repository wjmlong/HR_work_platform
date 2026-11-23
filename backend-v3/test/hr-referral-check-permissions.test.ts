import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {configFixture,publishDefinition} from './business-config-fixture.js';
import {actor} from './helpers.js';
import {RecruitingService} from '../src/recruiting/service.js';
import {referralRoutes} from '../src/referrals/routes.js';

const input={candidateName:'Synthetic private candidate',candidatePhone:'13800000001',targetJob:'Synthetic private job'};
async function fixture(t:any){
  const f=await configFixture(t),recruiter=await actor(f.db,['recruiter']),app=Fastify();
  app.decorateRequest('actor',null);app.addHook('preHandler',async req=>{req.actor=recruiter;});
  referralRoutes(app,f.identity);await app.ready();t.after(()=>app.close());
  const created=await app.inject({method:'POST',url:'/api/v4/referrals',payload:{...input,referrerName:'Synthetic referrer',grade:'初级'}});
  assert.equal(created.statusCode,200,created.body);
  await new RecruitingService(f.identity).createCandidate(f.admin,{name:input.candidateName,phone:input.candidatePhone});
  return {...f,app,recruiter};
}
const check=(f:any,payload:any=input)=>f.app.inject({method:'POST',url:'/api/v4/referrals/check',payload});
async function changeField(f:any,entity:string,key:string,change:(field:any)=>any){
  const current=await f.configs.effective(f.admin,entity),doc:any=await f.configs.version(f.admin,current.ref);
  await publishDefinition(f,{...doc,fields:doc.fields.map((field:any)=>field.coreKey===key?change(field):field)});
}

test('referral checks retain authorized duplicate and existing-candidate results',async t=>{
  const f=await fixture(t),response=await check(f);
  assert.equal(response.statusCode,200,response.body);assert.equal(response.json().duplicateCount,1);
  assert.ok(response.json().flags.some((flag:any)=>flag.code==='existing_candidate'));
});

for(const [entity,key] of [['lead','name'],['lead','contact'],['lead','direction'],['resume','name'],['resume','phone'],['job','name']])
test('referral checks reject probing hidden '+entity+'.'+key,async t=>{
  const f=await fixture(t);
  assert.equal((await check(f)).statusCode,200);
  await changeField(f,entity,key,field=>({...field,access:{...field.access,read:['admin'],write:['admin'],export:['admin']}}));
  const response=await check(f);assert.equal(response.statusCode,403,response.body);assert.match(response.body,/field_query_forbidden/);
  assert.equal(response.json().duplicateCount,undefined);assert.equal(response.json().flags,undefined);
});

test('referral checks reject conditional or unsearchable inputs but do not require unused fields',async t=>{
  const f=await fixture(t);
  await changeField(f,'resume','phone',field=>({...field,searchable:false}));
  const denied=await check(f);assert.equal(denied.statusCode,403,denied.body);
  const nameOnly=await check(f,{candidateName:input.candidateName});assert.equal(nameOnly.statusCode,200,nameOnly.body);
  assert.ok(nameOnly.json().flags.some((flag:any)=>flag.code==='existing_candidate'));
  await changeField(f,'resume','phone',field=>({...field,searchable:true,visibleWhen:{fieldId:'core.resume.location',op:'eq',value:'Visible location'}}));
  const conditional=await check(f);assert.equal(conditional.statusCode,409,conditional.body);assert.match(conditional.body,/configured_query_required/);
});
