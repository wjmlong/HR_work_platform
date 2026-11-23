import {formatDateTime} from '../lib/date-time';
import {useEffect,useRef,useState} from 'react';
import {api,ApiError} from '../lib/api';
import {useResource,Resource,type Row} from '../lib/state';
import {Dialog,Field} from '../components/ui';

const errors:Record<string,string>={mail_reply_not_configured:'尚未配置发信通道。',mail_reply_config_invalid:'发信通道暂不可用，请稍后重试。',mail_reply_draft_invalid:'请检查主题和正文，内容不能为空。',mail_reply_preview_stale:'邮件或发信配置已变化，请核对后再次发送。',mail_reply_template_stale:'模板已更新，请关闭后重新打开。',mail_reply_placeholder:'仍有待补充内容，请在正文中补齐或删除不适用的部分。',mail_reply_recipient_unconfirmed:'请核对候选人邮箱，不能回复到招聘平台通知地址或招聘邮箱本身。',mail_reply_headers_invalid:'原邮件线程标识异常，暂不能回复。'};
const errorText=(error:unknown)=>error instanceof ApiError?errors[error.code]||error.message:(error as Error).message;
const states:Record<string,string>={sending:'正在发送',sent:'发信服务器已接受',failed:'发送失败',unknown:'发送结果待核对'};
export type MailDraft={templateId:string;recipient:string;subject:string;text:string;dirty:boolean;receipt?:Row};
type Props={message:Row;savedDraft?:MailDraft;onDraft?:(draft:MailDraft)=>void;onSent?:()=>void;onClose:()=>void};

