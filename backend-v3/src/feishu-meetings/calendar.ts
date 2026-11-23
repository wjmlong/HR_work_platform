import type {Config} from '../config.js';
import {fail} from '../http/errors.js';
export class FeishuCalendar {
 private token='';
 botOpenId='';
 constructor(readonly config:Config,readonly transport:typeof fetch=fetch){}
 async request(path:string,body?:unknown,method=body?'POST':'GET'){
  let response:Response;
  try{response=await this.transport('https://open.feishu.cn/open-apis/'+path,{method,headers:{'content-type':'application/json',...(this.token?{authorization:'Bearer '+this.token}:{})},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(12000)});}catch{fail(503,'feishu_meeting_unavailable');}
  const text=await response.text();if(text.length>1024*1024)fail(502,'feishu_meeting_invalid');
  let value:any;try{value=JSON.parse(text);}catch{fail(502,'feishu_meeting_invalid');}
  if(!response.ok||value.code!==0)fail(502,'feishu_calendar_error_'+(Number(value.code)||response.status));
  return value;
 }
 async connect(){
  const f=this.config.feishu;if(!f.appId||!f.appSecret)fail(503,'feishu_not_configured');
  const t=await this.request('auth/v3/tenant_access_token/internal',{app_id:f.appId,app_secret:f.appSecret});
  if(!t.tenant_access_token)fail(502,'feishu_meeting_invalid');this.token=t.tenant_access_token;
  const bot=await this.request('bot/v3/info');this.botOpenId=bot.bot?.open_id||'';
 }
 async primary(){
  const calendars:any[]=[];let page='',pages=0;
  do{if(++pages>10)fail(502,'feishu_meeting_invalid');const r=await this.request('calendar/v4/calendars?page_size=50'+(page?'&page_token='+encodeURIComponent(page):''));calendars.push(...(r.data?.calendar_list||[]));page=r.data?.has_more?r.data.page_token:'';if(r.data?.has_more&&!page)fail(502,'feishu_meeting_invalid');}while(page&&calendars.length<500);
  const eligible=calendars.filter(c=>c.type==='primary'&&c.role==='owner');if(eligible.length!==1)fail(503,'feishu_calendar_not_ready');return eligible[0].calendar_id as string;
 }
 root(calendarId:string,eventId?:string){return 'calendar/v4/calendars/'+encodeURIComponent(calendarId)+'/events'+(eventId?'/'+encodeURIComponent(eventId):'');}
 async create(calendarId:string,key:string,input:any,ownerId:string){
  const start=Math.floor(new Date(input.startsAt).getTime()/1000);
  const r=await this.request(this.root(calendarId)+'?user_id_type=open_id&idempotency_key='+encodeURIComponent(key),{summary:input.summary,description:'由招聘工作台发起。',start_time:{timestamp:String(start),timezone:'Asia/Shanghai'},end_time:{timestamp:String(start+input.durationMinutes*60),timezone:'Asia/Shanghai'},visibility:'private',attendee_ability:'none',vchat:{vc_type:'vc',meeting_settings:{owner_id:ownerId,auto_record:false,open_lobby:true,allow_attendees_start:true,join_meeting_permission:'anyone_can_join'}}});
  if(!r.data?.event?.event_id)fail(502,'feishu_meeting_invalid');return r.data.event;
 }
 async attendees(calendarId:string,eventId:string){
  const users:any[]=[];let page='',pages=0;do{if(++pages>10)fail(502,'feishu_meeting_invalid');const r=await this.request(this.root(calendarId,eventId)+'/attendees?user_id_type=open_id&page_size=100'+(page?'&page_token='+encodeURIComponent(page):''));if(!Array.isArray(r.data?.items)||typeof r.data.has_more!=='boolean')fail(502,'feishu_meeting_invalid');users.push(...r.data.items);page=r.data?.has_more?r.data.page_token:'';if(r.data?.has_more&&!page)fail(502,'feishu_meeting_invalid');}while(page&&users.length<1000);if(page)fail(502,'feishu_meeting_invalid');return users;
 }
 async invite(calendarId:string,eventId:string,openIds:string[]){
  const current=await this.attendees(calendarId,eventId),missing=openIds.filter(id=>!current.some(u=>u.user_id===id));
  if(missing.length)await this.request(this.root(calendarId,eventId)+'/attendees?user_id_type=open_id',{attendees:missing.map(user_id=>({type:'user',user_id})),need_notification:true});
  const verified=await this.attendees(calendarId,eventId);if(openIds.some(id=>!verified.some(u=>u.user_id===id)))fail(502,'feishu_invitation_pending');
 }
 async list(calendarId:string,syncToken=''){
  const items:any[]=[];let page='',next='',pages=0;
  do{if(++pages>1000)fail(502,'feishu_calendar_page_limit');const q=new URLSearchParams({page_size:'500',user_id_type:'open_id'});if(syncToken)q.set('sync_token',syncToken);if(page)q.set('page_token',page);
   const r=await this.request(this.root(calendarId)+'?'+q);if(!Array.isArray(r.data?.items)||typeof r.data.has_more!=='boolean')fail(502,'feishu_meeting_invalid');items.push(...r.data.items);page=r.data.has_more?r.data.page_token:'';if(r.data.has_more&&!page)fail(502,'feishu_meeting_invalid');next=r.data.sync_token||next;
  }while(page);return {items,syncToken:next};
 }
 async createShared(calendarId:string,key:string,body:any){const r=await this.request(this.root(calendarId)+'?user_id_type=open_id&idempotency_key='+encodeURIComponent(key),body);if(!r.data?.event?.event_id)fail(502,'feishu_meeting_invalid');return r.data.event;}
 async patchShared(calendarId:string,eventId:string,body:any){await this.request(this.root(calendarId,eventId)+'?user_id_type=open_id',body,'PATCH');}
 async cancelShared(calendarId:string,eventId:string){await this.request(this.root(calendarId,eventId),undefined,'DELETE');}
 async reconcileAttendees(calendarId:string,eventId:string,openIds:string[],managedIds:string[]=[],expectedIds?:string[]){
  const current=await this.attendees(calendarId,eventId);
  const active=current.filter(p=>p.type==='user'&&!p.is_external&&p.user_id&&p.user_id!==this.botOpenId&&!p.is_deleted&&!['decline','declined','removed','cancelled'].includes(p.rsvp_status));
  const observed=[...new Set<string>(active.map(p=>p.user_id))].sort();
  if(expectedIds&&JSON.stringify(observed)!==JSON.stringify([...expectedIds].sort()))fail(409,'calendar_roster_changed');
  const remove=active.filter(p=>managedIds.includes(p.user_id)&&!openIds.includes(p.user_id));
  const missing=openIds.filter(id=>!observed.includes(id));
  if(expectedIds&&(remove.length+missing.length>1))fail(500,'calendar_roster_step_invalid');
  if(remove.length)await this.request(this.root(calendarId,eventId)+'/attendees/batch_delete?user_id_type=open_id',{attendee_ids:remove.map(p=>p.attendee_id),need_notification:true});
  if(missing.length)await this.request(this.root(calendarId,eventId)+'/attendees?user_id_type=open_id',{attendees:missing.map(user_id=>({type:'user',user_id})),need_notification:true});
 }
 async event(calendarId:string,eventId:string){return (await this.request(this.root(calendarId,eventId)+'?user_id_type=open_id')).data?.event;}
}
