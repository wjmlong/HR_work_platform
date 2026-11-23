import test from 'node:test';import assert from 'node:assert/strict';
import {requestMailboxSync,requestMailboxCollection} from '../src/lib/mailbox-update.ts';
test('mailbox update sends JSON objects through the real API serializer',async()=>{
 const original=globalThis.fetch,requests:{url:string;body:unknown}[]=[];
 const requestId='89ff03b2-6212-46b4-958f-825105369b02';
 globalThis.fetch=async(url,options)=>{requests.push({url:String(url),body:JSON.parse(String(options?.body))});return new Response(JSON.stringify({data:{requestId}}),{status:200});};
 try{const sync=await requestMailboxSync('/mailboxes/recruitment');await requestMailboxCollection('/mailboxes/recruitment',sync.requestId);
 assert.deepEqual(requests,[{url:'/api/v4/mailboxes/recruitment/sync',body:{}},{url:'/api/v4/mailboxes/recruitment/update',body:{requestId}}]);
 }finally{globalThis.fetch=original;}
});
