import {speakerBubbles} from '../lib/interview-speakers';
import {useEffect,useRef,useState,type ReactNode} from 'react';
import type {Row} from '../lib/state';
export default function InterviewConversation({segments,turns=[],tools}:{segments:Row[];turns?:any[];tools:(segment:Row)=>ReactNode}){
 const scroll=useRef<HTMLDivElement>(null),following=useRef(true),lastCount=useRef(segments.length);
 const [unread,setUnread]=useState(0),[annotate,setAnnotate]=useState(false);
 const bottom=()=>{const el=scroll.current;if(el){el.scrollTop=el.scrollHeight;following.current=true;setUnread(0);}};
 useEffect(()=>{const added=Math.max(0,segments.length-lastCount.current);lastCount.current=segments.length;if(following.current)bottom();else if(added)setUnread(n=>n+added);},[segments.length,turns]);
 return <section className="interview-conversation" aria-label="面试对话流">
  <header><div><h3>面试对话</h3><span className="muted">{segments.length} 段原话 · 左：候选人 · 右：面试官</span></div><button aria-pressed={annotate} onClick={()=>setAnnotate(v=>!v)}>{annotate?'收起校正':'校正发言方'}</button></header>
  <div className="interview-conversation-scroll" ref={scroll} role="log" aria-label="面试原话滚动窗口" aria-live="off" tabIndex={0} onScroll={()=>{const el=scroll.current!;following.current=el.scrollHeight-el.scrollTop-el.clientHeight<64;if(following.current)setUnread(0);}}>
   {!segments.length&&<p className="interview-empty">开始听面试后，对话会持续出现在这里。</p>}
   {segments.map(s=><div className="interview-segment-group" id={'assistant-segment-'+s.id} key={s.id}>
    {speakerBubbles(s as any,turns).map((part,n)=><article className={'interview-message side-'+part.side+(part.inferred?' is-inferred':'')} key={n}>
     <div className="interview-message-meta"><span>{part.label}{part.inferred?' · AI推测':part.side==='center'?'':' · 已确认'}</span><time>{Math.floor(s.startMs/60000)}:{String(Math.floor(s.startMs/1000)%60).padStart(2,'0')}</time></div>
     <p>{part.text}</p>{s.parentId&&<small>已确认的原话摘录</small>}
    </article>)}
    {annotate&&<div className="interview-message-tools"><small>校正原始片段；双方混合时请选择“多人混合”并摘录。</small>{tools(s)}</div>}
   </div>)}
  </div>
  <footer><span className="muted">AI推测可校正 · 未确定居中显示</span><button onClick={bottom}>{unread?unread+' 段新对话 · 回到最新':'回到最新'}</button></footer>
 </section>;
}
