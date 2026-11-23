import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import https from 'node:https';import {execFileSync} from 'node:child_process';import {once} from 'node:events';import WebSocket,{WebSocketServer} from 'ws';
import {testDatabase,actor} from './helpers.js';import {Identity} from '../src/identity/service.js';import {InterviewGrants} from '../src/identity/grants.js';import {InterviewService} from '../src/interviews/service.js';import {RecruitingService} from '../src/recruiting/service.js';import {InterviewAssistant} from '../src/interview-assistant/service.js';import {buildApp} from '../src/http/app.js';import {realtimeUpgrades} from '../src/http/realtime-upgrade.js';
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(fn:()=>boolean,ms=5000){const end=Date.now()+ms;while(!fn()){if(Date.now()>end)throw Error('condition timeout');await wait(20);}}
async function fixture(t:any){
 const f=await testDatabase(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'relay-test-')),key=path.join(dir,'key.pem'),ca=path.join(dir,'cert.pem');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',ca,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{stdio:'ignore'});
 const tls={key:fs.readFileSync(key),cert:fs.readFileSync(ca)},upstream=https.createServer(tls),vendor=new WebSocketServer({server:upstream}),received:any[]=[],peers:WebSocket[]=[],paths:string[]=[];
 vendor.on('connection',(socket,req)=>{assert.equal(req.headers.authorization,'Bearer synthetic-only-key');paths.push(req.url!);peers.push(socket);socket.send(JSON.stringify({type:'session.created',session:{private:'do not expose'}}));socket.on('message',data=>{const e=JSON.parse(data.toString());received.push(e);if(e.type==='session.update')socket.send(JSON.stringify({type:'session.updated'}));if(e.type==='input_audio_buffer.append'){socket.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'a',transcript:'合成原话'}));socket.send(JSON.stringify({type:'response.text.delta',delta:'合成建议'}));}});});
 await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));
 f.config.feishu={...f.config.feishu,appId:'app',tenant:'company'};f.config.speechConfigFile=path.join(dir,'speech.json');fs.writeFileSync(f.config.speechConfigFile,JSON.stringify({provider:'qwen-realtime',baseUrl:`https://localhost:${(upstream.address() as any).port}/api/v1`,model:'qwen3.8-omni-flash-realtime',apiKey:'synthetic-only-key',caFile:ca}));
 const person={tenant:'company',appId:'app',openId:'ou_relay',name:'临时面试官',active:true},provider={configured:()=>true,authorizeUrl:()=>'',identity:async()=>person,contact:async(openId:string)=>({...person,openId})},identity=new Identity(f.db,f.config,provider),admin=await actor(f.db),recruiting=new RecruitingService(identity),interviews=new InterviewService(identity),grants=new InterviewGrants(identity);
 const job=await recruiting.createJob(admin,{name:'合成岗位',level:'P5'}),candidate=await recruiting.createCandidate(admin,{name:'合成候选人'}),application=await recruiting.apply(admin,{jobId:job.id,candidateId:candidate.id}),interview=await interviews.create(admin,{applicationId:application.id,round:1,startsAt:'2030-01-01T09:00:00Z',durationMinutes:45,form:'online',interviewerIds:[admin.id]}),grant=await grants.grant(admin,interview.id,{openId:person.openId,role:'interviewer'}),token=await identity.establish(person),a=await identity.interviewActor(await identity.authenticate({cookies:{'__Host-recruit_v4_session':token}} as any),interview.id),session=await new InterviewAssistant(identity).start(a,interview.id,{consent:true});
 const apps=[await buildApp({db:f.db,config:f.config,provider}),await buildApp({db:f.db,config:f.config,provider})];for(const app of apps)await app.listen({port:0,host:'127.0.0.1'});
 let maintenance=false;const gateway=https.createServer(tls),closeGateway=realtimeUpgrades(gateway,new URL(f.config.origin),apps.map(app=>(app.server.address() as any).port),()=>maintenance);await new Promise<void>(r=>gateway.listen(0,'127.0.0.1',r));
 const endpoint='/api/v4/interviews/'+interview.id+'/assistant/'+session.id+'/relay?mode=hints',headers={host:new URL(f.config.origin).host,origin:f.config.origin,cookie:'__Host-recruit_v4_session='+token,'x-forwarded-proto':'https'},clients:WebSocket[]=[];
 const connect=(options:any={})=>{const client=new WebSocket('wss://127.0.0.1:'+(gateway.address() as any).port+endpoint,options.protocols||['recruit-realtime','csrf.'+a.csrf],{rejectUnauthorized:false,headers:{...headers,...options.headers}});clients.push(client);return client;};
 t.after(async()=>{for(const client of clients)client.terminate();closeGateway();await new Promise<void>(r=>gateway.close(()=>r()));for(const app of apps)await app.close();for(const peer of peers)peer.terminate();vendor.close();await new Promise<void>(r=>upstream.close(()=>r()));await f.cleanup();fs.rmSync(dir,{recursive:true,force:true});});
 return {...f,identity,admin,grants,grant,interview,session,token,connect,received,peers,paths,apps,setMaintenance:(value:boolean)=>maintenance=value};
}
function capture(socket:WebSocket){const events:any[]=[];socket.on('message',data=>events.push(JSON.parse(data.toString())));socket.on('error',()=>{});return events;}
async function rejected(socket:WebSocket){socket.on('error',()=>{});return new Promise<number>(resolve=>{socket.on('unexpected-response',(_,r)=>{r.resume();socket.terminate();resolve(r.statusCode!);});});}
test('authenticated gateway relay controls config, audio, cross-instance ownership and revocation',async t=>{
 const f=await fixture(t);assert.equal(await rejected(f.connect({headers:{origin:'https://evil.invalid'}})),403);assert.equal(await rejected(f.connect({protocols:['recruit-realtime','csrf.wrong']})),403);assert.equal(f.peers.length,0);
 const client=f.connect(),events=capture(client);await until(()=>events.some(e=>e.type==='relay.ready'));assert.equal(client.protocol,'recruit-realtime');assert.equal(f.paths[0],'/api-ws/v1/realtime?model=qwen3.8-omni-flash-realtime');assert.match(f.received[0].session.instructions,/合成岗位/);assert.equal(JSON.stringify(events).includes('private'),false);
 client.send(JSON.stringify({type:'audio',audio:Buffer.alloc(3200).toString('base64')}));await until(()=>events.some(e=>e.transcript==='合成原话'));assert.ok(events.some(e=>e.delta==='合成建议'));
 const duplicate=f.connect();capture(duplicate);const duplicateResult=await Promise.race([once(duplicate,'close').then(([code])=>code),new Promise<number>(r=>duplicate.on('unexpected-response',(_,response)=>{response.resume();duplicate.terminate();r(response.statusCode!);} ))]);assert.ok([1008,429].includes(duplicateResult));assert.equal(f.peers.length,1);
 const closed=once(client,'close'),start=Date.now();await f.grants.revoke(f.admin,f.grant.id);assert.equal((await closed)[0],1008);assert.ok(Date.now()-start<5000);await until(()=>f.peers[0].readyState===WebSocket.CLOSED);assert.equal(await rejected(f.connect()),403);
});
test('relay refuses arbitrary settings and oversized frames then releases ownership',async t=>{
 const f=await fixture(t),client=f.connect(),events=capture(client);await until(()=>events.some(e=>e.type==='relay.ready'));const closed=once(client,'close');client.send(JSON.stringify({type:'session.update',session:{instructions:'client override'}}));assert.equal((await closed)[0],1008);assert.equal(f.received.some(e=>e.session?.instructions==='client override'),false);await wait(100);
 const second=f.connect(),more=capture(second);await until(()=>more.some(e=>e.type==='relay.ready'));const large=once(second,'close');second.send('x'.repeat(70000));assert.equal((await large)[0],1009);
});
test('relay closes on original login expiry and maintenance rejects upgrades',async t=>{
 const f=await fixture(t),client=f.connect(),events=capture(client);await until(()=>events.some(e=>e.type==='relay.ready'));const closed=once(client,'close');await f.db.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",[f.identity.hash(f.token)]);assert.equal((await closed)[0],1008);f.setMaintenance(true);assert.equal(await rejected(f.connect()),503);
});
test('context refresh sends only instructions and ended session closes existing relay',async t=>{
 const f=await fixture(t),client=f.connect(),events=capture(client);await until(()=>events.some(e=>e.type==='relay.ready'));// 15s freshness + up to3s poll + bounded2s authorization + bounded2s context, plus scheduling margin.
 await until(()=>f.received.filter(e=>e.type==='session.update').length>=2,24000);assert.deepEqual(Object.keys(f.received.filter(e=>e.type==='session.update')[1].session),['instructions']);const closed=once(client,'close');await f.db.query("UPDATE interview_assistant_sessions SET state='finished' WHERE id=$1",[f.session.id]);assert.equal((await closed)[0],1008);
});
test('grant expiry and interview cancellation both terminate already-open relays',async t=>{
 const f=await fixture(t),client=f.connect(),events=capture(client);await until(()=>events.some(e=>e.type==='relay.ready'));const closed=once(client,'close');await f.db.query("UPDATE interview_access_grants SET starts_at=now()-interval '2 seconds',expires_at=now()-interval '1 second' WHERE id=$1",[f.grant.id]);assert.equal((await closed)[0],1008);await f.grants.extend(f.admin,f.grant.id,'2030-01-04T00:00:00Z');await wait(100);
 const next=f.connect(),more=capture(next);await until(()=>more.some(e=>e.type==='relay.ready'));const cancelled=once(next,'close');await f.db.query("UPDATE interviews SET status='cancelled' WHERE id=$1",[f.interview.id]);assert.equal((await cancelled)[0],1008);await until(()=>f.peers.every(p=>p.readyState===WebSocket.CLOSED));
});
test('client burst is bounded before unlimited audio can reach the vendor',async t=>{
 const f=await fixture(t),client=f.connect(),events=capture(client);await until(()=>events.some(e=>e.type==='relay.ready'));const closed=once(client,'close');for(let n=0;n<100;n++)client.send(JSON.stringify({type:'audio',audio:Buffer.alloc(3200).toString('base64')}));assert.equal((await closed)[0],1008);assert.ok(f.received.filter(e=>e.type==='input_audio_buffer.append').length<=8);
});

