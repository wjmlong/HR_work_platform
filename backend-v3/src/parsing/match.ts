import {termRanges,type Parsed,type Evidence} from './profile.js';
import {withContext} from './evidence.js';
export const ALGORITHM='professional-4.0.0';
type Status='matched'|'not_matched'|'not_applicable'|'unknown';
export type Requirements={skills:string[];experienceYears?:number|null;experienceMaxYears?:number|null;education?:string|null;schoolPreferences?:string[]};
export function compareProfile(parsed:Parsed,raw:string,job:Requirements){
 const cited=(items:Evidence[])=>items.filter((e,index,all)=>all.findIndex(other=>other.field===e.field&&other.start===e.start&&other.end===e.end)===index).map(e=>withContext(raw,e));
 const assertions=(fields:string[])=>(parsed as any).assertions?.filter((a:any)=>fields.includes(a.field))||[];
 const skills=job.skills.map(requirement=>{
  const human=assertions(['skills']),semantic=parsed.parserVersion.startsWith('deepseek-vision-'),hits=human.length||semantic?[]:termRanges(raw,requirement);
  const evidence=cited([...parsed.evidence.filter(e=>e.field==='skill:'+requirement),...hits.map(h=>({id:'match:'+h.start+':'+h.end,field:'skill:'+requirement,...h,line:raw.slice(0,h.start).split('\n').length,text:raw.slice(h.start,h.end)}))]);
  const matched=human.length?parsed.profile.skills.includes(requirement):evidence.length>0&&(!semantic||parsed.profile.skills.includes(requirement));
  return {requirement,assertions:human,status:(matched?'matched':raw.trim()?'not_matched':'unknown') as Status,evidence,matchKind:matched?(evidence.some(e=>e.text.toLowerCase()!==requirement.toLowerCase())?'rule_alias':'explicit'):null};
 });
 const skillPoints=skills.length?Math.round(60*skills.filter(s=>s.status==='matched').length/skills.length):42;
 const years=parsed.profile.experienceYears,min=job.experienceYears??null,max=job.experienceMaxYears??null;
 const experienceStatus:Status=min===null&&max===null?'not_applicable':years===null?'unknown':(min===null||years>=min)&&(max===null||years<=max)?'matched':'not_matched';
 const experience={status:experienceStatus,requirement:min,range:{min,max},actual:years,evidence:cited(parsed.evidence.filter(e=>['experienceYears','firstEmployment'].includes(e.field))),points:years===null?13:min===null?25:Math.round(25*Math.min(1,years/Math.max(min,1))),assertions:assertions(['experienceYears','firstEmployment']),baseline:years===null?'unrecognized_experience_13':null};
 const rank:Record<string,number>={none:0,secondary:0,associate:1,bachelor:2,master:3,doctor:4},requiredEducation=job.education&&job.education!=='none'?job.education:null,actual=parsed.profile.education;
 const educationStatus:Status=!requiredEducation?'not_applicable':actual===null?'unknown':rank[actual]>=rank[requiredEducation]?'matched':'not_matched';
 const education={status:educationStatus,requirement:requiredEducation,actual,evidence:cited(parsed.evidence.filter(e=>e.field==='education')),points:!requiredEducation?12:actual===null?0:Math.max(0,15-Math.max(0,rank[requiredEducation]-rank[actual])*8),assertions:assertions(['education']),baseline:!requiredEducation?'unspecified_requirement_12':actual===null?'unknown_not_scored':null};
 const preferences=job.schoolPreferences||[],actualSchools=[parsed.profile.school,parsed.profile.bachelorSchool].filter(Boolean);
 const school={status:(!preferences.length?'not_applicable':!actualSchools.length?'unknown':preferences.some(pref=>actualSchools.some(s=>s.toLowerCase().includes(pref.toLowerCase())))?'matched':'not_matched') as Status,requirement:preferences,actual:actualSchools,evidence:cited(parsed.evidence.filter(e=>['school','bachelorSchool'].includes(e.field))),points:null,assertions:assertions(['school','bachelorSchool']),preferenceOnly:true};
 const rows=[...skills,experience,education,...(preferences.length?[school]:[])],unknownFields=[...(experienceStatus==='unknown'?['experienceYears']:[]),...(educationStatus==='unknown'?['education']:[]),...(school.status==='unknown'?['school']:[])];
 const value=skillPoints+experience.points+education.points,matched=rows.filter(r=>r.status==='matched').length,applicable=rows.filter(r=>r.status!=='not_applicable').length;
 return {algorithmVersion:ALGORITHM,skills,skillPoints,experience,education,school,
  score:{value,lower:value,upper:value,provisional:unknownFields.length>0,unknownFields,color:value>=75?'green':value>=50?'orange':'red',baselines:{skills:!skills.length?42:null,experience:years===null?13:null,education:!requiredEducation?12:null},formula:'skills_60_experience_25_education_15'},
  summary:{total:rows.length,matched,notMatched:rows.filter(r=>r.status==='not_matched').length,unknown:rows.filter(r=>r.status==='unknown').length,notApplicable:rows.length-applicable,denominator:applicable,hitRate:applicable?matched/applicable:null},
  hardGateHints:years!==null&&min!==null&&years<min?[{field:'experienceYears',text:'工作年限低于岗位下限，请人工核对相关经验',evidence:experience.evidence}]:[],
  warnings:parsed.warnings,evidenceAbsentText:'简历原文中未检索到相关内容',statement:'匹配度是规则算出的参考值，不构成淘汰结论。字段缺失不构成否决理由；仅供参考、人工最终确认。'};
}
