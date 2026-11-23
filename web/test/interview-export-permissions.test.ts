import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {registerHooks} from 'node:module';
registerHooks({load(url,context,next){if(url.endsWith('.css'))return {format:'module',source:'',shortCircuit:true};return next(url,context);}});

test('interview CSV uses the server field-export permission boundary and reports a denied export',async t=>{
  const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'https://recruit.test/#interviews'}),previous=new Map<string,PropertyDescriptor|undefined>();
  const install=(key:string,value:any)=>{previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});};
  for(const key of ['window','document','navigator','location','history','HTMLElement','Element','Node','Event','MouseEvent','FormData'])install(key,(dom.window as any)[key]);
  install('IS_REACT_ACT_ENVIRONMENT',true);
  const calls:string[]=[],notices:any[]=[],definition={entity:'interview',ref:{configId:'fixture',version:1},aclRevision:'fixture',fields:[{fieldId:'core.interview.round',coreKey:'round',type:'number',label:'轮次',active:true,order:0,constraints:{},options:[],access:{read:['interviewer'],write:['admin'],export:['admin']}}]};
  install('fetch',async(url:any,init:any)=>{
    const name=String(url);calls.push(name);
    if(name==='/api/v4/business-config/interview/export'){
      assert.deepEqual(JSON.parse(init.body).query.columns,['core.interview.round']);
      return new Response(JSON.stringify({error:{code:'field_query_forbidden'}}),{status:403,headers:{'content-type':'application/json'}});
    }
    const data=name.endsWith('/business-config/effective/interview')?definition:name.includes('/views?')?[]:{items:[],total:0,page:1,pageSize:25,facets:{}};
    return new Response(JSON.stringify({data}),{headers:{'content-type':'application/json'}});
  });
  const root=createRoot(document.getElementById('root')!);
  t.after(async()=>{await act(async()=>root.unmount());dom.window.close();for(const [key,descriptor] of previous)descriptor?Object.defineProperty(globalThis,key,descriptor):Reflect.deleteProperty(globalThis,key);});
  const [{default:Interviews},{Context}]=await Promise.all([import('../src/features/Interviews.tsx'),import('../src/lib/state.tsx')]);
  const settle=async()=>act(async()=>{await new Promise(r=>setTimeout(r,30));});
  await act(async()=>root.render(React.createElement(Context.Provider,{value:{user:{id:'reader',name:'reader',roles:['interviewer'],status:'active',csrf:'fixture'},revision:0,canWrite:false,canManage:false,isAdmin:false,notify:(...args:any[])=>notices.push(args),refresh:()=>{},openApplication:()=>{},openPerson:()=>{}}},React.createElement(Interviews))));await settle();
  const click=async(text:string)=>{const button=Array.from(document.querySelectorAll('button')).find(b=>b.textContent===text);assert.ok(button,text);await act(async()=>button.click());await settle();};
  assert.equal(Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='导出 CSV'),false,'readable rows must not bypass export permission through a local CSV download');
  await click('字段视图与导出');await settle();
  await click('下载所选列 CSV');
  assert.ok(calls.includes('/api/v4/business-config/interview/export'));
  assert.equal(notices.length,1);assert.equal(notices[0][1],true);
});
