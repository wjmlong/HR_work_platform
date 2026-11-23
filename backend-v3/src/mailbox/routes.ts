import path from 'node:path';
import type {FastifyInstance} from 'fastify';
import {Identity,requireRole} from '../identity/service.js';
import {parse,z,uuid} from '../http/validation.js';
import {fail} from '../http/errors.js';
import {FileStore} from '../files/storage.js';
import {TaskService} from '../tasks/service.js';
import {MailboxArchive} from './archive.js';
import {assertLegacySource} from '../business-config/legacy-fields.js';
import {MailboxUpdate} from './update.js';

export function mailboxRoutes(app:FastifyInstance,id:Identity){
 const archive=new MailboxArchive(path.join(path.dirname(id.config.storageRoot),'mailboxes'));
 const params=(input:unknown)=>parse(z.object({mailboxId:z.string(),messageKey:z.string().optional(),attachmentId:z.string().regex(/^\d{1,3}$/).optional()}),input);
 const access=async(a:Parameters<typeof requireRole>[0])=>{requireRole(a,'admin','manager','recruiter');await assertLegacySource(id,a,['resume']);};
 const links=async(mailboxId:string,keys:string[])=>keys.length?(await id.db.query("SELECT id,state,jsonb_build_object('applicationId',result->'applicationId') result,payload->>'mailMessageKey' message_key,payload->>'mailAttachmentId' attachment_id FROM tasks WHERE payload->>'mailboxId'=$1 AND payload->>'mailMessageKey'=ANY($2::text[]) ORDER BY created_at DESC",[mailboxId,keys])).rows:[];
 app.get('/api/v4/mailboxes',async req=>{await access(req.actor);return {items:await archive.accounts()};});
 app.get('/api/v4/mailboxes/:mailboxId/messages',async req=>{
  await access(req.actor);const p=params(req.params),q=parse(z.object({q:z.string().max(300).default(''),page:z.coerce.number().int().min(1).max(100000).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(25)}),req.query);
  const result=await archive.list(p.mailboxId,q),imports=await links(p.mailboxId,result.items.map(m=>m.id));
  return {...result,items:result.items.map(m=>({...m,imports:imports.filter(i=>i.message_key===m.id)}))};
 });
 app.get('/api/v4/mailboxes/:mailboxId/messages/:messageKey',async req=>{
  await access(req.actor);const p=params(req.params),message=await archive.message(p.mailboxId,p.messageKey!);
  const jobs=(await id.db.query('SELECT id,name FROM jobs WHERE open ORDER BY name')).rows;
  const text=(message.subject+'\n'+message.body).replace(/\s+/g,'').toLowerCase();
  return {...message,imports:await links(p.mailboxId,[p.messageKey!]),suggestedJobs:jobs.filter(j=>j.name.replace(/\s+/g,'').length>=2&&text.includes(j.name.replace(/\s+/g,'').toLowerCase()))};
 });
 for(const isAttachment of [false,true]){
  const url='/api/v4/mailboxes/:mailboxId/messages/:messageKey'+(isAttachment?'/attachments/:attachmentId':'')+'/file';
  app.get(url,async(req,reply)=>{await access(req.actor);const p=params(req.params),f=await archive.file(p.mailboxId,p.messageKey!,p.attachmentId);
   await id.audit(id.db.sql,req.actor.id,'mailbox.download',null,{mailboxId:p.mailboxId,messageKey:p.messageKey,attachmentId:p.attachmentId||null});
   return reply.header('content-security-policy',"sandbox; default-src 'none'").header('content-disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(f.name)).type('application/octet-stream').send(f.data);
  });
 }
 app.post('/api/v4/mailboxes/:mailboxId/sync',async req=>{await access(req.actor);const p=params(req.params);await id.audit(id.db.sql,req.actor.id,'mailbox.sync.request',null,{mailboxId:p.mailboxId});return archive.requestSync(p.mailboxId);});
 app.get('/api/v4/mailboxes/:mailboxId/sync/:requestId',async req=>{await access(req.actor);const p=parse(z.object({mailboxId:z.string(),requestId:uuid}),req.params);return archive.synchronization(p.mailboxId,p.requestId);});
 app.post('/api/v4/mailboxes/:mailboxId/update',async req=>{await access(req.actor);const p=params(req.params),body=parse(z.object({requestId:uuid}).strict(),req.body);return new MailboxUpdate(id,archive).queue(req.actor,p.mailboxId,body.requestId);});
 app.get('/api/v4/mailboxes/:mailboxId/updates/:batchId',async req=>{await access(req.actor);const p=parse(z.object({mailboxId:z.string(),batchId:uuid}),req.params);await archive.status(p.mailboxId);return new MailboxUpdate(id,archive).progress(p.mailboxId,p.batchId);});
 app.post('/api/v4/mailboxes/:mailboxId/messages/:messageKey/attachments/:attachmentId/import',async req=>{
  await access(req.actor);const p=params(req.params),body=parse(z.object({jobId:uuid}).strict(),req.body);
  const f=await archive.file(p.mailboxId,p.messageKey!,p.attachmentId);
  if(!f.attachment?.importable||f.attachment.inline)fail(422,'mailbox_attachment_not_importable');
  const tasks=new TaskService(id,new FileStore(id.config.storageRoot));
  return id.db.tx(async c=>{
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['mailbox-import:'+p.mailboxId+':'+p.messageKey+':'+p.attachmentId]);
   const old=(await c.query("SELECT * FROM tasks WHERE payload->>'mailboxId'=$1 AND payload->>'mailMessageKey'=$2 AND payload->>'mailAttachmentId'=$3 ORDER BY created_at LIMIT 1",[p.mailboxId,p.messageKey,p.attachmentId])).rows[0];
   if(old){if(old.payload.jobId!==body.jobId)fail(409,'mailbox_already_imported_other_job');return tasks.projectTask(req.actor,old);}
   const task=await tasks.upload(req.actor,{jobId:body.jobId,name:f.name,data:f.data,newCandidatesOnly:true,source:'招聘邮箱',note:('来自招聘邮箱；邮件主题：'+f.message.subject).slice(0,2000)});
   await c.query("UPDATE tasks SET payload=payload||$2::jsonb WHERE id=$1",[task.id,JSON.stringify({mailboxId:p.mailboxId,mailMessageKey:p.messageKey,mailAttachmentId:p.attachmentId})]);
   await id.audit(c,req.actor.id,'mailbox.import',task.id,{mailboxId:p.mailboxId,messageKey:p.messageKey,attachmentId:p.attachmentId});
   return tasks.projectTask(req.actor,task);
  });
 });
}
