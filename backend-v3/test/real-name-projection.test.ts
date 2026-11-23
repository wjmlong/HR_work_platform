import test from 'node:test';
import assert from 'node:assert/strict';
import {configFixture,publishDefinition} from './business-config-fixture.js';
import {ConfiguredRecruiting} from '../src/business-config/recruiting.js';
import {RecruitingService} from '../src/recruiting/service.js';
import {loadDefinition} from '../src/business-config/fields.js';
import {projectLegacyCore} from '../src/business-config/legacy-fields.js';
test('real names inherit name visibility across personnel profiles, history and legacy lists',async t=>{
 const f=await configFixture(t),r=new RecruitingService(f.identity),c=new ConfiguredRecruiting(f.identity);
 const person=await r.createCandidate(f.admin,{name:'Synthetic alias',realName:'Synthetic legal name'});
 const current=await f.configs.effective(f.admin,'resume'),doc=await f.configs.version(f.admin,current.ref);
 const name=doc.fields.find((x:any)=>x.coreKey==='name');name.access={...name.access,read:['manager'],write:['manager'],export:['manager']};
 await publishDefinition(f,doc);
 const shown=await c.person(f.admin,person.id);assert.equal(shown.profile.realName,undefined);assert.ok(shown.history.every((h:any)=>h.profile.realName===undefined));
 const def=await loadDefinition(f.identity,'resume',f.db.sql,f.admin);
 assert.equal(projectLegacyCore(def,f.admin,{name:'Synthetic alias',realName:'Synthetic legal name'}).realName,undefined);
 await assert.rejects(c.candidate(f.admin,person.id,{version:person.version,profile:{realName:'Cannot change'},definitionVersion:def.ref.version,definitionRevision:def.aclRevision}),/field_forbidden/);
});
