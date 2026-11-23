import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {registerHooks} from 'node:module';
registerHooks({load(url,context,next){if(url.endsWith('.css'))return {format:'module',source:'',shortCircuit:true};return next(url,context);}});

test('evaluation list review action opens and closes the real interview review dialog',async t=>{
  const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'https://recruit.test/#evaluations'}),previous=new Map<string,PropertyDescriptor|undefined>();
  const install=(key:string,value:any)=>{previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});};
  for(const key of ['window','document','navigator','location','HTMLElement','Element','Node','Event','MouseEvent','FormData'])install(key,(dom.window as any)[key]);
  install('IS_REACT_ACT_ENVIRONMENT',true);
  dom.window.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};dom.window.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
  const calls:string[]=[],row={id:'meeting-review-fixture',application_id:'application-fixture',candidate_name:'Synthetic candidate',job_name:'Synthetic job',round:1,starts_at:'2030-01-01T09:00:00Z',duration_minutes:30,form:'online',status:'pending',interviewer_ids:['reader'],primary_interviewer_id:'reader'};
  install('fetch',async(url:any)=>{
    const name=String(url);calls.push(name);let data:any;
    if(name.endsWith('/interviews/query'))data={items:[row],total:1,page:1,pageSize:25};
    else if(name.endsWith('/assistant/context-card'))data={sections:[],summary:'Synthetic review context'};
    else if(name.endsWith('/assistant/evidence'))data={items:[]};
    else if(name.endsWith('/assistant/output-review'))data={};
    else throw Error('Unexpected request '+name);
    return new Response(JSON.stringify({data}),{headers:{'content-type':'application/json'}});
  });
  const root=createRoot(document.getElementById('root')!);
  t.after(async()=>{await act(async()=>root.unmount());dom.window.close();for(const [key,descriptor] of previous)descriptor?Object.defineProperty(globalThis,key,descriptor):Reflect.deleteProperty(globalThis,key);});
  const [{default:Interviews},{Context}]=await Promise.all([import('../src/features/Interviews.tsx'),import('../src/lib/state.tsx')]);
  const settle=async()=>act(async()=>{await new Promise(r=>setTimeout(r,25));});
  await act(async()=>root.render(React.createElement(Context.Provider,{value:{user:{id:'reader',name:'reader',roles:['interviewer'],status:'active',csrf:'fixture'},revision:0,canWrite:false,canManage:false,isAdmin:false,notify:()=>{},refresh:()=>{},openApplication:()=>{},openPerson:()=>{}}},React.createElement(Interviews,{evaluate:true}))));await settle();
  const review=Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='上下文与输出自查');assert.ok(review);
  await act(async()=>review.click());await settle();
  const dialog=document.querySelector('dialog[open]');assert.ok(dialog,'evaluation page must render the selected review dialog');
  assert.match(dialog.textContent!,/面试上下文与输出自查/);
  assert.ok(calls.includes('/api/v4/interviews/meeting-review-fixture/assistant/context-card'));
  const close=dialog.querySelector<HTMLButtonElement>('button[aria-label="关闭弹窗"]');assert.ok(close);
  await act(async()=>close.click());assert.equal(document.querySelector('dialog'),null);
});
