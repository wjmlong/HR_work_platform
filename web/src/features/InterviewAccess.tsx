import {departmentLabel} from '../lib/member-label';
import {calendarReason} from './CalendarSync';
import {useState} from 'react';
import DirectoryPicker,{type DirectoryMember} from '../components/DirectoryPicker';
import {api,query} from '../lib/api';
import {date,Resource,useApp,useDebounced,useResource,type Row} from '../lib/state';
import {Dialog,Field,Form,Panel,values} from '../components/ui';
export function InterviewAccess({interview,onClose}:{interview:Row;onClose:()=>void}){
 const [members,setMembers]=useState<DirectoryMember[]>([]),[extend,setExtend]=useState<Row|null>(null),{notify}=useApp();
 const materials=useResource<Row>(s=>api('/interviews/'+interview.id+'/materials',{signal:s}),[interview.id]);
 const grants=useResource<Row[]>(s=>api('/interviews/'+interview.id+'/access-grants',{signal:s}),[interview.id]);
 return <Dialog title="本场临时权限" onClose={onClose} wide><p>{interview.candidate_name} · {interview.job_name} · 第 {interview.round} 轮</p><p className="notice">范围仅限本场面试、本次申请的简历与 JD、AI 面试和本人反馈。不会改变永久角色。撤销会收回该员工在本场的全部临时授权，日历更新不会重新开通。</p>
 <p>{materials.data?.calendar?.eventId?"已关联共享日历事件 · "+materials.data.calendar.eventId:"尚未关联共享日历事件"}{materials.data?.calendar?.queued?" · 等待同步":""}{materials.data?.calendar?.state==="conflict"?" · 两端冲突":""}</p>{materials.data?.calendar?.lastError&&<p>{calendarReason(materials.data.calendar.lastError)}</p>}
 <Resource {...grants} retry={grants.reload}><table><thead><tr><th>员工 / 角色</th><th>来源 / 有效期</th><th>操作</th></tr></thead><tbody>{grants.data?.map(g=><tr key={g.id}><td>{g.name}<small>{departmentLabel(g)}</small>{g.role==='coordinator'?'HR 协调':'面试官'}</td><td>{g.source==='calendar'?'共享日历':'管理员授权'}<small>{date(g.expires_at)}</small>{g.revoked_at?'已撤销':new Date(g.expires_at)<=new Date()?'已到期':'有效'}</td><td>{!g.revoked_at&&<><button onClick={()=>setExtend(g)}>延长</button><button onClick={()=>void api('/interview-access-grants/'+g.id+'/revoke',{method:'POST',body:{}}).then(()=>{grants.reload();notify('已撤销该员工本场全部临时权限');}).catch(e=>notify(e.message,true))}>撤销本场权限</button></>}</td></tr>)}</tbody></table></Resource>
 <Form submit="预授予本场权限" onCancel={onClose} onSubmit={async()=>{if(!members.length)throw Error('请选择员工');for(const member of members)await api('/interviews/'+interview.id+'/access-grants',{method:'POST',body:{openId:member.openId,role:member.role}});setMembers([]);grants.reload();notify('本场权限已开通；员工仍须飞书登录');}}><DirectoryPicker value={members} onChange={setMembers}/></Form>
 {extend&&<Dialog title="延长本场权限" onClose={()=>setExtend(null)}><Form onCancel={()=>setExtend(null)} onSubmit={async form=>{await api('/interview-access-grants/'+extend.id,{method:'PATCH',body:{expiresAt:new Date(values(form).expiresAt).toISOString()}});setExtend(null);grants.reload();}}><Field label="失效时间"><input required type="datetime-local" name="expiresAt" min={new Date(new Date(extend.expires_at).getTime()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16)}/></Field></Form></Dialog>}
 </Dialog>;
}
export default function InterviewAccessAdmin(){
 const [text,setText]=useState(''),[selected,setSelected]=useState<Row|null>(null),q=useDebounced(text),rows=useResource<Row>(s=>query('/interviews/query',{query:q,pageSize:25},s),[q]);
 return <Panel title="按面试预开通临时权限"><p>选择面试后从飞书通讯录授权，不必等待员工首次登录。若飞书登录提示无应用权限，请管理员检查“招聘”应用可用范围。</p><Field label="查找面试候选人或岗位"><input value={text} onChange={e=>setText(e.target.value)}/></Field><Resource {...rows} retry={rows.reload}>{rows.data?.items.map((row:Row)=><div className="toolbar" key={row.id}><span>{row.candidate_name} · {row.job_name} · 第 {row.round} 轮 · {date(row.starts_at)}</span><button onClick={()=>setSelected(row)}>管理本场权限</button></div>)}{rows.data?.total>25&&<p>显示前 25 场，请缩小搜索范围。</p>}</Resource>{selected&&<InterviewAccess interview={selected} onClose={()=>setSelected(null)}/>}</Panel>;
}
