import {defaultChecklistTemplates,defaultCcTemplates} from './checklist-template.js';
import {defaultEvaluationTemplate} from './evaluation-template.js';
import {defaultQuestionTemplate} from './question-template.js';
import type {EntityKind,FieldDefinition,FieldDocument} from './types.js';
import {fieldSchema} from './schema.js';
import {defaultMatchTemplate} from './match-template.js';
export const defaultTemplates=()=>[defaultMatchTemplate(),defaultQuestionTemplate(),defaultEvaluationTemplate(),...defaultChecklistTemplates(),...defaultCcTemplates()];
type Core=[string,string,FieldDefinition['type'],boolean?];
export const coreDictionaryKeys:Record<string,string>={
 'core.job.level':'job_levels','core.job.department':'departments','core.job.urgency':'urgency','core.job.requirements.education':'education','core.job.requirements.skills':'skills',
 'core.resume.education':'education','core.resume.skills':'skills','core.application.source':'recruitment_sources','core.interview.form':'interview_forms',
 'core.lead.source':'lead_sources','core.lead.skills':'skills','core.campus.region':'campus_regions','core.campus.tier':'campus_tiers',
};
const core:Record<EntityKind,Core[]>={
 job:[['name','岗位名称','text',true],['level','内部岗位等级','select',true],['department','所属部门','text'],['headcount','招聘人数','number',true],['urgency','紧急度','select'],['requirements.education','学历要求','select'],['requirements.experienceYears','经验最低年数','number'],['requirements.experienceMaxYears','经验最高年数','number'],['requirements.experienceDescription','经验要求原文','text'],['requirements.schoolPreferences','院校偏好','multiselect'],['requirements.skills','岗位技能要求','multiselect'],['requirements.description','岗位说明与画像','longtext'],['salaryRange','内部薪酬区间','text'],['marketSalary','市场同类岗位薪资参考','text'],['marketSource','市场数据来源','text'],['marketReferenceDate','参考日期','date'],['salaryNote','薪资建议说明','longtext']],
 resume:[['name','姓名','text',true],['phone','电话','text'],['email','邮箱','text'],['location','所在地','text'],['bachelorSchool','本科院校','text'],['intent','求职意向','text'],['expectedSalary','原始薪资表述','text'],['firstEmployment','首次就业时间','text'],['companies','公司','multiselect'],['education','学历','select'],['experienceYears','工作年限','number'],['school','院校','text'],['major','专业','text'],['skills','技能','multiselect'],['summary','简历摘要','longtext']],
 application:[['source','招聘来源','select']],
 interview:[['round','面试轮次','number',true],['startsAt','面试时间','datetime',true],['durationMinutes','面试时长','number',true],['form','面试形式','text',true],['location','面试地点','text'],['meetingUrl','会议链接','text'],['feedback','面试反馈','longtext']],
 evaluation:[['evidenceNotes','评估依据','longtext'],['projectExperience','项目经历','longtext'],['motivation','求职动机','longtext'],['risks','风险与待核对项','longtext'],['questionCoverage','题目覆盖','longtext'],['summary','综合建议说明','longtext']],
 lead:[['name','姓名','text',true],['org','机构/公司','text',true],['school','院校','text'],['major','专业','text'],['skills','技能','multiselect'],['direction','研究/工作方向','text',true],['contact','联系方式','text'],['source','来源','select',true],['note','备注','longtext']],
 campus:[['school','院校名称','text',true],['region','地区','select'],['city','城市','text'],['tier','院校层次','select'],['url','就业网网址','text'],['note','备注','longtext']],
};
export function defaultConfigs():FieldDocument[]{
 return (Object.entries(core) as [EntityKind,Core[]][]).map(([entity,items])=>({kind:'fields',entity,fields:[...items.map(([key,label,type,required],order)=>fieldSchema.parse({fieldId:`core.${entity}.${key}`,coreKey:key,label:entity==='job'&&['salaryRange','marketSalary'].includes(key)?label+'原文':label,type,required:!!required,system:!!required,dictionaryKey:coreDictionaryKeys[`core.${entity}.${key}`],group:entity==='job'&&/salary|market/i.test(key)?'内部薪资建议':'基本信息',order,access:{...(entity==='evaluation'?{write:['admin','manager','recruiter','interviewer']}:{}),sensitivity:entity==='job'&&/salary|market/i.test(key)||entity==='resume'&&key==='expectedSalary'?'salary':'general'}})),...compensationFields(entity)]}));
}
export function compensationFields(entity:EntityKind):FieldDefinition[]{
 const items=entity==='job'?[['salaryCompensation','内部薪酬区间'],['marketCompensation','市场同类岗位薪资参考']]:entity==='resume'||entity==='application'?[['expectedCompensation','期望年包']]:[];
 return items.map(([key,label],i)=>fieldSchema.parse({fieldId:`builtin.${entity}.${key}`,label,type:'money_range',group:entity==='job'?'内部薪资建议':'薪酬期望',order:80+i,description:'税前现金金额；保留币种、年/月口径和奖金/股权组成，原文另存。',access:{sensitivity:'salary'}}));
}
export function coreDefinition(entity:EntityKind){return defaultConfigs().find(d=>d.entity===entity)!;}
