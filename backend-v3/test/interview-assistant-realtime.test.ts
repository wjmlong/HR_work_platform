import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import https from 'node:https';import {execFileSync} from 'node:child_process';
import {exchangeOffer,realtimeContext,realtimeStatus} from '../src/interview-assistant/realtime.js';
import type {Config} from '../src/config.js';
test('Realtime exchanges SDP with Qwen using server-only authorization',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qwen-realtime-')),key=path.join(dir,'key.pem'),ca=path.join(dir,'cert.pem');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',ca,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{stdio:'ignore'});
 let request:any;let reply='v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
 const server=https.createServer({key:fs.readFileSync(key),cert:fs.readFileSync(ca)},async(req,res)=>{let body='';for await(const part of req)body+=part;request={body,url:req.url,headers:req.headers};res.writeHead(201,{'content-type':'application/sdp'});res.end(reply);});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise<void>(r=>server.close(()=>r()));fs.rmSync(dir,{recursive:true,force:true});});
 const configFile=path.join(dir,'speech.json');fs.writeFileSync(configFile,JSON.stringify({provider:'qwen-realtime',baseUrl:`https://localhost:${(server.address() as any).port}/api/v1`,model:'qwen3.8-omni-flash-realtime',apiKey:'synthetic-only-key',caFile:ca}));
 const config={speechConfigFile:configFile} as Config;assert.equal(realtimeStatus(config),true);
 assert.equal(await exchangeOffer(config,'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'),reply);
 assert.equal(request.url,'/api/v1/webrtc/realtime?model=qwen3.8-omni-flash-realtime');assert.equal(request.headers.authorization,'Bearer synthetic-only-key');assert.equal(request.headers['content-type'],'application/sdp');
 reply='{"apiKey":"not-sdp"}';await assert.rejects(exchangeOffer(config,'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'),/assistant_realtime_invalid/);
});
test('Realtime context retains oldest and newest originals; over-budget fails explicitly',()=>{
 const session={basis:{job:'后端',requirements:{skills:['SQL']},dimensions:[]},segments:[{id:'a',speaker:'candidate',text:'最早原话'}, {id:'z',speaker:'unknown',text:'最后原话'}]};
 const context=realtimeContext(session,'hints');assert.match(context.instructions,/最早原话/);assert.match(context.instructions,/最后原话/);assert.deepEqual(context.modalities,['text']);assert.equal(context.voice,'Tina');
 assert.deepEqual(realtimeContext(session,'voice').modalities,['text','audio']);assert.throws(()=>realtimeContext({...session,segments:[{text:'中'.repeat(50000)}]},'hints'),/assistant_context_budget/);
 assert.equal(JSON.stringify(context).includes('apiKey'),false);
});
