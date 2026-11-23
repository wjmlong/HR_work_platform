export const dimensions=['professional','communication','logicalThinking','culturalFit'] as const;
export const dimensionNames={professional:'专业能力',communication:'沟通表达',logicalThinking:'逻辑思维',culturalFit:'文化匹配'};
export function validScore(value:unknown):value is number {return typeof value==='number'&&Number.isFinite(value)&&value>=1&&value<=5&&Number.isInteger(value*2);}
export function cleanEvaluation<T extends Record<string,unknown>>(input:T):Record<string,any>{
 const result={...input};
 for(const field of [...dimensions,'overallScore','problemSolving'])if(!validScore(result[field]))delete result[field];
 return result;
}
export function mergeEvaluation(previous:Record<string,unknown>,input:Record<string,unknown>,provided:string[]){
 const result=cleanEvaluation(previous),scoreFields=[...dimensions,'overallScore','problemSolving'];
 for(const field of provided){
  if(scoreFields.includes(field)){
   if(validScore(input[field]))result[field]=input[field];
   else if(input[field]===null||input[field]==='')delete result[field];
  }else result[field]=input[field];
 }
 return result;
}
