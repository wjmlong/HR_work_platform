export type RealtimeMode='hints'|'voice';
export type LiveTranscript={id:string;text:string;startMs:number;endMs:number};
export type RealtimeOptions={mode:RealtimeMode;audio:HTMLAudioElement;signal:AbortSignal;exchange:(offer:string)=>Promise<{answer:string;config:Record<string,unknown>}>;transcript:(value:LiveTranscript)=>void;text:(value:string)=>void;error:(message:string)=>void;ready:()=>void;notice?:(message:string)=>void};
export class TurnLedger {
 private turns=new Map<string,{start:number;end:number}>();private done=new Set<string>();
 get pending(){return this.turns.size;}
 accept(event:any):LiveTranscript|null {
  const id=event.item_id;if(typeof id!=='string'||this.done.has(id))return null;
  if(event.type==='input_audio_buffer.speech_started')this.turns.set(id,{start:Math.max(0,event.audio_start_ms||0),end:Math.max(0,event.audio_start_ms||0)});
  if(event.type==='input_audio_buffer.speech_stopped'){const turn=this.turns.get(id);if(turn)turn.end=Math.max(turn.start,event.audio_end_ms||turn.start);}
  if(event.type!=='conversation.item.input_audio_transcription.completed')return null;
  const turn=this.turns.get(id)||{start:0,end:0};this.turns.delete(id);this.done.add(id);
  if(typeof event.transcript!=='string'||!event.transcript.trim())return null;
  return {id,text:event.transcript,startMs:turn.start,endMs:turn.end};
 }
}
export async function connectInterviewRealtime(options:RealtimeOptions){
 const pc=new RTCPeerConnection({iceServers:[]}),sender=pc.addTransceiver('audio',{direction:'sendrecv'}).sender;
 const streams:MediaStream[]=[],channels=new Set<RTCDataChannel>(),nodes:AudioNode[]=[],ledger=new TurnLedger();
 let context:AudioContext|undefined,channel:RTCDataChannel|undefined,closed=false,created=false,configured=false,ready=false,stopping=false,reply='',timer:ReturnType<typeof setTimeout>|undefined;
 const close=()=>{if(closed)return;closed=true;clearTimeout(timer);for(const s of streams)for(const t of s.getTracks())t.stop();for(const n of nodes)n.disconnect();for(const c of channels)c.close();pc.close();options.audio.pause();options.audio.srcObject=null;void context?.close();options.signal.removeEventListener('abort',close);};
 const fail=(message:string)=>{if(closed)return;close();options.error(message);};
 const check=()=>{if(closed||options.signal.aborted)throw Error('实时连接已取消');};
 const send=(event:Record<string,unknown>)=>{check();if(channel?.readyState!=='open')throw Error('实时事件通道未就绪');channel.send(JSON.stringify({event_id:crypto.randomUUID(),...event}));};
 let settings:Record<string,unknown>|undefined,track:MediaStreamTrack|undefined;
 const initialize=()=>{if(!closed&&created&&!configured&&settings&&channel?.readyState==='open'&&pc.connectionState==='connected'){configured=true;send({type:'session.update',session:settings});}};
 const bind=(c:RTCDataChannel)=>{channels.add(c);c.onopen=initialize;c.onclose=()=>{if(!closed&&!stopping)fail('实时事件通道已断开，请检查记录后重新连接');};c.onmessage=event=>{if(closed)return;try{
  const e=JSON.parse(event.data);
  if(e.type==='session.created'){created=true;channel=c;initialize();}
  else if(e.type==='session.updated'&&!ready&&configured){ready=true;clearTimeout(timer);void sender.replaceTrack(track!).then(()=>{check();options.ready();}).catch(()=>fail('实时音频发送失败'));}
  else if(e.type==='error'||e.type==='conversation.item.input_audio_transcription.failed')fail('实时模型返回错误，已停止采集。请核对最后一段原话后重连。');
  else {
   const transcript=ledger.accept(e);if(transcript&&options.mode==='hints')options.transcript(transcript);
   if(e.type==='response.created'){reply='';options.text('');}
   if(e.type==='response.text.delta'||e.type==='response.audio_transcript.delta'){reply+=typeof e.delta==='string'?e.delta:'';options.text(reply);}
   if(e.type==='input_audio_buffer.speech_started'&&options.mode==='voice')options.audio.muted=true;
   if(e.type==='response.created'&&options.mode==='voice'){options.audio.muted=false;void options.audio.play().catch(()=>options.notice?.('浏览器阻止播放，请点击音频播放器开始播放'));}
  }
 }catch{fail('实时事件格式无效，已停止采集');}};};
 const watch=(stream:MediaStream)=>{streams.push(stream);if(closed||options.signal.aborted){stream.getTracks().forEach(t=>t.stop());check();}for(const t of stream.getTracks())t.addEventListener('ended',()=>{if(!stopping)fail('共享或麦克风已停止；请核对最后一段原话后重连');});return stream;};
 options.signal.addEventListener('abort',close,{once:true});
 pc.ondatachannel=e=>bind(e.channel);bind(pc.createDataChannel('oai-events'));
 pc.onconnectionstatechange=()=>{initialize();if(['failed','disconnected'].includes(pc.connectionState))fail('实时连接中断；请核对最后一段原话后重连');};
 pc.ontrack=e=>{if(closed)return;options.audio.srcObject=e.streams[0]||new MediaStream([e.track]);options.audio.muted=options.mode!=='voice';if(options.mode==='voice')void options.audio.play().catch(()=>options.notice?.('请点击音频播放器以允许播放'));};
 try{
  check();
  if(options.mode==='hints'){
   const display=watch(await navigator.mediaDevices.getDisplayMedia({video:true,audio:true,systemAudio:'include',selfBrowserSurface:'exclude'} as DisplayMediaStreamOptions));
   if(!display.getAudioTracks().length)throw Error('未获取会议音频，请选择带系统音频的共享来源');
  }
  watch(await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false}));check();
  context=new AudioContext();await context.resume();check();const dest=context.createMediaStreamDestination();
  for(const stream of streams){const source=context.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));source.connect(dest);nodes.push(source);}track=dest.stream.getAudioTracks()[0];streams.push(dest.stream);
  await pc.setLocalDescription(await pc.createOffer());check();
  await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>finish(Error('ICE 协商超时')),15000);const finish=(error?:Error)=>{clearTimeout(timeout);pc.removeEventListener('icegatheringstatechange',changed);options.signal.removeEventListener('abort',abort);error?reject(error):resolve();};const changed=()=>{if(pc.iceGatheringState==='complete')finish();};const abort=()=>finish(Error('实时连接已取消'));pc.addEventListener('icegatheringstatechange',changed);options.signal.addEventListener('abort',abort,{once:true});if(options.signal.aborted)abort();else changed();});
  check();const answer=await options.exchange(pc.localDescription!.sdp);check();settings=answer.config;
  timer=setTimeout(()=>fail('实时模型初始化超时，请重连'),20000);await pc.setRemoteDescription({type:'answer',sdp:answer.answer});check();
  return {close,context:(instructions:string)=>send({type:'session.update',session:{instructions}}),stop:async()=>{
   if(closed)return;stopping=true;await sender.replaceTrack(null);for(const s of streams)for(const t of s.getTracks())t.stop();options.audio.pause();
   // Allow server VAD to close the last turn and deliver its final transcription.
   const deadline=Date.now()+8000;await new Promise(r=>setTimeout(r,1200));while(ledger.pending&&Date.now()<deadline&&!closed)await new Promise(r=>setTimeout(r,100));
   const incomplete=ledger.pending>0;close();if(incomplete)throw Error('最后一段语音未确认转写完成，请手动补充原话后结束面试');
  }};
 }catch(e){close();throw e;}
}
