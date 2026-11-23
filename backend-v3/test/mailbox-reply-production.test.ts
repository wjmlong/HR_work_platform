import test from 'node:test';
import assert from 'node:assert/strict';
import {replyRecipient,productionReplyDraft,validateProductionDraft} from '../src/mailbox/reply-context.js';
const raw=(h='')=>Buffer.from(h+'\r\nMessage-ID: <test@company.com>\r\n\r\n正文');
test('reply recipient distinguishes individual, forwarded, conflicting and explicit reply addresses',()=>{
 assert.equal(replyRecipient(raw(),'candidate@personal.com').address,'candidate@personal.com');
 assert.equal(replyRecipient(raw(),'b4.service@zhaopinmail.com').address,'');
 assert.equal(replyRecipient(raw('Reply-To: Candidate <person@personal.com>'),'b4.service@zhaopinmail.com').address,'person@personal.com');
 assert.equal(replyRecipient(raw('Reply-To: a@personal.com, b@personal.com'),'x@personal.com').address,'');
 assert.equal(replyRecipient(raw('Reply-To: a@personal.com, Candidate <b@personal.com>'),'x@personal.com').address,'');
 assert.equal(replyRecipient(raw('Reply-To: a@personal.com\r\nReply-To: b@personal.com'),'x@personal.com').address,'');
 assert.equal(replyRecipient(raw(),'b4.service@zhaopinmail.com',['person@personal.com']).source,'candidate');
 assert.equal(replyRecipient(raw(),'x@personal.com',['a@personal.com','b@personal.com']).address,'');
});
test('production drafts use known values, mark unknown details, and allow free editing without test prefixes or fixed scheduling fields',()=>{
 const draft=productionReplyDraft('advance',{name:'王女士',position:'薪酬激励专家',senderName:'HR',senderEmail:'hr@company.com'});
 assert.match(draft.text,/王女士/);assert.match(draft.text,/【待补充：可选日期 A】/);assert.doesNotMatch(draft.text,/测试候选人|2026年|000 0000/);
 assert.throws(()=>validateProductionDraft(draft),/mail_reply_placeholder/);
 assert.deepEqual(validateProductionDraft({subject:'面试沟通',text:'您好，请告知下周方便面试的时间。'}),{subject:'面试沟通',text:'您好，请告知下周方便面试的时间。'});
 assert.throws(()=>validateProductionDraft({subject:'主题\r\nBcc: other@company.com',text:'正文'}));
});
