import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';

const drafts=[{id:'advance',name:'进入后续流程',version:'a'.repeat(64),draft:{subject:'[模板测试] 山子高科 · 后续流程沟通',text:'测试候选人您好：\n感谢您投递山子高科。\n合成HR\n招聘测试'}},{id:'decline',name:'暂不推进',version:'b'.repeat(64),draft:{subject:'[模板测试] 山子高科 · 投递反馈',text:'测试候选人您好：\n本次暂未推进。\n合成HR\n招聘测试'}}];
async function fixture(t:any,{configured=true,normalize=false,state='sent',dropResponse=false}:{configured?:boolean;normalize?:boolean;state?:string;dropResponse?:boolean}={}){
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'https://recruit.test/'}),previous=new Map<string,PropertyDescriptor|undefined>();
 const install=(key:string,value:any)=>{previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});};
 for(const key of ['window','document','navigator','location','HTMLElement','Element','Node','Event','MouseEvent','FormData'])install(key,(dom.window as any)[key]);
 install('IS_REACT_ACT_ENVIRONMENT',true);dom.window.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};dom.window.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
 const requests:{url:string;body:any;key:string}[]=[],receipt={id:'test-receipt',subject:'[模板测试] 测试主题',recipient:'recruiting-operator@example.invalid',state,createdAt:'2026-11-16T00:00:00Z'};let sent=false;
 install('fetch',async(url:any,options:any)=>{
  const route=String(url),body=options.body?JSON.parse(options.body):undefined;requests.push({url:route,body,key:options.headers['idempotency-key']});let data:any;
  if(route.endsWith('/reply-context'))data={configured,recipient:{address:'recruiting-operator@example.invalid',source:'sender'},templates:drafts};
  else if(route.endsWith('/replies')&&!body)data={items:sent?[receipt]:[]};
  else if(route.endsWith('/reply-preview'))data={configured,to:'recruiting-operator@example.invalid',subject:body.draft.subject,text:normalize&&!body.draft.text.endsWith('（已规范化）')?body.draft.text+'（已规范化）':body.draft.text,previewToken:'signed-final-text'};
  else if(route.endsWith('/replies')){assert.equal(body.confirmed,true);assert.equal(body.testMode,false);assert.equal(body.recipient,'recruiting-operator@example.invalid');assert.equal(body.recipientConfirmed,true);assert.equal(body.previewToken,'signed-final-text');assert.equal(body.to,undefined);assert.equal(body.from,undefined);sent=true;data=receipt;if(dropResponse)throw new TypeError('network interrupted');}
  else throw Error('unexpected route '+route);
  return new Response(JSON.stringify({data}),{headers:{'content-type':'application/json'}});
 });
 const root=createRoot(document.getElementById('root')!);t.after(async()=>{await act(async()=>root.unmount());dom.window.close();for(const [key,descriptor]of previous)descriptor?Object.defineProperty(globalThis,key,descriptor):Reflect.deleteProperty(globalThis,key);});
 const [{default:MailReplyDialog},{Context}]=await Promise.all([import('../src/features/MailReplyDialog.tsx'),import('../src/lib/state.tsx')]);
 const settle=async()=>act(async()=>{await new Promise(r=>setTimeout(r,20));});
 await act(async()=>root.render(React.createElement(Context.Provider,{value:{user:{name:'合成HR'}} as any},React.createElement(MailReplyDialog,{message:{id:'a'.repeat(64),subject:'应聘邮件'},onClose:()=>{}}))));await settle();
 const send=()=>{const button=Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='发送'||b.textContent==='重试发送')!;assert.ok(button,'one visible send action');return button;};
 const confirm=async()=>{if(!Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='确认发送'))await act(async()=>send().click());await act(async()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='确认发送')!;b.click();b.click();});await settle();};return {dom,requests,settle,send,confirm};
}
test('single editable reply requires visible recipient confirmation and suppresses double-click sends',async t=>{
 const f=await fixture(t);assert.equal(document.querySelectorAll('input').length,2);assert.equal(document.querySelectorAll('textarea').length,1);assert.doesNotMatch(document.body.textContent!,/生成预览|落款姓名/);
 assert.equal(f.send().disabled,false);await act(async()=>f.send().click());assert.equal(f.requests.filter(r=>r.url.endsWith('/replies')&&r.body).length,0);assert.match(document.body.textContent!,/将发送给/);
 await f.confirm();assert.equal(f.requests.filter(r=>r.url.endsWith('/reply-preview')).length,1);assert.equal(f.requests.filter(r=>r.url.endsWith('/replies')&&r.body).length,1);assert.match(document.body.textContent!,/不代表对方已收取或已读/);
});
test('edited draft survives template selection until confirmed and can be restored with undo',async t=>{
 const f=await fixture(t),body=document.querySelector('textarea') as HTMLTextAreaElement,edited=drafts[0].draft.text+'\n人工修改';
 await act(async()=>{Object.getOwnPropertyDescriptor(f.dom.window.HTMLTextAreaElement.prototype,'value')!.set!.call(body,edited);body.dispatchEvent(new Event('input',{bubbles:true}));});
 const select=document.querySelector('select')!;await act(async()=>{select.value='decline';select.dispatchEvent(new Event('change',{bubbles:true}));});
 assert.equal(body.value,edited);assert.match(document.body.textContent!,/替换内容/);
 await act(async()=>Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='替换内容')!.click());assert.equal(body.value,drafts[1].draft.text);
 await act(async()=>Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='撤销')!.click());assert.equal(body.value,edited);
 await f.confirm();assert.equal(f.requests.find(r=>r.url.endsWith('/replies')&&r.body)!.body.draft.text,edited);
});
test('normalization requires another review and missing configuration blocks sending',async t=>{
 const f=await fixture(t,{normalize:true});await f.confirm();assert.equal(f.requests.filter(r=>r.url.endsWith('/replies')&&r.body).length,0);assert.match(document.body.textContent!,/再次发送/);await f.confirm();assert.equal(f.requests.filter(r=>r.url.endsWith('/replies')&&r.body).length,1);
});
test('missing configuration preserves editing and disables sending',async t=>{
 const f=await fixture(t,{configured:false});assert.equal(f.send().disabled,true);assert.equal((document.querySelector('textarea') as HTMLTextAreaElement).disabled,false);
});
test('unknown delivery locks the draft and does not offer blind retry',async t=>{
 const f=await fixture(t,{state:'unknown'});await f.confirm();assert.match(document.body.textContent!,/发送结果待核对/);assert.equal(f.send().disabled,true);assert.equal((document.querySelector('textarea') as HTMLTextAreaElement).disabled,true);
});
test('definite failure preserves draft and retries only after another explicit confirmation',async t=>{
 const f=await fixture(t,{state:'failed'});await f.confirm();assert.equal(f.send().textContent,'重试发送');await f.confirm();const calls=f.requests.filter(r=>r.url.endsWith('/replies')&&r.body);assert.equal(calls.length,2);assert.equal(calls[1].body.retryReceiptId,'test-receipt');assert.notEqual(calls[0].key,calls[1].key);assert.deepEqual(calls[0].body.draft,calls[1].body.draft);
});

test('a lost send response preserves the draft and locks editing until the receipt is checked',async t=>{
 const f=await fixture(t,{dropResponse:true});await f.confirm();assert.equal((document.querySelector('textarea') as HTMLTextAreaElement).disabled,true);assert.equal(f.requests.filter(r=>r.url.endsWith('/replies')&&r.body).length,1);assert.equal(f.send().disabled,true);
});
