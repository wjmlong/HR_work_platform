import {useEffect,useState} from 'react';
import {DownloadSimple,EnvelopeSimple,Paperclip} from '@phosphor-icons/react';
import {api} from '../lib/api';
import {useDebounced,useResource,Resource,type Row} from '../lib/state';
import {PageHeader,Panel,Pagination,Empty} from '../components/ui';
import MailboxUpdateButton from './MailboxUpdateButton';
import '../mailbox.css';
const size=(n:number)=>n>=1024*1024?(n/1024/1024).toFixed(1)+' MB':Math.max(1,Math.ceil(n/1024))+' KB';
const time=(v?:string)=>v?new Date(v).toLocaleString('zh-CN',{hour12:false}):'尚未同步';
export default function Mailbox({jobs:_jobs}:{jobs:Row[]}){
 const [search,setSearch]=useState(''),[page,setPage]=useState(1),[current,setCurrent]=useState(''),q=useDebounced(search,250),base='/mailboxes/recruitment';
 const accounts=useResource<Row>(()=>api('/mailboxes'),[]);
 const messages=useResource<Row>(signal=>api(base+'/messages?'+new URLSearchParams({q,page:String(page)}),{signal}),[q,page]);
 const detail=useResource<Row>(signal=>current?api(base+'/messages/'+current,{signal}):Promise.resolve(null as any),[current]);
 const account=accounts.data?.items?.find((a:Row)=>a.id==='recruitment'),rows:Row[]=messages.data?.items||[],message=detail.data?.id===current?detail.data:null;
 useEffect(()=>{setPage(1);},[q]);
 useEffect(()=>{const timer=setInterval(()=>{if(document.visibilityState==='visible'){accounts.reload();messages.reload();}},10000);return()=>clearInterval(timer);},[accounts.reload,messages.reload]);
 return <>
  <PageHeader title="邮箱来信" description="保留原始来信与简历附件"/>
  <MailboxUpdateButton/>
  <Resource loading={accounts.loading&&!accounts.data} error={accounts.error} retry={accounts.reload}>
   <div className="mailbox-account"><EnvelopeSimple size={26}/><div><strong>{account?.account||'招聘邮箱'}</strong><span>{account?.state==='error'?'同步待检查':account?.state==='syncing'?'正在获取邮件':'原件已归档'}</span></div>{account&&<p>已保存 {account.messageCount} 封来信 · 最近同步 {time(account.lastSyncedAt)}</p>}</div>
  </Resource>
  <Panel>
   <div className="mailbox-toolbar"><input type="search" aria-label="搜索招聘邮件" placeholder="搜索姓名、邮箱、岗位或附件名" value={search} onChange={e=>setSearch(e.target.value)}/></div>
   <Resource loading={messages.loading&&!messages.data} error={messages.error} retry={messages.reload}>
    {!rows.length?<Empty>暂无符合条件的来信</Empty>:<div className="table-scroll"><table><thead><tr><th>应聘邮件</th><th>附件</th><th>收件时间</th></tr></thead><tbody>{rows.map(m=><tr key={m.id}><td><button className="mailbox-subject text-button" onClick={()=>setCurrent(m.id)}>{m.subject||'（无主题）'}</button><span className="mailbox-sender">{m.senderName||m.senderEmail}{m.senderName&&m.senderEmail?' · '+m.senderEmail:''}</span></td><td>{m.attachments.filter((a:Row)=>!a.inline).length} 个</td><td>{time(m.receivedAt)}</td></tr>)}</tbody></table></div>}
    <Pagination page={page} total={messages.data?.total||0} onChange={setPage}/>
   </Resource>
  </Panel>
  {current&&<Panel title="原始来信" action={<button onClick={()=>setCurrent('')}>关闭详情</button>}><Resource loading={detail.loading&&!message} error={detail.error} retry={detail.reload}>{message&&<div className="mailbox-detail"><header><h2>{message.subject||'（无主题）'}</h2><p>{message.senderName} {message.senderEmail} · {time(message.receivedAt)}</p><a className="button" href={'/api/v4'+base+'/messages/'+message.id+'/file'}><DownloadSimple size={16}/>下载原邮件</a></header><div className="mailbox-attachments">{message.attachments.filter((a:Row)=>!a.inline).map((a:Row)=><div className="mailbox-attachment" key={a.id}><Paperclip size={19}/><span><strong>{a.name}</strong><span>{size(a.size)}</span></span><a className="button" href={'/api/v4'+base+'/messages/'+message.id+'/attachments/'+a.id+'/file'}>下载原件</a></div>)}</div><h3>应聘者原始描述</h3>{message.bodyWarning&&<p className="notice warning">{message.bodyWarning}</p>}<pre className="mailbox-body">{message.body||'（邮件无可提取的正文）'}</pre></div>}</Resource></Panel>}
 </>;
}
