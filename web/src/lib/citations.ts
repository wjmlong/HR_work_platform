export type BriefCitation = {
  kind:'match'|'resume'|'evaluation'|'evaluation_absence'|'rule';
  title:string;
  text:string;
};
const status:Record<string,string>={matched:'已命中',not_matched:'原文未命中',unknown:'字段未识别',not_applicable:'未设置要求'};
const conclusion:Record<string,string>={strong_yes:'强烈推进',yes:'推进',hold:'待定',no:'不推进'};
// A material is already an immutable snapshot. Never substitute a latest
// matches/public-JD/evaluation-list response for its recorded historical basis.
export async function resolveBriefCitation(material:any,c:any,load:(path:string)=>Promise<any>,savedText=''):Promise<BriefCitation>{
  if(c.kind==='rule_template')return {kind:'rule',title:'生成时使用的规则模板',text:`规则：${c.rule}\n岗位版本：${c.jobVersion??material.inputs?.jobVersion??'历史未注明'}\n${c.templateText||savedText}\n通用沟通模板；不构成薪资报价或录用结论。`};
  if(c.matchSnapshotId){
    if(c.matchSnapshotId!==material.inputs?.matchSnapshotId||!material.data.professionalComparison)throw Error('引用快照与材料记录不一致');
    const match=material.data.professionalComparison;
    const skills=(match.skills||[]).map((s:any)=>`${s.requirement}：${status[s.status]||s.status}\n${(s.evidence||[]).map((e:any)=>`原文第 ${e.line} 行：${e.text}`).join('\n')}`).join('\n');
    return {kind:'match',title:'生成时的专业条件对照',text:`匹配快照：${c.matchSnapshotId}\n岗位版本：${material.inputs.jobVersion}\n简历版本：${material.inputs.resumeVersionId}\n${skills}\n工作年限：${status[match.experience?.status]||'历史未注明'}\n学历：${status[match.education?.status]||'历史未注明'}\n未命中不等于不具备，仅供人工核实。`};
  }
  if(c.resumeVersionId){
    const raw=await load('/resumes/'+c.resumeVersionId+'/raw');
    if(raw.resumeVersionId!==c.resumeVersionId)throw Error('简历引用版本不一致');
    return {kind:'resume',title:'生成时引用的简历原文',text:`简历版本：${c.resumeVersionId}\n期望薪资：${raw.profile?.expectedSalary||'未明确'}\n${raw.raw}`};
  }
  if(c.evaluationId){
    const e=await load('/evaluations/'+c.evaluationId+'/versions/'+c.version);
    if(e.version!==c.version||!e.data)throw Error('面试评估引用版本不一致');
    return {kind:'evaluation',title:`引用的评估版本 ${c.version}`,text:`事实依据：${e.data.evidenceNotes||'未填写'}\n总结：${e.data.summary||'未填写'}\n人工结论：${conclusion[e.data.conclusion]||'未填写'}`};
  }
  if(c.path?.endsWith('/evaluations') && !material.data.evaluations?.length)return {kind:'evaluation_absence',title:'生成时的评估状态',text:'本材料生成时尚无已提交人工评估。之后新增的评估须重新生成材料后引用。'};
  throw Error('历史引用缺少固定版本，请重新生成材料并核对');
}

export async function resolveSavedFact(material:any,fact:any,load:(path:string)=>Promise<any>){const c=fact.citation,saved=material.data?.facts?.find((f:any)=>f.text===fact.text&&['resumeVersionId','evidenceId','start','end','line'].every(k=>f.citation?.[k]===c?.[k]));if(!saved||c.resumeVersionId!==material.inputs?.resumeVersionId)throw Error('事实引用与材料快照不一致');if(material.inputs?.sourceAccess?.fullResume===false)return {raw:saved.text,citation:{...c,start:0,end:saved.text.length},limited:true};const original=await load('/resumes/'+c.resumeVersionId+'/raw');if(original.resumeVersionId!==c.resumeVersionId||original.raw.slice(c.start,c.end)!==saved.text)throw Error('原文引用与保存事实不一致');return {...original,citation:c,limited:false};}