test('app close drains an in-flight authorization and queued audio before releasing ownership',async t=>{
 const f=await fixture(t),client=f.connect(),events=capture(client);await until(()=>events.some(e=>e.type==='relay.ready'));
 let entered=false,release!:()=>void,reads=0,closing=false;const gate=new Promise<void>(r=>release=r),query=f.db.query.bind(f.db);
 f.db.query=(async(sql:string,values?:unknown[])=>{if(sql.startsWith('SELECT s.*,EXISTS')){reads++;if(!entered){entered=true;await gate;}}return query(sql,values);}) as typeof f.db.query;
 try{
 for(let n=0;n<3;n++)client.send(JSON.stringify({type:'audio',audio:Buffer.alloc(3200).toString('base64')}));await until(()=>entered);
 const stopped=Promise.all(f.apps.map(app=>app.close())).then(()=>{closing=true;});await wait(50);assert.equal(closing,false,'app close must await the actual read, not just WebSocket close');
 release();await stopped;const atClose=reads;await wait(50);assert.equal(reads,atClose);assert.equal(reads,1,'queued callbacks must not start new authorization after close');
 const lock=await f.db.pool.connect(),key=f.config.schema+':realtime-user:'+f.grant.user_id;
 try{assert.equal((await lock.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) ok',[key])).rows[0].ok,true,'shutdown releases cross-instance ownership');await lock.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);}finally{lock.release();}
 }finally{release();f.db.query=query;}
});

test('shutdown drains context work that outlives its authorization timeout',async t=>{
 const f=await fixture(t);let reads=0,entered=false,release!:()=>void,stopped=false;const gate=new Promise<void>(r=>release=r),query=f.db.query.bind(f.db);
 // First read validates the upgrade, second authorizes the relay, third builds initial context.
 f.db.query=(async(sql:string,values?:unknown[])=>{if(sql.startsWith('SELECT s.*,EXISTS')&&++reads===3){entered=true;await gate;}return query(sql,values);}) as typeof f.db.query;
 try{
 const client=f.connect();capture(client);const closed=once(client,'close');await until(()=>entered);assert.equal((await closed)[0],1008,'the production2s context timeout still closes the connection');
 const drained=Promise.all(f.apps.map(app=>app.close())).then(()=>{stopped=true;});await wait(50);assert.equal(stopped,false,'timeout racing does not cancel the underlying database work');
 release();await drained;assert.equal(reads,3);
 }finally{release();f.db.query=query;}
});
