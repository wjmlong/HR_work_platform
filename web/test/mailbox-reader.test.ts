import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {registerHooks} from 'node:module';
import {initialPage} from '../src/lib/prd.ts';
registerHooks({load(url,context,next){if(url.endsWith('.css'))return {format:'module',source:'',shortCircuit:true};return next(url,context);}});

const attachments=[
 {id:'0',name:'简历.pdf',size:1200,contentType:'application/pdf',inline:false},
 {id:'1',name:'作品.png',size:1200,contentType:'image/png',inline:false},
 {id:'2',name:'经历.docx',size:1200,contentType:'application/octet-stream',inline:false},
 {id:'3',name:'伪装.svg',size:1200,contentType:'image/svg+xml',inline:false},
];
const messages=[{id:'a'.repeat(64),subject:'应聘研发工程师',senderName:'测试甲',senderEmail:'a@example.invalid',receivedAt:'2026-11-16T00:00:00Z',attachments,body:'甲的原始正文 <script>不可执行</script>'},{id:'b'.repeat(64),subject:'应聘产品经理',senderName:'测试乙',senderEmail:'b@example.invalid',receivedAt:'2026-11-16T01:00:00Z',attachments:[],body:'乙的原始正文'}];
async function fixture(t:any,{narrow=false,app=false,hash='#inbox/mailbox',previewMismatch=false}={}){
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'https://recruit.test/'+hash}),previous=new Map<string,PropertyDescriptor|undefined>();
 const install=(key:string,value:any)=>{previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});};
 for(const key of ['window','document','navigator','location','HTMLElement','Element','Node','Event','MouseEvent','FormData'])install(key,(dom.window as any)[key]);
 install('IS_REACT_ACT_ENVIRONMENT',true);dom.window.scrollTo=()=>{};
 dom.window.matchMedia=()=>({matches:narrow,addEventListener(){},removeEventListener(){}} as any);
 dom.window.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};dom.window.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
 let resolveDelayed:undefined|(()=>void);let delayed=false;
 install('fetch',async(url:any,options:any)=>{
  const route=String(url);let data:any;
  if(route.endsWith('/auth/me'))data={id:'hr',name:'合成人事',roles:['recruiter'],status:'active',csrf:'fixture'};
  else if(route.endsWith('/jobs'))data=[];
  else if(route.endsWith('/mailboxes'))data={items:[{id:'recruitment',account:'recruit@example.invalid',state:'ready',messageCount:2}]};
  else if(route.includes('/messages?'))data={items:messages.map(({body,...m})=>m),total:2};
  else if(route.endsWith('/preview'))return new Response(null,{headers:{'content-type':previewMismatch?'text/html':route.includes('/attachments/0/')?'application/pdf':'image/png'}});
  else {const found=messages.find(m=>route.endsWith('/messages/'+m.id));assert.ok(found,'Unexpected request '+route);if(delayed&&found.id===messages[0].id){delayed=false;await new Promise<void>(resolve=>{resolveDelayed=resolve;});}data=found;}
  return new Response(JSON.stringify({data}),{headers:{'content-type':'application/json'}});
 });
 const root=createRoot(document.getElementById('root')!);t.after(async()=>{resolveDelayed?.();await act(async()=>root.unmount());dom.window.close();for(const [key,descriptor]of previous)descriptor?Object.defineProperty(globalThis,key,descriptor):Reflect.deleteProperty(globalThis,key);});
 const [{default:Mailbox},{default:App},{Context}]=await Promise.all([import('../src/features/Mailbox.tsx'),import('../src/App.tsx'),import('../src/lib/state.tsx')]);
 const settle=async()=>act(async()=>{await new Promise(r=>setTimeout(r,25));});
 const user={id:'hr',name:'合成人事',roles:['recruiter'],status:'active',csrf:'fixture'};
 await act(async()=>root.render(app?React.createElement(App):React.createElement(Context.Provider,{value:{user,revision:0,notify(){},refresh(){},canWrite:true,canManage:false,isAdmin:false,openApplication(){},openPerson(){}}},React.createElement(Mailbox,{jobs:[]}))));
 for(let i=0;i<20&&!document.querySelector('button.mailbox-message');i++)await settle();
 const click=async(selector:string)=>{const element=document.querySelector<HTMLButtonElement>(selector);assert.ok(element,selector);await act(async()=>element.click());await settle();};
 return {dom,settle,click,delayFirst:()=>{delayed=true;},resolve:()=>resolveDelayed?.()};
}

