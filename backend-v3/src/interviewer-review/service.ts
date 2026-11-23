import {evaluationBasis,templateScores,aggregateEvaluationCohorts} from '../business-config/evaluation-template.js';
import {legacyDefinition,legacyKeys} from '../business-config/legacy-fields.js';
import {Identity,requireRole,type Actor} from '../identity/service.js';
import {parse,z,uuid} from '../http/validation.js';
import {fail} from '../http/errors.js';
import {dimensions,dimensionNames,validScore} from '../interviews/scores.js';
import {csvDocument} from '../http/csv.js';
export const interviewerReviewRequest=z.object({interviewerId:uuid.optional(),from:z.iso.datetime({offset:true}).optional(),to:z.iso.datetime({offset:true}).optional()}).strict();
const mean=(values:number[])=>values.length?values.reduce((sum,n)=>sum+n,0)/values.length:null;
type Bucket={id:string|null;name:string;assigned:number;completed:number;passed:number;failed:number;scoredSessions:number;comparableCompleted:number;comparablePassed:number;ratings:number[];values:Record<string,number[]>};
export function trainingVerdict(row:{completed:number;passRate:number|null;averageScore:number|null;dimensionAverages:Record<string,number|null>}){
 if(row.completed<3)return {rule:'insufficient',title:'数据不足',color:'gray',advice:'已完成不足 3 场，仅展示原始数字，不下结论。'};
 if(row.passRate!==null&&row.passRate>=0.85&&row.averageScore!==null&&row.averageScore<3)return {rule:'R1',title:'打分偏松',color:'amber',advice:'用「要点」卡达标线，逐条判是否命中。'};
 if(row.passRate!==null&&row.passRate<=0.2&&row.averageScore!==null&&row.averageScore>=3.5)return {rule:'R2',title:'标准偏严',color:'amber',advice:'与用人部门对齐岗位达标线。'};
 if(row.averageScore!==null&&row.averageScore>=4.5)return {rule:'R3',title:'评分集中在上限',color:'blue',advice:'用「要点」逐条判，避免整体印象打分，检查区分度。'};
 const low=dimensions.filter(key=>row.dimensionAverages[key]!==null&&row.dimensionAverages[key]<=3).toSorted((a,b)=>row.dimensionAverages[a]!-row.dimensionAverages[b]!)[0];
 if(low)return {rule:'R4',title:dimensionNames[low]+'偏弱',color:'red',advice:'针对'+dimensionNames[low]+'做专项追问训练。',dimension:low};
 return {rule:'R5',title:'暂无异常',color:'green',advice:row.averageScore===null?'尚未填写四维评分，无法判断评分分布；原始场次数与通过率仍可核对。':'用于训练与口径对齐，不用于绩效考核。'};
}
export class InterviewerReview {
 constructor(readonly identity:Identity){}
 async query(a:Actor,input:unknown){
  requireRole(a,'admin','manager','recruiter');const q=parse(interviewerReviewRequest,input);
  if(q.from&&q.to&&new Date(q.from)>=new Date(q.to))fail(422,'invalid_time_range');
  const [resumeDefinition,jobDefinition,evaluationDefinition]=await Promise.all(['resume','job','evaluation'].map(kind=>legacyDefinition(this.identity,a,kind as any))),resumeKeys=legacyKeys(resumeDefinition,a),jobKeys=legacyKeys(jobDefinition,a),evaluationKeys=legacyKeys(evaluationDefinition,a);
  return this.identity.db.tx(async c=>{
   await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const records=(await c.query(`SELECT i.id,i.application_id,i.round,i.starts_at,i.status,i.primary_interviewer_id,u.name interviewer_name,p.profile->>'name' candidate_name,j.name job_name,e.id evaluation_id,v.version evaluation_version,v.data,CASE WHEN v.version IS NOT NULL THEN v.configuration_refs WHEN tb.config_id IS NOT NULL THEN jsonb_build_object('evaluationTemplate',jsonb_build_object('ref',jsonb_build_object('configId',tb.config_id,'version',tb.template_version),'document',tv.document)) ELSE '{}'::jsonb END configuration_refs FROM interviews i JOIN applications a ON a.id=i.application_id JOIN candidates p ON p.id=a.candidate_id JOIN jobs j ON j.id=a.job_id LEFT JOIN users u ON u.id=i.primary_interviewer_id LEFT JOIN business_template_bindings tb ON tb.object_kind='interview' AND tb.object_id=i.id AND tb.purpose='evaluation' LEFT JOIN business_config_versions tv ON tv.config_id=tb.config_id AND tv.version=tb.template_version LEFT JOIN evaluations e ON e.interview_id=i.id AND e.author_id=i.primary_interviewer_id LEFT JOIN LATERAL(SELECT v.version,v.data,v.configuration_refs FROM evaluation_versions v WHERE v.evaluation_id=e.id AND v.status='submitted' ORDER BY v.version DESC LIMIT 1) v ON true WHERE i.deleted_at IS NULL AND a.deleted_at IS NULL AND p.deleted_at IS NULL AND ($1::uuid IS NULL OR i.primary_interviewer_id=$1) AND ($2::timestamptz IS NULL OR i.starts_at>=$2) AND ($3::timestamptz IS NULL OR i.starts_at<$3) ORDER BY i.starts_at DESC,i.id`,[q.interviewerId||null,q.from||null,q.to||null])).rows;
   const buckets=new Map<string,Bucket>(),globalValues=Object.fromEntries(dimensions.map(key=>[key,[] as number[]]));
   const allRatings:number[]=[];let completed=0,passed=0,scoredSessions=0;
   for(const record of records){
    const key=record.primary_interviewer_id||'unassigned';
    const bucket:Bucket=buckets.get(key)||{id:record.primary_interviewer_id,name:record.interviewer_name||'主责待补录',assigned:0,completed:0,passed:0,failed:0,scoredSessions:0,comparableCompleted:0,comparablePassed:0,ratings:[],values:Object.fromEntries(dimensions.map(dim=>[dim,[] as number[]]))};
    bucket.assigned++;
    if(['passed','failed'].includes(record.status)){
     completed++;bucket.completed++;
     if(record.status==='passed'){passed++;bucket.passed++;}else bucket.failed++;
     const eligible=evaluationBasis(record.configuration_refs)?.defaultComparable===true;
     if(eligible){bucket.comparableCompleted++;if(record.status==='passed')bucket.comparablePassed++;}
     const scores=eligible?dimensions.filter(dim=>validScore(record.data?.[dim])):[];
     if(scores.length){scoredSessions++;bucket.scoredSessions++;}
     for(const dim of scores){const value=record.data[dim] as number;bucket.values[dim].push(value);bucket.ratings.push(value);globalValues[dim].push(value);allRatings.push(value);}
    }
    buckets.set(key,bucket);
   }
   const interviewers=[...buckets.values()].map(bucket=>{
    const dimensionAverages=Object.fromEntries(dimensions.map(dim=>[dim,mean(bucket.values[dim])])),dimensionSamples=Object.fromEntries(dimensions.map(dim=>[dim,bucket.values[dim].length]));
    const row={id:bucket.id,name:bucket.name,assigned:bucket.assigned,completed:bucket.completed,passed:bucket.passed,failed:bucket.failed,passRate:bucket.completed?bucket.passed/bucket.completed:null,averageScore:mean(bucket.ratings),comparableCompleted:bucket.comparableCompleted,comparablePassRate:bucket.comparableCompleted?bucket.comparablePassed/bucket.comparableCompleted:null,cohorts:aggregateEvaluationCohorts(records.filter(r=>r.primary_interviewer_id===bucket.id&&['passed','failed'].includes(r.status))),scoredSessions:bucket.scoredSessions,scoreSamples:bucket.ratings.length,dimensionAverages,dimensionSamples};
    return {...row,verdict:trainingVerdict({...row,completed:row.comparableCompleted,passRate:row.comparablePassRate})};
   }).sort((x,y)=>y.completed-x.completed||x.name.localeCompare(y.name,'zh-CN'));
   return {scope:q,cohorts:aggregateEvaluationCohorts(records.filter(r=>['passed','failed'].includes(r.status))),kpis:{interviewers:interviewers.filter(row=>row.id!==null).length,completed,passRate:completed?passed/completed:null,averageScore:mean(allRatings),scoredSessions},interviewers,
    dimensionAverages:Object.fromEntries(dimensions.map(dim=>[dim,mean(globalValues[dim])])),dimensionSamples:Object.fromEntries(dimensions.map(dim=>[dim,globalValues[dim].length])),
    details:records.slice(0,30).map(record=>({id:record.id,applicationId:record.application_id,round:record.round,startsAt:record.starts_at,status:record.status,interviewerId:record.primary_interviewer_id,interviewerName:record.interviewer_name||'主责待补录',candidateName:resumeKeys.has('name')?record.candidate_name:undefined,jobName:jobKeys.has('name')?record.job_name:undefined,evaluationId:record.evaluation_id,evaluationVersion:record.evaluation_version,templateRef:evaluationBasis(record.configuration_refs)?.template.ref||null,templateLabel:evaluationBasis(record.configuration_refs)?.template.label||'来源未知',dimensions:evaluationBasis(record.configuration_refs)?.template.dimensions.filter(d=>d.active).toSorted((a,b)=>a.order-b.order).map(d=>({id:d.id,label:d.label}))||[],scores:(()=>{const b=evaluationBasis(record.configuration_refs);return b?Object.fromEntries(b.template.dimensions.filter(d=>d.active).map(d=>[d.id,templateScores(b.template,record.data)[d.id]??null])):{};})(),questionCoverage:evaluationKeys.has('questionCoverage')?record.data?.questionCoverage||'':''})),
    basis:{completed:'passed + failed; distinct interview IDs',scores:'latest submitted primary-interviewer evaluation; default four-dimensional comparable ratings only; custom cohorts separate',scoreSamples:allRatings.length,ruleVersion:'prd-20261019',purpose:'仅用于训练与口径对齐，不用于绩效考核',statement:'评分由面试官人工填写，AI 只做汇总排序（本版为规则汇总）。'}};
  });
 }
 async exportCohorts(a:Actor,input:unknown){
  const report=await this.query(a,input),rows=report.interviewers.flatMap(person=>person.cohorts.flatMap(cohort=>cohort.dimensions.map((dim:any)=>[person.name,cohort.label,cohort.templateRef?.configId||'',cohort.templateRef?.version??'历史未注明',dim.id,dim.label,cohort.dimensionAverages[dim.id]===null?'':cohort.dimensionAverages[dim.id].toFixed(2),cohort.dimensionSamples[dim.id],cohort.completed,cohort.legacy?'历史四维口径，模板版本未记录':'不可变模板版本'])));
  await this.identity.audit(this.identity.db.sql,a.id,'interviewer_review.cohorts_export','report',{rows:rows.length});
  return csvDocument([['面试官','模板','模板 ID','模板版本','维度 ID','维度名称','均分','有效评分样本数','已完成面试数','来源'],...rows]);
 }
 async export(a:Actor,input:unknown){
  const report=await this.query(a,input);
  await this.identity.db.tx(c=>this.identity.audit(c,a.id,'interviewer_review.export','report',{rows:report.interviewers.length}));
  return csvDocument([['面试官','安排场次','已完成','通过','未通过','通过率','平均评分','专业均分','沟通均分','逻辑均分','文化均分','评价建议'],...report.interviewers.map(row=>[row.name,row.assigned,row.completed,row.passed,row.failed,row.passRate===null?'':(row.passRate*100).toFixed(1)+'%',row.averageScore===null?'':row.averageScore.toFixed(2),...dimensions.map(dim=>row.dimensionAverages[dim]===null?'':row.dimensionAverages[dim].toFixed(2)),row.verdict.title+'；'+row.verdict.advice])]);
 }
}
