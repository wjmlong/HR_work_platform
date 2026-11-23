import {createHash} from 'node:crypto';
import {Identity,requireRole,type Actor} from '../identity/service.js';
import {InterviewGrants} from '../identity/grants.js';
import {FeishuCalendar} from './calendar.js';
import {DirectoryScheduling} from './scheduling.js';
import {loadDefinition} from '../business-config/fields.js';
import {BusinessConfigService} from '../business-config/service.js';
import {fail,found,ApiError} from '../http/errors.js';
import {parse,z,uuid} from '../http/validation.js';
import type {Sql} from '../db.js';
export interface CalendarProvider {
 botOpenId?:string;connect():Promise<void>;list(id:string,token?:string):Promise<{items:any[];syncToken:string}>;
 event(id:string,event:string):Promise<any>;attendees(id:string,event:string):Promise<any[]>;
 createShared(id:string,key:string,body:any):Promise<any>;patchShared(id:string,event:string,body:any):Promise<void>;
 cancelShared(id:string,event:string):Promise<void>;reconcileAttendees(id:string,event:string,ids:string[],managedIds?:string[],expectedIds?:string[]):Promise<void>;
}
type Schedule={startsAt:string;durationMinutes:number;location:string;meetingUrl:string;cancelled:boolean;openIds:string[]};
type ProviderStep={kind:'patch'|'remove'|'add'|'cancel';before:Schedule;after:Schedule;openId?:string};
type SyncIntent={schedule:Schedule;managedIds:string[];creationAttemptedAt?:string;progress?:{confirmed:Schedule;pending?:ProviderStep}};
type Snapshot={schedule:Schedule|null;raw:any;unsupported:string|null;excludedAttendees:number;participants?:{openId:string;name:string}[]};
const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const equal=(a:any,b:any)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const errorCode=(e:unknown)=>e instanceof ApiError?e.code:'calendar_dependency_unavailable';
const revision=z.number().int().positive();
export class CalendarSync {
 constructor(readonly identity:Identity,readonly factory:()=>CalendarProvider=()=>new FeishuCalendar(identity.config)){}
 get db(){return this.identity.db;} get settings(){return this.identity.config.calendarSync||{enabled:false,calendarId:''};}
 get scope(){const f=this.identity.config.feishu;return createHash('sha256').update(JSON.stringify([f.tenant,f.appId,this.settings.calendarId])).digest('hex');}
 get sourceKey(){return 'calendar:'+this.scope+':';}
 async initialize(){
  const f=this.identity.config.feishu,s=this.settings;
  // Old calendar configurations are disabled; no rows are backfilled on activation.
  await this.db.query('UPDATE calendar_sync_state SET enabled=false WHERE scope<>$1 OR NOT $2',[this.scope,s.enabled]);
  if(!s.enabled)return;if(!s.calendarId||!f.tenant||!f.appId)fail(503,'calendar_sync_not_configured');
  await this.db.query('INSERT INTO calendar_sync_state(scope,tenant,app_id,calendar_id,enabled) VALUES($1,$2,$3,$4,true) ON CONFLICT(scope) DO UPDATE SET enabled=true',[this.scope,f.tenant,f.appId,s.calendarId]);
 }
 async locked<T>(fn:()=>Promise<T>){const c=await this.db.pool.connect();let held=false;try{held=(await c.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) ok',[this.db.config.schema+':calendar:'+this.scope])).rows[0].ok;if(!held)fail(409,'calendar_sync_busy');return await fn();}finally{try{if(held)await c.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[this.db.config.schema+':calendar:'+this.scope]);}finally{c.release();}}}
 async admin(a:Actor){requireRole(a,'admin');const f=this.identity.config.feishu,u=(await this.db.query("SELECT 1 FROM users WHERE id=$1 AND version=$2 AND status='active' AND directory_active AND tenant=$3 AND app_id=$4 AND 'admin'=ANY(roles)",[a.id,a.version,f.tenant,f.appId])).rows[0];if(!u)fail(403,'membership_changed');}
 async status(a:Actor){await this.admin(a);const state=(await this.db.query('SELECT activated_at,last_attempt_at,last_success_at,last_error,requested_at FROM calendar_sync_state WHERE scope=$1',[this.scope])).rows[0]||{};const counts=(await this.db.query("SELECT count(*) FILTER(WHERE state='pending')::int pending,count(*) FILTER(WHERE state='conflict')::int conflicts,count(*) FILTER(WHERE state='error')::int errors FROM calendar_sync_inbox WHERE scope=$1",[this.scope])).rows[0];const outbound=(await this.db.query('SELECT count(*) FILTER(WHERE generation>completed_generation)::int pending,count(*) FILTER(WHERE last_error IS NOT NULL)::int errors FROM calendar_sync_outbox WHERE scope=$1',[this.scope])).rows[0];return {outboundPending:outbound.pending,outboundErrors:outbound.errors,enabled:this.settings.enabled,calendarId:this.settings.calendarId,pollSeconds:60,...state,...counts};}
 async inbox(a:Actor){await this.admin(a);const rows=(await this.db.query("SELECT b.*,l.interview_id,i.version interview_version FROM calendar_sync_inbox b LEFT JOIN calendar_event_links l USING(scope,event_id) LEFT JOIN interviews i ON i.id=l.interview_id WHERE b.scope=$1 AND b.state<>'synced' ORDER BY b.updated_at DESC LIMIT 200",[this.scope])).rows;const outbound=(await this.db.query("SELECT o.interview_id,o.attempts,o.last_error,o.next_attempt_at,o.generation,o.completed_generation,c.profile->>'name' AS candidate_name,j.name AS job_name,i.round,i.starts_at FROM calendar_sync_outbox o JOIN interviews i ON i.id=o.interview_id JOIN applications a ON a.id=i.application_id JOIN candidates c ON c.id=a.candidate_id JOIN jobs j ON j.id=a.job_id WHERE o.scope=$1 AND o.generation>o.completed_generation ORDER BY o.next_attempt_at LIMIT 200",[this.scope])).rows;return {outbound,items:rows.map(r=>({eventId:r.event_id,interviewId:r.interview_id||null,interviewVersion:r.interview_version||null,state:r.state,revision:r.revision,reason:r.reason,summary:String(r.snapshot.raw?.summary||'').slice(0,500),schedule:r.snapshot.schedule,participants:r.snapshot.participants||[],excludedAttendees:r.excluded_attendees,updatedAt:r.updated_at}))};}
 async requestRun(a:Actor){await this.admin(a);if(!this.settings.enabled)fail(409,'calendar_sync_disabled');await this.initialize();await this.db.query('UPDATE calendar_sync_state SET requested_at=now() WHERE scope=$1',[this.scope]);return {queued:true};}
 async retry(a:Actor,id:string){await this.admin(a);await this.db.query("UPDATE calendar_sync_outbox SET next_attempt_at=now(),last_error=CASE WHEN last_error IN ('creation_receipt_mismatch','calendar_creation_recovery_required','cancelled_waiting_for_creation_receipt') THEN last_error ELSE NULL END WHERE scope=$1 AND interview_id=$2",[this.scope,id]);await this.db.query("UPDATE calendar_sync_inbox b SET state=CASE WHEN l.id IS NULL THEN 'pending' ELSE 'retry' END,reason=NULL FROM calendar_event_links l WHERE b.scope=$1 AND l.scope=b.scope AND l.event_id=b.event_id AND l.interview_id=$2 AND b.state='error'",[this.scope,id]);await this.db.query("UPDATE calendar_event_links SET state='retry',last_error=NULL WHERE scope=$1 AND interview_id=$2 AND state='error'",[this.scope,id]);return this.requestRun(a);}
 async readEvent(p:CalendarProvider,eventId:string){try{return await p.event(this.settings.calendarId,eventId);}catch(e){if(errorCode(e)==='feishu_calendar_error_193003')return {event_id:eventId,status:'cancelled'};throw e;}}
 async snapshot(p:CalendarProvider,event:any):Promise<Snapshot>{
  if(!event?.event_id)fail(502,'calendar_event_invalid');
  if(event.status==='cancelled'||event.is_deleted)return {schedule:{startsAt:'',durationMinutes:0,location:'',meetingUrl:'',cancelled:true,openIds:[]},raw:event,unsupported:null,excludedAttendees:0};
  const people=await p.attendees(this.settings.calendarId,event.event_id);if(!Array.isArray(people))fail(502,'calendar_attendees_invalid');
  const eligible=people.filter(u=>u.type==='user'&&!u.is_external&&u.user_id&&u.user_id!==p.botOpenId&&!['decline','declined','removed','cancelled'].includes(u.rsvp_status)&&!u.is_deleted);
  const openIds=[...new Set<string>(eligible.map(u=>u.user_id))].sort();
  const start=Number(event.start_time?.timestamp),end=Number(event.end_time?.timestamp),duration=(end-start)/60;
  const unsupported=event.recurrence?'recurring_event_unsupported':(!Number.isFinite(start)||!Number.isFinite(end)||event.start_time?.date||event.end_time?.date)?'all_day_or_invalid_time':(!Number.isInteger(duration)||duration<5||duration>480)?'duration_unsupported':null;
  const url=event.vchat?.meeting_url||'';if(url&&!/^https?:\/\//.test(url))fail(422,'calendar_meeting_url_invalid');
  const known=(await this.db.query('SELECT open_id,name FROM users WHERE tenant=$1 AND app_id=$2 AND open_id=ANY($3::text[])',[this.identity.config.feishu.tenant,this.identity.config.feishu.appId,openIds])).rows;
  const participants=openIds.map(openId=>({openId,name:String(eligible.find(p=>p.user_id===openId)?.display_name||known.find(u=>u.open_id===openId)?.name||openId).slice(0,200)}));
  return {participants,schedule:unsupported?null:{startsAt:new Date(start*1000).toISOString(),durationMinutes:duration,location:String(event.location?.name||'').slice(0,1000),meetingUrl:url,cancelled:false,openIds},raw:event,unsupported,excludedAttendees:people.length-eligible.length};
 }
 async store(eventId:string,snapshot:Snapshot,state='pending',reason:string|null=null,sql:Sql=this.db.sql){return (await sql.query("INSERT INTO calendar_sync_inbox(scope,event_id,snapshot,state,reason,excluded_attendees) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(scope,event_id) DO UPDATE SET snapshot=EXCLUDED.snapshot,revision=calendar_sync_inbox.revision+CASE WHEN calendar_sync_inbox.snapshot IS DISTINCT FROM EXCLUDED.snapshot THEN 1 ELSE 0 END,excluded_attendees=EXCLUDED.excluded_attendees,updated_at=now() RETURNING *",[this.scope,eventId,snapshot,state,reason,snapshot.excludedAttendees])).rows[0];}
 async mark(eventId:string,state:string,reason:string|null=null){await this.db.query('UPDATE calendar_sync_inbox SET state=$3,reason=$4,updated_at=now() WHERE scope=$1 AND event_id=$2',[this.scope,eventId,state,reason]);await this.db.query('UPDATE calendar_event_links SET state=$3,last_error=$4,updated_at=now() WHERE scope=$1 AND event_id=$2',[this.scope,eventId,state,reason]);}
 async local(id:string,c:Sql=this.db.sql):Promise<Schedule>{const i=found((await c.query('SELECT * FROM interviews WHERE id=$1',[id])).rows[0]),f=this.identity.config.feishu;
 const people=(await c.query('SELECT u.* FROM interviewers x JOIN users u ON u.id=x.user_id WHERE x.interview_id=$1 ORDER BY u.open_id',[id])).rows;
 if(i.status!=='cancelled'&&!i.deleted_at&&people.some(u=>u.tenant!==f.tenant||u.app_id!==f.appId||!u.directory_active||!['active','pending'].includes(u.status)))fail(409,'calendar_participant_inactive');
 return {startsAt:new Date(Math.floor(new Date(i.starts_at).getTime()/1000)*1000).toISOString(),durationMinutes:i.duration_minutes,location:i.location||'',meetingUrl:i.meeting_url||'',cancelled:i.status==='cancelled'||!!i.deleted_at,openIds:people.map(u=>u.open_id).sort()};}
 async link(eventId:string){return (await this.db.query('SELECT * FROM calendar_event_links WHERE scope=$1 AND event_id=$2',[this.scope,eventId])).rows[0];}
 async apply(link:any,s:Snapshot,expectedVersion?:number){if(!s.schedule||s.unsupported)fail(422,s.unsupported||'calendar_event_invalid');const v=s.schedule;
 await this.db.tx(async c=>{
  await c.query("SET LOCAL recruit.calendar_inbound='on'");const i=found((await c.query('SELECT * FROM interviews WHERE id=$1 FOR UPDATE',[link.interview_id])).rows[0]);
  if(expectedVersion!==undefined?i.version!==expectedVersion:!equal(await this.local(i.id,c),link.local_snapshot))fail(409,'calendar_local_changed');
  if((i.status==='cancelled'||i.deleted_at)&&!v.cancelled)fail(409,'calendar_cancelled_interview_requires_review');
  if(v.cancelled){await c.query("UPDATE interviews SET status='cancelled',version=version+1,updated_at=now() WHERE id=$1 AND status<>'cancelled'",[i.id]);}
  else{
   await c.query('UPDATE interviews SET starts_at=$2,duration_minutes=$3,location=$4,meeting_url=$5,version=version+1,updated_at=now() WHERE id=$1',[i.id,v.startsAt,v.durationMinutes,v.location,v.meetingUrl]);
   const grants=new InterviewGrants(this.identity),participants=v.openIds.map(openId=>({openId,role:link.coordinator_open_ids.includes(openId)?'coordinator' as const:'interviewer' as const}));
   await grants.syncCalendarParticipants(c,i.id,participants,this.sourceKey+link.event_id,link.binding_actor_id);
   const ids:string[]=[];for(const p of participants){const u=(await c.query('SELECT id FROM users WHERE tenant=$1 AND app_id=$2 AND open_id=$3',[this.identity.config.feishu.tenant,this.identity.config.feishu.appId,p.openId])).rows[0];ids.push(u.id);await c.query('INSERT INTO interviewers(interview_id,user_id,temporary_access) VALUES($1,$2,true) ON CONFLICT DO NOTHING',[i.id,u.id]);}
   await c.query('DELETE FROM interviewers WHERE interview_id=$1 AND NOT(user_id=ANY($2::uuid[]))',[i.id,ids]);
   // Do not invent a replacement primary when the explicit primary departs.
   await c.query('UPDATE interviews SET primary_interviewer_id=NULL WHERE id=$1 AND NOT(primary_interviewer_id=ANY($2::uuid[]))',[i.id,ids]);
  }
  const local=await this.local(i.id,c);await c.query("UPDATE calendar_event_links SET local_snapshot=$3,remote_snapshot=$4,state='synced',last_error=NULL,revision=revision+1,updated_at=now() WHERE scope=$1 AND event_id=$2",[this.scope,link.event_id,local,v]);
  await c.query('UPDATE calendar_sync_outbox SET completed_generation=generation,intent=NULL,intent_generation=NULL,last_error=NULL WHERE scope=$1 AND interview_id=$2',[this.scope,i.id]);
  await this.identity.audit(c,link.binding_actor_id,'calendar.interview.update',i.id,{source:'calendar',eventId:link.event_id,cancelled:v.cancelled,excludedAttendees:s.excludedAttendees});await this.mark(link.event_id,'synced');
 });}
 async ingest(p:CalendarProvider,event:any){const snapshot=await this.snapshot(p,event),eventId=event.event_id;await this.store(eventId,snapshot);let link=await this.link(eventId);
  if(!link){
   // A random marker is not authorization: only a pre-existing outbound receipt may recover a lost create response.
   const marker=/\[recruit-sync:([a-f0-9-]{36})\]/.exec(event.description||'')?.[1];
   const receipt=marker?(await this.db.query('SELECT * FROM calendar_sync_outbox WHERE scope=$1 AND operation_key=$2 AND intent IS NOT NULL',[this.scope,marker])).rows[0]:null;
   if(receipt){
    const {openIds:planned,...wanted}=receipt.intent.schedule,{openIds:observed,...actual}=snapshot.schedule||{};
    if(!equal(wanted,actual)||!Array.isArray(observed)||observed.some((id:string)=>!planned.includes(id))){await this.db.query('UPDATE calendar_sync_outbox SET last_error=$3 WHERE scope=$1 AND interview_id=$2',[this.scope,receipt.interview_id,'creation_receipt_mismatch']);await this.mark(eventId,'pending','creation_receipt_mismatch');return;}
    await this.db.query('INSERT INTO calendar_event_links(scope,event_id,interview_id,local_snapshot,remote_snapshot) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[this.scope,eventId,receipt.interview_id,receipt.intent.schedule,snapshot.schedule]);link=await this.link(eventId);}
   if(!link){await this.mark(eventId,'pending',snapshot.unsupported||(snapshot.schedule?.cancelled?'cancelled_unbound':null));return;}
  }
  if(snapshot.unsupported){await this.mark(eventId,'error',snapshot.unsupported);return;}
  const pending=(await this.db.query('SELECT intent FROM calendar_sync_outbox WHERE scope=$1 AND interview_id=$2',[this.scope,link.interview_id])).rows[0]?.intent;
  if(pending){
   if(this.acceptsPending(pending,link,snapshot.schedule))return;
   await this.mark(eventId,'conflict','both_sides_changed');
   return;
  }
  if(equal(snapshot.schedule,link.remote_snapshot)){return;}
  const local=await this.local(link.interview_id);
  if(!equal(local,link.local_snapshot)){await this.mark(eventId,'conflict','both_sides_changed');return;}
  await this.apply(link,snapshot);
 }
 body(schedule:Schedule,key:string){return {summary:'招聘工作台 · 面试',description:'由招聘工作台同步。\n[recruit-sync:'+key+']',start_time:{timestamp:String(Date.parse(schedule.startsAt)/1000),timezone:'Asia/Shanghai'},end_time:{timestamp:String(Date.parse(schedule.startsAt)/1000+schedule.durationMinutes*60),timezone:'Asia/Shanghai'},location:{name:schedule.location},vchat:schedule.meetingUrl?{vc_type:'third_party',meeting_url:schedule.meetingUrl}:{vc_type:'no_meeting'},visibility:'private',attendee_ability:'none'};}
 async saveIntent(job:any){
  await this.db.query('UPDATE calendar_sync_outbox SET intent=$3,intent_generation=$4 WHERE scope=$1 AND interview_id=$2',[this.scope,job.interview_id,job.intent,job.intent_generation]);
 }

 // Only the last acknowledged state and the exact before/after images of ONE
 // persisted provider request can explain an unfinished operation. In particular,
 // matching time/location never licenses overwriting a different attendee roster.
 acceptsPending(intent:SyncIntent,link:any,current:Schedule|null){
  if(!current)return false;
  if(intent.schedule.cancelled&&current.cancelled)return true;
  const progress=intent.progress;
  if(progress?.pending)return equal(current,progress.pending.before)||equal(current,progress.pending.after);
  return equal(current,progress?.confirmed??link.remote_snapshot);
 }

 async readCurrent(p:CalendarProvider,eventId:string){
  const snapshot=await this.snapshot(p,await this.readEvent(p,eventId));
  await this.store(eventId,snapshot);
  if(!snapshot.schedule||snapshot.unsupported)fail(422,snapshot.unsupported||'calendar_event_invalid');
  return snapshot;
 }

 async confirmStep(job:any,after:Schedule){
  job.intent.progress={confirmed:after};
  await this.saveIntent(job);
 }

 async executeStep(p:CalendarProvider,job:any,link:any,step:ProviderStep,current:Schedule){
  // A successful operation may have lost its response. Do not resend it if its
  // exact postcondition is already visible. Any third state is a remote conflict.
  if(equal(current,step.after)){
   await this.confirmStep(job,current);
   return current;
  }
  if(!equal(current,step.before)){
   await this.mark(link.event_id,'conflict','both_sides_changed');
   return null;
  }
  if(step.kind==='cancel'){
   try{await p.cancelShared(this.settings.calendarId,link.event_id);}
   catch(e){if(errorCode(e)!=='feishu_calendar_error_193003')throw e;}
   await this.confirmStep(job,step.after);
   return step.after;
  }
  if(step.kind==='patch'){
   const {start_time,end_time,location,vchat}=this.body(step.after,job.operation_key);
   await p.patchShared(this.settings.calendarId,link.event_id,{start_time,end_time,location,...(step.before.meetingUrl!==step.after.meetingUrl?{vchat}:{})});
  }else{
   // Exactly one removal OR addition per persisted request. The provider adapter
   // must not re-invite other users that changed during its own final GET.
   try{await p.reconcileAttendees(this.settings.calendarId,link.event_id,step.after.openIds,step.kind==='remove'?[step.openId!]:[],step.before.openIds);}
   catch(e){
    if(errorCode(e)!=='calendar_roster_changed')throw e;
    await this.mark(link.event_id,'conflict','both_sides_changed');
    return null;
   }
  }
  const observed=(await this.readCurrent(p,link.event_id)).schedule!;
  if(!equal(observed,step.after)){
   if(!equal(observed,step.before))await this.mark(link.event_id,'conflict','both_sides_changed');
   fail(502,'calendar_write_not_verified');
  }
  await this.confirmStep(job,observed);
  return observed;
 }

 async performStep(p:CalendarProvider,job:any,link:any,step:ProviderStep,current:Schedule){
  job.intent.progress={confirmed:current,pending:step};
  // Commit the exact request boundary before doing external I/O.
  await this.saveIntent(job);
  return this.executeStep(p,job,link,step,current);
 }

 async outbound(p:CalendarProvider,job:any){
  let link=(await this.db.query('SELECT * FROM calendar_event_links WHERE scope=$1 AND interview_id=$2',[this.scope,job.interview_id])).rows[0];
  if(link&&(link.state==='conflict'||(link.state==='error'&&!job.intent)))return;
  if(!job.intent){
   const schedule=await this.local(job.interview_id);
   if((link&&equal(schedule,link.local_snapshot))||(!link&&schedule.cancelled)){
    await this.db.query('UPDATE calendar_sync_outbox SET completed_generation=$3 WHERE scope=$1 AND interview_id=$2',[this.scope,job.interview_id,job.generation]);
    return;
   }
   job.intent={schedule,managedIds:link?.local_snapshot?.openIds||[]};
   job.intent_generation=job.generation;
   await this.saveIntent(job);
  }
  let intent=job.intent as SyncIntent;
  const latest=await this.local(job.interview_id);
  if(!link&&latest.cancelled){
   await this.db.query('UPDATE calendar_sync_outbox SET last_error=$3 WHERE scope=$1 AND interview_id=$2',[this.scope,job.interview_id,'cancelled_waiting_for_creation_receipt']);
   return;
  }
  const cancelling=latest.cancelled||intent.schedule.cancelled;
  if(!cancelling&&Date.parse(intent.schedule.startsAt)+intent.schedule.durationMinutes*60000<=Date.now())fail(409,'calendar_interview_ended');
  if(!cancelling)for(const openId of intent.schedule.openIds)await this.db.tx(c=>new InterviewGrants(this.identity).verifiedUser(c,openId));

  let current:Schedule;
  if(!link){
   const error=(await this.db.query('SELECT last_error FROM calendar_sync_outbox WHERE scope=$1 AND interview_id=$2',[this.scope,job.interview_id])).rows[0]?.last_error;
   if(error==='creation_receipt_mismatch')return;
   if(intent.creationAttemptedAt&&Date.now()-Date.parse(intent.creationAttemptedAt)>23*60*60*1000)fail(409,'calendar_creation_recovery_required');
   if(!intent.creationAttemptedAt){intent.creationAttemptedAt=new Date().toISOString();await this.saveIntent(job);}
   const event=await p.createShared(this.settings.calendarId,job.operation_key,this.body(intent.schedule,job.operation_key));
   const snapshot=await this.snapshot(p,event);
   current=found(snapshot.schedule);
   const expected={...intent.schedule,openIds:[]};
   // Creation does not send invitations. Unexpected attendees require review.
   if(!equal(current,expected))fail(409,'calendar_creation_snapshot_changed');
   await this.db.query('INSERT INTO calendar_event_links(scope,event_id,interview_id,local_snapshot,remote_snapshot) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[this.scope,event.event_id,job.interview_id,intent.schedule,current]);
   link=found(await this.link(event.event_id));
   await this.confirmStep(job,current);
  }else{
   current=(await this.readCurrent(p,link.event_id)).schedule!;
   if(!this.acceptsPending(intent,link,current)){
    await this.mark(link.event_id,'conflict','both_sides_changed');
    return;
   }
  }

  // Cancellation supersedes an unsent invitation, including a request whose
  // response is ambiguous. The observed before/after state is already validated.
  if(latest.cancelled&&!intent.schedule.cancelled){
   job.intent={...intent,schedule:latest,progress:{confirmed:current}};
   job.intent_generation=job.generation;
   await this.saveIntent(job);
   intent=job.intent;
  }
  if(current.cancelled&&!intent.schedule.cancelled){
   await this.mark(link.event_id,'conflict','calendar_cancelled_interview_requires_review');
   return;
  }
  const pending=intent.progress?.pending;
  if(pending){
   const recovered=await this.executeStep(p,job,link,pending,current);
   if(!recovered)return;
   current=recovered;
  }
  const desired=(job.intent as SyncIntent).schedule;
  if(desired.cancelled){
   const after:Schedule={startsAt:'',durationMinutes:0,location:'',meetingUrl:'',cancelled:true,openIds:[]};
   const cancelled=await this.performStep(p,job,link,{kind:'cancel',before:current,after},current);
   if(!cancelled)return;
   current=cancelled;
  }else{
   const patched={...desired,openIds:current.openIds};
   if(!equal(patched,current)){
    const result=await this.performStep(p,job,link,{kind:'patch',before:current,after:patched},current);
    if(!result)return;
    current=result;
   }
   const managed=new Set<string>(intent.managedIds);
   for(const openId of current.openIds.filter(id=>managed.has(id)&&!desired.openIds.includes(id))){
    const after={...current,openIds:current.openIds.filter(id=>id!==openId)};
    const result=await this.performStep(p,job,link,{kind:'remove',openId,before:current,after},current);
    if(!result)return;
    current=result;
   }
   for(const openId of desired.openIds.filter(id=>!current.openIds.includes(id))){
    const after={...current,openIds:[...current.openIds,openId].sort()};
    const result=await this.performStep(p,job,link,{kind:'add',openId,before:current,after},current);
    if(!result)return;
    current=result;
   }
  }
  if(desired.cancelled?!current.cancelled:!equal(current,desired))fail(502,'calendar_write_not_verified');
  const result=await this.snapshot(p,desired.cancelled?{event_id:link.event_id,status:'cancelled'}:await this.readEvent(p,link.event_id));
  if(!equal(result.schedule,current)){
   await this.store(link.event_id,result);
   await this.mark(link.event_id,'conflict','both_sides_changed');
   return;
  }
  await this.db.tx(async c=>{
   await c.query("UPDATE calendar_event_links SET local_snapshot=$3,remote_snapshot=$4,state='synced',last_error=NULL,updated_at=now() WHERE scope=$1 AND event_id=$2",[this.scope,link.event_id,desired,result.schedule]);
   await c.query('UPDATE calendar_sync_outbox SET completed_generation=$3,intent=NULL,intent_generation=NULL,attempts=0,last_error=NULL,next_attempt_at=now() WHERE scope=$1 AND interview_id=$2',[this.scope,job.interview_id,job.intent_generation]);
   await this.store(link.event_id,result);
   await this.mark(link.event_id,'synced');
   await this.identity.audit(c,null,'calendar.interview.sent',job.interview_id,{source:'calendar',eventId:link.event_id,cancelled:desired.cancelled});
  });
 }
 async run(){await this.initialize();if(!this.settings.enabled)return {enabled:false};return this.locked(async()=>{
  await this.db.query('UPDATE calendar_sync_state SET last_attempt_at=now(),requested_at=NULL WHERE scope=$1',[this.scope]);let errors=0;
  try{const p=this.factory();await p.connect();const state=(await this.db.query('SELECT * FROM calendar_sync_state WHERE scope=$1',[this.scope])).rows[0];let list;
   try{list=await p.list(this.settings.calendarId,state.sync_token);}catch(e){if(errorCode(e)!=='feishu_calendar_error_190008')throw e;list=await p.list(this.settings.calendarId,'');}
   for(const e of list.items){try{await this.ingest(p,e);}catch(error){errors++;if(e?.event_id){if(!await this.link(e.event_id))await this.store(e.event_id,{schedule:null,raw:e,unsupported:null,excludedAttendees:0},'error',errorCode(error));await this.mark(e.event_id,'error',errorCode(error));}}}
   // Never advance the cursor past an event whose full attendee/directory snapshot failed.
   if(!errors)await this.db.query('UPDATE calendar_sync_state SET sync_token=$2 WHERE scope=$1',[this.scope,list.syncToken]);
   const jobs=(await this.db.query(`SELECT o.* FROM calendar_sync_outbox o
    LEFT JOIN calendar_event_links l ON l.scope=o.scope AND l.interview_id=o.interview_id
    WHERE o.scope=$1 AND o.generation>o.completed_generation AND o.next_attempt_at<=now()
    AND (l.id IS NULL OR (l.state<>'conflict' AND (l.state<>'error' OR o.intent IS NOT NULL)))
    AND (l.id IS NOT NULL OR coalesce(o.last_error,'') NOT IN ('creation_receipt_mismatch','calendar_creation_recovery_required','cancelled_waiting_for_creation_receipt'))
    ORDER BY o.next_attempt_at,o.interview_id LIMIT 50`,[this.scope])).rows;
   for(const j of jobs)try{await this.outbound(p,j);}catch(error){errors++;const code=errorCode(error);await this.db.query("UPDATE calendar_sync_outbox SET attempts=attempts+1,last_error=$3,next_attempt_at=now()+make_interval(secs=>LEAST(3600,30*power(2,LEAST(attempts,7)))::int) WHERE scope=$1 AND interview_id=$2",[this.scope,j.interview_id,code]);const l=(await this.db.query('SELECT event_id FROM calendar_event_links WHERE scope=$1 AND interview_id=$2',[this.scope,j.interview_id])).rows[0];if(l&&(await this.link(l.event_id))?.state!=='conflict')await this.mark(l.event_id,'error',code);}
   await this.db.query("UPDATE calendar_sync_state SET last_success_at=CASE WHEN $2=0 THEN now() ELSE last_success_at END,last_error=CASE WHEN $2=0 THEN NULL ELSE 'calendar_items_failed' END WHERE scope=$1",[this.scope,errors]);return {enabled:true,errors};
  }catch(e){await this.db.query('UPDATE calendar_sync_state SET last_error=$2 WHERE scope=$1',[this.scope,errorCode(e)]);return {enabled:true,errors:errors+1};}
 });}
 async refreshed(p:CalendarProvider,eventId:string,expected:number){const old=found((await this.db.query('SELECT * FROM calendar_sync_inbox WHERE scope=$1 AND event_id=$2',[this.scope,eventId])).rows[0]);if(old.revision!==expected)fail(409,'calendar_event_changed');const snapshot=await this.snapshot(p,await this.readEvent(p,eventId));const now=await this.store(eventId,snapshot,'pending',null,this.db.pool);if(now.revision!==expected)fail(409,'calendar_event_changed');return {row:now,snapshot};}
 async bind(a:Actor,eventId:string,input:unknown){await this.admin(a);if(!this.settings.enabled)fail(409,'calendar_sync_disabled');const b=parse(z.object({revision,applicationId:uuid,round:z.number().int().min(1).max(50),form:z.string().min(1).max(100),primaryOpenId:z.string().min(1),coordinatorOpenIds:z.array(z.string()).max(20).default([]),customFields:z.record(z.string(),z.unknown()).optional()}).strict(),input);return this.locked(async()=>{
  const p=this.factory();await p.connect();const {snapshot}=await this.refreshed(p,eventId,b.revision);if(await this.link(eventId))fail(409,'calendar_event_already_bound');const s=snapshot.schedule;if(!s||s.cancelled)fail(422,snapshot.unsupported||'calendar_event_cancelled');if(!s.openIds.includes(b.primaryOpenId)||b.coordinatorOpenIds.some(id=>!s.openIds.includes(id)))fail(422,'calendar_binding_participant_invalid');
  return this.db.tx(async c=>{await c.query("SET LOCAL recruit.calendar_inbound='on'");await new BusinessConfigService(this.identity).seed();const def=await loadDefinition(this.identity,'interview',c,a);const row=await new DirectoryScheduling(this.identity).create(a,{applicationId:b.applicationId,round:b.round,form:b.form,startsAt:s.startsAt,durationMinutes:s.durationMinutes,location:s.location,meetingUrl:s.meetingUrl,primaryOpenId:b.primaryOpenId,directoryMembers:s.openIds.map(openId=>({openId,role:b.coordinatorOpenIds.includes(openId)?'coordinator':'interviewer'})),definitionVersion:def.ref.version,definitionRevision:def.aclRevision,customFields:b.customFields},{key:this.sourceKey+eventId});
   await c.query('INSERT INTO calendar_event_links(scope,event_id,interview_id,binding_actor_id,coordinator_open_ids,local_snapshot,remote_snapshot) VALUES($1,$2,$3,$4,$5,$6,$6)',[this.scope,eventId,row.id,a.id,JSON.stringify(b.coordinatorOpenIds),s]);await this.mark(eventId,'synced');await this.identity.audit(c,a.id,'calendar.interview.bind',row.id,{source:'calendar',eventId});return row;
  });
 });}
 async resolve(a:Actor,eventId:string,input:unknown){await this.admin(a);if(!this.settings.enabled)fail(409,'calendar_sync_disabled');const b=parse(z.object({revision,interviewVersion:revision,resolution:z.enum(['workbench','calendar'])}).strict(),input);return this.locked(async()=>{const p=this.factory();await p.connect();const {snapshot}=await this.refreshed(p,eventId,b.revision),link=found(await this.link(eventId));if((await this.db.query('SELECT version FROM interviews WHERE id=$1',[link.interview_id])).rows[0]?.version!==b.interviewVersion)fail(409,'calendar_local_changed');if(b.resolution==='calendar'){await this.apply({...link,binding_actor_id:a.id},snapshot,b.interviewVersion);}else{
   if(snapshot.schedule?.cancelled)fail(409,'calendar_cancelled_interview_requires_review');
   await this.db.tx(async c=>{const current=found((await c.query('SELECT version FROM interviews WHERE id=$1 FOR UPDATE',[link.interview_id])).rows[0]);if(current.version!==b.interviewVersion)fail(409,'calendar_local_changed');await c.query('UPDATE calendar_event_links SET remote_snapshot=$3,binding_actor_id=$4 WHERE scope=$1 AND event_id=$2',[this.scope,eventId,snapshot.schedule,a.id]);await this.mark(eventId,'retry');await c.query('INSERT INTO calendar_sync_outbox(scope,interview_id) VALUES($1,$2) ON CONFLICT(scope,interview_id) DO UPDATE SET generation=calendar_sync_outbox.generation+1,intent=NULL,intent_generation=NULL,next_attempt_at=now(),last_error=NULL',[this.scope,link.interview_id]);});
  }return {id:link.interview_id,resolution:b.resolution};});}
}
