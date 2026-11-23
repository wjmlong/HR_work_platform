import {useState} from 'react';
import {api} from '../lib/api';
import {Dialog,CopyButton} from '../components/ui';
import {date,type Row} from '../lib/state';
export default function FeishuSchedulePrompt({interview,names,onDone}:{interview:Row;names:string[];onDone:()=>void}){
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState<Row|null>(null);
 async function create(){if(busy)return;setBusy(true);setError('');try{setResult(await api<Row>('/interviews/'+interview.id+'/feishu-calendar',{method:'POST',body:{confirmed:true}}));}catch(e){const message=(e as Error).message;setError(message.startsWith('feishu_calendar_error_')?'飞书暂未完成请求（错误码 '+message.slice('feishu_calendar_error_'.length)+'），请核对应用权限后重试。':message);}finally{setBusy(false);}}
 return <Dialog title={result?'飞书日程已创建':'是否创建飞书日程？'} onClose={()=>{if(!busy)onDone();}}>
 {result?<><p>已向 {result.participants.map((p:Row)=>p.name).join('、')} 发送日程邀请。</p><p><a href={result.meetingUrl} target="_blank" rel="noreferrer">进入飞书会议</a></p><div className="toolbar"><CopyButton text={result.meetingUrl} label="复制会议链接"/><button className="primary" onClick={onDone}>完成</button></div></>:<><p>面试安排已保存。创建后将向所选面试官发送飞书日程邀请，并保存会议链接。</p><p>{date(interview.starts_at)} · {interview.duration_minutes} 分钟</p><p>{names.join('、')}</p>{error&&<p className="notice error" role="alert">{error} 面试安排已保留，不用重新新建。</p>}<div className="toolbar"><button disabled={busy} onClick={onDone}>{error?'关闭':'暂不创建'}</button><button className="primary" disabled={busy} onClick={()=>void create()}>{busy?'正在创建…':error?'重试':'创建并邀请'}</button></div></>}
 </Dialog>;
}
