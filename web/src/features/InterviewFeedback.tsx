import {useState} from 'react';
import {api,ApiError} from '../lib/api';
import {Resource,useApp,useResource,date,type Row} from '../lib/state';
import {Dialog} from '../components/ui';
type FeedbackStatus={version:number;enabled:boolean;canSend:boolean;needsCoordination:boolean;items:{userId:string;name:string;delivery:string;decision:string;reason:string;respondedAt?:string;stale:boolean}[]};
const deliveries:Record<string,string>={not_sent:'尚未发送',queued:'等待发送',sending:'发送中／结果待确认',sent:'已发送',failed:'发送失败，可重试'};
const errors:Record<string,string>={feedback_not_enabled:'飞书确认功能尚未开启，请联系管理员。',feedback_outer_transaction:'发送入口配置异常，未发送消息，请联系管理员。',feedback_busy:'本场确认正在发送，请稍后刷新。',feedback_interview_unavailable:'面试已开始或结束，请先核对安排。',feedback_interview_changed:'安排已更新，请刷新后重新核对。',feedback_participant_invalid:'所选面试官的账号或本场权限已失效，请核对后重试。'};
export default function InterviewFeedback({interview,onClose}:{interview:Row;onClose:()=>void}){
 const {notify}=useApp(),[busy,setBusy]=useState(false);
 const data=useResource<FeedbackStatus>(s=>api('/interviews/'+interview.id+'/feishu-feedback',{signal:s}),[interview.id]);
 const state=data.data,canSend=!!state?.canSend&&state.items.some(r=>r.stale||['not_sent','queued','sending','failed'].includes(r.delivery));
 const retry=state?.items.some(r=>!r.stale&&['failed','sending'].includes(r.delivery));
 async function send(){
  if(!state)return;setBusy(true);
  try{const result=await api<FeedbackStatus>('/interviews/'+interview.id+'/feishu-feedback',{method:'POST',body:{version:state.version,confirmed:true}});data.reload();notify(result.items.some(r=>r.delivery==='failed')?'部分确认发送失败，可在本页重试。':'确认卡片已发送，等待面试官回复。',result.items.some(r=>r.delivery==='failed'));}
  catch(e){notify(e instanceof ApiError?(errors[e.code]||e.message):(e as Error).message,true);}
  finally{setBusy(false);}
 }
 return <Dialog title="面试确认与反馈" onClose={onClose} wide>
  <p>{interview.candidate_name} · {interview.job_name} · 第 {interview.round} 轮</p>
  <p>向本场已选内部面试官发送飞书确认卡片。卡片仅含岗位、轮次和时间；面试官提交的拒绝原因会在此显示。</p>
  <Resource {...data} retry={data.reload}>
   {!state?.enabled&&<p className="notice">飞书确认功能尚未开启，请联系管理员完成配置。</p>}
   {state?.needsCoordination&&<p className="notice" role="status">有面试官拒绝，需协调。请联系相关面试官，再按实际结果修改安排。</p>}
   <div className="table-scroll"><table><thead><tr><th>面试官</th><th>发送状态</th><th>答复</th><th>拒绝原因</th></tr></thead><tbody>{state?.items.map(r=><tr key={r.userId}>
    <td>{r.name}</td><td>{deliveries[r.delivery]||r.delivery}</td><td>{r.stale?'旧安排已失效':r.decision==='accepted'?'已确认参加':r.decision==='declined'?'已拒绝 · 需协调':'待回复'}{r.respondedAt&&<small>{date(r.respondedAt)}</small>}</td><td>{r.reason||'—'}{r.stale&&r.reason&&<small>此原因属于旧安排</small>}</td>
   </tr>)}</tbody></table></div>
   {!state?.items.length&&<p>本场尚未选择面试官。</p>}
   <p className="muted">已发送表示飞书已接收消息；是否参加以面试官答复为准。修改安排后，旧卡片失效，需再次发送确认。</p>
   <div className="toolbar"><button disabled={busy} onClick={data.reload}>刷新反馈</button><button className="primary" disabled={busy||!canSend} onClick={()=>void send()}>{busy?'正在发送…':retry?'重试未成功发送的确认':'发送面试确认'}</button></div>
  </Resource>
 </Dialog>;
}
