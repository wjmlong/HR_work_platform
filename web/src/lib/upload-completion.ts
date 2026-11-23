// Track IDs returned by ingestion, independent of the actionable queue view.
export async function observeSubmittedTasks(ids:string[],load:(id:string)=>Promise<any>){
 const pending:string[]=[],completed:any[]=[];
 for(const id of ids){const task=await load(id);if(['queued','running'].includes(task.state))pending.push(id);else completed.push(task);}
 return {pending,completed};
}
export function comparisonModeLabel(data:any){const algorithm=data?.algorithmVersion;if(algorithm==='professional-config-1.0.0')return '公司自定义专业规则';if(algorithm==='professional-4.0.0'||algorithm==='professional-4.0.0-pinned.1')return 'PRD 默认专业规则';return '历史规则（口径未记录）';}
