import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import {EventEmitter} from 'node:events';
import {requestResumeJson} from '../src/parsing/resume-model.js';
import type {Config} from '../src/config.js';

test('resume requests accept the current gateway model and preserve legacy model configurations',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'resume-model-transport-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const config={modelConfigFile:path.join(root,'model.json')} as Config,caFile=path.join(root,'ca.pem');
 fs.writeFileSync(caFile,'synthetic-test-ca');
 let sent:any,finishReason='stop';
 t.mock.method(https,'request',((url:string,options:any,callback:any)=>{
  assert.equal(url,'https://model.example.test/v1/chat/completions');
  assert.equal(options.ca.toString(),'synthetic-test-ca');
  assert.equal(options.headers.authorization,'Bearer synthetic-test-token');
  const request=new EventEmitter() as any;
  request.destroy=()=>{};
  request.end=(body:string)=>{
   sent=JSON.parse(body);
   queueMicrotask(()=>{const response=new EventEmitter() as any;response.statusCode=200;callback(response);response.emit('data',Buffer.from(JSON.stringify({choices:[{finish_reason:finishReason,message:{content:'{"ok":true}'}}],usage:{total_tokens:3}})));response.emit('end');});
  };
  return request;
 }) as any);
 for(const model of ['deepseek-flash','deepseek-v4-pro','deepseek-v4.1-flash']){
  fs.writeFileSync(config.modelConfigFile!,JSON.stringify({baseUrl:'https://model.example.test/v1',apiKey:'synthetic-test-token',model,caFile}));
  const result=await requestResumeJson(config,'synthetic resume','Return JSON.',100);
  assert.equal(sent.model,model);assert.equal(sent.stream,false);assert.equal(result.model,model);assert.equal(result.content,'{"ok":true}');
  assert.deepEqual(sent.thinking,model==='deepseek-v4.1-flash'?{type:'disabled'}:undefined);
 }
 finishReason='length';
 await assert.rejects(requestResumeJson(config,'synthetic resume','Return JSON.'),/resume_model_response_invalid/);
 for(const model of ['unknown-model','']){
  fs.writeFileSync(config.modelConfigFile!,JSON.stringify({baseUrl:'https://model.example.test/v1',apiKey:'synthetic-test-token',model,caFile}));
  await assert.rejects(requestResumeJson(config,'synthetic resume','Return JSON.'),/resume_model_config_invalid/);
 }
});
