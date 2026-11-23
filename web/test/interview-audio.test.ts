import test from 'node:test';import assert from 'node:assert/strict';
import {AudioQueue,pcm16,SpeechChunks} from '../src/lib/interview-audio.ts';
test('PCM clamps and encodes signed mono samples',()=>{assert.deepEqual([...pcm16(new Float32Array([-2,0,2]),16000)], [0,128,0,0,255,127]);});
test('queue retains a failed chunk, retries in order, and drains the tail before finish',async()=>{let fail=true;const delivered:number[]=[];const q=new AudioQueue<number>(async n=>{if(n===1&&fail)throw Error('offline');delivered.push(n);},()=>{});q.push(1);q.push(2);await assert.rejects(q.drain(),/offline/);assert.equal(q.pending,2);fail=false;await q.retry();await q.drain();assert.deepEqual(delivered,[1,2]);assert.equal(q.pending,0);});
test('two sources can transcribe concurrently without dropping failed chunks',async()=>{let active=0,peak=0;const delivered:number[]=[];const q=new AudioQueue<number>(async n=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,5));delivered.push(n);active--;},()=>{},2);q.push(1);q.push(2);q.push(3);await q.drain();assert.equal(peak,2);assert.deepEqual(delivered.sort(),[1,2,3]);});

test('silence never produces an ASR request, and a sentence flushes on its trailing pause',()=>{const chunks:any[]=[];const c=new SpeechChunks(16000,(x,start)=>chunks.push({length:x.length,start}));c.add(new Float32Array(16000),0);c.flush();assert.equal(chunks.length,0);c.add(new Float32Array(16000).fill(0.1),1000);assert.equal(chunks.length,0);c.add(new Float32Array(8000),2000);assert.deepEqual(chunks,[{length:24000,start:1000}]);c.flush();assert.equal(chunks.length,1);});
test('unfinished speech is flushed when recording stops',()=>{const chunks:any[]=[];const c=new SpeechChunks(16000,x=>chunks.push(x.length));c.add(new Float32Array(4000).fill(0.1),0);c.flush();assert.deepEqual(chunks,[4000]);});

test('sharing stopped while microphone permission is pending cannot become a successful capture',async()=>{
 const {captureInterview}=await import('../src/lib/interview-audio.ts');
 const original=Object.getOwnPropertyDescriptor(globalThis,'navigator');
 const track=new EventTarget() as any;track.readyState='live';track.stop=()=>{track.readyState='ended';};
 const meeting={getTracks:()=>[track],getAudioTracks:()=>[track]};
 const micTrack=Object.assign(new EventTarget(),{readyState:'live',stop(){this.readyState='ended';}}),mic={getTracks:()=>[micTrack]};
 let lost=0;
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getDisplayMedia:async()=>meeting,getUserMedia:async()=>{track.readyState='ended';track.dispatchEvent(new Event('ended'));return mic;}}}});
 try{await assert.rejects(captureInterview(()=>{},()=>{},()=>lost++),/取消或设备已断开/);assert.equal(lost,1);assert.equal(micTrack.readyState,'ended');}
 finally{if(original)Object.defineProperty(globalThis,'navigator',original);else delete (globalThis as any).navigator;}
});
