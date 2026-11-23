import fs from 'node:fs/promises';import path from 'node:path';import {analyzeSemantic} from './semantic.mjs';
const [config,out]=process.argv.slice(2);await fs.mkdir(out,{recursive:true,mode:0o700});
const jd={mandatory:'n8n/Zapier/RAGFlow/ComfyUI/Make/Airflow任意一项实战，或自建Workflow引擎，非要求全部掌握',experience:'1–3年',education:'本科',stack:'Node.js/Python/Java至少一门并且React/Vue至少一种'};
const cases=[
{id:'one-tool-is-enough',text:'姓名：验收甲\n本科，计算机专业，工作经验2年。\n项目：使用n8n独立搭建订单自动化，Webhook接收订单后调用飞书API，配置异常重试和去重，负责测试部署上线。Python FastAPI后端配合React管理页面。',status:'demonstrated'},
{id:'agent-is-not-engine',text:'姓名：验收乙\n本科，工作经验2年。\n项目：使用LangGraph StateGraph实现问答Agent，包含检索节点和生成节点。并未实现通用工作流引擎，也没有n8n、Zapier、RAGFlow、ComfyUI、Make、Airflow实际项目经验。',status:'uncertain'},
{id:'explicit-built-engine',text:'姓名：验收丙\n本科，工作经验3年。\n项目：独立设计并交付自建Workflow工作流引擎，实现DAG节点调度、条件分支、SQL状态持久化、失败重试和断点恢复，用于订单审批自动化。独立负责需求澄清、Python后端、Vue前端、测试与部署上线。',status:'demonstrated'}];
const rows=[];for(const c of cases){const file=path.join(out,c.id+'.txt');await fs.writeFile(file,c.text,{mode:0o600});const r=await analyzeSemantic(file,config,{jd});await fs.writeFile(path.join(out,c.id+'.result.json'),JSON.stringify(r,null,2),{mode:0o600});const w=r.result.assessment.find(a=>a.id==='workflow');rows.push({id:c.id,expected:c.status,actual:w.status,pass:w.status===c.status,noAutomaticScore:!('score'in r.result),summary:w.summary});console.log(JSON.stringify(rows.at(-1)));}await fs.writeFile(path.join(out,'acceptance.json'),JSON.stringify(rows,null,2),{mode:0o600});if(rows.some(r=>!r.pass))process.exitCode=1;
