import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {testDatabase,httpSession,actor} from './helpers.js';
import {Identity} from '../src/identity/service.js';
import {MailboxArchive} from '../src/mailbox/archive.js';
import {MailboxReplyService} from '../src/mailbox/reply-service.js';
import {replyTemplateCatalog,TEST_RECIPIENT} from '../src/mailbox/reply-templates.js';
import {readReplyConfiguration,type ReplyConfiguration} from '../src/mailbox/reply-smtp.js';
import {BusinessConfigService} from '../src/business-config/service.js';
import {publishDefinition} from './business-config-fixture.js';

const configuration:ReplyConfiguration={host:'smtp.sensteed.com',port:465,secure:true,auth:{user:'hr@sensteed.com',pass:'synthetic-not-a-real-secret'},from:{name:'招聘测试',address:'hr@sensteed.com'}};
function input(name='模板测试对象'){
 return {templateId:'decline',templateVersion:replyTemplateCatalog().find(t=>t.id==='decline')!.version,testMode:true,parameters:{candidateName:name,company:'山子',position:'招聘专员',senderName:'招聘同事',senderTitle:'人力资源',reason:'该岗位目前更倾向具备技术招聘经验的候选人'}};
}
async function fixture(){
 const db=await testDatabase(),temp=await mkdtemp(path.join(os.tmpdir(),'mail-reply-'));db.config.storageRoot=path.join(temp,'files');
 const session=await httpSession(db.db,db.config),identity=new Identity(db.db,db.config,session.provider),archive=new MailboxArchive(path.join(temp,'mailboxes'));
 return {...db,...session,temp,identity,archive,cleanup:async()=>{await session.app.close();await db.cleanup();await rm(temp,{recursive:true,force:true});}};
}

