import {useEffect,useRef,useState} from 'react';
import {ArrowsClockwise} from '@phosphor-icons/react';
import {api} from '../lib/api';
import {requestMailboxSync,requestMailboxCollection} from '../lib/mailbox-update';
import {useApp,type Row} from '../lib/state';

export default function MailboxUpdateButton(){
 const {notify,refresh}=useApp(),[busy,setBusy]=useState(false),[stage,setStage]=useState(''),[result,setResult]=useState<Row|null>(null),mounted=useRef(true);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const pause=()=>new Promise<void>(resolve=>setTimeout(resolve,2000));
 async function update(){
  setBusy(true);setResult(null);setStage('正在获取新来信…');
  const base='/mailboxes/recruitment';
  try{
   const sync=await requestMailboxSync(base);
   let completed=false;
   for(let i=0;i<90&&mounted.current;i++){
    const state=await api<Row>(base+'/sync/'+sync.requestId);
    if(state.completed){completed=true;break;}
    if(state.state==='error')throw Error('邮箱同步暂未完成，请稍后重试。');
    await pause();
   }
   if(!mounted.current)return;
   if(!completed)throw Error('邮件仍在同步，稍后可再次点击同步邮件。已有人员资料不会被覆盖。');
   setStage('正在检查尚未收集的应聘资料…');
   const batch=await requestMailboxCollection(base,sync.requestId);
   let summary:Row={total:batch.queued,active:batch.queued,added:0,skippedExisting:0,notResume:0,needsReview:0,failed:0,pendingJobs:0};
   for(let i=0;i<300&&mounted.current&&summary.active;i++){
    summary=await api<Row>(base+'/updates/'+batch.batchId);
    setStage('正在补入新人 · 已处理 '+(summary.total-summary.active)+' / '+summary.total+' 份资料');
    if(summary.active)await pause();
   }
   if(!mounted.current)return;
   setResult({...summary,processed:batch.processed,unrecognized:batch.unrecognized,invalid:batch.invalid||0});refresh();
   if(summary.active)notify('其余资料仍在后台处理，可稍后刷新简历收件箱');
  }catch(e){if(mounted.current)notify((e as Error).message,true);}
  finally{if(mounted.current){setBusy(false);setStage('');}}
 }
 return <div className="mailbox-update-action">
  <button className="primary" disabled={busy} title="只补入从未出现的新应聘者，已有资料保持原样" onClick={()=>void update()}><ArrowsClockwise size={17}/>{busy?'同步中…':'同步邮件'}</button>
  {stage&&<p role="status">{stage}</p>}
  {result&&<div className="notice" role="status">{result.active?'当前已新增':'本次新增'} <strong>{result.added}</strong> 人{result.pendingJobs?'，其中 '+result.pendingJobs+' 人岗位待确认':''}；已有人员的 {result.skippedExisting} 份资料已跳过，先前处理过的 {result.processed} 份资料不重复导入。{result.notResume?'另有 '+result.notResume+' 份非简历资料已跳过。':''}{result.needsReview||result.failed?'另有 '+(result.needsReview+result.failed)+' 份资料需核对。':''}{result.invalid?' '+result.invalid+' 个附件格式异常，原件已保留。':''} <a href="#inbox">查看新收录简历</a>{(result.needsReview||result.failed)>0&&<> · <a href="#upload">查看待确认资料</a></>}{(result.invalid||result.unrecognized)>0&&<> · <a href="#inbox/mailbox">查阅原始来信</a></>}</div>}
 </div>;
}
