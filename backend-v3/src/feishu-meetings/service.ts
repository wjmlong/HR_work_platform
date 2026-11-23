import {createHash} from 'node:crypto';
import {z} from 'zod';
import {parse} from '../http/validation.js';
import {fail,found} from '../http/errors.js';
import {Identity,requireRole,type Actor} from '../identity/service.js';
import {ConfiguredEntities} from '../business-config/entities.js';
import {loadDefinition} from '../business-config/fields.js';
import {fieldAllowed} from '../business-config/access.js';
import {sourceFieldAccess} from '../business-config/bindings.js';
import {FeishuCalendar} from './calendar.js';
export class FeishuMeetings {
 constructor(readonly identity:Identity,readonly calendarFactory=()=>new FeishuCalendar(identity.config)){}
 get db(){return this.identity.db;}
 async access(a:Actor,id:string){
  requireRole(a,'admin','manager','recruiter');
  const u=(await this.db.query('SELECT version,status,directory_active,tenant,app_id FROM users WHERE id=$1',[a.id])).rows[0],f=this.identity.config.feishu;
  if(!u||u.version!==a.version||u.status!=='active'||!u.directory_active||u.tenant!==f.tenant||u.app_id!==f.appId)fail(403,'membership_changed');
  const i=found((await this.db.query('SELECT * FROM interviews WHERE id=$1 AND deleted_at IS NULL',[id])).rows[0]);
  await this.identity.applicationAccess(a,i.application_id,true);
  if(i.created_by!==a.id||!await this.receipt(a,id,'offered'))fail(403,'feishu_new_interview_only');
  const access=await sourceFieldAccess(this.identity,a,{kind:'interview',id},{startsAt:i.starts_at,durationMinutes:i.duration_minutes,meetingUrl:i.meeting_url,round:i.round});
  if(['startsAt','durationMinutes','meetingUrl','round'].some(k=>!access.keys.has(k)))fail(403,'field_read_forbidden');
  const definition=await loadDefinition(this.identity,'interview',this.db.sql,a),meetingField=definition.fields.find(f=>f.coreKey==='meetingUrl');
  if(!meetingField||!meetingField.active||!fieldAllowed(meetingField,a,'write',true))fail(403,'field_forbidden:meetingUrl');
  return i;
 }
 async receipt(a:Actor,key:string,kind:string){return (await this.db.query('SELECT detail FROM audit_events WHERE actor_id=$1 AND entity_id=$2 AND kind=$3 ORDER BY id DESC LIMIT 1',[a.id,key,'feishu.meeting.'+kind])).rows[0]?.detail;}
 async record(a:Actor,key:string,kind:string,detail:any){await this.identity.audit(this.db.sql,a.id,'feishu.meeting.'+kind,key,detail);}
 async create(a:Actor,id:string,input:unknown){
  if(this.identity.config.calendarSync?.enabled)fail(409,'shared_calendar_sync_enabled');
  parse(z.object({confirmed:z.literal(true)}).strict(),input);await this.access(a,id);
  const key=createHash('sha256').update(this.identity.config.feishu.appId+':interview:'+id).digest('hex'),lock=await this.db.pool.connect();let held=false;
  try{
   held=(await lock.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) ok',['feishu-meeting:'+id])).rows[0].ok;if(!held)fail(409,'feishu_meeting_busy');
   const i=await this.access(a,id),done=await this.receipt(a,id,'completed');if(done)return done;
   if(i.status!=='pending')fail(409,'feishu_interview_changed');
   let request=await this.receipt(a,id,'request');
   if(!request){
    if(i.version!==1||i.meeting_url)fail(409,'feishu_interview_changed');
    if(new Date(i.starts_at).getTime()<Date.now()-60000)fail(422,'feishu_meeting_time_invalid');
    await this.identity.limit('feishu-meeting:'+a.id,10);
    const f=this.identity.config.feishu,people=(await this.db.query("SELECT u.id,u.name,u.open_id FROM interviewers x JOIN users u ON u.id=x.user_id WHERE x.interview_id=$1 AND u.tenant=$2 AND u.app_id=$3 AND u.status='active' AND u.directory_active AND u.roles&&ARRAY['admin','manager','recruiter','interviewer']::text[] ORDER BY u.id",[id,f.tenant,f.appId])).rows;
    const total=Number((await this.db.query('SELECT count(*) n FROM interviewers WHERE interview_id=$1',[id])).rows[0].n);
    if(!total||people.length!==total||!people.some(p=>p.id===i.primary_interviewer_id))fail(422,'feishu_participant_invalid');
    request={version:i.version,input:{summary:'招聘面试 · 第 '+i.round+' 轮',startsAt:new Date(i.starts_at).toISOString(),durationMinutes:i.duration_minutes},participants:people,ownerId:people.find(p=>p.id===i.primary_interviewer_id)!.open_id};
    await this.record(a,id,'request',request);
   }
   if(i.version!==request.version)fail(409,'feishu_interview_changed');
   const calendar=this.calendarFactory();await calendar.connect();
   let basis=await this.receipt(a,id,'calendar');if(!basis){basis={calendarId:await calendar.primary()};await this.record(a,id,'calendar',basis);}
   let saved=await this.receipt(a,id,'created');if(!saved){
    // Stable upstream idempotency survives a lost HTTP response or process restart.
    const event=await calendar.create(basis.calendarId,key,request.input,request.ownerId);saved={calendarId:basis.calendarId,eventId:event.event_id};await this.record(a,id,'created',saved);
   }
   const current=await this.access(a,id);if(current.version!==request.version||current.status!=='pending')fail(409,'feishu_interview_changed');
   const f=this.identity.config.feishu,eligible=await this.db.query("SELECT id FROM users WHERE id=ANY($1::uuid[]) AND tenant=$2 AND app_id=$3 AND status='active' AND directory_active AND roles&&ARRAY['admin','manager','recruiter','interviewer']::text[]",[request.participants.map((p:any)=>p.id),f.tenant,f.appId]);if(eligible.rowCount!==request.participants.length)fail(422,'feishu_participant_invalid');
   await calendar.invite(saved.calendarId,saved.eventId,request.participants.map((p:any)=>p.open_id));
   const event=await calendar.event(saved.calendarId,saved.eventId);if(!event||event.status==='cancelled')fail(409,'feishu_meeting_cancelled');
   let url:URL;try{url=new URL(event.vchat?.meeting_url);if(url.protocol!=='https:'||!url.hostname.endsWith('.feishu.cn'))throw Error();}catch{fail(502,'feishu_meeting_link_pending');}
   const result={interviewId:id,meetingUrl:url.href,eventId:saved.eventId,calendarId:saved.calendarId,participants:request.participants.map((p:any)=>({id:p.id,name:p.name})),invitationStatus:'sent'};
   await this.db.tx(async()=>{
    await this.access(a,id);
    const def=await loadDefinition(this.identity,'interview',this.db.sql,a);
    await new ConfiguredEntities(this.identity).write(a,'interview',id,{version:request.version,meetingUrl:url.href,definitionVersion:def.ref.version,definitionRevision:def.aclRevision});
    await this.record(a,id,'completed',result);
   });return result;
  }finally{try{if(held)await lock.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',['feishu-meeting:'+id]);}finally{lock.release();}}
 }
}