test('synthetic preview needs no candidate archive; strict test-only sending is unavailable without SMTP',async t=>{
 const f=await fixture();t.after(f.cleanup);
 const service=new MailboxReplyService(f.identity,f.archive,{configuration:async()=>null});
 const preview=await service.preview(f.actor,undefined,input());assert.equal(preview.to,TEST_RECIPIENT);assert.equal(preview.configured,false);
 await assert.rejects(service.send(f.actor,undefined,{...input(),previewToken:preview.previewToken,confirmed:true},'no-config'),/mail_reply_not_configured/);
 for(const body of [{...input(),testMode:false},{...input(),to:'candidate@example.com'},{...input(),from:'attacker@sensteed.com'}])await assert.rejects(service.preview(f.actor,undefined,body));
 const response=await f.app.inject({method:'POST',url:'/api/v4/mailbox-replies/test/preview',headers:{...f.headers,'idempotency-key':'preview-1'},payload:input()});assert.equal(response.statusCode,200,response.body);assert.equal(response.json().data.configured,false);
 assert.equal(Number((await f.db.query("SELECT count(*) FROM idempotency_keys WHERE key='preview-1'")).rows[0].count),0,'reply routes must not enter the generic command transaction or response cache');
 const old=await f.app.inject({method:'POST',url:'/api/v3/mailbox-replies/test/send',headers:f.headers,payload:{}});assert.equal(old.statusCode,426);
 const anonymous=await f.app.inject({url:'/api/v4/mailbox-replies/templates',headers:{host:f.headers.host,'x-forwarded-proto':'https'}});assert.equal(anonymous.statusCode,401);
});
test('durable send claims suppress concurrent requests, changed keys, and SMTP uncertainty without reporting reads',async t=>{
 const f=await fixture();t.after(f.cleanup);let calls=0;
 const service=new MailboxReplyService(f.identity,f.archive,{configuration:async()=>configuration,transport:async(_config,message)=>{
  calls++;assert.equal(message.to,TEST_RECIPIENT);assert.ok(!message.text.includes('candidate@example.com'));
  const durable=await f.db.pool.query('SELECT state FROM mailbox_reply_receipts WHERE message_id=$1',[message.messageId]);assert.equal(durable.rows[0].state,'sending');
  return {accepted:true};
 }});
 const preview=await service.preview(f.actor,undefined,input()),payload={...input(),confirmed:true,previewToken:preview.previewToken};
 await f.db.tx(()=>assert.rejects(service.send(f.actor,undefined,payload,'outer-transaction'),/mail_reply_transaction_boundary/));assert.equal(calls,0);
 const results=await Promise.all(['send-one','send-two'].map(k=>service.send(f.actor,undefined,payload,k)));
 assert.equal(calls,1);assert.equal(results[0].id,results[1].id);assert.equal((await service.send(f.actor,undefined,payload,'send-three')).state,'sent');assert.equal(calls,1);
 assert.equal((await service.receipts(f.actor)).items.length,1);assert.ok(!('readAt' in results[0]));
 const changed=input('不同测试对象'),changedPreview=await service.preview(f.actor,undefined,changed);
 await assert.rejects(service.send(f.actor,undefined,{...changed,confirmed:true,previewToken:changedPreview.previewToken},'send-one'),/idempotency_conflict/);
 const uncertain=new MailboxReplyService(f.identity,f.archive,{configuration:async()=>configuration,transport:async()=>{calls++;throw Object.assign(Error('secret-auth-value must never leak'),{code:'ETIMEDOUT'});}});
 const pending=await uncertain.preview(f.actor,undefined,changed),uncertainBody={...changed,confirmed:true,previewToken:pending.previewToken};
 const receipt=await uncertain.send(f.actor,undefined,uncertainBody,'uncertain-one');assert.equal(receipt.state,'unknown');assert.equal(receipt.errorCode,'smtp_result_unknown');
 assert.equal((await uncertain.send(f.actor,undefined,uncertainBody,'uncertain-two')).id,receipt.id);assert.equal(calls,2);assert.ok(!JSON.stringify(await uncertain.receipts(f.actor)).includes('secret-auth-value'));
});
test('preview bindings reject edits, older templates, expiry, config changes, membership versions and revoked roles',async t=>{
 const f=await fixture();t.after(f.cleanup);let sent=0,clock=new Date('2026-11-16T00:00:00Z'),smtp=configuration;
 const service=new MailboxReplyService(f.identity,f.archive,{configuration:async()=>smtp,now:()=>clock,transport:async()=>{sent++;return {accepted:true};}});
 const preview=await service.preview(f.actor,undefined,input()),payload={...input(),previewToken:preview.previewToken,confirmed:true};
 await assert.rejects(service.send(f.actor,undefined,{...payload,parameters:{...payload.parameters,candidateName:'已改姓名'}},'changed-params'),/mail_reply_preview_stale/);
 await assert.rejects(service.send(f.actor,undefined,{...payload,confirmed:false},'unconfirmed'));
 await assert.rejects(service.preview(f.actor,undefined,{...input(),templateVersion:'0'.repeat(64)}),/mail_reply_template_stale/);
 clock=new Date('2026-11-16T00:16:00Z');await assert.rejects(service.send(f.actor,undefined,payload,'expired-preview'),/mail_reply_preview_stale/);clock=new Date('2026-11-16T00:00:00Z');
 smtp={...configuration,auth:{...configuration.auth,pass:'rotated'}};await assert.rejects(service.send(f.actor,undefined,payload,'rotated-config'),/mail_reply_preview_stale/);smtp=configuration;
 await f.db.query('UPDATE users SET version=version+1 WHERE id=$1',[f.actor.id]);await assert.rejects(service.send(f.actor,undefined,payload,'old-membership'),/membership_changed/);
 const current={...f.actor,version:f.actor.version+1};await f.db.query("UPDATE users SET roles=ARRAY['interviewer'] WHERE id=$1",[f.actor.id]);await assert.rejects(service.preview(current,undefined,input()),/forbidden/);assert.equal(sent,0);
});
test('permission checks also cover receipt replay and current source-field access',async t=>{
 const f=await fixture();t.after(f.cleanup);const recruiter=await actor(f.db,['recruiter']);let calls=0;
 const service=new MailboxReplyService(f.identity,f.archive,{configuration:async()=>configuration,transport:async()=>{calls++;return {accepted:true};}});
 const preview=await service.preview(recruiter,undefined,input()),payload={...input(),previewToken:preview.previewToken,confirmed:true};
 await service.send(recruiter,undefined,payload,'hr-send');
 const configs=new BusinessConfigService(f.identity),def=await configs.effective(f.actor,'resume'),doc:any=await configs.version(f.actor,def.ref);
 doc.fields.find((v:any)=>v.coreKey==='phone').access={read:['manager'],write:['manager'],export:['manager']};await publishDefinition({configs,admin:f.actor},doc);
 await assert.rejects(service.send(recruiter,undefined,payload,'hr-send'),/source_fields_forbidden/);await assert.rejects(service.receipts(recruiter),/source_fields_forbidden/);assert.equal(calls,1);
});
test('replies bind the verified original headers and still use only the authorized test address',async t=>{
 const f=await fixture();t.after(f.cleanup);const key='c'.repeat(64),dir=path.join(f.archive.root,'recruitment','messages',key);await mkdir(dir,{recursive:true});
 const raw=Buffer.from('From: candidate@example.com\r\nMessage-ID: <candidate@source.invalid>\r\nReferences: <ancestor@source.invalid>\r\n\r\nSynthetic application');
 const message={id:key,mailboxId:'recruitment',subject:'合成原信',senderName:'合成对象',senderEmail:'candidate@example.com',receivedAt:'2026-11-16T00:00:00Z',archivedAt:'2026-11-16T00:00:00Z',messageId:'<candidate@source.invalid>',rawSize:raw.length,rawSha256:createHash('sha256').update(raw).digest('hex'),body:'合成正文',attachments:[]};
 await writeFile(path.join(dir,'original.eml'),raw);await writeFile(path.join(dir,'message.json'),JSON.stringify(message));
 let envelope:any;const service=new MailboxReplyService(f.identity,f.archive,{configuration:async()=>configuration,transport:async(_c,m)=>{envelope=m;return {accepted:true};}}),source={mailboxId:'recruitment',messageKey:key};
 const preview=await service.preview(f.actor,source,input());assert.equal(preview.inReplyTo,'<candidate@source.invalid>');
 await service.send(f.actor,source,{...input(),previewToken:preview.previewToken,confirmed:true},'source-send');assert.equal(envelope.to,TEST_RECIPIENT);assert.deepEqual(envelope.references,['<ancestor@source.invalid>','<candidate@source.invalid>']);
 await writeFile(path.join(dir,'original.eml'),'tampered');await assert.rejects(service.preview(f.actor,source,input()),/mailbox_integrity_error/);
});
test('private SMTP config enforces TLS, concrete sender, and strict keys without exposing secrets',async t=>{
 const temp=await mkdtemp(path.join(os.tmpdir(),'reply-config-'));t.after(()=>rm(temp,{recursive:true,force:true}));const file=path.join(temp,'smtp.json');
 assert.equal(await readReplyConfiguration(),null);
 for(const value of [{...configuration,secure:false},{...configuration,from:{...configuration.from,address:'hr@yourcompany.com'}},{...configuration,tls:{rejectUnauthorized:false}}]){await writeFile(file,JSON.stringify(value),{mode:0o600});await assert.rejects(readReplyConfiguration(file),/mail_reply_config_invalid/);}
 await writeFile(file,JSON.stringify(configuration),{mode:0o600});assert.equal((await readReplyConfiguration(file))?.from.address,configuration.from.address);
});
