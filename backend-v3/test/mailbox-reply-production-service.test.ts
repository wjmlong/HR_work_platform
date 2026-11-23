import test from 'node:test';
import assert from 'node:assert/strict';
import {testDatabase,httpSession} from './helpers.js';
import {Identity} from '../src/identity/service.js';
import {MailboxReplyService} from '../src/mailbox/reply-service.js';
import {replyTemplateCatalog,TEST_RECIPIENT} from '../src/mailbox/reply-templates.js';
import type {MailboxArchive} from '../src/mailbox/archive.js';
const source={mailboxId:'recruitment',messageKey:'a'.repeat(64)};
const archive={file:async()=>({data:Buffer.from('Message-ID: <original@personal.com>\r\n\r\nresume'),message:{rawSha256:'b'.repeat(64),subject:'申请',senderEmail:'person@personal.com',body:'resume'}}),message:async()=>({})} as unknown as MailboxArchive;
const configuration={host:'mail.test',port:465 as const,secure:true,auth:{user:'hr',pass:'fixture'},from:{name:'HR',address:'hr@company.com'}};
const input=(recipient='person@personal.com')=>({templateId:'decline',templateVersion:replyTemplateCatalog().find(t=>t.id==='decline')!.version,testMode:false,recipient,recipientConfirmed:true,draft:{subject:'申请反馈',text:'您好，谢谢关注，本次暂不推进。'}});
async function fixture(t:any){const f=await testDatabase(),session=await httpSession(f.db,f.config);t.after(async()=>{await session.app.close();await f.cleanup();});return {...f,...session,identity:new Identity(f.db,f.config,session.provider)};}
test('production replies require source and recipient confirmation, bind final recipient and content, and record real delivery once',async t=>{
 const f=await fixture(t);let calls=0;const service=new MailboxReplyService(f.identity,archive,{configuration:async()=>configuration,transport:async(_c,message)=>{calls++;assert.equal(message.to,'person@personal.com');assert.equal(message.inReplyTo,'<original@personal.com>');return {accepted:true};}});
 for(const body of [{...input(),recipientConfirmed:false},input('b4.service@zhaopinmail.com'),input('a@personal.com,b@personal.com')])await assert.rejects(service.preview(f.actor,source,body));
 await assert.rejects(service.preview(f.actor,undefined,input()));
 const preview=await service.preview(f.actor,source,input());assert.equal(preview.testMode,false);assert.equal(preview.subject,'申请反馈');
 await assert.rejects(service.send(f.actor,source,{...input('changed@personal.com'),confirmed:true,previewToken:preview.previewToken},'changed-recipient'),/mail_reply_preview_stale/);
 await assert.rejects(service.send(f.actor,source,{...input(),draft:{subject:'申请反馈',text:'changed'},confirmed:true,previewToken:preview.previewToken},'changed-body'),/mail_reply_preview_stale/);
 const payload={...input(),confirmed:true,previewToken:preview.previewToken};const results=await Promise.all(['send-1','send-2'].map(key=>service.send(f.actor,source,payload,key)));assert.equal(calls,1);assert.equal(results[0].id,results[1].id);assert.equal(results[0].testMode,false);
 const row=(await f.db.query('SELECT * FROM mailbox_reply_receipts')).rows[0];assert.equal(row.recipient,'person@personal.com');assert.equal(row.test_mode,false);
 const verification=await service.preview(f.actor,source,input(TEST_RECIPIENT));assert.equal(verification.testMode,true,'owner verification never marks original candidate replied');
});
test('only a new explicit retry of a definite failure dispatches again; unknown is never retried',async t=>{
 const f=await fixture(t);let calls=0,mode='failed';const service=new MailboxReplyService(f.identity,archive,{configuration:async()=>configuration,transport:async()=>{calls++;if(mode==='unknown')throw Error('timeout');return {accepted:mode==='sent'};}});
 const p=await service.preview(f.actor,source,input()),payload={...input(),confirmed:true,previewToken:p.previewToken},failed=await service.send(f.actor,source,payload,'attempt-1');assert.equal(failed.state,'failed');
 await service.send(f.actor,source,payload,'automatic-new-key');assert.equal(calls,1);
 mode='sent';const retry={...payload,retryReceiptId:failed.id};const results=await Promise.all(['retry-1','retry-2'].map(k=>service.send(f.actor,source,retry,k)));assert.equal(calls,2);assert.equal(results[0].id,failed.id);assert.ok(['sending','sent'].includes(results[1].state));assert.equal((await service.receipts(f.actor,source)).items[0].state,'sent');
 mode='unknown';const body={...input(),draft:{subject:'另一次沟通',text:'您好，请回复。'}},p2=await service.preview(f.actor,source,body),unknown=await service.send(f.actor,source,{...body,confirmed:true,previewToken:p2.previewToken},'uncertain');assert.equal(unknown.state,'unknown');
 await service.send(f.actor,source,{...body,confirmed:true,previewToken:p2.previewToken,retryReceiptId:unknown.id},'uncertain-retry');assert.equal(calls,3);
 const changed={...input(),draft:{subject:'改写后也不重复发',text:'用户修改正文。'}},p3=await service.preview(f.actor,source,changed);const blocked=await service.send(f.actor,source,{...changed,confirmed:true,previewToken:p3.previewToken},'changed-uncertain');assert.equal(blocked.id,unknown.id);assert.equal(calls,3);
});
