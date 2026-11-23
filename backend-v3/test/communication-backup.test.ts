import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {actor,testDatabase,dropFeedback24,dropMailReplies23,dropRecognition26} from './helpers.js';
import {Identity} from '../src/identity/service.js';
import {RecruitingService} from '../src/recruiting/service.js';
import {InterviewService} from '../src/interviews/service.js';
import {InterviewFeedback} from '../src/feishu-feedback/service.js';
import {MailboxReplyService} from '../src/mailbox/reply-service.js';
import {MailboxArchive} from '../src/mailbox/archive.js';
import {replyTemplateCatalog} from '../src/mailbox/reply-templates.js';
import {FileStore} from '../src/files/storage.js';
import {backup,restore,readArchive,TABLES} from '../src/operations/backup.js';
import type {ReplyConfiguration} from '../src/mailbox/reply-smtp.js';

const smtp:ReplyConfiguration={host:'mail-reply.test',port:465,secure:true,auth:{user:'hr@sensteed.com',pass:'synthetic-backup-only'},from:{name:'合成HR',address:'hr@sensteed.com'}};
const mailInput={templateId:'decline',templateVersion:replyTemplateCatalog().find(t=>t.id==='decline')!.version,testMode:true,parameters:{candidateName:'归档恢复合成对象',company:'山子',position:'招聘专员',reason:'该岗位目前更倾向具备技术招聘经验的候选人',senderName:'合成HR',senderTitle:'人力资源'}};

