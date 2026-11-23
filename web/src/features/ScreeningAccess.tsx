import {useState} from 'react';
import {api} from '../lib/api';
import {date,Resource,useApp,useDebounced,useResource,type Row} from '../lib/state';
import {departmentLabel} from '../lib/member-label';
import {Dialog,Field,Empty} from '../components/ui';

type Picked={openId:string;name:string;departments?:string[]};

// Fixed lifetime: the server defaults to 14 days, so the dialog has no term picker.
const DAYS=14;

// Admin-only: a screening grant is one job, fourteen days, one forward step.
export default function ScreeningAccess({jobs,onClose,initialJob}:{jobs:Row[];onClose:()=>void;initialJob?:string}){
 const {notify}=useApp();
 const [job,setJob]=useState(initialJob||jobs[0]?.id||'');
 const [text,setText]=useState(''),[picked,setPicked]=useState<Picked[]>([]);
 const [busy,setBusy]=useState(false);
 const q=useDebounced(text);
 const grants=useResource<Row[]>(s=>api('/job-screening-grants'+(job?'?jobId='+encodeURIComponent(job):''),{signal:s}),[job]);
 const members=useResource<Row>(s=>api('/directory/members?query='+encodeURIComponent(q)+'&pageSize=10',{signal:s}),[q]);
 const grant=async()=>{
  if(!job){notify('请先选择岗位',true);return;}
  if(!picked.length){notify('请先从通讯录选择员工',true);return;}
  setBusy(true);
  try{
   for(const member of picked)await api('/job-screening-grants',{method:'POST',body:{jobId:job,openId:member.openId}});
   setPicked([]);grants.reload();notify('已开通 '+DAYS+' 天岗位筛选权限；员工用企业飞书登录即可，到期自动失效');
  }catch(e){notify((e as Error).message,true);}finally{setBusy(false);}
 };
 const revoke=async(g:Row)=>{
  try{await api('/job-screening-grants/'+g.jobId+'/'+g.userId,{method:'DELETE'});grants.reload();notify('已撤销 '+g.userName+' 的该岗位权限');}
  catch(e){notify((e as Error).message,true);}
 };
 return <Dialog title="岗位筛选授权" onClose={onClose} wide>
  <p className="notice">只能看授权岗位的候选人，只能把「待筛选」推进到「初筛通过」；电话、邮箱显示为 ***；{DAYS} 天后自动失效。</p>
  <Field label="岗位"><select value={job} onChange={e=>{setJob(e.target.value);setPicked([]);}}>
   <option value="">请选择岗位</option>
   {jobs.map(j=><option key={j.id} value={j.id}>{j.name} · {j.department||'部门未填'}{j.open===false?'（已关闭）':''}</option>)}
  </select></Field>
  <Field label="飞书通讯录 · 搜索姓名或部门"><input value={text} onChange={e=>setText(e.target.value)} placeholder="输入姓名或部门"/></Field>
  {members.error&&<p role="alert">{members.error}<button type="button" onClick={members.reload}>重试</button></p>}
  {!!members.data?.items?.length&&<table><thead><tr><th>员工</th><th>部门</th><th>选择</th></tr></thead><tbody>
   {members.data.items.map((m:Row)=><tr key={m.openId}><td>{m.name}</td><td><small>{departmentLabel(m)}</small></td>
    <td><button type="button" className="small" disabled={picked.some(p=>p.openId===m.openId)||picked.length>=20}
     onClick={()=>setPicked([...picked,{openId:m.openId,name:m.name,departments:m.departments}])}>加入</button></td></tr>)}
  </tbody></table>}
  {picked.map(m=><div className="toolbar" key={m.openId}><strong>{m.name}</strong><small>{departmentLabel(m)}</small>
   <button type="button" onClick={()=>setPicked(picked.filter(p=>p.openId!==m.openId))}>移除</button></div>)}
  {!!picked.length&&<div className="toolbar">
   <button className="primary" disabled={busy} onClick={()=>void grant()}>为 {picked.length} 人开通 {DAYS} 天权限</button>
   <small className="muted">到期后自动失效，可随时撤销</small>
  </div>}
  <h3>当前授权</h3>
  <Resource {...grants} retry={grants.reload}>
   {!!grants.data?.length?<table><thead><tr><th>岗位 / 员工</th><th>状态</th><th>操作</th></tr></thead><tbody>
    {grants.data.map((g:Row)=><tr key={g.jobId+'/'+g.userId}>
     <td>{g.jobName}<small>{g.userName} · {g.openId}</small></td>
     <td>{g.active?'有效 · '+date(g.expiresAt):g.revokedAt?'已撤销':'已到期'}</td>
     <td>{g.active&&<button className="small" onClick={()=>void revoke(g)}>撤销</button>}</td></tr>)}
   </tbody></table>:<Empty>该岗位还没有授权记录</Empty>}
  </Resource>
 </Dialog>;
}
