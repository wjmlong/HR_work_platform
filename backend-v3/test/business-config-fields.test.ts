import {fieldSchema} from '../src/business-config/schema.js';
import {validateValue} from '../src/business-config/field-validation.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {configFixture,fieldDefinition,publishDefinition} from './business-config-fixture.js';
import {actor} from './helpers.js';
import {Database} from '../src/db.js';
import {validateDocument} from '../src/business-config/schema.js';
import {validateFieldValues,writeFieldValues,readFieldValues,projectFieldValues} from '../src/business-config/fields.js';
import {Commands} from '../src/http/commands.js';
import {assertFilterField} from '../src/business-config/access.js';
import type {EffectiveDefinition} from '../src/business-config/types.js';

function definition(fields:any[]):EffectiveDefinition{
 const doc=validateDocument({kind:'fields',entity:'job',fields});
 assert.equal(doc.kind,'fields');
 return {entity:'job',ref:{configId:'11111111-1111-4111-8111-111111111111',version:1},fields:(doc as any).fields,aclRevision:'test'};
}
test('field types preserve false zero dates and Unicode, validate precision and conditionally required values',()=>{
 const def=definition([
  fieldDefinition({fieldId:'text',label:'说明',constraints:{maxLength:4}}),
  fieldDefinition({fieldId:'n',label:'数量',type:'number',constraints:{min:0,max:10,precision:1}}),
  fieldDefinition({fieldId:'d',label:'日期',type:'date'}),
  fieldDefinition({fieldId:'b',label:'开关',type:'boolean',required:true}),
  fieldDefinition({fieldId:'o',label:'选项',type:'select',options:[{id:'old',label:'旧项',active:false},{id:'new',label:'新项'}]}),
  fieldDefinition({fieldId:'why',label:'补充说明',requiredWhen:{fieldId:'b',op:'eq',value:true}}),
 ]);
 assert.deepEqual(validateFieldValues(def,{text:'🧪甲',n:0,d:'2026-10-21',b:false,o:'old'},{o:'old'},'edit'),{text:'🧪甲',n:0,d:'2026-10-21',b:false,o:'old'});
 for(const input of [{n:-1,b:false},{n:1.25,b:false},{d:'2026-02-30',b:false},{b:true},{o:'old',b:false},{x:'unknown',b:false},{text:'a\0b',b:false}])assert.throws(()=>validateFieldValues(def,input,{},'create'),/field_/);
 assert.equal(validateFieldValues(def,{n:1.1,b:true,why:'已核对'}, {},'create').n,1.1);
 assert.equal(validateFieldValues(def,{b:true},{},'draft').b,true);
});

test('field configuration rejects cycles, impossible ranges, hidden required fields and permission-dependent visibility',()=>{
 for(const fields of [
  [fieldDefinition({fieldId:'a',visibleWhen:{fieldId:'b',op:'eq',value:1}}),fieldDefinition({fieldId:'b',label:'B',visibleWhen:{fieldId:'a',op:'empty'}})],
  [fieldDefinition({required:true,active:false})],
  [fieldDefinition({type:'number',constraints:{min:3,max:2}})],
  [fieldDefinition({fieldId:'private',label:'私有',access:{read:['admin']}}),fieldDefinition({fieldId:'public',label:'公开',visibleWhen:{fieldId:'private',op:'not_empty'}})],
  [fieldDefinition({fieldId:'number',label:'数值',type:'number'}),fieldDefinition({fieldId:'target',label:'条件项',visibleWhen:{fieldId:'number',op:'range',value:[10,1]}})],
  [fieldDefinition({fieldId:'flag',label:'标志',type:'boolean'}),fieldDefinition({fieldId:'target',label:'条件项',requiredWhen:{mode:'all',rules:[{fieldId:'flag',op:'eq',value:true},{fieldId:'flag',op:'eq',value:false}]}})],
  [fieldDefinition({fieldId:'number',label:'数值',type:'number'}),fieldDefinition({fieldId:'target',label:'条件项',visibleWhen:{fieldId:'number',op:'eq'}})],
  [fieldDefinition({fieldId:'salary',label:'薪酬',access:{sensitivity:'salary'}}),fieldDefinition({fieldId:'target',label:'条件项',visibleWhen:{fieldId:'salary',op:'not_empty'}})],
 ])assert.throws(()=>definition(fields),/condition_|field_|hidden_/);
 let condition:any={fieldId:'a',op:'empty'};for(let n=0;n<20;n++)condition={mode:'all',rules:[condition]};
 assert.throws(()=>definition([fieldDefinition({fieldId:'a',visibleWhen:condition})]),/invalid_input|condition_/);
});

