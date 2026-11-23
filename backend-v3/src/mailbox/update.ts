import {randomUUID} from 'node:crypto';
import {Identity,type Actor} from '../identity/service.js';
import {FileStore} from '../files/storage.js';
import {TaskService} from '../tasks/service.js';
import {fail,ApiError} from '../http/errors.js';
import {MailboxArchive,type MailMessage} from './archive.js';

export function mailPosition(subject:string,body:string,jobs:{id:string;name:string}[]){
 const declarations=body.match(/(?:应聘(?:岗位|职位)?|求职(?:岗位|意向)|意向(?:岗位|职位))\s*[:：][^\n]{1,100}/g)||[];
 const positions=declarations.map(value=>value.replace(/^[^:：]*[:：]\s*/,'').trim());
 const subjectMatch=subject.trim().match(/^(?:应聘|求职|申请)(?:岗位|职位)?\s*[:：]?\s*(.+)$/);
 if(subjectMatch)positions.push(subjectMatch[1].trim());
 else if(jobs.some(job=>job.name.trim()===subject.trim()))positions.push(subject.trim());
 const normalized=[...new Set(positions.map(value=>value.replace(/\s+/g,'').toLowerCase()))];
 const matches=normalized.length===1?jobs.filter(job=>job.name.replace(/\s+/g,'').toLowerCase()===normalized[0]):[];
 return {jobId:matches.length===1?matches[0].id:undefined,position:positions.length===1?positions[0]:''};
}
export function bodyIsApplication(message:Pick<MailMessage,'body'|'attachments'>){
 const platform=/[\u4e00-\u9fff]{1,5}(?:女士|先生)\s*投递了您的职位[「“][^」”]+[」”]/.test(message.body)&&/工作经历/.test(message.body)&&/教育经历/.test(message.body)&&message.body.replace(/\s/g,'').length>200;
 return !message.attachments.some(a=>a.importable&&!a.inline)&&(platform||/(?:姓名|应聘人|求职者)\s*[:：]/.test(message.body)&&/(?:1[3-9]\d{9}|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i.test(message.body));
}

export class MailboxUpdate{
 constructor(readonly identity:Identity,readonly archive:MailboxArchive){}
 async queue(actor:Actor,mailboxId:string,requestId:string){
  if(!(await this.archive.synchronization(mailboxId,requestId)).completed)fail(409,'mailbox_sync_pending');
  const batchId=randomUUID(),tasks=new TaskService(this.identity,new FileStore(this.identity.config.storageRoot));
  const jobs=(await this.identity.db.query<{id:string;name:string}>('SELECT id,name FROM jobs WHERE open')).rows;
  let queued=0,processed=0,unrecognized=0,pendingJobs=0,invalid=0;
  for(let page=1;;page++){
   const list=await this.archive.list(mailboxId,{q:'',page,pageSize:100});
   for(const entry of list.items){
    const message=await this.archive.message(mailboxId,entry.id),{jobId,position}=mailPosition(message.subject,message.body,jobs);
    const attachments=message.attachments.filter(a=>a.importable&&!a.inline);
    const inputs=attachments.map(a=>({id:a.id,name:a.name,body:false}));
    // Body-only applications require explicit person/contact labels; ordinary mail stays archived.
    if(bodyIsApplication(message))inputs.push({id:'body',name:'邮件自述.txt',body:true});
    if(!inputs.length){unrecognized++;continue;}
    for(const input of inputs){
     const created=await this.identity.db.tx(async c=>{
      await c.query('SAVEPOINT mailbox_item');
      try{
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['mailbox-import:'+mailboxId+':'+message.id+':'+input.id]);
      const old=(await c.query("SELECT id FROM tasks WHERE payload->>'mailboxId'=$1 AND payload->>'mailMessageKey'=$2 AND payload->>'mailAttachmentId'=$3 LIMIT 1",[mailboxId,message.id,input.id])).rows[0];
      if(old){await c.query('RELEASE SAVEPOINT mailbox_item');return 'processed';}
      const data=input.body?Buffer.from(message.body,'utf8'):(await this.archive.file(mailboxId,message.id,input.id)).data;
      const task=await tasks.upload(actor,{name:input.name,data,jobId,newCandidatesOnly:true,initialDescription:message.body.slice(0,4000),initialPosition:position,source:'招聘邮箱',note:('邮件主题：'+message.subject+'\n来信描述：'+message.body).slice(0,2000)});
      await c.query("UPDATE tasks SET payload=payload||$2::jsonb WHERE id=$1",[task.id,JSON.stringify({mailboxId,mailMessageKey:message.id,mailAttachmentId:input.id,mailboxBatchId:batchId})]);
      await c.query('RELEASE SAVEPOINT mailbox_item');return 'queued';
      }catch(error){
       await c.query('ROLLBACK TO SAVEPOINT mailbox_item');await c.query('RELEASE SAVEPOINT mailbox_item');
       if(!(error instanceof ApiError)||![413,422].includes(error.statusCode))throw error;
       await this.identity.audit(c,actor.id,'mailbox.attachment.needs_review',null,{mailboxId,messageKey:message.id,attachmentId:input.id,batchId,code:error.code});
       return 'invalid';
      }
     });
     if(created==='queued'){queued++;if(!jobId)pendingJobs++;}else if(created==='invalid')invalid++;else processed++;
    }
   }
   if(page*100>=list.total)break;
  }
  await this.identity.audit(this.identity.db.sql,actor.id,'mailbox.update',null,{mailboxId,batchId,queued,processed,unrecognized});
  return {batchId,queued,processed,unrecognized,pendingJobs,invalid};
 }
 async progress(mailboxId:string,batchId:string){
  const rows=(await this.identity.db.query("SELECT state,result FROM tasks WHERE payload->>'mailboxId'=$1 AND payload->>'mailboxBatchId'=$2",[mailboxId,batchId])).rows;
  const result={total:rows.length,active:0,added:0,skippedExisting:0,notResume:0,needsReview:0,failed:0,pendingJobs:0};
  for(const row of rows){if(['queued','running'].includes(row.state))result.active++;else if(row.state==='succeeded'&&row.result?.skippedExisting)result.skippedExisting++;else if(row.state==='succeeded'&&row.result?.skippedNonResume)result.notResume++;else if(row.state==='succeeded'&&row.result?.candidateId){result.added++;if(row.result.pendingJob)result.pendingJobs++;}else if(row.state==='failed')result.failed++;else result.needsReview++;}
  return result;
 }
}
