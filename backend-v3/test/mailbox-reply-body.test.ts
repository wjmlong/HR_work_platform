import test from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import {replyBody} from '../src/mailbox/reply-body.js';

test('named links produce clickable HTML and readable plain text in the outgoing MIME',async()=>{
 const url='https://www.16personality.com.cn/#version=48';
 const label='MBTI十六型人格免费测试 - 专业深度测评平台 | 16personalities';
 const text=`第一行\n没做过：链接：[${label}](${url})，请抽空完成。`;
 const body=replyBody(text);
 assert.equal(body.text,`第一行\n没做过：链接：${label} (${url})，请抽空完成。`);
 assert.equal(body.html,`<div>第一行<br>\n没做过：链接：<a href="${url}">${label}</a>，请抽空完成。</div>`);
 const transport=nodemailer.createTransport({streamTransport:true,buffer:true});
 const mail=await transport.sendMail({from:'hr@company.test',to:'candidate@personal.test',subject:'面试沟通',...body});
 const mime=mail.message.toString();
 assert.match(mime,/multipart\/alternative/);assert.match(mime,/text\/plain/);assert.match(mime,/text\/html/);
});

test('draft HTML remains literal and unsafe or malformed link targets are not made clickable',()=>{
 const text='<img src=x onerror=alert(1)>\r\n[A & B](https://example.test/?a=1&b=2) [bad](javascript:alert(1)) [bad](https://x.test/"bad)';
 const body=replyBody(text);
 assert.ok(body.html!.includes('&lt;img src=x onerror=alert(1)&gt;<br>'));
 assert.ok(body.html!.includes('<a href="https://example.test/?a=1&amp;b=2">A &amp; B</a>'));
 assert.equal(body.html!.match(/<a /g)?.length,1);assert.doesNotMatch(body.html!,/<img|href="javascript:/);
 assert.deepEqual(replyBody('普通邮件\n第二行'),{text:'普通邮件\n第二行'});
});
