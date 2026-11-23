import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultReplyDraft,validateReplyDraft} from '../src/mailbox/reply-templates.js';

const now=new Date('2026-12-31T17:00:00Z');
test('ready-to-send synthetic defaults include department-only signature and future Beijing dates',()=>{
 const draft=defaultReplyDraft('advance','合成HR','recruit@sensteed.com',now);
 assert.match(draft.subject,/山子高科/);assert.match(draft.text,/测试候选人（合成示例）/);assert.match(draft.text,/祝好\n山子高科 人力资源部\n$/);assert.doesNotMatch(draft.text,/合成HR|recruit@sensteed.com|合成测试号码/);assert.match(draft.text,/2027年1月3日 周日/);assert.match(draft.text,/2027年1月2日 18:00/);
 assert.deepEqual(validateReplyDraft('advance',draft,now),draft);assert.doesNotMatch(draft.text,/[{}]|candidate@example|yourcompany/);
 assert.match(defaultReplyDraft('decline','合成HR',undefined,now).text,/本次我们暂未推进/);
});
test('edited subject and body remain exact while unsafe fields, placeholders and invalid scheduling dates reject',()=>{
 const original=defaultReplyDraft('advance','合成HR','recruit@sensteed.com',now),edited={subject:original.subject+' · 人工修改',text:original.text.replace('期待与您交流。','期待和您进一步交流。')};
 assert.deepEqual(validateReplyDraft('advance',edited,now),edited);
 for(const patch of [{subject:'x\r\nBcc: leak@other.invalid'},{text:original.text+'{姓名}'},{text:original.text+'\0'},{to:'other@sensteed.com'},{text:original.text.replace('2027年1月3日','2027年2月30日')},{text:original.text.replace('周日','周一')},{text:original.text.replace('14:00-15:00','15:00-14:00')},{text:original.text.replace('2027年1月2日 18:00','2027年1月4日 18:00')}])assert.throws(()=>validateReplyDraft('advance',{...original,...patch},now));
 assert.throws(()=>validateReplyDraft('advance',original,new Date('2027-01-03T00:00:00Z')));
 assert.equal(validateReplyDraft('decline',{subject:'直接修改的主题',text:'这是一封合成测试邮件。'},now).subject,'[模板测试] 直接修改的主题');
});
