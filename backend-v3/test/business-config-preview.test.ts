import test from 'node:test';import assert from 'node:assert/strict';
import {configFixture,fieldDefinition,publishDefinition} from './business-config-fixture.js';
import {RecruitingService} from '../src/recruiting/service.js';import {writeFieldValues} from '../src/business-config/fields.js';import {SavedViewService} from '../src/business-config/views.js';
test('publication preview reports real required gaps/invalidated views and binds typed-value changes',async t=>{
 const f=await configFixture(t),r=new RecruitingService(f.identity),a=await r.createJob(f.admin,{name:'Synthetic regular',level:'P5'}),b=await r.createJob(f.admin,{name:'Synthetic urgent',level:'P5',urgency:'urgent'}),first=await f.configs.effective(f.admin,'job'),original=await f.configs.version(f.admin,first.ref);
 await publishDefinition(f,{...original,fields:[...original.fields,fieldDefinition(),fieldDefinition({fieldId:'custom.urgentNote',label:'紧急招聘说明',requiredWhen:{fieldId:'core.job.urgency',op:'eq',value:'urgent'}})]});
 const d=await f.configs.effective(f.admin,'job');await writeFieldValues(f.identity,f.admin,{kind:'job',id:b.id},{definitionVersion:d.ref.version,customFields:{'custom.urgentNote':'已核对'}});
 await new SavedViewService(f.identity).save(f.admin,{entity:'job',name:'字段视图',scope:'personal',query:{definitionVersion:d.ref.version,columns:['custom.portfolio'],filters:[],sort:[]}});
 const doc=await f.configs.version(f.admin,d.ref);doc.fields.find((x:any)=>x.fieldId==='custom.portfolio').active=false;
 const draft=await f.configs.saveDraft(f.admin,{key:'fields.job',baseVersion:d.ref.version,document:doc}),preview=await f.configs.preview(f.admin,draft.id);
 assert.equal(preview.analysis.invalidatedViews,1);assert.equal(preview.analysis.required.find((x:any)=>x.fieldId==='custom.urgentNote').missing,0);
 await writeFieldValues(f.identity,f.admin,{kind:'job',id:b.id},{definitionVersion:d.ref.version,customFields:{'custom.urgentNote':null}},undefined,{},'draft');
 await assert.rejects(f.configs.publish(f.admin,preview),/preview_stale/);
 const fresh=await f.configs.preview(f.admin,draft.id);assert.equal(fresh.analysis.required.find((x:any)=>x.fieldId==='custom.urgentNote').missing,1);
});
test('preview does not reveal required-value counts excluded by field ACL',async t=>{
 const f=await configFixture(t),d=await f.configs.effective(f.admin,'job'),doc=await f.configs.version(f.admin,d.ref);doc.fields.push(fieldDefinition({required:true,access:{read:['manager'],write:['manager'],export:['manager']}}));
 const draft=await f.configs.saveDraft(f.admin,{key:'fields.job',baseVersion:d.ref.version,document:doc}),preview=await f.configs.preview(f.admin,draft.id);
 assert.equal(preview.analysis.required.find((x:any)=>x.fieldId==='custom.portfolio').missing,null);
});
