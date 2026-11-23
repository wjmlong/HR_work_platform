import {validateDocument} from './schema.js';
import {createHash} from 'node:crypto';
import type {Database,Sql} from '../db.js';
import {Identity,requireRole,type Actor} from '../identity/service.js';
import {fail,found} from '../http/errors.js';
import {catalog,v4AliasPolicy} from '../dictionary/data.js';
import {leadSourceValues} from '../sourcing/schema.js';
import {regions,tiers} from '../campus/schema.js';
import {coreDictionaryKeys} from './defaults.js';
import type {DefinitionRef,DictionaryDocument,DictionaryOption,FieldDefinition} from './types.js';
export const dictionaryKeys=['job_levels','departments','job_families','urgency','recruitment_sources','lead_sources','skills','rejection_reasons','termination_reasons','interview_forms','campus_regions','campus_tiers','recruiting_statuses','lead_statuses','campus_statuses','education','interview_statuses'] as const;
export const fixedDictionaryKeys=['recruiting_statuses','lead_statuses','campus_statuses','interview_statuses','education'];
const options=(values:readonly string[],labels?:readonly string[]):DictionaryOption[]=>[...new Set(values.filter(Boolean))].map((id,order)=>({id,label:labels?.[order]||id,aliases:[],order,active:true}));
async function initialDocuments(db:Database):Promise<DictionaryDocument[]>{
 const observed=async(table:string,column:string)=>(await db.query(`SELECT DISTINCT ${column} value FROM ${table} WHERE ${column} IS NOT NULL AND ${column}<>'' ORDER BY ${column}`)).rows.map(r=>r.value as string);
 const rows=(await db.query("SELECT s.name,s.category,coalesce(array_agg(a.alias) FILTER(WHERE a.alias IS NOT NULL),'{}') aliases FROM skills s LEFT JOIN skill_aliases a ON a.skill=s.name GROUP BY s.name ORDER BY s.name")).rows;
 let skillOptions:DictionaryOption[];
 if(rows.length)skillOptions=rows.map((r,order)=>({id:r.name,label:r.name,category:r.category,aliases:r.aliases,order,active:true}));
 else{
  const aliases=new Map<string,string>();for(const [name,,terms] of catalog)for(const term of [name,...terms])if(!aliases.has(term.toLowerCase()))aliases.set(term.toLowerCase(),name);
  for(const [alias,name] of v4AliasPolicy)aliases.set(alias.toLowerCase(),name);
  skillOptions=catalog.map(([id,category],order)=>({id,label:id,category,aliases:[...aliases].filter(([,name])=>name===id).map(([alias])=>alias),order,active:true}));
 }
 // Existing PRD grouping may retain an older canonical skill row with the
 // same spelling. Keep that historical option inactive; only the documented
 // target owns its name in the initial active namespace. Do not change legacy
 // skill rows, profiles, snapshots, or arbitrary undocumented conflicts.
 const grouped=new Map(v4AliasPolicy.map(([alias,target])=>[alias.toLocaleLowerCase(),target]));
 for(const option of skillOptions){const target=grouped.get(option.id.toLocaleLowerCase());if(target&&target!==option.id&&skillOptions.some(o=>o.id===target))option.active=false;}
 validateDocument({kind:'dictionary',key:'dictionary.skills',entity:'resume',options:skillOptions});
 const doc=(key:string,entity:DictionaryDocument['entity'],items:DictionaryOption[]):DictionaryDocument=>({kind:'dictionary',key:'dictionary.'+key,entity,options:items});
 return [
  doc('job_levels','job',options(['P4','P5','P6','P7','P8','P9','M1','M2','M3','专业服务',...await observed('jobs','level')])),
  doc('departments','job',options(['技术','人力','财务','行政','业务',...await observed('jobs','department')])),
  doc('job_families','job',options(['技术研发','生产制造','职能支持','经营管理'])),
  doc('urgency','job',options(['normal','urgent',...await observed('jobs','urgency')],['常规','紧急'])),
  doc('recruitment_sources','application',options(['手动上传','线索池','内推','其他',...await observed('applications','source')])),
  doc('lead_sources','lead',options([...leadSourceValues,...await observed('leads','source')])),
  doc('skills','resume',skillOptions),
  doc('rejection_reasons','application',options(['技能不匹配','经验不足','学历不符','薪资不匹配','候选人放弃','专业能力不匹配','其他',...await observed('applications','reject_reason')])),
  doc('termination_reasons','application',options(['接受其他 offer','主动放弃','薪资未达预期','到岗时间不匹配','背调未通过','录用审批未通过','岗位编制冻结','其他',...await observed('applications','term_reason')]).map(o=>({...o,...(o.id==='其他'?{coreCode:'other'}:{})}))),
  doc('interview_forms','interview',options(['线上','线下','现场','视频','电话','online','offline','其他',...await observed('interviews','form')])),
  doc('campus_regions','campus',options(regions)),doc('campus_tiers','campus',options(tiers)),
  doc('recruiting_statuses','application',options(['screening','screened','interviewing','collecting','background_check','offered','hired','terminated','rejected','hired_other','on_hold','reserve'],['待筛选','初筛通过','面试中','资料收集中','背调中','已发 offer','已入职','录用终止','已淘汰','录用到其他','待定','人才储备']).map(o=>({...o,coreCode:o.id}))),
  doc('lead_statuses','lead',options(['uncontacted','contacted','replied','resume_received','uploaded','declined'],['未联系','已联系未回','已回复','已拿到简历','已上传系统','明确拒绝']).map(o=>({...o,coreCode:o.id}))),
  doc('campus_statuses','campus',options(['unregistered','registered','published','renewal','invalid'],['未注册','已注册·未发布','已发布','需年度续期','账号失效']).map(o=>({...o,coreCode:o.id}))),
  doc('education','resume',options(['none','secondary','associate','bachelor','master','doctor'],['不限','高中/中专','大专','本科','硕士','博士']).map((o,i)=>({...o,rank:[0,0,1,2,3,4][i],coreCode:o.id}))),
  doc('interview_statuses','interview',options(['pending','passed','failed','cancelled','legacy_completed','no_show'],['待进行','已通过','未通过','已取消','已完成、待补结果','爽约／未到场']).map(o=>({...o,coreCode:o.id}))),
 ];
}
export async function ensureDictionaries(db:Database){
 const keys=dictionaryKeys.map(k=>'dictionary.'+k);
 if(Number((await db.query('SELECT count(*) n FROM business_configs WHERE key=ANY($1::text[])',[keys])).rows[0].n)===keys.length)return;
 await db.tx(async c=>{
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('business-dictionary-seed',0))");
  if(Number((await c.query('SELECT count(*) n FROM business_configs WHERE key=ANY($1::text[])',[keys])).rows[0].n)===keys.length)return;
  for(const doc of await initialDocuments(db)){
   const row=(await c.query("INSERT INTO business_configs(key,kind,entity,label) VALUES($1,'dictionary',$2,$3) ON CONFLICT(key) DO NOTHING RETURNING id",[doc.key,doc.entity,doc.key.slice(11)])).rows[0];
   if(!row)continue;
   await c.query('INSERT INTO business_config_versions(config_id,version,document) VALUES($1,1,$2)',[row.id,doc]);
   await c.query('UPDATE business_configs SET published_version=1 WHERE id=$1',[row.id]);
  }
 });
}
export function validateOption(items:DictionaryOption[],value:string,previous?:string):string{
 const option=items.find(o=>o.id===value);if(!option){if(value===previous)return value;fail(422,'option_unknown');}
 if(!option.active&&value!==previous)fail(422,'option_inactive');return value;
}
export async function dictionaryDocument(sql:Sql,key:string,ref?:DefinitionRef):Promise<{ref:DefinitionRef;document:DictionaryDocument}>{
 const row=found((await sql.query('SELECT c.id,c.key,v.version,v.document FROM business_configs c JOIN business_config_versions v ON v.config_id=c.id AND v.version=coalesce($2::int,c.published_version) WHERE c.key=$1 AND ($3::uuid IS NULL OR c.id=$3) FOR SHARE OF c',['dictionary.'+key,ref?.version??null,ref?.configId??null])).rows[0]);
 if(row.document.kind!=='dictionary'||row.document.key!==row.key)fail(422,'dictionary_reference_invalid');
 return {ref:{configId:row.id,version:row.version},document:row.document};
}
export class BusinessDictionaryService {
 constructor(readonly identity:Identity){}
 async dictionary(a:Actor,key:string,ref?:DefinitionRef){requireRole(a,'admin','manager','recruiter','interviewer','viewer');await ensureDictionaries(this.identity.db);const {ref:actual,document}=await dictionaryDocument(this.identity.db.sql,key,ref);return {ref:actual,options:document.options};}
}
export async function resolveFieldDictionaries(db:Database,fields:FieldDefinition[],sql:Sql){
 const result:FieldDefinition[]=[],refs:Record<string,DefinitionRef>={};
 const keys=[...new Set(fields.map(f=>f.dictionaryKey||coreDictionaryKeys[f.fieldId]).filter(Boolean))];
 const rows=keys.length?(await sql.query('SELECT c.key,c.id,c.published_version,v.document FROM business_configs c JOIN business_config_versions v ON v.config_id=c.id AND v.version=c.published_version WHERE c.key=ANY($1::text[]) FOR SHARE OF c',[keys.map(k=>'dictionary.'+k)])).rows:[];
 for(const f of fields){
  const key=f.dictionaryKey||coreDictionaryKeys[f.fieldId],row=rows.find(r=>r.key==='dictionary.'+key);
  if(key&&!row)fail(409,'dictionary_unavailable');
  if(row){refs[key]={configId:row.id,version:row.published_version};result.push({...f,dictionaryKey:key,options:row.document.options});}else result.push(f);
 }
 return {fields:result,refs};
}
export function definitionRevision(ref:DefinitionRef,refs:Record<string,DefinitionRef>,a?:Actor){return createHash('sha256').update(JSON.stringify([ref,Object.entries(refs).sort(([a],[b])=>a.localeCompare(b)),a?[a.id,a.version,[...a.roles].sort()]:null])).digest('hex');}
