import test from 'node:test';
import assert from 'node:assert/strict';
import {renderReplyTemplate,replyTemplateCatalog,parseReplyHeaders,TEST_RECIPIENT} from '../src/mailbox/reply-templates.js';

const common={candidateName:'邮件测试',company:'山子',position:'招聘专员',senderName:'招聘同事',senderTitle:'人力资源'};
const advance={...common,reason:'您的招聘协作经验与团队需求契合',questionnaireMinutes:8,interviewMinutes:60,interviewFormat:'线上视频',locationNotice:'会议链接',senderPhone:'13800138000',senderEmail:'hr@sensteed.com',slots:[{date:'2026-11-20',start:'14:00',end:'15:00'},{date:'2026-11-23',start:'10:00',end:'11:00'},{date:'2026-11-24',start:'16:00',end:'17:00'}],replyDeadline:'2026-11-19T18:00'};
const now=new Date('2026-11-16T00:00:00Z');

test('both supplied templates retain original wording while every example placeholder is replaced',()=>{
 const first=renderReplyTemplate('advance',advance,now),second=renderReplyTemplate('decline',{...common,reason:'该岗位目前更倾向具备技术招聘经验的候选人'},now);
 assert.match(first.subject,/山子 · 招聘专员 后续流程沟通 — 邮件测试/);
 assert.match(first.text,/近 6 个月内是否做过 MBTI 测评/);
 assert.ok(first.text.includes('没做过：链接：[MBTI十六型人格免费测试 - 专业深度测评平台 | 16personalities](https://www.16personality.com.cn/#version=48)，请抽空完成。'));
 assert.doesNotMatch(first.text,/后续可能会给您发送|大约需要 8 分钟/);
 assert.match(first.text,/2026年11月20日 周五/);
 assert.match(first.text,/其他时间：________________/);
 assert.match(second.text,/您的简历我们已存入公司人才库/);
 for(const draft of [first,second])assert.match(draft.text,/祝好\n山子 人力资源部\n$/);
 assert.doesNotMatch(first.text+second.text,/[{}]|XX|yourcompany|candidate@example/);
 assert.equal(TEST_RECIPIENT,'recruiting-operator@example.invalid');
 assert.equal(replyTemplateCatalog().length,2);
});
test('strict parameters reject omitted values, samples, unknown fields and header injection',()=>{
 for(const patch of [{candidateName:''},{candidateName:'{候选人姓名}'},{reason:'XX方向经验'},{senderEmail:'candidate@example.com'},{company:'山子\r\nBcc: leak@evil.invalid'},{to:'victim@example.org'},{questionnaireMinutes:0},{senderPhone:'{手机}'}])assert.throws(()=>renderReplyTemplate('advance',{...advance,...patch},now));
 assert.throws(()=>renderReplyTemplate('decline',{...common,reason:'合适'},now));
});
test('dates are real future calendar dates and deadline precedes the available slots',()=>{
 for(const patch of [{replyDeadline:'2026-02-30T18:00'},{replyDeadline:'2026-11-15T18:00'},{replyDeadline:'2026-11-21T18:00'},{slots:[{date:'2026-11-20',start:'15:00',end:'14:00'},...advance.slots.slice(1)]},{slots:[{date:'2026-02-30',start:'14:00',end:'15:00'},...advance.slots.slice(1)]}])assert.throws(()=>renderReplyTemplate('advance',{...advance,...patch},now));
});
test('reply headers preserve the source thread and reject malformed or injected values',()=>{
 const headers=parseReplyHeaders(Buffer.from('From: candidate@example.com\r\nMessage-ID: <new@example.com>\r\nReferences: <old@example.com>\r\n <prior@example.com>\r\nIn-Reply-To: <prior@example.com>\r\n\r\nbody'));
 assert.deepEqual(headers,{inReplyTo:'<new@example.com>',references:['<old@example.com>','<prior@example.com>','<new@example.com>']});
 assert.deepEqual(parseReplyHeaders(Buffer.from('Subject: hi\r\n\r\nbody')),{});
 assert.throws(()=>parseReplyHeaders(Buffer.from('Message-ID: <ok@example.com>\r\nMessage-ID: <extra@example.com>\r\n\r\n')));
 assert.throws(()=>parseReplyHeaders(Buffer.from('Message-ID: <ok@example.com>\r\n Bcc: <victim@example.com>\r\n\r\n')));
});
