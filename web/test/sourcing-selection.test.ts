import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

// Exercise the production component's async actions, with React state slots and
// HTTP boundaries replaced. Rendering/DOM acceptance is also run in the browser.
function harness() {
  const source = fs.readFileSync(new URL('../src/features/SourcingDiscovery.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('    const { user }');
  const end = source.indexOf('    return <div className="discovery-workspace">');
  const code = ts.transpileModule(`function component(){${source.slice(start, end)}return { choose, perform, load, selected, results };}`, {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const slots: any[] = []; let cursor = 0;
  const tasks: any = {A:{id:'A',name:'Task A'},B:{id:'B',name:'Task B'},C:{id:'C',name:'New task'}};
  const useState = (initial: any) => { const i=cursor++; if (!(i in slots)) slots[i]=initial; return [slots[i],(v:any)=>slots[i]=typeof v==='function'?v(slots[i]):v]; };
  const useRef = (initial:any) => { const i=cursor++; return slots[i] ??= {current:initial}; };
  const api = async (path:string) => path.includes('/tasks/') ? {...tasks[path.split('/').pop()!]} : path.endsWith('model-status') ? {configured:true} : [];
  const query = async (path:string, body:any) => path.endsWith('results/query') ? {items:[{id:`result-${body.taskId}`}]} : path.endsWith('tasks/query') ? {items:Object.values(tasks),total:3} : {items:[],total:0,groups:[]};
  const render = new Function('useState','useRef','useEffect','useApp','api','query',`${code};return component;`)(useState,useRef,()=>{},()=>({user:{roles:['admin']}}),api,query);
  return { render:()=>{cursor=0;return render();} };
}
for (const next of ['B','C']) test(`selecting ${next} survives the action's refresh with matching results`, async()=>{
  const h=harness(); await h.render().choose({id:'A'});
  const oldRender=h.render();
  await oldRender.perform(()=>oldRender.choose({id:next}));
  assert.equal(h.render().selected.id,next);
  assert.equal(h.render().results[0].id,`result-${next}`);
  await h.render().load();
  assert.equal(h.render().selected.id,next);
});
