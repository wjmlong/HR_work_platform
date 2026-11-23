import test from 'node:test';
import assert from 'node:assert/strict';
import {maskScreeningContacts,screeningOnly} from '../src/business-config/screening-mask.js';
import type {Actor} from '../src/identity/service.js';

const actor=(roles:string[],screeningScope?:string[])=>(
 {id:'u1',name:'合成员工',roles,status:'active',version:1,csrf:'c',open_id:'ou_x',screeningScope} as unknown as Actor
);

test('a screening-only grant masks structured contacts without hiding the rest of the resume',()=>{
 const profile={name:'张三',phone:'13800000000',email:'zhang@example.com',school:'某大学',experienceYears:6};
 assert.deepEqual(maskScreeningContacts(actor(['viewer'],['job-1']),profile),{...profile,phone:'***',email:'***'});
});

test('permanent writers keep contacts even when they also hold a screening grant',()=>{
 const profile={name:'张三',phone:'13800000000',email:'zhang@example.com'};
 for(const role of ['admin','manager','recruiter'])
  assert.deepEqual(maskScreeningContacts(actor([role],['job-1']),profile),profile);
});

test('viewers without an active grant are untouched here and stay governed by field permissions',()=>{
 const profile={name:'张三',phone:'13800000000'};
 assert.equal(screeningOnly(actor(['viewer'],[])),false);
 assert.deepEqual(maskScreeningContacts(actor(['viewer'],[]),profile),profile);
});

test('empty contacts stay empty instead of implying the value was recorded',()=>{
 assert.deepEqual(maskScreeningContacts(actor(['viewer'],['job-1']),{name:'张三',phone:'',email:null}),{name:'张三',phone:'',email:null});
});
