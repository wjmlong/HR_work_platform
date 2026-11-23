import test from 'node:test';import assert from 'node:assert/strict';
import * as context from '../src/interview-assistant/context.js';
const segment=(n:number)=>({id:'s'+n,sequence:n,source:'meeting' as const,speaker:'candidate' as const,text:'第'+n+'段：'+ '我负责重试模块。'.repeat(30),startMs:n*1000,endMs:n*1000+900});
const session={basis:{job:'自动化',dimensions:[{id:'skill',label:'专业能力'}]},segments:Array.from({length:36},(_,n)=>segment(n+1))};
function report(refs:any[]){return {suggestions:[],dimensions:[{dimensionId:'skill',status:refs.length?'evidence':'not_covered',summary:refs.length?'候选人描述了项目职责':'未覆盖',evidence:refs.slice(0,8)}],nextSteps:[]};}
test('final analysis visits every original segment with bounded inputs and preserves early and late evidence',async()=>{
 const seen:string[]=[];let calls=0;
 const result=await context.analyzeBounded(session,async payload=>{calls++;assert.ok(Buffer.byteLength(JSON.stringify(payload))<=5000);if(payload.segments){seen.push(...payload.segments.map((s:any)=>s.id));const selected=payload.segments.filter((s:any)=>['s1','s36'].includes(s.id));return report(selected.map((s:any)=>({segmentId:s.id,quote:s.text.slice(0,12)})));}return report(payload.reports.flatMap((r:any)=>r.dimensions.flatMap((d:any)=>d.evidence)));},{final:true,inputBytes:5000});
 assert.deepEqual(seen,session.segments.map(s=>s.id));assert.ok(calls>1);assert.deepEqual(result.dimensions[0].evidence.map(e=>e.segmentId),['s1','s36']);
});
test('live analysis uses recent original text without modifying stored full transcript',async()=>{
 const before=JSON.stringify(session);let submitted:any;
 await context.analyzeBounded(session,async payload=>{submitted=payload;return report([]);},{final:false,inputBytes:5000});
 assert.equal(submitted.segments.at(-1).id,'s36');assert.ok(submitted.segments.length<36);assert.equal(JSON.stringify(session),before);
});
test('one failed batch prevents a falsely complete final report',async()=>{
 await assert.rejects(context.analyzeBounded(session,async payload=>{if(payload.segments?.some((s:any)=>s.id==='s36'))throw Error('upstream failed');return report([]);},{final:true,inputBytes:5000}),/upstream failed/);
});
test('oversized basis fails explicitly before model call instead of truncating source',async()=>{
 let called=false;await assert.rejects(context.analyzeBounded({...session,basis:{...session.basis,job:'x'.repeat(6000)}},async()=>{called=true;return report([]);},{final:true,inputBytes:5000}),/context_budget/);assert.equal(called,false);
});
test('merge cannot turn a dimension with verified earlier evidence into not covered',async()=>{
 await assert.rejects(context.analyzeBounded(session,async payload=>payload.segments?report([{segmentId:payload.segments[0].id,quote:payload.segments[0].text.slice(0,10)}]):report([]),{final:true,inputBytes:5000}),/context_evidence_lost/);
});
test('a failed analysis waits for its already started requests before releasing the session',async()=>{
 let active=0;await assert.rejects(context.analyzeBounded(session,async payload=>{if(payload.segments?.[0].id==='s1')throw Error('failed batch');active++;try{await new Promise(r=>setTimeout(r,10));return report([]);}finally{active--;}},{final:true,inputBytes:5000}),/failed batch/);assert.equal(active,0);
});
