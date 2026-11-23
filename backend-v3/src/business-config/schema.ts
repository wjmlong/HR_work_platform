import {checklistDocumentSchema,ccDocumentSchema,validateChecklistTemplate,validateCcTemplate} from './checklist-template.js';
import {evaluationDocumentSchema,validateEvaluationTemplate} from './evaluation-template.js';
import {questionDocumentSchema,validateQuestionTemplate} from './question-template.js';
import {z,parse,uuid} from '../http/validation.js';
import {fail} from '../http/errors.js';
import type {Condition,ConfigDocument} from './types.js';
import {conditionMatches,validateValue} from './field-validation.js';
import {matchDocumentSchema,validateMatchTemplate} from './match-template.js';
export const entityKind=z.enum(['job','resume','application','interview','evaluation','lead','campus']);
const key=z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,99}$/);
const label=z.string().trim().min(1).max(300);
const role=z.enum(['admin','manager','recruiter','interviewer','viewer']);
const roles=z.array(role).max(5);
export const optionSchema=z.object({id:z.string().trim().min(1).max(300).regex(/^[^\u0000-\u001f\u007f]+$/),label,aliases:z.array(z.string().trim().min(1).max(100)).max(100).default([]),active:z.boolean().default(true),order:z.number().int().min(0).max(10000).default(0),rank:z.number().int().min(0).max(100).optional(),coreCode:key.optional(),category:z.string().max(300).optional()}).strict();
const scalar=z.union([z.string().max(1000),z.number().finite(),z.boolean(),z.null(),z.array(z.union([z.string().max(1000),z.number().finite()])).max(100)]);
function conditionSchema(depth:number):z.ZodType<Condition>{
 const leaf=z.object({fieldId:key,op:z.enum(['eq','contains','range','empty','not_empty']),value:scalar.optional()}).strict();
 return depth===5?leaf:z.union([leaf,z.object({mode:z.enum(['all','any']),rules:z.array(conditionSchema(depth+1)).min(1).max(20)}).strict()]);
}
const condition=conditionSchema(0);
export const fieldSchema=z.object({
 fieldId:key,coreKey:z.string().max(100).optional(),type:z.enum(['text','longtext','number','date','datetime','select','multiselect','boolean','money','money_range']),label,
 active:z.boolean().default(true),required:z.boolean().default(false),order:z.number().int().min(0).max(10000).default(0),group:z.string().max(300).default('补充信息'),system:z.boolean().default(false),
 description:z.string().max(2000).default(''),placeholder:z.string().max(500).default(''),unit:z.string().max(50).default(''),defaultValue:z.unknown().optional(),
 constraints:z.object({min:z.number().finite().optional(),max:z.number().finite().optional(),precision:z.number().int().min(0).max(10).optional(),maxLength:z.number().int().min(1).max(100000).optional()}).strict().default({}),
 options:z.array(optionSchema).max(500).default([]),dictionaryKey:key.optional(),visibleWhen:condition.optional(),requiredWhen:condition.optional(),
 access:z.object({read:roles.default(['admin','manager','recruiter','interviewer','viewer']),write:roles.default(['admin','manager','recruiter']),export:roles.default(['admin','manager','recruiter']),sensitivity:z.enum(['general','private','salary']).default('general'),public:z.boolean().default(false)}).strict().default({read:['admin','manager','recruiter','interviewer','viewer'],write:['admin','manager','recruiter'],export:['admin','manager','recruiter'],sensitivity:'general',public:false}),
 searchable:z.boolean().default(true),sortable:z.boolean().default(true),
}).strict();
export const configDocumentSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('fields'),entity:entityKind,fields:z.array(fieldSchema).max(150)}).strict(),
 z.object({kind:z.literal('dictionary'),entity:entityKind,key,options:z.array(optionSchema).max(500)}).strict(),
 matchDocumentSchema,questionDocumentSchema,evaluationDocumentSchema,checklistDocumentSchema,ccDocumentSchema,
]);
export const draftRequest=z.object({key,baseVersion:z.number().int().min(0),document:configDocumentSchema,draftId:uuid.optional(),draftVersion:z.number().int().positive().optional()}).strict();
export const publishRequest=z.object({draftId:uuid,draftVersion:z.number().int().positive(),baseVersion:z.number().int().min(0),actorId:uuid,inputHash:z.string().regex(/^[a-f0-9]{64}$/),impactHash:z.string().regex(/^[a-f0-9]{64}$/),signature:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export function validateDocument(input:unknown):ConfigDocument {
 const doc=parse(configDocumentSchema,input);
 if(doc.kind==='checklist')return validateChecklistTemplate(doc);
 if(doc.kind==='cc')return validateCcTemplate(doc);
 if(doc.kind==='evaluation')return validateEvaluationTemplate(doc);
 if(doc.kind==='questions')return validateQuestionTemplate(doc);
 if(doc.kind==='match')return validateMatchTemplate(doc);
 const checkOptions=(options:z.infer<typeof optionSchema>[])=>{
  if(new Set(options.map(o=>o.id)).size!==options.length||new Set(options.filter(o=>o.active).map(o=>o.label.toLocaleLowerCase())).size!==options.filter(o=>o.active).length)fail(422,'duplicate_option');
  const names=new Map<string,string>();for(const o of options.filter(o=>o.active))for(const name of [o.id,o.label,...o.aliases]){const key=name.trim().toLocaleLowerCase(),owner=names.get(key);if(owner!==undefined&&owner!==o.id)fail(409,'alias_conflict');names.set(key,o.id);}
 };
 if(doc.kind==='dictionary'){checkOptions(doc.options);return doc;}
 if(new Set(doc.fields.map(f=>f.fieldId)).size!==doc.fields.length)fail(422,'duplicate_field');
 if(new Set(doc.fields.filter(f=>f.active).map(f=>f.label)).size!==doc.fields.filter(f=>f.active).length)fail(422,'duplicate_field_label:'+doc.fields.find((f,i)=>f.active&&doc.fields.slice(0,i).some(p=>p.active&&p.label===f.label))!.fieldId);
 const ids=new Set(doc.fields.map(f=>f.fieldId)),edges=new Map<string,string[]>();
 const dependencies=(c:Condition,depth=0):string[]=>{if(depth>5)fail(422,'condition_too_deep');return 'rules'in c?c.rules.flatMap(r=>dependencies(r,depth+1)):[c.fieldId];};
 for(const f of doc.fields){
  if(/(?:^|[_. -])(?:password|passwd|account|username|credentials?|(?:client|app|api)[_. -]?secret|(?:access|api)[_. -]?(?:token|key))(?:$|[_. -])/i.test(f.fieldId)||/(?:账号|账户|登录名|密码|口令|访问令牌|访问密钥|API密钥|应用密钥|客户端密钥|凭证)$/i.test(f.label.trim()))fail(422,'credential_field_forbidden:'+f.fieldId);
  try{checkOptions(f.options);}catch(e){if((e as any).statusCode)fail((e as any).statusCode,(e as any).code+':'+f.fieldId);throw e;}
  if(f.constraints.min!==undefined&&f.constraints.max!==undefined&&f.constraints.min>f.constraints.max)fail(422,'field_range_invalid:'+f.fieldId);
  if(!f.active&&(f.required||f.requiredWhen))fail(422,'hidden_field_required:'+f.fieldId);
  if(f.access.sensitivity==='salary'&&f.access.public)fail(422,'salary_permission_ceiling:'+f.fieldId);
  if(f.defaultValue!==undefined)validateValue(f,f.defaultValue,undefined);
  const deps=[...(f.visibleWhen?dependencies(f.visibleWhen):[]),...(f.requiredWhen?dependencies(f.requiredWhen):[])];
  if(deps.some(id=>!ids.has(id)))fail(422,'condition_field_unknown:'+f.fieldId);edges.set(f.fieldId,deps);
  if(deps.some(id=>f.access.read.some(role=>!doc.fields.find(dep=>dep.fieldId===id)!.access.read.includes(role))))fail(422,'condition_permission_dependency:'+f.fieldId);
  if(deps.some(id=>{const dep=doc.fields.find(dep=>dep.fieldId===id)!;return !dep.active||dep.access.sensitivity==='salary'&&f.access.sensitivity!=='salary'&&f.access.read.some(r=>!['admin','manager','recruiter'].includes(r));}))fail(422,'condition_permission_dependency:'+f.fieldId);
 }
 const checkCondition=(c:Condition):void=>{
  if('rules'in c){
   c.rules.forEach(checkCondition);
   if(c.mode==='all'){
    const leaves=(r:Condition):Condition[]=>'rules'in r&&r.mode==='all'?r.rules.flatMap(leaves):[r];
    const flat=c.rules.flatMap(leaves).filter((r):r is Extract<Condition,{fieldId:string}>=>'fieldId'in r);
    for(const id of new Set(flat.map(p=>p.fieldId))){
     const group=flat.filter(p=>p.fieldId===id),equals=group.filter(p=>p.op==='eq');
     if(new Set(equals.map(p=>JSON.stringify(p.value))).size>1)fail(422,'condition_unsatisfiable');
     if(group.some(p=>p.op==='empty')&&group.some(p=>p.op==='not_empty'))fail(422,'condition_unsatisfiable');
     if(equals.length&&group.some(p=>!conditionMatches(p,{[id]:equals[0].value})))fail(422,'condition_unsatisfiable');
     const ranges=group.filter(p=>p.op==='range').map(p=>p.value as [number,number]|[string,string]);
     for(const a of ranges)for(const b of ranges)if(a[0]>b[1]||b[0]>a[1])fail(422,'condition_unsatisfiable');
    }
   }return;
  }
  const field=doc.fields.find(f=>f.fieldId===c.fieldId)!;
  if(['empty','not_empty'].includes(c.op)){if(c.value!==undefined)fail(422,'condition_invalid');return;}
  if(c.value===undefined)fail(422,'condition_invalid');
  if(c.op==='range'){
   if(!['number','date','datetime'].includes(field.type)||!Array.isArray(c.value)||c.value.length!==2||typeof c.value[0]!==typeof c.value[1]||c.value[0]>c.value[1]||field.type==='number'&&typeof c.value[0]!=='number'||field.type!=='number'&&typeof c.value[0]!=='string')fail(422,'condition_invalid');
  }else if(c.op==='contains'){
   if(!['text','longtext','select','multiselect'].includes(field.type)||typeof c.value!=='string')fail(422,'condition_invalid');
  }else if(Array.isArray(c.value)||field.type==='number'&&typeof c.value!=='number'||field.type==='boolean'&&typeof c.value!=='boolean')fail(422,'condition_invalid');
 };
 for(const f of doc.fields){if(f.visibleWhen)checkCondition(f.visibleWhen);if(f.requiredWhen)checkCondition(f.requiredWhen);}
 const visiting=new Set<string>(),visited=new Set<string>();
 const visit=(id:string)=>{if(visiting.has(id))fail(422,'condition_cycle:'+id);if(visited.has(id))return;visiting.add(id);for(const d of edges.get(id)||[])visit(d);visiting.delete(id);visited.add(id);};
 for(const id of ids)visit(id);
 return doc;
}