for(const revision of [22,23,24,25])test(`revision ${revision} archive restores communication receipts without dispatch and preserves replay protection`,async t=>{
 const source=await testDatabase(),target=await testDatabase(),directory=await mkdtemp(path.join(os.tmpdir(),'communication-backup-'));
 t.after(source.cleanup);t.after(target.cleanup);t.after(()=>rm(directory,{recursive:true,force:true}));
 for(const config of [source.config,target.config]){config.feishu={...config.feishu,tenant:'company',appId:'app',appSecret:'synthetic-backup-secret'};config.feishuFeedback={enabled:true};config.calendarSync={enabled:false,calendarId:''};}
 const provider={configured:()=>true,authorizeUrl:()=>'',identity:async()=>{throw Error('unused');},contact:async(openId:string)=>({tenant:'company',appId:'app',openId,name:openId,active:true})};
 const sourceIdentity=new Identity(source.db,source.config,provider),targetIdentity=new Identity(target.db,target.config,provider),admin=await actor(source.db),participant=await actor(source.db,['interviewer']);
 const recruiting=new RecruitingService(sourceIdentity),job=await recruiting.createJob(admin,{name:'归档恢复岗位',level:'P5'}),candidate=await recruiting.createCandidate(admin,{name:'归档恢复合成人'}),application=await recruiting.apply(admin,{jobId:job.id,candidateId:candidate.id});
 const interview=await new InterviewService(sourceIdentity).create(admin,{applicationId:application.id,round:1,startsAt:'2030-01-01T09:00:00Z',durationMinutes:45,form:'online',interviewerIds:[admin.id,participant.id],primaryInterviewerId:admin.id});
 let sourceSends=0,targetSends=0;
 const archive=new MailboxArchive(path.join(directory,'mailboxes')),mail=new MailboxReplyService(sourceIdentity,archive,{configuration:async()=>smtp,transport:async()=>{sourceSends++;return {accepted:true};}});
 const preview=await mail.preview(admin,undefined,mailInput),mailReceipt=await mail.send(admin,undefined,{...mailInput,previewToken:preview.previewToken,confirmed:true},'archive-original');
 await source.db.query("UPDATE mailbox_reply_receipts SET state='unknown',sent_at=NULL,error_code='smtp_result_unknown' WHERE id=$1",[mailReceipt.id]);
 const feedback=new InterviewFeedback(sourceIdentity,()=>({send:async(openId:string)=>{sourceSends++;return {messageId:'om_archive_'+openId};}}));
 await feedback.send(admin,interview.id,{version:interview.version,confirmed:true});
 const confirmation=(await source.db.query('SELECT * FROM feishu_interview_confirmations WHERE user_id=$1',[participant.id])).rows[0];
 const callback={schema:'2.0',event_id:'archive-callback-event',event_type:'card.action.trigger',app_id:'app',tenant_key:'company',operator:{open_id:participant.open_id,tenant_key:'company'},host:'im_message',context:{open_message_id:confirmation.message_id},action:{tag:'button',value:{kind:'interview_confirmation',id:confirmation.id,token:feedback.token(confirmation.id),decision:'declined'},form_value:{reason:'合成冲突，请协调时间'}}};
 const callbackResult=await feedback.handleCardAction(callback);assert.equal(callbackResult.toast.type,'success');
 // Include an unfinished receipt to prove restore/read does not drain a pending queue.
 await source.db.query("UPDATE feishu_interview_confirmations SET delivery='queued',attempts=0,message_id=NULL WHERE user_id=$1",[admin.id]);
 await dropRecognition26(source.db);
 if(revision===24)await source.db.query('DELETE FROM schema_migrations WHERE version=25');
 if(revision===22)await dropMailReplies23(source.db);else if(revision===23)await dropFeedback24(source.db);
 const backupDirectory=path.join(directory,'archive'),manifest=await backup(source.db,new FileStore(path.join(directory,'source-files')),backupDirectory,true);
 assert.equal(manifest.schemaRevision,revision);assert.equal(Object.keys(manifest.tables).length,revision===22?76:revision===23?77:revision<27?79:80);
 const checked=await readArchive(target.db,new FileStore(path.join(directory,'target-files')),backupDirectory);assert.equal(Object.keys(checked.tables).length,TABLES.length);
 assert.equal(checked.tables.mailbox_reply_receipts.length,revision>=23?1:0);assert.equal(checked.tables.feishu_interview_callback_receipts.length,revision>=24?1:0);
 const sourceMail=revision>=23?(await source.db.query('SELECT * FROM mailbox_reply_receipts ORDER BY id')).rows:[],sourceFeedback=revision>=24?(await source.db.query('SELECT * FROM feishu_interview_confirmations ORDER BY id')).rows:[];
 await restore(target.db,new FileStore(path.join(directory,'target-files')),backupDirectory);
 assert.equal(targetSends,0);assert.deepEqual((await target.db.query('SELECT * FROM mailbox_reply_receipts ORDER BY id')).rows,sourceMail);assert.deepEqual((await target.db.query('SELECT * FROM feishu_interview_confirmations ORDER BY id')).rows,sourceFeedback);
 assert.equal((await target.db.query('SELECT max(version) version FROM schema_migrations WHERE version<1000')).rows[0].version,27);
 const restoredMail=new MailboxReplyService(targetIdentity,archive,{configuration:async()=>smtp,transport:async()=>{targetSends++;return {accepted:true};}}),restoredFeedback=new InterviewFeedback(targetIdentity,()=>({send:async()=>{targetSends++;return {messageId:'must-not-dispatch'};}}));
 assert.equal((await restoredMail.receipts(admin)).items.length,revision>=23?1:0);
 const status=await restoredFeedback.status(admin,interview.id);assert.equal(status.needsCoordination,revision>=24);
 if(revision>=23){const retry=await restoredMail.preview(admin,undefined,mailInput),same=await restoredMail.send(admin,undefined,{...mailInput,previewToken:retry.previewToken,confirmed:true},'different-key-after-restore');assert.equal(same.id,mailReceipt.id);assert.equal(same.state,'unknown');}
 if(revision>=24){assert.deepEqual(await restoredFeedback.handleCardAction(callback),callbackResult);assert.equal((await target.db.query('SELECT count(*)::int n FROM feishu_interview_callback_receipts')).rows[0].n,1);assert.equal((await target.db.query('SELECT delivery FROM feishu_interview_confirmations WHERE user_id=$1',[admin.id])).rows[0].delivery,'queued');}
 assert.equal(targetSends,0,'restore, status reads and receipt replay must not deliver messages');assert.equal(sourceSends,3,'all original delivery is through synthetic test doubles');
});