test('datetime fields reject calendar rollover instead of silently changing the user-entered date',()=>{
 const def=definition([fieldDefinition({fieldId:'when',type:'datetime',label:'约定时间'})]);
 assert.equal(validateFieldValues(def,{when:'2028-02-29T12:30:00+08:00'},{},'create').when,'2028-02-29T04:30:00.000Z');
 for(const when of ['2026-02-30T12:00:00Z','2026-12-31T24:00:00Z','0000-01-01T00:00:00Z'])assert.throws(()=>validateFieldValues(def,{when},{},'create'),/field_invalid/);
});

test('field_types_conditions_history: SQL reads obey current definitions, history stays immutable and stale forms fail',async t=>{
 const f=await configFixture(t),current=await f.configs.effective(f.admin,'job');
 const base=await f.configs.version(f.admin,current.ref);assert.equal(base.kind,'fields');
 const ref=await publishDefinition(f,{...base,fields:[...(base as any).fields,fieldDefinition({fieldId:'custom.count',type:'number',label:'补充数量'}),fieldDefinition({fieldId:'custom.private',label:'私有核对',access:{read:['admin'],write:['admin'],export:['admin']}})]});
 const job=(await f.db.query("INSERT INTO jobs(name) VALUES('Synthetic custom fields') RETURNING id")).rows[0],object={kind:'job' as const,id:job.id};
 await f.db.tx(c=>writeFieldValues(f.identity,f.admin,object,{definitionVersion:ref.version,customFields:{'custom.count':0,'custom.private':'Synthetic private'}},c));
 assert.deepEqual(await readFieldValues(f.identity,f.admin,object,f.db.sql),{'custom.count':0,'custom.private':'Synthetic private'});
 const manager=await actor(f.db,['manager']);
 assert.deepEqual(await readFieldValues(f.identity,manager,object,f.db.sql),{'custom.count':0});
 await assert.rejects(writeFieldValues(f.identity,manager,object,{definitionVersion:ref.version,customFields:{'custom.private':'Not allowed'}},f.db.sql),/field_forbidden/);
 const old=(await f.db.query('SELECT * FROM custom_field_value_versions ORDER BY field_id,version')).rows;
 const latest=await f.configs.version(f.admin,ref);assert.equal(latest.kind,'fields');
 const renamed={...latest,fields:(latest as any).fields.map((x:any)=>x.fieldId==='custom.count'?{...x,label:'新的数量名称'}:x)};
 await publishDefinition(f,renamed);
 await assert.rejects(writeFieldValues(f.identity,f.admin,object,{definitionVersion:ref.version,customFields:{'custom.count':3}},f.db.sql),/configuration_changed/);
 assert.deepEqual((await f.db.query('SELECT * FROM custom_field_value_versions ORDER BY field_id,version')).rows,old);
 await assert.rejects(f.db.query("UPDATE custom_field_value_versions SET value='999'"),/immutable/);
 const db2=new Database(f.config);t.after(()=>db2.close());
 const row=(await db2.query("SELECT number_value FROM custom_field_values WHERE field_id='custom.count'")).rows[0];assert.equal(row.number_value,'0');
});

test('configured money permissions retain salary authorization ceilings even if the display label is changed',async t=>{
 const f=await configFixture(t),current=await f.configs.effective(f.admin,'job'),base:any=await f.configs.version(f.admin,current.ref);
 const salary=base.fields.find((x:any)=>x.coreKey==='salaryRange');
 await assert.rejects(f.configs.saveDraft(f.admin,{key:'fields.job',baseVersion:1,document:{...base,fields:base.fields.map((x:any)=>x.fieldId===salary.fieldId?{...x,access:{...x.access,sensitivity:'general',public:true}}:x)}}),/salary_permission_ceiling/);
 const def=definition([fieldDefinition({fieldId:'salary',label:'已改名的字段',access:{sensitivity:'salary',read:['admin','interviewer'],export:['admin','interviewer']}})]),interviewer=await actor(f.db,['interviewer']);
 assert.deepEqual(projectFieldValues(def,interviewer,{salary:'Synthetic salary'},'read'),{});
 const stranger=await actor(f.db,['viewer']),job=(await f.db.query("INSERT INTO jobs(name) VALUES('Synthetic hidden') RETURNING id")).rows[0];
 await assert.rejects(readFieldValues(f.identity,stranger,{kind:'job',id:job.id},f.db.sql),/forbidden/);
});

