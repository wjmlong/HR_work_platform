import test from 'node:test';import assert from 'node:assert/strict';
import {validateAnalysis} from '../src/interview-assistant/contracts.js';
const segments:any[]=[{id:'mix',sequence:1,source:'mixed',speaker:'unknown',text:'你做过什么？我做过接口集成。',startMs:0,endMs:5000}];
const report=()=>({suggestions:[{dimensionId:'skill',question:'这里的接口如何处理重复请求？',reason:'对话提到接口集成，需核实具体实现。',evidence:[{segmentId:'mix',quote:'接口集成'}]}],dimensions:[{dimensionId:'skill',status:'not_covered',summary:'尚无归属明确的个人能力证据',evidence:[]}],discussionSummary:[{summary:'对话涉及接口集成，职责待核实。',evidence:[{segmentId:'mix',quote:'我做过接口集成'}]}],nextSteps:['核实个人职责']});
test('unattributed conversation supports grounded followups and minutes',()=>{assert.equal(validateAnalysis(report(),segments,['skill']).discussionSummary?.length,1);});
test('unattributed speech cannot become candidate capability evidence',()=>{const r:any=report();r.dimensions[0]={dimensionId:'skill',status:'evidence',summary:'候选人会接口集成',evidence:[{segmentId:'mix',quote:'接口集成'}]};assert.throws(()=>validateAnalysis(r,segments,['skill']),/unconfirmed_speaker/);});
test('conversation minutes reject invented citations',()=>{const r=report();r.discussionSummary[0].evidence[0].quote='并不存在的原话';assert.throws(()=>validateAnalysis(r,segments,['skill']),/invalid_citation/);});
