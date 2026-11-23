import {useEffect,useState} from 'react';
import {api} from '../lib/api';
import {date,useDebounced,useResource,type Row} from '../lib/state';
import {Field} from './ui';
export type DirectoryMember={openId:string;name:string;role:'interviewer'|'coordinator'};
export default function DirectoryPicker({value,onChange}:{value:DirectoryMember[];onChange:(value:DirectoryMember[])=>void}){
 const [text,setText]=useState(''),[page,setPage]=useState(1),q=useDebounced(text);
 const result=useResource<Row>(signal=>api('/directory/members?query='+encodeURIComponent(q)+'&page='+page+'&pageSize=25',{signal}),[q,page]);
 useEffect(()=>{if(!result.data?.refreshing&&!result.data?.error)return;const t=setTimeout(result.reload,(result.data.retryAfterSeconds||3)*1000);return()=>clearTimeout(t);},[result.data,result.reload]);
 return <fieldset className="directory-picker"><legend>飞书通讯录 · 本场临时参与人</legend><p className="muted">无需先登录；仍须通过企业飞书登录，且在“招聘”应用可用范围内。默认在面试结束 48 小时后失效。</p>
 <Field label="搜索员工姓名或 open_id"><input value={text} onChange={e=>{setText(e.target.value);setPage(1);}}/></Field>
 {result.error&&<p role="alert">{result.error}<button type="button" onClick={result.reload}>重试通讯录</button></p>}
 <p role="status">{result.loading?'正在检索…':result.data?.refreshing?'正在刷新企业通讯录…':result.data?.error?'通讯录暂不可用，显示最近缓存':`共 ${result.data?.total||0} 位员工`}{result.data?.cachedAt?' · 更新于 '+date(result.data.cachedAt):''}</p>
 {result.data?.error&&<button type="button" onClick={result.reload}>重新检查通讯录</button>}
 <div className="table-scroll"><table><thead><tr><th>员工</th><th>应用身份</th><th>选择</th></tr></thead><tbody>{result.data?.items.map((member:Row)=><tr key={member.openId}><td>{member.name}</td><td><small>{member.openId}</small></td><td><button type="button" disabled={value.some(v=>v.openId===member.openId)||value.length>=20} onClick={()=>onChange([...value,{...member,role:'interviewer'} as DirectoryMember])}>加入本场</button></td></tr>)}</tbody></table></div>
 {!result.loading&&!result.data?.refreshing&&!result.data?.error&&!result.data?.items.length&&<p>没有匹配的在职员工</p>}
 <div className="toolbar"><button type="button" disabled={page===1} onClick={()=>setPage(page-1)}>上一页</button><span>第 {page} 页</span><button type="button" disabled={page*25>=(result.data?.total||0)} onClick={()=>setPage(page+1)}>下一页</button></div>
 {value.map(member=><div className="toolbar" key={member.openId}><strong>{member.name}</strong><small>{member.openId}</small><select aria-label={member.name+' 本场角色'} value={member.role} onChange={e=>onChange(value.map(v=>v.openId===member.openId?{...v,role:e.target.value as DirectoryMember['role']}:v))}><option value="interviewer">面试官 · 材料 / AI / 本人反馈</option><option value="coordinator">HR 协调 · 另可调整本场安排</option></select><button type="button" onClick={()=>onChange(value.filter(v=>v.openId!==member.openId))}>移除选择</button></div>)}
 </fieldset>;
}
