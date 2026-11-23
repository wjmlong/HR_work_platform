import test from 'node:test';
import assert from 'node:assert/strict';
import {createCardActionRouter,startInterviewFeedbackListener} from '../src/feishu-feedback/listener.js';
test('shared bot routes card actions by exact business namespace and rejects unknown cards',async()=>{
 const seen:string[]=[],route=createCardActionRouter({interview_confirmation:async()=>{seen.push('interview');return {toast:{type:'success',content:'attendance'}};},screening:async()=>{seen.push('screening');return {toast:{type:'success',content:'screening'}};}});
 assert.equal((await route({action:{value:{kind:'screening'}}}) as any).toast.content,'screening');
 assert.equal((await route({action:{value:{kind:'interview_confirmation'}}}) as any).toast.content,'attendance');
 for(const kind of ['unknown','toString','__proto__',''])assert.equal((await route({action:{value:{kind}}}) as any).toast.type,'error');
 assert.deepEqual(seen,['screening','interview']);
});
test('disabled feedback listener does not initialize a connection and can close safely',()=>{
 const listener=startInterviewFeedbackListener({config:{feishuFeedback:{enabled:false},feishu:{}}} as any);listener.close();listener.close();
});
