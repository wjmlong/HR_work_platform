const education:Record<string,string>={none:'不限',secondary:'高中 / 中专',associate:'大专',bachelor:'本科',master:'硕士',doctor:'博士'};
const text=(value:unknown)=>typeof value==='string'?value.trim():'';
const list=(value:unknown)=>Array.isArray(value)?value.filter((v):v is string=>typeof v==='string'&&!!v.trim()).join('、'):'';
export function jobRequirementsText(value:any):string{
 if(typeof value==='string')return value.trim()||'尚未补充岗位职责与要求，请联系 HR。';
 const r=value||{},parts:string[]=[];
 if(text(r.description))parts.push(r.description.trim());
 if(list(r.skills))parts.push('专业技能：'+list(r.skills));
 if(r.education&&education[r.education])parts.push('学历要求：'+education[r.education]);
 if(text(r.experienceDescription))parts.push('工作经验：'+r.experienceDescription.trim());
 else if(typeof r.experienceYears==='number')parts.push('工作经验：'+r.experienceYears+(typeof r.experienceMaxYears==='number'?'–'+r.experienceMaxYears+' 年':' 年以上'));
 else if(typeof r.experienceMaxYears==='number')parts.push('工作经验：'+r.experienceMaxYears+' 年以内');
 if(list(r.schoolPreferences))parts.push('院校要求：'+list(r.schoolPreferences));
 return parts.join('\n\n')||'尚未补充岗位职责与要求，请联系 HR。';
}
export function resumeMaterialText(resume:any):string{
 if(text(resume?.raw))return resume.raw;
 const p=resume?.profile||{},parts:string[]=[];
 for(const [key,label] of [['name','姓名'],['intent','求职意向'],['school','毕业院校'],['bachelorSchool','本科院校'],['major','专业'],['firstEmployment','首次工作时间'],['location','所在地'],['summary','经历概述']])if(text(p[key]))parts.push(label+'：'+p[key].trim());
 if(p.education&&education[p.education])parts.push('学历：'+education[p.education]);
 if(typeof p.experienceYears==='number')parts.push('工作经验：'+p.experienceYears+' 年');
 if(list(p.skills))parts.push('专业技能：'+list(p.skills));
 return parts.join('\n\n')||'当前没有可展示的简历正文，请联系 HR 核对已选择的简历。';
}
