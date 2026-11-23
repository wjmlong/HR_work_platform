import {z,parse} from '../http/validation.js';
import {fail} from '../http/errors.js';
import {compareProfile,type Requirements} from '../parsing/match.js';
import {termRanges,type Parsed,type Evidence} from '../parsing/profile.js';
import type {HumanCorrection} from '../parsing/corrections.js';
import type {DefinitionRef} from './types.js';
const id=z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/),text=z.string().trim().min(1).max(300);
const leafSchema=z.object({id,type:z.literal('skill'),skill:text,required:z.boolean().default(false),note:z.string().max(2000).default('')}).strict();
const subGroupSchema=z.object({id,label:text,mode:z.enum(['all','any']),required:z.boolean().default(false),note:z.string().max(2000).default(''),items:z.array(leafSchema).min(1).max(50)}).strict();
const groupSchema=subGroupSchema.extend({weight:z.number().finite().min(0).max(100),items:z.array(z.union([leafSchema,subGroupSchema])).min(1).max(50)}).strict();
export const matchDocumentSchema=z.object({kind:z.literal('match'),entity:z.literal('job'),key:id,label:text,description:z.string().max(3000).default(''),mode:z.enum(['prd_compat','custom']),weights:z.object({skills:z.number().int().min(0).max(100),experience:z.number().int().min(0).max(100),education:z.number().int().min(0).max(100)}).strict(),thresholds:z.object({green:z.number().finite().min(0).max(100),orange:z.number().finite().min(0).max(100)}).strict(),groups:z.array(groupSchema).max(30)}).strict();
export type MatchTemplate=z.infer<typeof matchDocumentSchema>;
export type DictionarySnapshot={ref:DefinitionRef;aliases:Record<string,string>;labels?:Record<string,string>};
type Leaf=z.infer<typeof leafSchema>;type SubGroup=z.infer<typeof subGroupSchema>;type Group=z.infer<typeof groupSchema>;
export const CONFIGURED_ALGORITHM='professional-config-1.0.0';
export function defaultMatchTemplate():MatchTemplate{return {kind:'match',entity:'job',key:'match.prd_default',label:'PRD 默认专业对照',description:'保留 60/25/15、42/13/12 基线、低一档扣 8 和 75/50 阈值；仅供人工参考。',mode:'prd_compat',weights:{skills:60,experience:25,education:15},thresholds:{green:75,orange:50},groups:[]};}
const leaves=(node:Group|SubGroup):Leaf[]=>node.items.flatMap(item=>'skill'in item?[item]:leaves(item));
export function validateMatchTemplate(input:unknown):MatchTemplate{
 const t=parse(matchDocumentSchema,input),sum=Object.values(t.weights).reduce((a,b)=>a+b,0);
 if(Math.abs(sum-100)>1e-8)fail(422,'match_weight_sum');if(t.thresholds.green<=t.thresholds.orange)fail(422,'match_threshold_order');
 if(t.mode==='prd_compat'){const d=defaultMatchTemplate();if(t.key!==d.key||JSON.stringify(t.weights)!==JSON.stringify(d.weights)||JSON.stringify(t.thresholds)!==JSON.stringify(d.thresholds)||t.groups.length)fail(422,'prd_default_immutable');}
 if(t.groups.length&&t.weights.skills>0&&t.groups.every(g=>g.weight===0))fail(422,'match_group_weight');
 const ids=new Set<string>();
 const walk=(node:Group|SubGroup|Leaf)=>{if(ids.has(node.id))fail(422,'match_duplicate_id');ids.add(node.id);if('skill'in node){if(/^(?:(?:age|gender|sex|salary|expectedSalary|expectedCompensation|customField)$|core\.|custom\.)/i.test(node.skill)||/^(?:年龄|性别|期望薪酬|期望薪资|期望年包)$/.test(node.skill))fail(422,'match_source_forbidden');return;}
  const direct=(node.items as (Leaf|SubGroup)[]).filter((item):item is Leaf=>'skill'in item).map(l=>l.skill.toLocaleLowerCase());if(new Set(direct).size!==direct.length)fail(422,'match_duplicate_condition');node.items.forEach(walk);
 };t.groups.forEach(walk);return t;
}
type GroupResult={id:string;label:string;mode:'all'|'any';weight?:number;required:boolean;note:string;value:number;satisfied:boolean;allSatisfied:boolean;provisional:boolean;items:(GroupResult|{id:string;skill:string;label:string;method:string;reason:string;status:string;value:number;satisfied:boolean;provisional:boolean;evidence:Evidence[];assertions:HumanCorrection[]})[]};
type SkillExplanation={label:string;method:string;reason:string};
// 每条技能的判定依据：字典里 option_xxx 是内部标识，label 才是给人看的技能名。
// method 说明解析方式，reason 说明为什么判为命中/未命中，两者都不参与计分。
function explainSkill(key:string,skill:{status:string;evidence:Evidence[];assertions:HumanCorrection[]},dictionary:DictionarySnapshot):SkillExplanation{
 const label=dictionary.labels?.[key]||key;
 const aliases=Object.entries(dictionary.aliases).filter(([,canonical])=>canonical===key).map(([alias])=>alias).filter(a=>a!==key.toLocaleLowerCase()&&a!==label.toLocaleLowerCase()).slice(0,4);
 const human=skill.assertions?.length?skill.assertions[skill.assertions.length-1]:null;
 if(human)return {label,method:'人工核对',reason:'由招聘同事人工核对补录：'+human.reason};
 if(skill.status==='unknown')return {label,method:'无法判定',reason:'简历原文为空或未解析，缺少判定依据'};
 const hit=skill.evidence?.[0];
 if(skill.status==='matched'&&hit){
  const text=hit.text.trim(),alias=text.toLocaleLowerCase()!==key.toLocaleLowerCase()&&text.toLocaleLowerCase()!==label.toLocaleLowerCase();
  return {label,method:alias?'词典别名命中':'原文关键词命中',reason:'简历原文第 '+hit.line+' 行出现「'+text+'」'+(alias?'，按技能词典归入「'+label+'」':'')+(aliases.length?'；已登记别名：'+aliases.join('、'):'')};
 }
 return {label,method:'原文检索无命中',reason:'简历原文未出现「'+label+'」'+(aliases.length?'及其词典别名（'+aliases.join('、')+'）':'')+'，判为未命中；未命中不等于不具备'};
}
function provenParsed(parsed:Parsed,raw:string,dictionary:DictionarySnapshot,skills:string[]){
 const assertions=((parsed as Parsed&{assertions?:HumanCorrection[]}).assertions||[]).filter(a=>a.actorId&&a.reason.trim()&&Number.isFinite(new Date(a.at).getTime()));
 const has=(fields:string[])=>assertions.some(a=>fields.includes(a.field));
 const valid=(e:Evidence)=>Number.isInteger(e.start)&&Number.isInteger(e.end)&&e.start>=0&&e.end>e.start&&e.end<=raw.length&&raw.slice(e.start,e.end)===e.text;
 const evidence=parsed.evidence.filter(e=>valid(e)&&!e.field.startsWith('skill:'));
 const profile=structuredClone(parsed.profile),canonical=new Map(Object.entries(dictionary.aliases).map(([alias,name])=>[alias.toLocaleLowerCase(),name]));
 for(const name of Object.values(dictionary.aliases))canonical.set(name.toLocaleLowerCase(),name);
 const skillAssertion=assertions.filter(a=>a.field==='skills').at(-1);if(skillAssertion)profile.skills=Array.isArray(skillAssertion.value)?skillAssertion.value.filter((v):v is string=>typeof v==='string').map(s=>canonical.get(s.toLocaleLowerCase())||s):[];
 for(const field of ['experienceYears','education'] as const){const a=assertions.filter(a=>a.field===field).at(-1);if(a)(profile as any)[field]=a.value;}
 if(!has(['experienceYears','firstEmployment'])&&!evidence.some(e=>['experienceYears','firstEmployment'].includes(e.field)))profile.experienceYears=null;
 if(!has(['education'])&&!evidence.some(e=>e.field==='education'))profile.education=null;
 if(profile.experienceYears!==null&&(!Number.isFinite(profile.experienceYears)||profile.experienceYears<0))profile.experienceYears=null;
 for(const skill of skills)if(![...canonical.values()].includes(skill))fail(422,'match_skill_unregistered');
 if(!has(['skills']))for(const skill of skills){const aliases=[skill,...Object.entries(dictionary.aliases).filter(([,name])=>name===skill).map(([alias])=>alias)];for(const alias of new Set(aliases))for(const span of termRanges(raw,alias))evidence.push({id:'configured:'+skill+':'+span.start+':'+span.end,field:'skill:'+skill,...span,line:raw.slice(0,span.start).split('\n').length,text:raw.slice(span.start,span.end)});}
 return {...parsed,profile,evidence,assertions};
}
export function compareConfiguredProfile(parsed:Parsed,raw:string,job:Requirements,template:MatchTemplate&{ref?:DefinitionRef},dictionary:DictionarySnapshot){
 const {ref:templateRef,...wire}=template,t=validateMatchTemplate(wire),refs={template:templateRef||null,dictionary:dictionary.ref};
 if(t.mode==='prd_compat')return {...compareProfile(parsed,raw,job),configurationRefs:refs,groups:[] as GroupResult[],duplicateSkills:[] as string[],weights:t.weights};
 const entries=t.groups.flatMap(leaves),names=[...new Set(entries.map(l=>l.skill))],verified=provenParsed(parsed,raw,dictionary,names),base=compareProfile(verified,raw,{...job,skills:names});
 const explained=base.skills.map(s=>({...s,...explainSkill(s.requirement,s,dictionary)}));
 const byName=new Map(explained.map(s=>[s.requirement,s]));
 const group=(g:Group|SubGroup):GroupResult=>{const items=g.items.map(item=>{if(!('skill'in item))return group(item);const s=byName.get(item.skill)!;return {id:item.id,skill:item.skill,label:s.label,method:s.method,reason:s.reason,status:s.status,value:s.status==='matched'?1:0,satisfied:s.status==='matched',provisional:s.status==='unknown',evidence:s.evidence,assertions:s.assertions};}),allSatisfied=items.every(x=>x.satisfied),satisfied=g.mode==='any'?items.some(x=>x.satisfied):allSatisfied;
 // 按命中程度计分：any 与 all 统一采用组内命中比例，命中 3/5 即计 60%。
 // 未识别 / 不适用的条目不计入分母，避免把「简历没读到」当成「不具备」而压低分数。
 const countable=items.filter(x=>!('status'in x)||(x.status!=='unknown'&&x.status!=='not_applicable')),denominator=countable.length||items.length||1;
 const degree=countable.reduce((sum,x)=>sum+x.value,0)/denominator;
 return {id:g.id,label:g.label,mode:g.mode,...('weight'in g?{weight:g.weight}:{}),required:g.required,note:g.note,value:degree,satisfied,allSatisfied,provisional:items.some(x=>x.provisional),items};};
 const groups=t.groups.map(group),groupWeight=t.groups.reduce((sum,g)=>sum+g.weight,0);
 const hasSkillRules=groups.length>0&&groupWeight>0;
 const skillRatio=hasSkillRules?groups.reduce((sum,g,i)=>sum+g.value*t.groups[i].weight,0)/groupWeight:null;
 const skillPoints=t.weights.skills===0?0:(skillRatio===null?null:Math.round(t.weights.skills*skillRatio));
 const years=verified.profile.experienceYears,min=job.experienceYears??null;
 const experiencePoints=t.weights.experience===0?0:years===null?null:min===null||min<5?t.weights.experience:years<min?Math.round(t.weights.experience*Math.min(1,years/Math.max(min,1))):Math.round(t.weights.experience*(years>=12?1:years>=8?0.8:0.6));
 const rank:Record<string,number>={none:0,secondary:0,associate:1,bachelor:2,master:3,doctor:4},required=job.education&&job.education!=='none'?job.education:null,actual=verified.profile.education,actualRank=actual===null?undefined:rank[actual],requiredRank=required===null?undefined:rank[required];
 if(required!==null&&requiredRank===undefined)fail(422,'match_education_unknown');
 const educationPoints=Math.round(!required?t.weights.education*12/15:actualRank===undefined?0:Math.max(0,t.weights.education-Math.max(0,requiredRank!-actualRank)*t.weights.education*8/15));
 const unknownFields=[...(t.weights.skills>0&&groups.some(g=>g.provisional)?['skills']:[]),...(t.weights.experience>0&&years===null?['experienceYears']:[]),...(t.weights.education>0&&required&&actualRank===undefined?['education']:[])],unscoredDimensions=[...(skillPoints===null?['skills']:[]),...(experiencePoints===null?['experience']:[])],value=[skillPoints,experiencePoints,educationPoints].reduce<number>((sum,part)=>sum+(part??0),0);
 const duplicateSkills=names.filter(name=>entries.filter(l=>l.skill===name).length>1);
 const hints=groups.filter(g=>g.required&&!g.satisfied).map(g=>({field:'skills',text:'必备技能组“'+g.label+'”尚未满足，请人工核对证据',evidence:base.skills.flatMap(s=>s.evidence)}));
 for(const entry of entries)if(entry.required&&byName.get(entry.skill)!.status!=='matched')hints.push({field:'skills',text:'必备核对项“'+entry.skill+'”缺少命中依据，请人工核对',evidence:byName.get(entry.skill)!.evidence});
 // 未识别计数把「未评分维度」也算进去，避免明细顶部长期显示「未识别 0」。
 const pendingFields=[...new Set([...unknownFields,...unscoredDimensions.map(k=>k==='skills'?'skills':k==='experience'?'experienceYears':'education')])];
 const baseUnknown:string[]=(base.score as any).unknownFields||[];
 const summary={...base.summary,unknown:base.summary.unknown+pendingFields.filter(f=>!baseUnknown.includes(f)).length,pendingFields};
 return {...base,skills:explained,summary,algorithmVersion:CONFIGURED_ALGORITHM,configurationRefs:refs,groups,duplicateSkills,weights:t.weights,skillPoints,experience:{...base.experience,points:experiencePoints as number},education:{...base.education,status:required&&actualRank===undefined?'unknown' as const:base.education.status,points:educationPoints},
  score:{...base.score,value,lower:value,upper:value,provisional:unknownFields.length>0||unscoredDimensions.length>0,unknownFields,unscoredDimensions,color:unscoredDimensions.length?'orange':value>=t.thresholds.green?'green':value>=t.thresholds.orange?'orange':'red',baselines:{skills:!hasSkillRules&&t.weights.skills>0?'unscored':null,experience:years===null?'unscored':null,education:!required?educationPoints:null},formula:'custom_weighted_skill_groups_experience_education',zeroWeightDimensions:Object.entries(t.weights).filter(([,w])=>w===0).map(([name])=>name)},
  hardGateHints:[...base.hardGateHints,...hints],warnings:[...base.warnings,...duplicateSkills.map(s=>'技能“'+s+'”跨组重复计权，请核对')],statement:'自定义规则版本，区别于原 PRD 默认口径。专业条件及必备项仅供人工核对，不自动淘汰、推进流程或生成录用决定。'};
}
