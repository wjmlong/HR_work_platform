import type {Sql} from '../db.js';
import type {EffectiveDefinition,FieldValues,ObjectRef} from './types.js';
export async function storedCoreValues(c:Sql,ref:ObjectRef,def:EffectiveDefinition):Promise<FieldValues>{
 let core:any;
 if(ref.kind==='resume')core=(await c.query('SELECT p.profile FROM resume_versions r JOIN parse_results p ON p.id=r.parse_result_id WHERE r.id=$1',[ref.id])).rows[0]?.profile;
 else if(ref.kind==='evaluation')core=(await c.query('SELECT v.data FROM evaluations e JOIN evaluation_versions v ON v.evaluation_id=e.id AND v.version=e.version WHERE e.id=$1',[ref.id])).rows[0]?.data;
 else {const table={job:'jobs',application:'applications',interview:'interviews',lead:'leads',campus:'campuses'}[ref.kind];core=(await c.query(`SELECT * FROM ${table} WHERE id=$1`,[ref.id])).rows[0];
  if(ref.kind==='job'&&core){core={...core,requirements:(await c.query('SELECT requirements FROM job_versions WHERE job_id=$1 AND version=$2',[ref.id,core.requirements_version])).rows[0]?.requirements,salaryRange:core.salary_range,marketSalary:core.market_salary,marketSource:core.market_source,marketReferenceDate:core.market_reference_date,salaryNote:core.salary_note};}
  if(ref.kind==='interview'&&core)core={...core,startsAt:core.starts_at?.toISOString(),durationMinutes:core.duration_minutes,meetingUrl:core.meeting_url};
 }
 const get=(path:string)=>path.split('.').reduce((o,k)=>o?.[k],core);
 return Object.fromEntries(def.fields.filter(f=>f.coreKey&&get(f.coreKey)!==undefined).map(f=>[f.fieldId,get(f.coreKey!)]));
}
