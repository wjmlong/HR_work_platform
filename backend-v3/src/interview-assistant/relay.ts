import fs from 'node:fs';
import type {PoolClient} from 'pg';
import {randomUUID} from 'node:crypto';
import WebSocket from 'ws';
import type {FastifyInstance} from 'fastify';
import type {Identity} from '../identity/service.js';
import type {InterviewAssistant} from './service.js';
import {settings} from './realtime.js';
import {fail} from '../http/errors.js';

type Context = {instructions:Record<string,unknown>|null;contextState:string};
type RelayOptions = {authorize:()=>Promise<void>;context:()=>Promise<Context>;connect:()=>WebSocket;checkMs?:number};
// Only bounded PCM and a stop/cancel signal cross the client trust boundary.
export function relayConnection(client:WebSocket, options:RelayOptions){
 let upstream:WebSocket|undefined,closed=false,ready=false,busy=false,frames=0,bytes=0,windowAt=Date.now(),lastContext=0,queued=0;
 let chain=Promise.resolve();
 const pending=new Set<Promise<unknown>>();
 // Track the real operation, including work still running after its timeout race.
 const track=<T>(operation:()=>Promise<T>)=>{if(closed)return Promise.reject<T>(Error('closed'));const work=operation();pending.add(work);void work.then(()=>pending.delete(work),()=>pending.delete(work));return work;};
 const finish=(code=1000,reason='连接已关闭')=>{if(closed)return;closed=true;clearInterval(check);clearTimeout(initial);for(const ws of [client,upstream])if(ws){ws.close(code,reason);const t=setTimeout(()=>ws.terminate(),1000);t.unref();ws.once('close',()=>clearTimeout(t));}};
 const send=(ws:WebSocket,value:unknown)=>{if(closed||ws.readyState!==WebSocket.OPEN)return;if(ws.bufferedAmount>512*1024){finish(1008,'音频积压过多');return;}ws.send(JSON.stringify(value));};
 const bounded=async<T>(operation:Promise<T>)=>{let deadline:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([operation,new Promise<never>((_,reject)=>{deadline=setTimeout(()=>reject(Error('authorization_timeout')),2000);})]);}finally{clearTimeout(deadline);}};
 const update=async()=>{const context=await bounded(track(options.context));if(!context.instructions)throw Error('context');send(upstream!,{event_id:randomUUID(),type:'session.update',session:ready?{instructions:context.instructions.instructions}:context.instructions});lastContext=Date.now();};
 const validate=async()=>{if(closed)throw Error('closed');await bounded(track(options.authorize));if(closed)throw Error('closed');};
 const initial=setTimeout(()=>finish(1011,'实时初始化超时'),20000);
 const check=setInterval(()=>{if(busy||closed)return;busy=true;void validate().then(async()=>{if(ready&&Date.now()-lastContext>=15000)await update();}).catch(()=>finish(1008,'权限或会话已失效')).finally(()=>{busy=false;});},options.checkMs??3000);
 client.on('close',()=>finish());client.on('error',()=>finish(1011,'连接中断'));
 client.on('message',(data,binary)=>{
  if(closed)return;
  if(Date.now()-windowAt>=1000){windowAt=Date.now();frames=0;bytes=0;}
  frames++;bytes+=Buffer.byteLength(data as Buffer);
  if(binary||Buffer.byteLength(data as Buffer)>65536||frames>40||bytes>100000||queued>=8){finish(1008,'音频或消息超过限制');return;}
  let event:any;try{event=JSON.parse(data.toString());}catch{finish(1008,'消息格式无效');return;}
  if(!event||typeof event!=='object'||!['audio','stop','cancel'].includes(event.type)||Object.keys(event).some(k=>!['type','audio'].includes(k))){finish(1008,'不支持的实时操作');return;}
  if(event.type==='audio'&&(!ready||typeof event.audio!=='string'||event.audio.length>44000||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.audio)||!event.audio.length||Buffer.from(event.audio,'base64').length%2)){finish(1008,'音频格式无效');return;}
  queued++;
  chain=chain.then(async()=>{await validate();if(event.type==='audio')send(upstream!,{event_id:randomUUID(),type:'input_audio_buffer.append',audio:event.audio});else if(event.type==='cancel')send(upstream!,{event_id:randomUUID(),type:'response.cancel'});else { // Silence closes server VAD without an unsafe empty commit.
    send(upstream!,{event_id:randomUUID(),type:'input_audio_buffer.append',audio:Buffer.alloc(32000).toString('base64')});
  }}).catch(()=>finish(1008,'权限或会话已失效')).finally(()=>{queued--;});
 });
 void validate().then(()=>{if(closed)return;upstream=options.connect();upstream.on('error',()=>finish(1011,'实时服务连接失败'));upstream.on('close',()=>finish(1011,'实时服务连接中断'));upstream.on('message',(data,binary)=>{
  if(closed)return;if(binary||Buffer.byteLength(data as Buffer)>512*1024){finish(1011,'实时服务响应过大');return;}
  let e:any;try{e=JSON.parse(data.toString());}catch{finish(1011,'实时服务响应无效');return;}
  if(e.type==='session.created'){void update().catch(()=>finish(1008,'历史上下文不可用'));return;}
  if(e.type==='session.updated'){if(!ready){ready=true;clearTimeout(initial);send(client,{type:'relay.ready'});}return;}
  if(e.type==='error'||e.type==='conversation.item.input_audio_transcription.failed'){finish(1011,'实时模型返回错误，请核对最后一段原话');return;}
  // Do not expose upstream session metadata, authorization, tool calls or raw errors.
  const allowed=['input_audio_buffer.speech_started','input_audio_buffer.speech_stopped','conversation.item.input_audio_transcription.completed','response.created','response.done','response.text.delta','response.audio_transcript.delta','response.audio.delta','response.audio.done'];
  if(allowed.includes(e.type))send(client,{type:e.type,item_id:e.item_id,audio_start_ms:e.audio_start_ms,audio_end_ms:e.audio_end_ms,transcript:e.transcript,delta:e.delta});
 });}).catch(()=>finish(1008,'权限或会话已失效'));
 return Object.assign(finish,{drain:async()=>{await chain;while(pending.size)await Promise.allSettled([...pending]);}});
}
export function realtimeRelayRoute(app:FastifyInstance,id:Identity,service:InterviewAssistant,contextFor:(session:any,mode:'hints'|'voice')=>Context){
 const active=new Map<string,()=>Promise<void>>();
 app.addHook('onClose',async()=>{await Promise.allSettled([...active.values()].map(close=>close()));});
 app.get<{Params:{id:string;sessionId:string};Querystring:{mode?:string}}>('/api/v4/interviews/:id/assistant/:sessionId/relay',{
  websocket:true,
  preValidation:async req=>{
   const protocols=String(req.headers['sec-websocket-protocol']||'').split(',').map(s=>s.trim());
   if(req.headers.origin!==id.config.origin||protocols.length!==2||!protocols.includes('recruit-realtime')||!protocols.includes('csrf.'+req.actor.csrf))fail(403,'csrf_invalid');
   if(!['hints','voice'].includes(req.query.mode||'')||Object.keys(req.query).some(k=>k!=='mode'))fail(422,'invalid_input');
   if(active.has(req.params.sessionId)||active.size>=2)fail(429,'assistant_busy');
   const session=await service.read(req.actor,req.params.id,req.params.sessionId);
   if(session.owner_id!==req.actor.id||session.state!=='active')fail(403,'assistant_session_owner');
   settings(id.config);
  }
 },(socket,req)=>{
  const {id:interviewId,sessionId}=req.params,mode=req.query.mode as 'hints'|'voice';
  if(active.has(sessionId)||active.size>=2){socket.close(1008,'已有实时连接');return;}
  const read=async()=>{const actor=await id.interviewActor(await id.authenticate(req),interviewId);const session=await service.read(actor,interviewId,sessionId);if(session.owner_id!==actor.id||session.state!=='active')throw Error('ended');return session;};
  let lock:PoolClient|undefined,held=false,lockReady=false,releasePromise:Promise<void>|undefined;
  const lockError=()=>socket.close(1011,'授权连接中断');
  const lockKey=id.config.schema+':realtime-user:'+req.actor.id;
  const release=()=>{if(!lock||!lockReady)return Promise.resolve();return releasePromise??=(async()=>{const connection=lock!;try{if(held)await connection.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[lockKey]);connection.removeListener('error',lockError);connection.release();}catch{connection.removeListener('error',lockError);connection.release(true);}})();};
  let relay:ReturnType<typeof relayConnection>|undefined,setup=Promise.resolve(),shutdownPromise:Promise<void>|undefined;
  const shutdown=()=>shutdownPromise??=(async()=>{
   if(relay)relay();else socket.close(1001,'服务正在关闭');
   await setup;
   relay?.();await relay?.drain();await release();
   active.delete(sessionId);
  })();
  // Keep closing sessions registered until their actual async work and lock release finish.
  active.set(sessionId,shutdown);socket.once('close',()=>{void shutdown();});
  setup=(async()=>{try{lock=await id.db.pool.connect();if(socket.readyState!==WebSocket.OPEN){lockReady=true;await release();return;}lock.on('error',lockError);held=(await lock.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) ok',[lockKey])).rows[0].ok;lockReady=true;if(!held)throw Error('busy');if(socket.readyState!==WebSocket.OPEN){await release();return;}
   relay=relayConnection(socket,{authorize:async()=>{await read();},context:async()=>contextFor(await read(),mode),connect:()=>{const s=settings(id.config),url=new URL(s.baseUrl);url.protocol='wss:';url.pathname='/api-ws/v1/realtime';url.searchParams.set('model',s.model);return new WebSocket(url,{headers:{Authorization:'Bearer '+s.apiKey},ca:s.caFile?fs.readFileSync(s.caFile):undefined,handshakeTimeout:15000,maxPayload:512*1024,perMessageDeflate:false});}});
  }catch{lockReady=true;socket.close(1008,'已有实时连接或授权暂不可用');await release();}})();
 });
}