test('both original-mail URLs resolve to the inbox child page',()=>{
 assert.equal(initialPage('#inbox/mailbox'),'mailbox');
 assert.equal(initialPage('#mailbox?source=legacy'),'mailbox');
 assert.equal(initialPage('#inbox/mailbox?source=inbox'),'mailbox');
});
test('legacy URL becomes canonical while the inbox remains the only active sidebar entry and breadcrumb returns to it',async t=>{
 await fixture(t,{app:true,hash:'#mailbox?source=legacy'});
 assert.equal(location.hash,'#inbox/mailbox?source=legacy');
 assert.equal(document.querySelector('nav[aria-label="主要导航"] a[aria-current="page"]')?.getAttribute('href'),'#inbox');
 assert.equal(document.querySelector('nav[aria-label="主要导航"] a[href="#mailbox"]'),null);
 assert.equal(document.querySelector('nav[aria-label="面包屑"] a')?.getAttribute('href'),'#inbox');
 assert.match(document.querySelector('nav[aria-label="面包屑"]')!.textContent!,/简历收件箱.*原始来信/);
});
test('desktop switches the reader without moving the list and restores each message position; stale detail never replaces selection',async t=>{
 const f=await fixture(t),list=document.querySelector<HTMLElement>('[aria-label="邮件列表"]');assert.ok(list);list.scrollTop=180;
 await f.click('button.mailbox-message');
 let reader=document.querySelector<HTMLElement>('[aria-label="邮件正文"]')!;assert.ok(reader);assert.match(reader.textContent!,/甲的原始正文/);assert.equal(reader.querySelector('script'),null);reader.scrollTop=240;
 await f.click('button.mailbox-message:nth-of-type(2)');
 assert.equal(list.scrollTop,180);assert.equal(document.querySelector('button.mailbox-message[aria-pressed="true"]')?.textContent?.includes('应聘产品经理'),true);assert.match(reader.textContent!,/乙的原始正文/);assert.equal(reader.scrollTop,0);assert.equal(document.querySelector('dialog'),null);
 await f.click('button.mailbox-message');reader=document.querySelector('[aria-label="邮件正文"]')!;assert.equal(reader.scrollTop,240);
 await f.click('button.mailbox-message:nth-of-type(2)');f.delayFirst();await f.click('button.mailbox-message');assert.doesNotMatch(reader.textContent!,/乙的原始正文/);
 await f.click('button.mailbox-message:nth-of-type(2)');await act(async()=>f.resolve());await f.settle();assert.match(reader.textContent!,/乙的原始正文/);assert.doesNotMatch(reader.textContent!,/甲的原始正文/);
});
test('narrow reader and separate attachment dialogs close back to the selected mail with downloads for unsupported files',async t=>{
 const f=await fixture(t,{narrow:true});await f.click('button.mailbox-message');
 const mail=document.querySelector('dialog[open]');assert.ok(mail);assert.match(mail.textContent!,/甲的原始正文/);
 await f.click('button[aria-label="查看附件 简历.pdf"]');
 let preview=document.querySelector('dialog[open]')!;assert.notEqual(preview,mail);assert.equal(document.querySelectorAll('dialog[open]').length,1);
 assert.match(preview.querySelector('iframe')!.getAttribute('src')!,/\/attachments\/0\/preview$/);assert.equal(preview.querySelector('iframe')!.hasAttribute('sandbox'),false,'native PDF viewers are blocked by an iframe sandbox');assert.ok(preview.querySelector('a[download]'));
 await f.click('dialog[open] button[aria-label="关闭弹窗"]');assert.equal(document.querySelector('dialog[open]'),mail);
 await f.click('button[aria-label="查看附件 作品.png"]');preview=document.querySelector('dialog[open]')!;assert.match(preview.querySelector('img')!.getAttribute('src')!,/\/attachments\/1\/preview$/);await f.click('dialog[open] button[aria-label="关闭弹窗"]');
 for(const name of ['经历.docx','伪装.svg']){await f.click('button[aria-label="查看附件 '+name+'"]');preview=document.querySelector('dialog[open]')!;assert.equal(preview.querySelector('iframe,img,object'),null);assert.match(preview.textContent!,/暂不支持预览/);assert.ok(preview.querySelector('a[download]'));await f.click('dialog[open] button[aria-label="关闭弹窗"]');}
 await f.click('dialog[open] button[aria-label="关闭弹窗"]');assert.equal(document.querySelector('dialog'),null);assert.equal(document.querySelector('button.mailbox-message[aria-pressed="true"]')?.textContent?.includes('应聘研发工程师'),true);
});
test('a rejected preview type never creates an embedded document and retains the original download',async t=>{
 const f=await fixture(t,{previewMismatch:true});await f.click('button.mailbox-message');await f.click('button[aria-label="查看附件 简历.pdf"]');
 const preview=document.querySelector('dialog[open]')!;assert.ok(preview);assert.equal(preview.querySelector('iframe,img,object'),null);assert.match(preview.textContent!,/无法预览/);assert.ok(preview.querySelector('a[download]'));
});
