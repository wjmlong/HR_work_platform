import { fail } from '../http/errors.js';
import { type Actor } from '../identity/service.js';
import { ranks, type transitionInput } from './schema.js';

export const stageOrder=['screening','screened','interviewing','collecting','background_check','offered','hired','terminated','rejected','hired_other','on_hold','reserve'] as const;
export const terminalStages=['hired','terminated','rejected','hired_other'];
export const ccMethods={both:'飞书群 + 邮件',feishu:'仅飞书群',email:'仅邮件',oral:'当面或电话口头同步',deferred:'暂不抄送（仅记录）'};
export const stageCC: Record<string,{to:string[];items:string[]}>= {
 collecting:{to:['用人部门','行政','信息技术'],items:['入职资料清单（学历/离职证明/体检报告）','办公位与工位设备','系统账号与邮箱开通申请']},
 background_check:{to:['用人部门','人力（背调机构）'],items:['前雇主证明人确认','竞业与保密情况核对','背调结果书面回执']},
 offered:{to:['用人部门','人力','财务','行政','信息技术'],items:['offer 审批与用印','薪酬结构与发放口径入系统','入职日与报到安排通知','部门内部提前同步交接计划']},
 hired:{to:['用人部门','人力','行政','信息技术','财务'],items:['入职手续与劳动合同','门禁卡与工牌','社保公积金增员','试用期目标与导师安排']},
};
export const terminationReasons=['接受其他 offer','主动放弃','薪资未达预期','到岗时间不匹配','背调未通过','录用审批未通过','岗位编制冻结','其他'];
export function carryStage(status:string) {return status==='hired'?'offered':['terminated','rejected','hired_other'].includes(status)?'screening':status;}
export function gateTransition(a:Actor,row:any,b:ReturnType<typeof transitionInput.parse>,allowedTerminationReasons:readonly string[]=terminationReasons) {
 if(!row.is_current) fail(409,'historical_application');
 if(['hired_other','on_hold','reserve'].includes(b.to)&&(!b.confirm||b.interaction!=='form'||b.reason.trim().length<1||b.opinion.trim().length<5))fail(422,'flow_opinion_required');
 if(b.to==='rejected'&&(!b.rejectReason.trim()||!b.rejectDetail.trim())) fail(422,'rejection_required');
 if(b.to==='terminated'&&(!allowedTerminationReasons.includes(b.termReason)||b.termReason==='其他'&&!b.termDetail.trim())) fail(422,'termination_required');
 if(terminalStages.includes(row.status)&&b.to!==row.status) {
  if(!b.confirm||!b.reason.trim()) fail(409,'reopen_confirmation');
 } else if(b.interaction!=='drag'&&!['rejected','terminated'].includes(b.to)&&b.to!==row.status&&ranks[b.to]!==ranks[row.status]+1&&(!b.confirm||!b.reason.trim())) fail(409,'stage_confirmation');
 if(b.interaction==='form') {
  if(!b.reason.trim()) fail(422,'flow_reason_required');
  if(b.opinion.trim().length<5) fail(422,'flow_opinion_required');
 }
}
export function ccRecord(to:string,method:keyof typeof ccMethods,interaction:string) {
 const template=stageCC[to];
 if(!template||interaction==='drag')return {cc:null,snapshot:null};
 return {cc:template.to.join(' + ')+'（'+ccMethods[method]+'）'+(method==='deferred'?'（未实际抄送）':''),snapshot:{...template,method,templateVersion:'prd-20261019',actualDelivery:'not_verified'}};
}
