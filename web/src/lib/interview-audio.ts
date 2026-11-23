export function pcm16(input:Float32Array,rate:number):Uint8Array{
 const count=Math.floor(input.length*16000/rate),bytes=new Uint8Array(count*2),view=new DataView(bytes.buffer);
 for(let n=0;n<count;n++){const start=Math.floor(n*rate/16000),end=Math.min(input.length,Math.max(start+1,Math.floor((n+1)*rate/16000)));let sum=0;for(let i=start;i<end;i++)sum+=input[i];const sample=Math.max(-1,Math.min(1,sum/(end-start)));view.setInt16(n*2,Math.round(sample*(sample<0?32768:32767)),true);}return bytes;
}
export class AudioQueue<T>{
 private items:{value:T;active:boolean}[]=[];private tasks=new Set<Promise<void>>();private error:Error|null=null;
 private send:(item:T)=>Promise<void>;private changed:()=>void;private concurrency:number;
 constructor(send:(item:T)=>Promise<void>,changed:()=>void,concurrency=1){this.send=send;this.changed=changed;this.concurrency=concurrency;}
 get pending(){return this.items.length;}
 push(value:T){if(this.items.length>=60)throw Error('转写积压过多，请暂停并重试');this.items.push({value,active:false});this.changed();this.pump();}
 private pump(){
  while(!this.error&&this.tasks.size<this.concurrency){const item=this.items.find(i=>!i.active);if(!item)break;item.active=true;
   const task=Promise.resolve().then(()=>this.send(item.value)).then(()=>{this.items.splice(this.items.indexOf(item),1);}).catch(e=>{this.error=e instanceof Error?e:Error('转写失败');}).finally(()=>{item.active=false;this.tasks.delete(task);this.changed();this.pump();});this.tasks.add(task);
  }
 }
 async drain():Promise<void>{while(this.tasks.size)await Promise.all([...this.tasks]);if(this.error)throw this.error;if(this.items.length){this.pump();return this.drain();}}
 async retry(){await Promise.all([...this.tasks]);this.error=null;this.pump();await this.drain();}
}
export class SpeechChunks {
 private chunks:Float32Array[]=[];private length=0;private silence=0;private start=0;private voice=0;
 private rate:number;private emit:(samples:Float32Array,startMs:number)=>void;
 constructor(rate:number,emit:(samples:Float32Array,startMs:number)=>void){this.rate=rate;this.emit=emit;}
 add(data:Float32Array,startMs:number){const rms=Math.sqrt(data.reduce((n,x)=>n+x*x,0)/data.length),speaking=rms>=0.001;
  if(!this.length&&!speaking)return;if(!this.length)this.start=startMs;
  this.chunks.push(data.slice());this.length+=data.length;if(speaking){this.voice+=data.length;this.silence=0;}else this.silence+=data.length;
  if(this.silence>=this.rate*0.45||this.length>=this.rate*15)this.flush();
 }
 flush(){if(!this.length)return;const length=this.length,start=this.start,voice=this.voice,parts=this.chunks;this.chunks=[];this.length=0;this.silence=0;this.voice=0;if(voice<this.rate*0.12)return;const joined=new Float32Array(length);let offset=0;for(const part of parts){joined.set(part,offset);offset+=part.length;}this.emit(joined,start);}
}
export type AudioChunk={source:'meeting'|'microphone';pcm:string;startMs:number;endMs:number};
export async function captureInterview(onChunk:(c:AudioChunk)=>void,onLevel:(source:string,level:number)=>void,onLost:(message:string)=>void,signal?:AbortSignal){
 const streams:MediaStream[]=[],nodes:AudioNode[]=[];let context:AudioContext|undefined,stopped=false;const flushers:(()=>void)[]=[];
 const stop=()=>{if(stopped)return;stopped=true;for(const node of nodes)node.disconnect();for(const flush of flushers)flush();for(const stream of streams)for(const track of stream.getTracks())track.stop();void context?.close();};
 const ensureLive=()=>{if(stopped||signal?.aborted||streams.some(s=>s.getTracks().some(t=>t.readyState!=='live')))throw Error('音频采集已取消或设备已断开，请重新开始');};
 const watch=(stream:MediaStream)=>{streams.push(stream);if(stopped||signal?.aborted){for(const track of stream.getTracks())track.stop();ensureLive();}for(const track of stream.getTracks())track.addEventListener('ended',()=>{if(!stopped){stop();onLost('音频共享或麦克风已停止，采集已暂停');}});ensureLive();};
 signal?.addEventListener('abort',stop,{once:true});
 try{
  ensureLive();const meeting=await navigator.mediaDevices.getDisplayMedia({video:true,audio:true,systemAudio:'include',selfBrowserSurface:'exclude'} as DisplayMediaStreamOptions);watch(meeting);
  if(!meeting.getAudioTracks().length)throw Error('没有获取到会议声音。请重新选择飞书窗口或屏幕，并勾选共享音频；当前浏览器不支持时请使用支持系统音频采集的 Chrome/Edge。');
  const mic=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false});watch(mic);
  context=new AudioContext({sampleRate:16000});await context.resume();ensureLive();const origin=performance.now();
  for(const [source,stream] of [['meeting',meeting],['microphone',mic]] as const){
   const chunker=new SpeechChunks(context.sampleRate,(input,startMs)=>{const bytes=pcm16(input,context!.sampleRate),endMs=startMs+Math.round(input.length/context!.sampleRate*1000);let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));try{onChunk({source,pcm:btoa(text),startMs,endMs});}catch(e){onLost((e as Error).message);}});
   flushers.push(()=>chunker.flush());const input=context.createMediaStreamSource(new MediaStream(stream.getAudioTracks())),processor=context.createScriptProcessor(4096,1,1),mute=context.createGain();mute.gain.value=0;
   processor.onaudioprocess=e=>{if(stopped)return;const data=e.inputBuffer.getChannelData(0);onLevel(source,Math.sqrt(data.reduce((n,x)=>n+x*x,0)/data.length));chunker.add(data,Math.max(0,Math.round(performance.now()-origin-data.length/context!.sampleRate*1000)));};
   input.connect(processor);processor.connect(mute);mute.connect(context.destination);nodes.push(input,processor,mute);
   for(const track of stream.getTracks())track.addEventListener('ended',()=>{if(!stopped){stop();onLost(source==='meeting'?'会议音频共享已停止，采集已暂停':'麦克风已断开，采集已暂停');}});
  }
  return {stop};
 }catch(e){stop();if(e instanceof DOMException){if(e.name==='NotAllowedError')throw Error('未获得采集权限或已取消共享。请允许浏览器录制屏幕与系统音频，并选择带音频的共享来源。');if(e.name==='InvalidStateError')throw Error('请将此面试页面切到前台，再点击采集。');}throw e;}
}
