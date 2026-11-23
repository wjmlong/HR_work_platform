import {test} from 'node:test';
import assert from 'node:assert/strict';
import {modelStatus,parseModelQuestions,generateModelQuestions} from '../src/materials/model.js';
import type {Config} from '../src/config.js';
test('model remains unavailable without private configuration and does not send requests',async()=>{assert.equal(modelStatus({} as Config).configured,false);await assert.rejects(generateModelQuestions({} as Config,{name:'测试岗位',skills:[]}),/model_not_configured/);});
test('model output rejects malformed, oversized or invented properties before persistence',()=>{for(const data of ['not json','{}',JSON.stringify({questions:[]}),JSON.stringify({questions:Array(4).fill({group:'技术',prompt:'如何验证接口幂等性？',referencePoints:['重试与重复提交'],followups:[],score:95})})])assert.throws(()=>parseModelQuestions(data),/model_response_invalid/);});
test('structured model questions preserve answer points and bounded followups',()=>{const questions=Array(6).fill({group:'技术',prompt:'如何验证接口幂等性？',referencePoints:['唯一键和事务','重试与重复提交'],followups:['如何处理并发请求？']});assert.deepEqual(parseModelQuestions('```json\n'+JSON.stringify({questions})+'\n```'),questions);});
