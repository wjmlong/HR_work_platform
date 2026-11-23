import {realtimeProtocols} from './api';
import {pcm16} from './interview-audio';
import {TurnLedger,type RealtimeOptions} from './interview-realtime';
export async function connectInterviewRelay(options:RealtimeOptions&{path:string}){
 const url=new URL('/api/v4'+options.path+'/relay',location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';url.searchParams.set('mode',options.mode);
 const socket=new WebSocket(url,realtimeProtocols()),streams:MediaStream[]=[],nodes:AudioNode[]=[],playing=new Set<AudioBufferSourceNode>(),ledger=new TurnLedger();
 let context:AudioContext|undefined,closed=false,stopping=false,ready=false,reply='',playAt=0,pendingAudio=new Uint8Array(0);
 const silence=()=>{for(const source of playing){try{source.stop();}catch{}}playing.clear();playAt=0;};
 const close=()=>{if(closed)return;closed=true;pendingAudio=new Uint8Array(0);clearTimeout(timer);for(const stream of streams)stream.getTracks().forEach(t=>t.stop());for(const node of nodes)node.disconnect();silence();void context?.close();socket.close();options.signal.removeEventListener('abort',close);};
 const fail=(message:string)=>{if(closed)return;close();options.error(message);};
 const send=(event:unknown)=>{if(closed||socket.readyState!==WebSocket.OPEN)throw Error('实时连接已断开');if(socket.bufferedAmount>256*1024)throw Error('音频发送积压，已停止采集');socket.send(JSON.stringify(event));};
 const watch=(stream:MediaStream)=>{streams.push(stream);if(closed||options.signal.aborted){stream.getTracks().forEach(t=>t.stop());throw Error('实时连接已取消');}stream.getTracks().forEach(t=>t.addEventListener('ended',()=>{if(!stopping)fail('音频采集已停止');}));return stream;};
 const timer=setTimeout(()=>fail('实时服务连接超时'),20000);options.signal.addEventListener('abort',close,{once:true});
 socket.onerror=()=>fail('实时连接失败，请核对登录与服务配置');socket.onclose=e=>fail(e.code===1008?'本场权限或会话已失效，采集已停止':'实时连接中断，请核对最后一段原话');
 socket.onmessage=event=>{try{const e=JSON.parse(event.data);
  if(e.type==='relay.ready'){ready=true;clearTimeout(timer);options.ready();return;}
  const transcript=ledger.accept(e);if(transcript&&options.mode==='hints')options.transcript(transcript);
  if(e.type==='response.created'){reply='';options.text('');}
  if(e.type==='response.text.delta'||e.type==='response.audio_transcript.delta'){reply+=e.delta||'';options.text(reply);}
  if(e.type==='input_audio_buffer.speech_started')silence();
  if(e.type==='response.audio.delta'&&options.mode==='voice'&&context){const raw=atob(e.delta),view=new DataView(Uint8Array.from(raw,c=>c.charCodeAt(0)).buffer),buffer=context.createBuffer(1,raw.length/2,24000),output=buffer.getChannelData(0);for(let i=0;i<output.length;i++)output[i]=view.getInt16(i*2,true)/32768;const source=context.createBufferSource();source.buffer=buffer;source.connect(context.destination);playAt=Math.max(playAt,context.currentTime);if(playAt-context.currentTime>10)throw Error('播放积压');source.start(playAt);playAt+=buffer.duration;playing.add(source);source.onended=()=>playing.delete(source);}
 }catch{fail('实时响应无效，已停止采集');}};
 try{
  // Permissions may finish after a rejected upgrade; watch immediately stops late streams.
  if(options.signal.aborted)throw Error('实时连接已取消');
  if(options.mode==='hints'){const display=watch(await navigator.mediaDevices.getDisplayMedia({video:true,audio:true,systemAudio:'include',selfBrowserSurface:'exclude'} as DisplayMediaStreamOptions));if(!display.getAudioTracks().length)throw Error('请选择带系统音频的共享来源');}
  watch(await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false}));
  context=new AudioContext();await context.resume();if(closed)throw Error('实时连接已取消');
  const processor=context.createScriptProcessor(2048,1,1),mute=context.createGain();mute.gain.value=0;
  for(const stream of streams){const source=context.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));source.connect(processor);nodes.push(source);}
  processor.connect(mute);mute.connect(context.destination);nodes.push(processor,mute);
  processor.onaudioprocess=e=>{if(!ready||closed||stopping)return;try{const pcm=pcm16(e.inputBuffer.getChannelData(0),context!.sampleRate),combined=new Uint8Array(pendingAudio.length+pcm.length);combined.set(pendingAudio);combined.set(pcm,pendingAudio.length);
    // Fixed100ms PCM packets keep message cadence independent of hardware rate.
    let offset=0;while(offset+3200<=combined.length){send({type:'audio',audio:btoa(String.fromCharCode(...combined.subarray(offset,offset+3200)))});offset+=3200;}pendingAudio=combined.slice(offset);}catch(e){fail((e as Error).message);}};
  return {close,context:(_instructions:string)=>{},stop:async()=>{if(closed)return;stopping=true;for(const stream of streams)stream.getTracks().forEach(t=>t.stop());silence();if(pendingAudio.length){send({type:'audio',audio:btoa(String.fromCharCode(...pendingAudio))});pendingAudio=new Uint8Array(0);}send({type:'stop'});const deadline=Date.now()+8000;await new Promise(r=>setTimeout(r,1500));while(ledger.pending&&Date.now()<deadline&&!closed)await new Promise(r=>setTimeout(r,100));const incomplete=ledger.pending>0;close();if(incomplete)throw Error('最后一段语音尚未完成转写，请手动补充');}};
 }catch(e){close();throw e;}
}
