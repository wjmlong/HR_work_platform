import type {EffectiveDefinition,EntityKind} from './business-config';
export type MoneyContext={currency:string;period:'annual'|'monthly';includesBonus:'yes'|'no';includesEquity:'yes'|'no'};
export type FieldFilter={fieldId:string;op:string;value?:any;money?:MoneyContext};
export type FieldQuery={definitionVersion:number;definitionRevision?:string;columns:string[];filters:FieldFilter[];sort:{fieldId:string;direction:'asc'|'desc';money?:MoneyContext}[];facets:string[];query:string;page:number;pageSize:number};
export const selectableFields=(d:EffectiveDefinition)=>d.fields.filter(f=>f.active).sort((a,b)=>a.order-b.order);
export const newFieldQuery=(d:EffectiveDefinition):FieldQuery=>({definitionVersion:d.ref.version,definitionRevision:d.aclRevision,columns:selectableFields(d).slice(0,6).map(f=>f.fieldId),filters:[],sort:[],facets:[],query:'',page:1,pageSize:25});
export function acceptSavedView(value:any):FieldQuery{if(!value||!Array.isArray(value.columns)||!value.columns.length||!Array.isArray(value.filters))throw Error('此视图已失效，请修改后再查询');return structuredClone(value);}
export function changeQuery(q:FieldQuery,patch:Partial<FieldQuery>){return {...q,...patch,page:patch.page??1};}
export async function exportFields(request:(path:string,options:any)=>Promise<any>,save:(blob:Blob,name:string)=>void,kind:EntityKind,scope:'filtered'|'all',query:FieldQuery){if(!['filtered','all'].includes(scope))throw Error('请选择导出范围');const blob=await request('/business-config/'+kind+'/export',{method:'POST',body:{scope,query},raw:true});save(blob,'招聘字段视图-'+kind+'-'+scope+'-'+new Date().toISOString().slice(0,10)+'.csv');}
export function archiveSummary(value:any){const m=value?.manifest;if(!m||![3,4].includes(m.version)||!m.tables)return null;return 'SQL 备份版本 '+m.version+(m.schemaRevision?' · 结构修订 '+m.schemaRevision:'')+' · '+Object.keys(m.tables).length+' 张数据表';}
// The URL contains only a pointer; conditions and columns remain authorized SQL data.
export function readSavedView(hash:string,kind:EntityKind){const id=new URLSearchParams(hash.split('?')[1]||'').get('view_'+kind)||'';return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)?id:'';}
export function savedViewHash(hash:string,kind:EntityKind,id:string){const [route]=hash.split('?'),params=new URLSearchParams(hash.split('?')[1]||'');for(const key of [...params.keys()])if(key.startsWith('view_'))params.delete(key);if(id)params.set('view_'+kind,id);return route+(params.size?'?'+params.toString():'');}
export function applyFieldView(draft:FieldQuery,blocked:string){if(blocked)throw Error('失效视图必须先明确重置，不能应用临时默认条件');return structuredClone(draft);}
