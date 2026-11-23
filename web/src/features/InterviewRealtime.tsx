import {connectInterviewRelay} from '../lib/interview-relay';
import {useApp} from '../lib/state';
import {useEffect,useRef,useState} from 'react';
import {api} from '../lib/api';import type {Row} from '../lib/state';import {AudioQueue} from '../lib/interview-audio';
import {connectInterviewRealtime,type RealtimeMode} from '../lib/interview-realtime';
type Props={root:string;session:Row;disabled:boolean;update:(row:Row)=>void;active:(value:boolean)=>void;pending:(value:number)=>void;hint:(value:string)=>void};
export default function InterviewRealtime(props:Props){
 const {user}=useApp();
 const latest=useRef(props);latest.current=props;
 const [running,setRunning]=useState(false),[starting,setStarting]=useState(false),[mode,setMode]=useState<RealtimeMode>('hints'),[text,setText]=useState(''),[error,setError]=useState(''),[pending,setPending]=useState(0),[memoryState,setMemoryState]=useState('original');
 const audio=useRef<HTMLAudioElement|null>(null),abort=useRef<AbortController|null>(null),live=useRef<Awaited<ReturnType<typeof connectInterviewRealtime>>|null>(null),queue=useRef<AudioQueue<Row>|null>(null),heartbeat=useRef<ReturnType<typeof setInterval>|null>(null),mounted=useRef(true),refreshing=useRef(false),generation=useRef(0);
 const state=(value:boolean)=>{if(mounted.current){setRunning(value);latest.current.active(value);}};
 const hardStop=()=>{generation.current++;if(heartbeat.current)clearInterval(heartbeat.current);heartbeat.current=null;abort.current?.abort();live.current?.close();live.current=null;state(false);};
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;hardStop();};},[]);
 async function refreshContext(selected:RealtimeMode){if(refreshing.current||!live.current)return;refreshing.current=true;const token=generation.current,connection=live.current;try{const value=await api<Row>(latest.current.root+'/'+latest.current.session.id+'/realtime-context',{method:'POST',body:{mode:selected}});if(token===generation.current){setMemoryState(value.contextState);if(value.instructions)connection?.context(value.instructions);}}catch(e){if(token!==generation.current)return;hardStop();setError('历史上下文更新失败，已停止采集：'+(e as Error).message);}finally{refreshing.current=false;}}
 async function start(selected:RealtimeMode){
  setStarting(true);setError('');setText('');latest.current.hint('');setMode(selected);state(true);const controller=new AbortController();abort.current=controller;const token=++generation.current;const valid=()=>mounted.current&&token===generation.current;
  const row=latest.current.session,path=latest.current.root+'/'+row.id;let sequence=Math.max(0,...row.segments.map((s:Row)=>s.sequence));const offset=Math.max(0,...row.segments.map((s:Row)=>s.endMs));
  queue.current=new AudioQueue<Row>(async segment=>{try{latest.current.update(await api<Row>(path+'/segments',{method:'POST',body:segment}));}catch(e){hardStop();setError('原话保存失败，请重试待保存记录后再关闭：'+(e as Error).message);throw e;}},()=>{if(mounted.current){const n=queue.current?.pending||0;setPending(n);latest.current.pending(n);}},1);
  try{
   const connection=await (user.temporaryAccess?connectInterviewRelay:connectInterviewRealtime)({path,mode:selected,audio:audio.current!,signal:controller.signal,
    exchange:offer=>api(path+'/realtime',{method:'POST',body:{offer,mode:selected}}),
    transcript:value=>queue.current!.push({id:crypto.randomUUID(),sequence:++sequence,source:'mixed',speaker:'unknown',text:value.text,startMs:value.startMs+offset,endMs:value.endMs+offset}),
    text:value=>{if(valid()){setText(value);if(value)latest.current.hint(value);}},notice:message=>{if(valid())setError(message);},error:message=>{if(!valid())return;hardStop();if(mounted.current){setError(message);setStarting(false);}},ready:()=>{if(valid())setStarting(false);},
   });
   if(!valid()||controller.signal.aborted){connection.close();return;}live.current=connection;
   if(!user.temporaryAccess)heartbeat.current=setInterval(()=>void refreshContext(selected),15000);
  }catch(e){if(!valid())return;hardStop();setError((e as Error).message);setStarting(false);}
 }
 async function stop(){const token=generation.current,connection=live.current,saves=queue.current;setStarting(true);try{await connection?.stop();await saves?.drain();}catch(e){if(token===generation.current)setError((e as Error).message);}finally{if(token===generation.current){hardStop();setStarting(false);}}}
 return <section aria-label="实时语音面试辅助">
  <p className="muted">Qwen 实时辅助 · 文字提示为主 · 请佩戴耳机</p>
  <div className="toolbar"><button disabled={props.disabled||running||starting||pending>0} onClick={()=>void start('hints')}>持续听面试，给我提示</button><button disabled={props.disabled||running||starting||pending>0} onClick={()=>void start('voice')}>与 AI 语音交流</button><button disabled={!running||starting} onClick={()=>void stop()}>停止实时连接</button>{starting&&<button onClick={()=>{hardStop();setStarting(false);}}>取消连接</button>}
  {pending>0&&!running&&<button onClick={()=>void queue.current?.retry().catch(e=>setError(e.message))}>重试保存 {pending} 段原话</button>}</div>
  <p role="status">{starting?'正在连接或收尾…':running?(mode==='hints'?'持续听面试 · 文字提示':'HR 语音交流 · 面试采集暂停'):'未连接'}{pending>0?' · 待保存 '+pending+' 段':''}</p>
  {error&&<p role="alert" className="notice warning">{error}</p>}
  <audio ref={audio} controls hidden={mode!=='voice'} />
  {text&&mode==='voice'&&<div className="notice"><strong>AI 回复</strong><p style={{whiteSpace:'pre-wrap'}}>{text}</p></div>}
  <p className="muted">{memoryState==='compacted'?'历史已压缩用于连续理解；原话完整保留。 ':memoryState==='preparing'?'正在整理历史上下文，当前连接继续运行。 ':''}不区分说话人 · 原话持续保存</p>
 </section>;
}
