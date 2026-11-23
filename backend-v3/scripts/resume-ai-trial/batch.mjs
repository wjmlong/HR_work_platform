import fs from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';import {request} from './analyze.mjs';import {analyzeSemantic as analyze} from './semantic.mjs';
const [dir,config,out]=process.argv.slice(2);if(!out)throw Error('usage: node batch.mjs INPUT_DIR PRIVATE_CONFIG PRIVATE_OUTPUT_DIR');
await fs.mkdir(out,{recursive:true,mode:0o700});await fs.chmod(out,0o700);
const files=(await fs.readdir(dir)).filter(n=>/\.(pdf|docx|txt|png|jpe?g)$/i.test(n)).sort();
const jd={title:'全栈开发工程师（自动化方向）',department:'AI实验室',experience:'1–3年',education:'本科及以上，计算机相关专业优先',mandatory:'n8n、Zapier、RAGFlow、ComfyUI、Make、Airflow 或自建 Workflow 引擎，至少一项实战，能独立搭建复杂自动化流程',stack:'Node.js/Python/Java 至少一门 + React/Vue 至少一种，SQL/NoSQL',requirements:['需求分析、方案设计、开发、测试、部署上线的端到端交付','飞书、CRM、财务、OA等系统API集成，OAuth、Webhook','澄清模糊非结构化需求','深入理解财务、进销存、ERP业务','沉淀文档与组件库'],bonus:'RPA、低代码、AI Agent、LLM应用，财务或供应链对接'};
await fs.writeFile(path.join(out,'manifest.json'),JSON.stringify({jd,files:files.map((name,i)=>({id:String(i+1).padStart(2,'0'),name}))},null,2),{mode:0o600});
let cursor=0;const rows=[];
async function worker(){while(cursor<files.length){const i=cursor++,name=files[i],id=String(i+1).padStart(2,'0'),file=path.join(dir,name);const started=Date.now();try{
 const r=await analyze(file,config,{jd,onPrepared:async p=>{await fs.writeFile(path.join(out,id+'.prepared.json'),JSON.stringify(p.pages.map(({image,...x})=>({...x,image:!!image}))),{mode:0o600});},send:async(s,b)=>{const response=await request(s,b);await fs.writeFile(path.join(out,id+'.response-'+Date.now()+'.json'),JSON.stringify(response),{mode:0o600});return response;}});
 await fs.writeFile(path.join(out,id+'.result.json'),JSON.stringify(r,null,2),{mode:0o600});rows.push({id,ok:true,...r.metrics,sha256:createHash('sha256').update(await fs.readFile(file)).digest('hex'),facts:r.result.facts.length,assessment:r.result.assessment?.map(({id,status})=>({id,status}))});
 }catch(e){rows.push({id,ok:false,error:e.message.slice(0,300),elapsedMs:Date.now()-started});}
 rows.sort((a,b)=>a.id.localeCompare(b.id));await fs.writeFile(path.join(out,'summary.json'),JSON.stringify({localOnly:true,productionModified:false,total:files.length,completed:rows.length,rows},null,2),{mode:0o600});const row=rows.find(x=>x.id===id);console.log(JSON.stringify({id,ok:row.ok,error:row.error,elapsedMs:Date.now()-started,completed:rows.length,total:files.length}));}}
await Promise.all([worker(),worker()]);
