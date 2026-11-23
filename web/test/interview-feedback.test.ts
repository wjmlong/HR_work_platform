import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
test('HR sees submitted declines and can retry a failed send without showing acceptance',async t=>{
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'https://recruit.test/'}),previous=new Map<string,PropertyDescriptor|undefined>();
 const install=(key:string,value:any)=>{previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});};
 for(const key of ['window','document','navigator','location','HTMLElement','Element','Node','Event','MouseEvent','FormData'])install(key,(dom.window as any)[key]);
 install('IS_REACT_ACT_ENVIRONMENT',true);
 dom.window.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};dom.window.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
 let sent=false;const calls:any[]=[];
 install('fetch',async(url:any,init:any)=>{assert.equal(String(url),'/api/v4/interviews/fixture/feishu-feedback');calls.push({method:init.method,body:init.body});if(init.method==='POST'){assert.deepEqual(JSON.parse(init.body),{version:3,confirmed:true});sent=true;}
  return new Response(JSON.stringify({data:{version:3,enabled:true,canSend:true,needsCoordination:true,items:[{userId:'one',name:'合成面试官甲',delivery:'sent',decision:'declined',reason:'时间冲突，请协调',stale:false},{userId:'two',name:'合成面试官乙',delivery:sent?'sent':'failed',decision:'pending',reason:'',stale:false}]}}),{headers:{'content-type':'application/json'}});
 });
 const root=createRoot(document.getElementById('root')!);t.after(async()=>{await act(async()=>root.unmount());dom.window.close();for(const [key,descriptor]of previous)descriptor?Object.defineProperty(globalThis,key,descriptor):Reflect.deleteProperty(globalThis,key);});
 const [{default:Feedback},{Context}]=await Promise.all([import('../src/features/InterviewFeedback.tsx'),import('../src/lib/state.tsx')]);
 const settle=async()=>act(async()=>{await new Promise(r=>setTimeout(r,25));});
 await act(async()=>root.render(React.createElement(Context.Provider,{value:{notify:()=>{},refresh:()=>{}} as any},React.createElement(Feedback,{interview:{id:'fixture',round:1},onClose:()=>{}}))));await settle();
 assert.match(document.body.textContent!,/拒绝.*需协调/);assert.match(document.body.textContent!,/时间冲突，请协调/);assert.match(document.body.textContent!,/发送失败/);
 const retry=Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='重试未成功发送的确认');assert.ok(retry);
 await act(async()=>retry.click());await settle();assert.equal(calls.filter(c=>c.method==='POST').length,1);
 assert.match(document.body.textContent!,/待回复/);assert.doesNotMatch(document.body.textContent!,/已确认参加/);
});
