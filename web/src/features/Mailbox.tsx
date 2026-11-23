import RelativeTime from '../components/RelativeTime';
import {formatDateTime} from '../lib/date-time';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {DownloadSimple,EnvelopeSimple,Paperclip} from '@phosphor-icons/react';
import {api} from '../lib/api';
import {useDebounced,useResource,Resource,type Row} from '../lib/state';
import {PageHeader,Pagination,Empty,Dialog} from '../components/ui';
import MailboxUpdateButton from './MailboxUpdateButton';
import MailReplyDialog,{type MailDraft} from './MailReplyDialog';
import '../mailbox.css';

const base='/mailboxes/recruitment';
const size=(n:number)=>n>=1024*1024?(n/1024/1024).toFixed(1)+' MB':Math.max(1,Math.ceil(n/1024))+' KB';
const time=(v?:string)=>v?formatDateTime(v):'尚未同步';
const attachmentUrl=(messageId:string,attachmentId:string)=>'/api/v4'+base+'/messages/'+encodeURIComponent(messageId)+'/attachments/'+encodeURIComponent(attachmentId);
const previewTypes:Record<string,string>={pdf:'application/pdf',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp'};

function AttachmentPreview({messageId,attachment,onClose}:{messageId:string;attachment:Row;onClose:()=>void}){
 const url=attachmentUrl(messageId,attachment.id),expected=previewTypes[String(attachment.name).split('.').at(-1)!.toLowerCase()];
 const [failed,setFailed]=useState(false);
 const preview=useResource<string>(async signal=>{
  if(!expected)return '';
  const response=await fetch(url+'/preview',{method:'HEAD',credentials:'same-origin',cache:'no-store',signal});
  if(!response.ok||response.headers.get('content-type')?.split(';')[0]!==expected)throw Error('该附件无法预览，请下载原件查看。');
  return expected;
 },[url,expected]);
 return <Dialog title={attachment.name} onClose={onClose} wide>
  <div className="mailbox-preview-actions"><span>{size(attachment.size)}</span><a className="button" href={url+'/file'} download={attachment.name}><DownloadSimple size={16}/>下载原件</a></div>
  {!expected?<Empty>此格式暂不支持预览，请下载原件查看。</Empty>:<Resource loading={preview.loading} error={preview.error} retry={preview.reload}>
   {failed?<p className="notice warning">预览加载失败，请下载原件查看。</p>:preview.data==='application/pdf'?<><iframe className="mailbox-preview-pdf" title={attachment.name+' PDF 预览'} src={url+'/preview'}/><p className="muted">若浏览器无法显示 PDF，可下载原件查看。</p></>:preview.data?<img className="mailbox-preview-image" src={url+'/preview'} alt={attachment.name} onError={()=>setFailed(true)}/>:null}
  </Resource>}
 </Dialog>;
}

export default function Mailbox({jobs:_jobs}:{jobs:Row[]}){
 const [search,setSearch]=useState(''),[page,setPage]=useState(1),[current,setCurrent]=useState(''),q=useDebounced(search,250);
 const [reply,setReply]=useState<{message:Row}|null>(null),[attachment,setAttachment]=useState<{messageId:string;attachment:Row}|null>(null);
 const [narrow,setNarrow]=useState(()=>window.matchMedia('(max-width: 900px)').matches),[readerOpen,setReaderOpen]=useState(false);
 const drafts=useRef(new Map<string,MailDraft>());
 const reader=useRef<HTMLDivElement>(null),positions=useRef(new Map<string,number>());
 const accounts=useResource<Row>(()=>api('/mailboxes'),[]);
 const messages=useResource<Row>(signal=>api(base+'/messages?'+new URLSearchParams({q,page:String(page)}),{signal}),[q,page]);
 const detail=useResource<Row>(signal=>current?api(base+'/messages/'+current,{signal}):Promise.resolve(null as any),[current]);
 const account=accounts.data?.items?.find((a:Row)=>a.id==='recruitment'),rows:Row[]=messages.data?.items||[],message=detail.data?.id===current?detail.data:null;
 useEffect(()=>{setPage(1);},[q]);
 useEffect(()=>{const timer=setInterval(()=>{if(document.visibilityState==='visible'){accounts.reload();messages.reload();}},10000);return()=>clearInterval(timer);},[accounts.reload,messages.reload]);
 useEffect(()=>{const media=window.matchMedia('(max-width: 900px)'),change=()=>setNarrow(media.matches);media.addEventListener('change',change);return()=>media.removeEventListener('change',change);},[]);
 useLayoutEffect(()=>{if(reader.current&&message)reader.current.scrollTop=positions.current.get(current)||0;},[current,message,narrow,readerOpen]);
 function select(id:string){
  if(reader.current&&current)positions.current.set(current,reader.current.scrollTop);
  setCurrent(id);setReaderOpen(true);
 }
 function closeReader(){if(reader.current&&current)positions.current.set(current,reader.current.scrollTop);setReaderOpen(false);}
 const content=<div className="mailbox-reader-scroll" ref={reader} role="region" aria-label="邮件正文" tabIndex={0}>
  {!current?<Empty>选择左侧来信，查看正文和附件</Empty>:<Resource loading={detail.loading&&!message} error={detail.error} retry={detail.reload}>{message&&<article className="mailbox-detail">
   <header><h2>{message.subject||'（无主题）'}</h2><p>{message.senderName} {message.senderEmail}</p><p>收件时间：{time(message.receivedAt)}</p><div className="mailbox-detail-actions"><a className="button" href={'/api/v4'+base+'/messages/'+message.id+'/file'}><DownloadSimple size={16}/>下载原邮件</a><button className="primary" onClick={()=>setReply({message})}>回复</button></div></header>
   {message.attachments.some((a:Row)=>!a.inline)&&<section className="mailbox-attachments" aria-label="邮件附件"><h3>附件</h3>{message.attachments.filter((a:Row)=>!a.inline).map((a:Row)=><button className="mailbox-attachment" aria-label={'查看附件 '+a.name} key={a.id} onClick={()=>setAttachment({messageId:message.id,attachment:a})}><Paperclip size={19}/><span><strong>{a.name}</strong><span>{size(a.size)} · 点击查看</span></span></button>)}</section>}
   <h3>应聘者原始描述</h3>{message.bodyWarning&&<p className="notice warning">{message.bodyWarning}</p>}<pre className="mailbox-body">{message.body||'（邮件无可提取的正文）'}</pre>
  </article>}</Resource>}
 </div>;
 return <div className="mailbox-page">
  <PageHeader title="简历邮件" description="查看简历邮件，回复候选人"><MailboxUpdateButton/></PageHeader>
  <Resource loading={accounts.loading&&!accounts.data} error={accounts.error} retry={accounts.reload}>
   <div className="mailbox-account"><EnvelopeSimple size={24}/><div><strong>{account?.account||'招聘邮箱'}</strong><span>{account?.state==='error'?'同步待检查':account?.state==='syncing'?'正在获取邮件':'原件已归档'}</span></div>{account&&<p>已保存 {account.messageCount} 封来信 · 最近同步 <RelativeTime value={account.lastSyncedAt} empty="尚未同步"/></p>}</div>
  </Resource>
  <div className="mailbox-workspace">
   <section className="mailbox-list-pane" aria-label="原始来信列表">
    <div className="mailbox-toolbar"><input type="search" aria-label="搜索招聘邮件" placeholder="搜索姓名、邮箱、岗位或附件名" value={search} onChange={e=>setSearch(e.target.value)}/></div>
    <div className="mailbox-list-scroll" role="region" aria-label="邮件列表" tabIndex={0}>
     <Resource loading={messages.loading&&!messages.data} error={messages.error} retry={messages.reload} preserve={!!messages.data}>
      {!rows.length?<Empty>暂无符合条件的来信</Empty>:rows.map(m=><button className={'mailbox-message'+(current===m.id?' mailbox-selected':'')} aria-pressed={current===m.id} key={m.id} onClick={()=>select(m.id)}><strong>{m.subject||'（无主题）'}</strong>{m.replyState&&<span className="mail-reply-state">{m.replyState==='sent'?'已回复':'发送待核对'}</span>}<span className="mailbox-sender">{m.senderName||m.senderEmail}{m.senderName&&m.senderEmail?' · '+m.senderEmail:''}</span><span className="mailbox-message-meta"><time dateTime={m.receivedAt}>{time(m.receivedAt)}</time><span><Paperclip size={13}/>{m.attachments.filter((a:Row)=>!a.inline).length}</span></span></button>)}
     </Resource>
    </div>
    <Pagination page={page} total={messages.data?.total||0} onChange={setPage}/>
   </section>
   {!narrow&&<section className="mailbox-reader-pane" aria-label="原始来信详情">{content}</section>}
  </div>
  {narrow&&current&&readerOpen&&<Dialog title="原始来信" onClose={closeReader} wide>{content}</Dialog>}
  {attachment&&<AttachmentPreview {...attachment} onClose={()=>setAttachment(null)}/>}
  {reply&&<MailReplyDialog message={reply.message} savedDraft={drafts.current.get(reply.message.id)} onDraft={draft=>drafts.current.set(reply.message.id,draft)} onSent={messages.reload} onClose={()=>setReply(null)}/>}
 </div>;
}
