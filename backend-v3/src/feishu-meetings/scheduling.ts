import {Directory} from '../identity/directory.js';
import {Identity,requireRole,type Actor} from '../identity/service.js';
import {InterviewGrants,grantInput} from '../identity/grants.js';
import {ConfiguredEntities} from '../business-config/entities.js';
import {parse,z} from '../http/validation.js';
import {fail} from '../http/errors.js';
export class DirectoryScheduling {
 constructor(readonly identity:Identity){}
 async roster(a:Actor,id:string){
  requireRole(a,'admin');await this.identity.interviewActor(a,id);
  return new Directory(this.identity).decorate((await this.identity.db.query("SELECT u.open_id AS \"openId\",u.name,x.temporary_access,coalesce((SELECT g.role FROM interview_access_grants g WHERE g.interview_id=x.interview_id AND g.user_id=x.user_id ORDER BY (g.revoked_at IS NULL) DESC,(g.source='manual') DESC,g.updated_at DESC LIMIT 1),'interviewer') role,(i.primary_interviewer_id=u.id) primary FROM interviewers x JOIN users u ON u.id=x.user_id JOIN interviews i ON i.id=x.interview_id WHERE x.interview_id=$1 AND u.tenant=$2 AND u.app_id=$3 ORDER BY u.name,u.open_id",[id,this.identity.config.feishu.tenant,this.identity.config.feishu.appId])).rows,p=>p.openId);
 }
 async update(a:Actor,id:string,input:any){
  requireRole(a,'admin');const {directoryMembers,primaryOpenId,...fields}=input||{};
  const members=parse(z.array(grantInput).min(1).max(20),directoryMembers),primary=parse(z.string().min(1),primaryOpenId);
  if(new Set(members.map(p=>p.openId)).size!==members.length)fail(422,'duplicate_directory_member');
  if(!members.some(p=>p.openId===primary))fail(422,'primary_interviewer_required');
  if(fields.interviewerIds!==undefined||fields.primaryInterviewerId!==undefined)fail(422,'directory_members_required');
  return this.identity.db.tx(async c=>{
   await c.query('SELECT id FROM interviews WHERE id=$1 FOR UPDATE',[id]);
   const before=await this.roster(a,id),grants=new InterviewGrants(this.identity),people=[];
   for(const member of members)people.push({member,user:await grants.verifiedUser(c,member.openId)});
   const ids=people.map(p=>p.user.id),row=await new ConfiguredEntities(this.identity).write(a,'interview',id,{...fields,interviewerIds:ids,primaryInterviewerId:people.find(p=>p.member.openId===primary)!.user.id},new Set(ids));
   if(row.status!=='cancelled')for(const p of people){const prior=before.find(r=>r.openId===p.member.openId);if(!prior||prior.role!==p.member.role)await grants.put(c,id,p.member,'manual','',a.id);}
   return {id:row.id,version:row.version};
  });
 }
 async create(a:Actor,input:any,source?:{key:string}){
  requireRole(a,'admin');
  const {directoryMembers,primaryOpenId,...fields}=input||{};
  const members=parse(z.array(grantInput).min(1).max(20),directoryMembers),primary=parse(z.string().min(1),primaryOpenId);
  if(new Set(members.map(p=>p.openId)).size!==members.length)fail(422,'duplicate_directory_member');
  if(!members.some(p=>p.openId===primary))fail(422,'primary_interviewer_required');
  if(fields.interviewerIds!==undefined||fields.primaryInterviewerId!==undefined)fail(422,'directory_members_required');
  return this.identity.db.tx(async c=>{
   const grants=new InterviewGrants(this.identity),people=[];
   for(const p of members)people.push({member:p,user:await grants.verifiedUser(c,p.openId)});
   const ids=people.map(p=>p.user.id),row=await new ConfiguredEntities(this.identity).write(a,'interview',null,{...fields,interviewerIds:ids,primaryInterviewerId:people.find(p=>p.member.openId===primary)!.user.id},new Set(ids));
   for(const p of people)await grants.put(c,row.id,p.member,source?'calendar':'manual',source?.key||'',a.id);
   return {id:row.id,version:row.version};
  });
 }
}
