type Part={speaker:string;text:string};
type Turn={segmentId:string;parts:Part[]};
export function speakerBubbles(segment:{id:string;speaker:string;text:string},turns:Turn[]=[]){
 const confirmed=segment.speaker==='candidate'||segment.speaker==='interviewer';
 const guess=turns.find(t=>t.segmentId===segment.id);
 const valid=guess?.parts.length&&guess.parts.every(p=>['candidate','interviewer','unknown'].includes(p.speaker)&&p.text.length>0)&&guess.parts.map(p=>p.text).join('')===segment.text;
 const parts=confirmed?[{speaker:segment.speaker,text:segment.text}]:valid?guess!.parts:[{speaker:'unknown',text:segment.text}];
 return parts.map(part=>({...part,inferred:!confirmed&&part.speaker!=='unknown',side:part.speaker==='candidate'?'left':part.speaker==='interviewer'?'right':'center',label:part.speaker==='candidate'?'候选人':part.speaker==='interviewer'?'面试官':'发言方未确定'}));
}
