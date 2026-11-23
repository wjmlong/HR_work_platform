import {validateAnalysis,type InterviewAnalysis,type TranscriptSegment} from './contracts.js';
type Session={basis:any;segments:TranscriptSegment[];analysis?:InterviewAnalysis|null};
export type ContextInput={basis:any;speakerSegments?:TranscriptSegment[];segments?:TranscriptSegment[];reports?:InterviewAnalysis[];recentSuggestions?:unknown[];scope:'recent'|'batch'|'merge'};
const bytes=(v:unknown)=>Buffer.byteLength(JSON.stringify(v));
/** Byte budget is a conservative input ceiling, not a tokenizer estimate. Originals are never overwritten. */
export async function analyzeBounded(session:Session,call:(input:ContextInput)=>Promise<unknown>,options:{final:boolean;inputBytes?:number}):Promise<InterviewAnalysis>{
 const limit=options.inputBytes??48000,basis={job:session.basis.job,requirements:session.basis.requirements,dimensions:session.basis.dimensions},ids=basis.dimensions.map((d:any)=>d.id);
 const priorTurns=(session.analysis?.speakerTurns||[]).filter(t=>session.segments.some(s=>s.id===t.segmentId&&s.text===t.parts.map(p=>p.text).join('')));
 const withTurns=(result:InterviewAnalysis)=>validateAnalysis({...result,speakerTurns:[...new Map([...priorTurns,...(result.speakerTurns||[])].map(t=>[t.segmentId,t])).values()]},session.segments,ids);
 const checked=async(input:ContextInput,source:TranscriptSegment[])=>{if(bytes(input)>limit)throw Error('assistant_context_budget');const result=validateAnalysis(await call(input),source,ids);if(input.reports)for(const dimension of result.dimensions)if(dimension.status==='not_covered'&&input.reports.some(r=>r.dimensions.some(d=>d.dimensionId===dimension.dimensionId&&d.status==='evidence')))throw Error('assistant_context_evidence_lost');return result;};
 if(!options.final){
  const input:ContextInput={basis,segments:[],recentSuggestions:session.analysis?.suggestions?.map(s=>({question:s.question}))||[],scope:'recent',speakerSegments:[]};
  const known=new Set(priorTurns.map(t=>t.segmentId));
  const deferred:NonNullable<InterviewAnalysis['speakerTurns']>=[];
  for(const s of session.segments.filter(s=>!known.has(s.id)&&['unknown','mixed'].includes(s.speaker))){
   // Bound echoed output as well as input. Oversized originals remain visibly uncertain.
   if(bytes({...input,speakerSegments:[s]})>Math.min(limit/2,12000)){deferred.push({segmentId:s.id,parts:[{speaker:'unknown',text:s.text}]});continue;}
   if(input.speakerSegments!.length>=12)break;
   const next={...input,speakerSegments:[...input.speakerSegments!,s]};if(bytes(next)>Math.min(limit/2,12000))break;input.speakerSegments=next.speakerSegments;
  }
  for(const segment of [...session.segments].reverse()){const next={...input,segments:[segment,...input.segments!]};if(bytes(next)>limit)break;input.segments=next.segments;}
  if(!input.segments!.length&&session.segments.length)throw Error('assistant_context_budget');
  const source=[...new Map([...input.segments!,...input.speakerSegments!].map(s=>[s.id,s])).values()];
  const result=await checked(input,source);const received=new Set(result.speakerTurns?.map(t=>t.segmentId));result.speakerTurns=[...deferred,...(result.speakerTurns||[]),...input.speakerSegments!.filter(s=>!received.has(s.id)).map(s=>({segmentId:s.id,parts:[{speaker:'unknown' as const,text:s.text}]}))];return withTurns(result);
 }
 const chunks:ContextInput[]=[];let input:ContextInput={basis,segments:[],scope:'batch'};
 for(const segment of session.segments){const next={...input,segments:[...input.segments!,segment]};if(bytes(next)>limit){if(!input.segments!.length)throw Error('assistant_context_budget');chunks.push(input);input={basis,segments:[segment],scope:'batch'};if(bytes(input)>limit)throw Error('assistant_context_budget');}else input=next;}
 chunks.push(input);if(chunks.length>64)throw Error('assistant_context_budget');
 // Three bounded requests in flight; final reduction starts only after every batch succeeded.
 const reports:InterviewAnalysis[]=new Array(chunks.length);let cursor=0,failed=false;
 const outcomes=await Promise.allSettled(Array.from({length:Math.min(3,chunks.length)},async()=>{while(!failed&&cursor<chunks.length){const i=cursor++;try{reports[i]=await checked(chunks[i],chunks[i].segments!);}catch(e){failed=true;throw e;}}}));
 for(const outcome of outcomes)if(outcome.status==='rejected')throw outcome.reason;
 let level=reports;
 while(level.length>1){
  const groups:ContextInput[]=[];let group:ContextInput={basis,reports:[],scope:'merge'};
  for(const report of level){const next={...group,reports:[...group.reports!,report]};if(bytes(next)>limit){if(!group.reports!.length)throw Error('assistant_context_budget');groups.push(group);group={basis,reports:[report],scope:'merge'};if(bytes(group)>limit)throw Error('assistant_context_budget');}else group=next;}
  groups.push(group);if(groups.length>=level.length)throw Error('assistant_context_budget');
  level=[];for(const g of groups)level.push(await checked(g,session.segments));
 }
 return withTurns(level[0]);
}
