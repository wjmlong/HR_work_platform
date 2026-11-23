import type {Sql} from '../db.js';import type {Actor} from '../identity/service.js';import type {ConfigDocument,EntityKind,FieldDocument} from './types.js';
import {fieldAllowed} from './access.js';import {fieldVisible,conditionMatches,empty} from './field-validation.js';import {decodeFieldRow} from './fields.js';import {compileFieldQuery} from './query.js';
export type PublicationAnalysis={invalidatedViews:number;templateBindings:number;required:{fieldId:string;label:string;missing:number|null;samples:string[]}[]};
async function coreRows(c:Sql,kind:EntityKind,a:Actor):Promise<{id:string;core:any}[]>{
 if(kind==='resume')return (await c.query('SELECT r.id,p.profile core FROM resume_versions r JOIN parse_results p ON p.id=r.parse_result_id JOIN candidates c ON c.id=r.candidate_id WHERE c.deleted_at IS NULL')).rows as any;
 if(kind==='job')return (await c.query("SELECT j.id,to_jsonb(j)||jsonb_build_object('requirements',v.requirements,'salaryRange',j.salary_range,'marketSalary',j.market_salary,'marketSource',j.market_source,'marketReferenceDate',j.market_reference_date,'salaryNote',j.salary_note) core FROM jobs j JOIN job_versions v ON v.job_id=j.id AND v.version=j.requirements_version")).rows as any;
 if(kind==='evaluation')return (await c.query("SELECT id,data core FROM evaluations WHERE status<>'draft' OR author_id=$1 OR last_editor_id=$1",[a.id])).rows as any;
 if(kind==='interview')return (await c.query("SELECT i.id,to_jsonb(i)||jsonb_build_object('startsAt',i.starts_at,'durationMinutes',i.duration_minutes,'meetingUrl',i.meeting_url) core FROM interviews i")).rows as any;
 const table={application:'applications',lead:'leads',campus:'campuses'}[kind];return (await c.query(`SELECT id,to_jsonb(o) core FROM ${table} o WHERE deleted_at IS NULL`)).rows as any;
}
export async function publicationAnalysis(c:Sql,a:Actor,document:ConfigDocument,configId:string):Promise<PublicationAnalysis>{
 const bindings=Number((await c.query('SELECT count(*)::int n FROM business_template_bindings WHERE config_id=$1',[configId])).rows[0].n),result:PublicationAnalysis={invalidatedViews:0,templateBindings:bindings,required:[]};if(document.kind!=='fields')return result;
 const doc=document as FieldDocument,rows=await coreRows(c,doc.entity,a),readable=doc.fields.filter(f=>fieldAllowed(f,a,'read',true)),values=new Map<string,Record<string,unknown>>();
 for(const row of rows){const map:Record<string,unknown>={};for(const f of readable.filter(f=>f.coreKey)){let value=f.coreKey!.split('.').reduce((v,k)=>v?.[k],row.core);if(f.type==='datetime'&&value)value=new Date(value).toISOString();map[f.fieldId]=value;}values.set(row.id,map);}
 const ids=readable.filter(f=>!f.coreKey).map(f=>f.fieldId);
 if(ids.length)for(const row of (await c.query('SELECT * FROM custom_field_values WHERE object_kind=$1 AND field_id=ANY($2::text[])',[doc.entity,ids])).rows){const map=values.get(row.object_id);if(map)map[row.field_id]=decodeFieldRow(row);}
 for(const f of doc.fields.filter(f=>f.active&&(f.required||f.requiredWhen))){if(!fieldAllowed(f,a,'read',true)){result.required.push({fieldId:f.fieldId,label:f.label,missing:null,samples:[]});continue;}const missing=rows.filter(row=>{const map=values.get(row.id)!,value=map[f.fieldId],blank=empty(value)||f.type.startsWith('money')&&!!value&&(value as any).min===null&&(value as any).max===null;return fieldVisible(doc,f,map,f=>fieldAllowed(f,a,'read',true))&&(f.required||!!f.requiredWhen&&conditionMatches(f.requiredWhen,map,id=>{const dep=doc.fields.find(d=>d.fieldId===id);return !!dep&&fieldVisible(doc,dep,map,f=>fieldAllowed(f,a,'read',true));}))&&blank;});result.required.push({fieldId:f.fieldId,label:f.label,missing:missing.length,samples:missing.slice(0,5).map(r=>r.id)});}
 const views=(await c.query('SELECT s.query,u.* FROM saved_views s JOIN users u ON u.id=s.owner_id WHERE s.entity=$1',[doc.entity])).rows;
 for(const view of views){try{compileFieldQuery({entity:doc.entity,ref:{configId,version:1},fields:doc.fields,aclRevision:''},view,view.query,'o',0);}catch{result.invalidatedViews++;}}
 return result;
}