test('configuration administrators can maintain definitions without implicitly reading restricted field values',async t=>{
 const f=await configFixture(t),base:any=await f.configs.version(f.admin,(await f.configs.effective(f.admin,'job')).ref);
 const ref=await publishDefinition(f,{...base,fields:[...base.fields,fieldDefinition({fieldId:'custom.managerOnly',label:'部门专用',access:{read:['manager'],write:['manager'],export:['manager']}})]});
 const definition:any=await f.configs.version(f.admin,ref);
 assert.ok(definition.fields.some((x:any)=>x.fieldId==='custom.managerOnly'));
 assert.deepEqual(projectFieldValues({...await f.configs.effective(f.admin,'job'),fields:definition.fields},f.admin,{'custom.managerOnly':'Synthetic departmental note'},'read'),{});
});

test('filter permission guard rejects inaccessible fields before building predicates or counts',async t=>{
 const f=await configFixture(t),manager=await actor(f.db,['manager']);
 const def=definition([fieldDefinition({fieldId:'public',label:'公开'}),fieldDefinition({fieldId:'private',label:'私有',access:{read:['admin']}})]);
 assert.equal(assertFilterField(def,manager,'public').fieldId,'public');
 assert.throws(()=>assertFilterField(def,manager,'private'),e=>(e as any).statusCode===403);
 assert.throws(()=>assertFilterField(def,manager,'not-defined'),e=>(e as any).statusCode===403);
});

test('field_acl_replay_after_publish: configured commands persist receipts and reproject under current permissions',async t=>{
 const f=await configFixture(t),manager=await actor(f.db,['manager']),c=new Commands(f.db);
 const base:any=await f.configs.version(f.admin,(await f.configs.effective(f.admin,'job')).ref);
 await publishDefinition(f,{...base,fields:[...base.fields,fieldDefinition({fieldId:'custom.secret',label:'私有业务信息',access:{read:['admin','manager'],write:['admin'],export:['admin']}})]});
 const object={kind:'job' as const,id:(await f.db.query("INSERT INTO jobs(name) VALUES('Synthetic receipt') RETURNING id")).rows[0].id};
 await writeFieldValues(f.identity,f.admin,object,{definitionVersion:2,customFields:{'custom.secret':'SYNTHETIC_PRIVATE_TEXT'}},f.db.sql);
 const policy={authorize:async()=>{await readFieldValues(f.identity,manager,object,f.db.sql);},toReceipt:()=>({object}),fromReceipt:async()=>readFieldValues(f.identity,manager,object,f.db.sql)};
 const first=await c.run(manager,'configured-replay',{intent:'unchanged'},async()=>({ok:true}),policy as any);
 assert.equal((first as any)['custom.secret'],'SYNTHETIC_PRIVATE_TEXT');
 assert.ok(!JSON.stringify((await f.db.query("SELECT response FROM idempotency_keys WHERE key='configured-replay'")).rows[0]).includes('SYNTHETIC_PRIVATE_TEXT'));
 const doc:any=await f.configs.version(f.admin,(await f.configs.effective(f.admin,'job')).ref);
 await publishDefinition(f,{...doc,fields:doc.fields.map((x:any)=>x.fieldId==='custom.secret'?{...x,access:{...x.access,read:['admin']}}:x)});
 const replay=await c.run(manager,'configured-replay',{intent:'unchanged'},async()=>{throw Error('must not repeat committed operation');},policy as any);
 assert.deepEqual(replay,{});
});

test('core selects retain an exact unknown historical value but never accept a new unknown choice',()=>{
 const field=fieldSchema.parse({fieldId:'core.application.source',coreKey:'source',type:'select',label:'来源',options:[{id:'manual',label:'手动'}]});
 assert.equal(validateValue(field,'historical-import','historical-import'),'historical-import');
 assert.throws(()=>validateValue(field,'new-unregistered','historical-import'),/field_invalid/);
});