function Composer({catalog,base,savedDraft,onDraft,onSent,onBusy}:{catalog:Row;base:string;savedDraft?:MailDraft;onDraft?:(draft:MailDraft)=>void;onSent:()=>void;onBusy:(busy:boolean)=>void}){
 const first=catalog.templates[0],initial:MailDraft=savedDraft||{templateId:first.id,recipient:catalog.recipient.address,subject:first.draft.subject,text:first.draft.text,dirty:false};
 const [draft,setDraft]=useState(initial),[undo,setUndo]=useState<MailDraft|null>(null),[switchTo,setSwitchTo]=useState<string|null>(null);
 const [sending,setSending]=useState(false),[reviewing,setReviewing]=useState(false),[receipt,setReceipt]=useState<Row|null>(savedDraft?.receipt||null),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const busy=useRef(false),sendKey=useRef(crypto.randomUUID()),textArea=useRef<HTMLTextAreaElement>(null);
 useEffect(()=>{onDraft?.({...draft,receipt:receipt||undefined});},[draft,receipt,onDraft]);
 const missing=[...new Set((draft.subject+'\n'+draft.text).match(/【待补充[^】]*】|\{[^{}\n]{1,100}\}/g)||[])];
 const change=(next:MailDraft)=>{setDraft({...next,receipt:undefined});setReviewing(false);setReceipt(null);setError('');setNotice('');sendKey.current=crypto.randomUUID();};
 function apply(id:string){const template=catalog.templates.find((t:Row)=>t.id===id);setUndo(draft);change({...draft,templateId:id,...template.draft,dirty:false});setSwitchTo(null);setNotice('已套用《'+template.name+'》');}
 function selectMissing(value:string){const n=draft.text.indexOf(value);if(n>=0){textArea.current?.focus();textArea.current?.setSelectionRange(n,n+value.length);}}
 async function checkReceipt(){try{const current=await api(base+'/replies'),found=current.items.find((r:Row)=>r.requestKey===(receipt?.requestKey||sendKey.current));if(found){setReceipt(found);if(found.state==='failed')sendKey.current=crypto.randomUUID();}else setNotice('暂未查到发送回执，请稍后再次核对。');onSent();}catch(error){setError(errorText(error));}}
 async function send(){
  if(busy.current||!catalog.configured||missing.length)return;
  busy.current=true;setSending(true);onBusy(true);setError('');
  const template=catalog.templates.find((t:Row)=>t.id===draft.templateId),body={templateId:template.id,templateVersion:template.version,draft:{subject:draft.subject,text:draft.text},recipient:draft.recipient.trim(),recipientConfirmed:true,testMode:false,...(receipt?.state==='failed'?{retryReceiptId:receipt.id}:{})};
  let dispatchStarted=false;
  try{
   const preview=await api(base+'/reply-preview',{method:'POST',body,key:crypto.randomUUID()});
   if(preview.to.toLowerCase()!==body.recipient.toLowerCase())throw Error('收件人发生变化，请重新核对。');
   if(preview.subject!==draft.subject||preview.text!==draft.text){change({...draft,subject:preview.subject,text:preview.text});setNotice('邮件格式已整理，请核对后再次发送。');return;}
   dispatchStarted=true;
   const result=await api(base+'/replies',{method:'POST',key:sendKey.current,body:{...body,previewToken:preview.previewToken,confirmed:true}});
   setReceipt(result);setReviewing(false);if(result.state==='failed')sendKey.current=crypto.randomUUID();onSent();
  }catch(error){
   setError(errorText(error));
   if(dispatchStarted&&(!(error instanceof ApiError)||error.status>=500)){
    setReceipt({state:'unknown',requestKey:sendKey.current,recipient:body.recipient,subject:body.draft.subject});setReviewing(false);
    try{const current=await api(base+'/replies'),found=current.items.find((r:Row)=>r.requestKey===sendKey.current);if(found){setReceipt(found);if(found.state==='failed')sendKey.current=crypto.randomUUID();}}catch{/* The uncertain receipt remains locked until checked. */}
   }
   onSent();
  }finally{busy.current=false;setSending(false);onBusy(false);}
 }
 const locked=sending||!!receipt&&['sent','sending','unknown'].includes(receipt.state);
 return <div className="mail-composer">
  {!catalog.configured&&<p className="notice warning">发信通道暂不可用，草稿仍可编辑。</p>}
  <Field label="收件人"><input type="email" aria-label="收件人邮箱" value={draft.recipient} placeholder="填写并核对候选人邮箱" disabled={locked} onInput={e=>change({...draft,recipient:e.currentTarget.value,dirty:true})}/></Field>
  <p className="muted">{catalog.recipient.source==='reply-to'?'已带入原邮件的回复地址，请核对。':catalog.recipient.source==='candidate'?'已带入关联候选人档案邮箱，请核对。':catalog.recipient.source==='sender'?'已带入发件人邮箱，请核对。':'未找到唯一可确认的回复地址，请填写候选人邮箱。'}</p>
  <Field label="套用模板"><select aria-label="套用模板" value={draft.templateId} disabled={locked} onChange={e=>draft.dirty?setSwitchTo(e.target.value):apply(e.target.value)}>{catalog.templates.map((t:Row)=><option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
  {switchTo&&<div className="notice" role="alert"><p>套用模板将替换当前主题和正文，收件人保持不变。</p><button onClick={()=>apply(switchTo)}>替换内容</button><button onClick={()=>setSwitchTo(null)}>保留当前内容</button></div>}
  {notice&&<p role="status" className="notice">{notice} {undo&&!locked&&<button onClick={()=>{change(undo);setUndo(null);}}>撤销</button>}</p>}
  <Field label="主题"><input aria-label="邮件主题" value={draft.subject} maxLength={2000} disabled={locked} onInput={e=>change({...draft,subject:e.currentTarget.value,dirty:true})}/></Field>
  <Field label="正文"><textarea ref={textArea} aria-label="邮件正文" value={draft.text} rows={15} maxLength={16000} disabled={locked} onInput={e=>change({...draft,text:e.currentTarget.value,dirty:true})}/></Field>
  {!!missing.length&&<div className="notice warning" role="status">还有 {missing.length} 处待补充，可直接修改正文或删除不适用的段落。<div className="mail-missing">{missing.map(v=><button key={v} onClick={()=>selectMissing(v)}><mark>{v}</mark></button>)}</div></div>}
  {error&&<p role="alert" className="notice error">{error}</p>}
  {receipt&&<p role="status" className={'notice '+(receipt.state==='sent'?'':'warning')}>{states[receipt.state]}。{receipt.testMode?'本次发往验证邮箱，不计入候选人已回复。':''}{receipt.state==='sent'?'不代表对方已收取或已读。':receipt.state==='failed'?'草稿已保留，可重试。':'请先核对发送记录，避免重复发信。'}</p>}
  {receipt&&['sending','unknown'].includes(receipt.state)&&<button disabled={sending} onClick={()=>void checkReceipt()}>核对发送结果</button>}
  {reviewing&&<div className="notice" role="alert"><p>将发送给 <strong>{draft.recipient}</strong>，主题为「{draft.subject}」。</p><button className="primary" disabled={sending} onClick={()=>void send()}>{sending?'发送中…':'确认发送'}</button><button disabled={sending} onClick={()=>setReviewing(false)}>继续编辑</button></div>}
  {!reviewing&&<div className="form-actions"><span className="muted">关闭后，草稿在当前页面保留。</span><button className="primary" disabled={!catalog.configured||locked||!!missing.length||!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(draft.recipient)||!draft.subject.trim()||!draft.text.trim()} onClick={()=>setReviewing(true)}>{receipt?.state==='failed'?'重试发送':'发送'}</button></div>}
 </div>;
}

export default function MailReplyDialog({message,savedDraft,onDraft,onSent,onClose}:Props){
 const base='/mailboxes/recruitment/messages/'+message.id,catalog=useResource<Row>(()=>api(base+'/reply-context'),[base]),history=useResource<Row>(()=>api(base+'/replies'),[base]);
 const [busy,setBusy]=useState(false);
 return <Dialog title="回复邮件" onClose={()=>{if(!busy)onClose();}} wide>
  <p className="muted">回复：{message.subject||'（无主题）'}</p>
  <Resource loading={catalog.loading} error={catalog.error} retry={catalog.reload}>{catalog.data&&<Composer catalog={catalog.data} base={base} savedDraft={savedDraft} onDraft={onDraft} onBusy={setBusy} onSent={()=>{history.reload();onSent?.();}}/>}</Resource>
  <details className="mail-history"><summary>发送记录{history.data?.items?.length?'（'+history.data.items.length+'）':''}</summary><Resource loading={history.loading} error={history.error} retry={history.reload}>{history.data?.items.length?<ul>{history.data.items.map((row:Row)=><li key={row.id}><strong>{states[row.state]}</strong>{row.testMode?' · 验证邮件':''} · {row.recipient} · {formatDateTime(row.createdAt)} · {row.subject}</li>)}</ul>:<p className="muted">尚无发送记录</p>}</Resource></details>
 </Dialog>;
}
