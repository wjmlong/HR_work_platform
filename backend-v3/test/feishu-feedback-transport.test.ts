import test from 'node:test';
import assert from 'node:assert/strict';
import {FeishuConfirmationSender} from '../src/feishu-feedback/transport.js';
import type {Config} from '../src/config.js';
const config={feishuFeedback:{enabled:true},feishu:{tenant:'company',appId:'app',appSecret:'synthetic-secret'}} as Config;
test('message transport uses selected open_id, interactive content and a stable deduplication UUID',async()=>{
 const requests:{url:string;request:RequestInit}[]=[];
 const transport:typeof fetch=async(url,request)=>{requests.push({url:String(url),request:request!});return new Response(JSON.stringify(requests.length===1?{code:0,tenant_access_token:'synthetic-token'}:{code:0,data:{message_id:'om_test'}}));};
 const sender=new FeishuConfirmationSender(config,transport),result=await sender.send('ou_selected','opaque-delivery-id',{schema:'2.0'});
 assert.deepEqual(result,{messageId:'om_test'});
 assert.equal(requests[1].url,'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id');
 assert.deepEqual(JSON.parse(String(requests[1].request.body)),{receive_id:'ou_selected',msg_type:'interactive',content:'{"schema":"2.0"}',uuid:'opaque-delivery-id'});
 assert.equal(requests[1].request.redirect,'error');
});
test('disabled transport makes no request and provider errors never become delivery receipts',async()=>{
 let calls=0;const transport:typeof fetch=async()=>{calls++;return new Response(JSON.stringify({code:999,msg:'sensitive provider details'}));};
 await assert.rejects(new FeishuConfirmationSender({...config,feishuFeedback:{enabled:false}},transport).send('ou','id',{}),/feedback_not_enabled/);assert.equal(calls,0);
 await assert.rejects(new FeishuConfirmationSender(config,transport).send('ou','id',{}),/feedback_send_failed/);
});
