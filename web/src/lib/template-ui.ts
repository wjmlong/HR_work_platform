export type TemplateRef={configId:string;version:number};
export const stageNames:Record<string,string>={collecting:'资料收集',background_check:'背调',offered:'Offer',hired:'入职'};
export const methodNames:Record<string,string>={both:'飞书群 + 邮件',feishu:'仅飞书群',email:'仅邮件',oral:'当面或电话口头同步',deferred:'暂不抄送（仅记录）'};
export const purposeNames:Record<string,string>={matching:'专业匹配',questions:'面试题库',evaluation:'评估量表',...Object.fromEntries(Object.entries(stageNames).flatMap(([k,v])=>[['checklist.'+k,v+'清单'],['cc.'+k,v+'抄送准备']]))};
export function copyTemplate(document:any,suffix:string){const copy=structuredClone(document);copy.key=copy.kind+(copy.stage?'.'+copy.stage:'')+'.company_'+suffix;copy.label+=' · 公司副本';if('mode'in copy)copy.mode='custom';return copy;}
export const templateModeLabel=(t:any)=>t.mode==='prd_compat'?'PRD 默认口径':t.mode==='custom'?'公司自定义口径':'人工清单与准备事项';
export const refLabel=(ref?:TemplateRef|null)=>ref?'固定版本 '+ref.version:'历史版本未记录';
export function adoptionBody(preview:any,selectedIds:string[]=[],matching=false){if(!preview?.receipt)throw Error('请先完成采用预览');const selected=[...new Set(selectedIds)];if(matching&&selected.some(id=>!preview.scope?.some((s:any)=>s.applicationId===id&&s.selectable)))throw Error('所选申请不在可重算范围');return {receipt:preview.receipt,objectVersion:preview.objectVersion,...(matching?{selectedIds:selected}:{})};}
export const evaluationDimensions=(template:any)=>(template?.dimensions||[]).filter((d:any)=>d.active).toSorted((a:any,b:any)=>a.order-b.order);
const score=(v:any)=>{const n=v===''||v==null?null:Number(v);return n===null?null:n>=1&&n<=5&&Number.isInteger(n*2)?n:undefined;};
export function evaluationScores(template:any,values:Record<string,any>){const scores=Object.fromEntries(evaluationDimensions(template).flatMap((d:any)=>{const v=score(values['score.'+d.id]);return v===undefined?[]:[[d.id,v]];})),overallScore=score(values.overallScore);return template?.mode==='custom'?{scores}:{...scores,...(overallScore===undefined?{}:{overallScore})};}
export const missingEvaluationDimension=(template:any,data:any)=>evaluationDimensions(template).find((d:any)=>d.required&&score(data.scores?.[d.id]??data[d.id])==null);
export function checklistItemBody(version:number,status:string,note:string){if(status==='not_applicable'&&!note.trim())throw Error('标记不适用时必须填写核对说明');return {version,status,note};}
export function ccSelection(template:any,ids:string[],method:string){if(!template?.ref)throw Error('抄送模板尚未加载，请重试');if(!Object.hasOwn(methodNames,method))throw Error('请选择记录方式');return {ccTemplateRef:template.ref,ccRecipientIds:[...new Set(ids)],ccMethod:method};}
export async function optionalOriginal<T>(load:()=>Promise<T>):Promise<T|null>{try{return await load();}catch(e){if((e as any).status===403)return null;throw e;}}
export const newStableId=(prefix:string)=>prefix+'_'+crypto.randomUUID();
export const lines=(text:string)=>text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
export const terms=(text:string)=>text.split(/[,，;；\n]/).map(s=>s.trim()).filter(Boolean);
