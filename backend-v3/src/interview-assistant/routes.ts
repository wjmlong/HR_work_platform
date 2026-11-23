import {realtimeRelayRoute} from './relay.js';
import {InterviewMemory} from './memory.js';
import {exchangeOffer,realtimeContext} from './realtime.js';
import type {FastifyInstance} from 'fastify';import type {Identity} from '../identity/service.js';import {requireRole} from '../identity/service.js';import {parse,z,uuid} from '../http/validation.js';import {fail} from '../http/errors.js';import {InterviewAssistant} from './service.js';
import {InterviewReviewService} from './review.js';import {assistantStatus,analyzeSession,transcribe,summarizeContinuity} from './model.js';
export function interviewAssistantRoutes(app:FastifyInstance,id:Identity){
 const service=new InterviewAssistant(id),review=new InterviewReviewService(id),root='/api/v4/interviews/:id/assistant',params=(p:unknown)=>parse(z.object({id:uuid,sessionId:uuid.optional()}),p);
 // I-1~I-6：静态路径先于 /:sessionId 注册，避免被动态段吞掉；沿用 app.ts 的 assistant 授权白名单。
 app.get(root+'/context-card',req=>{const p=params(req.params),q=parse(z.object({reveal:z.enum(['1']).optional()}).strict(),req.query);return review.contextCard(req.actor,p.id,q.reveal==='1');});
 app.get(root+'/evidence',req=>review.evidence(req.actor,params(req.params).id));
 app.get(root+'/output-review',req=>review.outputReview(req.actor,params(req.params).id));
 app.post(root+'/output-review',req=>review.saveReview(req.actor,params(req.params).id,req.body));
 app.post(root+'/output-review/archive',req=>review.archive(req.actor,params(req.params).id,req.body));
 const memory=new InterviewMemory((input,signal)=>summarizeContinuity(id.config,input,signal));app.addHook('onClose',async()=>memory.close());
 const busy=new Set<string>();
 function contextFor(session:any,mode:'hints'|'voice'){const state=memory.prepare(session.id,session.segments);try{return {instructions:realtimeContext(session,mode,state.context),contextState:state.context?'compacted':'original'};}catch(e){if(state.pending)return {instructions:null,contextState:'preparing'};throw e;}}
 realtimeRelayRoute(app,id,service,contextFor);
 async function limited<T>(key:string,fn:()=>Promise<T>){if(busy.has(key)||busy.size>=6)fail(429,'assistant_busy');busy.add(key);try{return await fn();}finally{busy.delete(key);}}
 app.get('/api/v4/interview-assistant/capabilities',req=>{if(!req.actor.temporaryAccess)requireRole(req.actor,'admin','manager','recruiter','interviewer');return assistantStatus(id.config);});
 app.get(root+'/context',async req=>{const row=await service.access(req.actor,params(req.params).id);return {id:row.id};});
 app.get(root,req=>service.list(req.actor,params(req.params).id));
 app.post(root,req=>service.start(req.actor,params(req.params).id,req.body));
 app.get(root+'/:sessionId',req=>{const p=params(req.params);return service.read(req.actor,p.id,p.sessionId!);});
 app.post(root+'/:sessionId/segments',req=>{const p=params(req.params);return service.append(req.actor,p.id,p.sessionId!,req.body);});
 app.post(root+'/:sessionId/speaker',req=>{const p=params(req.params);return service.setSpeaker(req.actor,p.id,p.sessionId!,req.body);});
 app.post(root+'/:sessionId/abandon',req=>{const p=params(req.params);return service.abandon(req.actor,p.id,p.sessionId!,req.body);});
 app.post(root+'/:sessionId/adopt',req=>{const p=params(req.params);return service.adopt(req.actor,p.id,p.sessionId!,req.body);});
 app.post(root+'/:sessionId/realtime',async req=>{
  if(req.actor.temporaryScope)fail(403,'temporary_realtime_relay_required');
  const p=params(req.params),b=parse(z.object({offer:z.string().min(1).max(100000),mode:z.enum(['hints','voice'])}).strict(),req.body);
  return limited(p.sessionId!+':realtime',async()=>{const session=await service.read(req.actor,p.id,p.sessionId!);if(session.owner_id!==req.actor.id)fail(403,'assistant_session_owner');if(session.state!=='active')fail(409,'assistant_session_finished');const context=contextFor(session,b.mode);if(!context.instructions)fail(409,'assistant_context_preparing');const answer=await exchangeOffer(id.config,b.offer);return {answer,config:context.instructions,contextState:context.contextState};});
 });
 app.post(root+'/:sessionId/realtime-context',async req=>{
  const p=params(req.params),b=parse(z.object({mode:z.enum(['hints','voice'])}).strict(),req.body),session=await service.read(req.actor,p.id,p.sessionId!);
  if(session.owner_id!==req.actor.id)fail(403,'assistant_session_owner');if(session.state!=='active')fail(409,'assistant_session_finished');const context=contextFor(session,b.mode);return {instructions:context.instructions?.instructions||null,contextState:context.contextState};
 });
 app.post(root+'/:sessionId/audio',{bodyLimit:1000000},async req=>{
  const p=params(req.params),b=parse(z.object({id:z.string().min(1).max(100),sequence:z.number().int().positive(),source:z.enum(['meeting','microphone']),speaker:z.enum(['candidate','interviewer','unknown']),startMs:z.number().int().min(0),endMs:z.number().int().min(0),pcm:z.string().max(900000)}).strict(),req.body);
  const session=await service.read(req.actor,p.id,p.sessionId!);if(session.owner_id!==req.actor.id)fail(403,'assistant_session_owner');if(session.state!=='active')fail(409,'assistant_session_finished');
  const prior=session.segments.find((s:any)=>s.id===b.id);if(prior)return {session,segment:prior};
  if(b.endMs<b.startMs||b.endMs-b.startMs>20000)fail(422,'assistant_audio_invalid');
  return limited(p.sessionId!+':audio:'+b.id,async()=>{const text=await transcribe(id.config,b.pcm);if(!text)return {session:await service.read(req.actor,p.id,p.sessionId!),segment:null};const {pcm,...metadata}=b,segment={...metadata,text};return {session:await service.append(req.actor,p.id,p.sessionId!,segment),segment};});
 });
 app.post(root+'/:sessionId/analyze',async req=>{
  const p=params(req.params),b=parse(z.object({final:z.boolean().default(false)}).strict(),req.body);
  return limited(p.sessionId!+':analysis',async()=>{const session=await service.read(req.actor,p.id,p.sessionId!);if(session.owner_id!==req.actor.id)fail(403,'assistant_session_owner');if(session.state!=='active') {if(b.final&&session.state==='finished')return session;fail(409,'assistant_session_finished');}if(!session.segments.length)fail(422,'assistant_transcript_empty');const result=await analyzeSession(id.config,session,b.final);return service.saveAnalysis(req.actor,p.id,p.sessionId!,session.revision,result,b.final);});
 });
}
