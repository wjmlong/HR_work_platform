import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,writeFile,rm,chmod} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {readReplyConfiguration,sendConfiguredReply} from '../src/mailbox/reply-smtp.js';
import {TEST_RECIPIENT} from '../src/mailbox/reply-templates.js';

test('EWS bridge configuration and delivery bind the live private revision, single recipient and authenticated socket',async t=>{
 const temp=await mkdtemp(path.join(os.tmpdir(),'reply-bridge-'));t.after(()=>rm(temp,{recursive:true,force:true}));
 const socketPath=process.platform==='win32'?'\\\\.\\pipe\\mail-reply-'+randomUUID():path.join(temp,'ews.sock'),token='a'.repeat(64),tokenFile=path.join(temp,'token'),configFile=path.join(temp,'config.json');
 await writeFile(tokenFile,token,{mode:0o600});await writeFile(configFile,JSON.stringify({transport:'ews-bridge',socketPath,tokenFile,from:{name:'合成HR',address:'hr@sensteed.com'}}),{mode:0o600});
 let revision='b'.repeat(64),sends=0;
 const server=http.createServer((req,res)=>{assert.equal(req.headers.authorization,'Bearer '+token);res.setHeader('content-type','application/json');if(req.url==='/status'){res.end(JSON.stringify({ready:true,account:'hr@sensteed.com',recipient:TEST_RECIPIENT,singleRecipientReplies:true,configurationRevision:revision}));return;}let body='';req.on('data',v=>body+=v);req.on('end',()=>{const input=JSON.parse(body);assert.equal(input.configurationRevision,revision);assert.equal(input.message.to,TEST_RECIPIENT);assert.deepEqual(input.message.references,['<original@source.invalid>']);sends++;res.end(JSON.stringify({accepted:true,state:'sent',messageId:input.message.messageId}));});});
 await new Promise<void>(resolve=>server.listen(socketPath,resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));if(process.platform!=='win32')await chmod(socketPath,0o600);
 const config=(await readReplyConfiguration(configFile))!;assert.equal(config.transport,'ews-bridge');
 const message={from:config.from,to:TEST_RECIPIENT,subject:'合成测试',text:'合成正文',messageId:'<fixed@sensteed.com>',inReplyTo:'<original@source.invalid>',references:['<original@source.invalid>']};
 assert.deepEqual(await sendConfiguredReply(config,message),{accepted:true});assert.equal(sends,1);
 await assert.rejects(sendConfiguredReply(config,{...message,to:'one@sensteed.com,two@sensteed.com'}),/mail_reply_recipient_forbidden/);assert.equal(sends,1);
 revision='c'.repeat(64);const changed=await readReplyConfiguration(configFile);assert.notDeepEqual(changed,config,'private authentication changes invalidate the preview binding');
});
