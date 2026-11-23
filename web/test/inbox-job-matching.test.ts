import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import CandidateCollection from '../src/features/CandidateCollection.tsx';
import {Context} from '../src/lib/state.tsx';

const recommended={id:'fixture-one',created_at:'2026-11-16T00:00:00Z',profile:{name:'合成甲',intent:'简历',skills:['Python']},inboxMatch:{kind:'recommended',jobId:'backend',jobName:'后端工程师',label:'AI推荐',intent:'',evidence:[{source:'resume',quote:'负责 Python 服务开发和数据库优化，独立维护支付服务。'}]}};
const pending={id:'fixture-two',created_at:'2026-11-16T00:00:00Z',profile:{name:'合成乙',intent:''},inboxMatch:{kind:'pending',label:'岗位待确认',intent:'',reason:'no_match'}};
async function fixture(t:any,initial:any[]){
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'https://fixture.invalid/#inbox'}),previous=new Map<string,PropertyDescriptor|undefined>();
 const install=(key:string,value:any)=>{previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});};
 for(const key of ['window','document','navigator','HTMLElement','Element','Node','Event','MouseEvent','FormData'])install(key,(dom.window as any)[key]);install('IS_REACT_ACT_ENVIRONMENT',true);
 let items=initial,requests=0,interval:(()=>void)|null=null;
 install('setInterval',(callback:()=>void,ms:number)=>{assert.equal(ms,15000);interval=callback;return 42;});install('clearInterval',()=>{interval=null;});
 install('fetch',async(url:any)=>{assert.ok(String(url).endsWith('/candidates/query'));requests++;return new Response(JSON.stringify({data:{items,total:items.length}}),{headers:{'content-type':'application/json'}});});
 const root=createRoot(document.getElementById('root')!);t.after(async()=>{await act(async()=>root.unmount());dom.window.close();for(const [key,descriptor]of previous)descriptor?Object.defineProperty(globalThis,key,descriptor):Reflect.deleteProperty(globalThis,key);});
 const user={id:'fixture-hr',name:'合成人事',roles:['recruiter'],status:'active',csrf:'fixture'};
 const settle=async()=>act(async()=>{await new Promise(r=>setTimeout(r,20));});
 await act(async()=>root.render(React.createElement(Context.Provider,{value:{user,revision:0,notify(){},refresh(){},canWrite:true,canManage:false,isAdmin:false,openApplication(){},openPerson(){}}},React.createElement(CandidateCollection,{lifecycle:'inbox'}))));await settle();
 return {dom,settle,requests:()=>requests,setItems:(next:any[])=>{items=next;},tick:async()=>{await act(async()=>interval?.());await settle();},hasTimer:()=>!!interval};
}
test('AI recommendations display separately from intention and the existing filter follows the displayed match',async t=>{
 const f=await fixture(t,[recommended,pending]);assert.match(document.querySelector('tbody')!.textContent!,/后端工程师.*AI推荐/);assert.doesNotMatch(document.querySelector('tbody')!.textContent!,/本人意向：简历/);
 assert.equal(document.querySelector('a[href="#inbox/mailbox"]')?.textContent,'原始来信');
 const select=document.querySelector<HTMLSelectElement>('select[aria-label="筛选匹配岗位"]')!;assert.ok(select);assert.ok([...select.options].some(o=>o.value==='后端工程师（AI推荐）'));
 await act(async()=>{select.value='后端工程师（AI推荐）';select.dispatchEvent(new domEvent('change',{bubbles:true}));});
 assert.equal(document.querySelectorAll('tbody tr').length,1);assert.match(document.querySelector('tbody')!.textContent!,/合成甲/);assert.equal(f.hasTimer(),false);
});
function domEvent(name:string,options:EventInit){return new window.Event(name,options);}
test('pending matching refreshes only a visible page and stops after the worker returns a terminal result',async t=>{
 const f=await fixture(t,[{...pending,inboxMatch:{...pending.inboxMatch,reason:'matching_pending'}}]);assert.equal(f.hasTimer(),true);const before=f.requests();
 Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});await f.tick();assert.equal(f.requests(),before);
 f.setItems([recommended]);Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});await f.tick();assert.equal(f.requests(),before+1);assert.equal(f.hasTimer(),false);assert.match(document.querySelector('tbody')!.textContent!,/AI推荐/);
});
