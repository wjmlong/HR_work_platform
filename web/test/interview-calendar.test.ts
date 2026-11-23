import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';

test('week calendar loads all 57 interviews across pages and fetches a new range on navigation',async t=>{
  const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'https://recruit.test/#interviews'}),previous=new Map<string,PropertyDescriptor|undefined>();
  const install=(key:string,value:any)=>{previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});};
  for(const key of ['window','document','navigator','location','HTMLElement','Element','Node','Event','MouseEvent','FormData'])install(key,(dom.window as any)[key]);
  install('IS_REACT_ACT_ENVIRONMENT',true);
  const calls:any[]=[];let firstWeek='';
  install('fetch',async(url:any,init:any)=>{
    assert.equal(String(url),'/api/v4/interviews/query');const q=JSON.parse(init.body);calls.push(q);firstWeek||=q.startsFrom;
    assert.equal(q.query,'Synthetic');assert.equal(q.deleted,false);
    assert.ok(new Date(q.startsBefore)>new Date(q.startsFrom));
    const total=q.startsFrom===firstWeek?57:1;
    const items=Array.from({length:total},(_,i)=>({id:q.startsFrom+'-'+i,candidate_name:(total===57?'Current ':'Next ')+i,job_name:'Synthetic job',round:1,starts_at:new Date(new Date(q.startsFrom).getTime()+i*60000).toISOString(),duration_minutes:30})).slice((q.page-1)*q.pageSize,q.page*q.pageSize);
    return new Response(JSON.stringify({data:{items,total,page:q.page,pageSize:q.pageSize}}),{headers:{'content-type':'application/json'}});
  });
  const root=createRoot(document.getElementById('root')!);
  t.after(async()=>{await act(async()=>root.unmount());dom.window.close();for(const [key,descriptor] of previous)descriptor?Object.defineProperty(globalThis,key,descriptor):Reflect.deleteProperty(globalThis,key);});
  const {default:Calendar}=await import('../src/features/InterviewCalendar.tsx');
  const settle=async()=>act(async()=>{await new Promise(r=>setTimeout(r,20));});
  await act(async()=>root.render(React.createElement(Calendar,{items:[],search:'Synthetic',deleted:false,revision:0,onPick:()=>{}} as any)));await settle();
  assert.equal(document.querySelectorAll('.calendar-event').length,57);
  assert.match(document.body.textContent!,/Current 56/);
  assert.deepEqual(calls.map(q=>q.page),[1,2,3]);
  const next=Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='下一周 →')!;
  await act(async()=>next.click());await settle();
  assert.equal(document.querySelectorAll('.calendar-event').length,1);assert.match(document.body.textContent!,/Next 0/);assert.doesNotMatch(document.body.textContent!,/Current 56/);
  assert.equal(calls.at(-1).startsFrom,calls[0].startsBefore);assert.equal(calls.at(-1).page,1);
  const current=Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='本周')!;
  await act(async()=>current.click());await settle();assert.equal(document.querySelectorAll('.calendar-event').length,57);
});
