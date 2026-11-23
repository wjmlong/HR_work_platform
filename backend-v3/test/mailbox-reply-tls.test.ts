import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import tls from 'node:tls';
import {readReplyConfiguration,replyTlsOptions,type ReplyConfiguration} from '../src/mailbox/reply-smtp.js';
import {serverKey,serverCertificate,untrustedCertificate} from './mailbox-reply-tls-fixtures.js';

test('private enterprise CA trusts only the configured certificate and still verifies the SMTP hostname',async t=>{
 const temp=await mkdtemp(path.join(os.tmpdir(),'mail-ca-'));t.after(()=>rm(temp,{recursive:true,force:true}));
 const file=path.join(temp,'smtp.json'),caFile=path.join(temp,'enterprise-ca.pem');
 const raw={host:'mail-reply.test',port:465,secure:true,auth:{user:'hr@sensteed.com',pass:'synthetic-only'},from:{name:'合成HR',address:'hr@sensteed.com'},tls:{caFile}};
 await writeFile(file,JSON.stringify(raw),{mode:0o600});await writeFile(caFile,serverCertificate);
 const trusted=(await readReplyConfiguration(file))!;assert.equal(trusted.tls?.ca,serverCertificate);assert.equal(replyTlsOptions(trusted).rejectUnauthorized,true);
 const server=tls.createServer({key:serverKey,cert:serverCertificate},socket=>socket.end());server.on('tlsClientError',()=>{});
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
 const port=(server.address() as {port:number}).port;
 const connect=(config:ReplyConfiguration)=>new Promise<boolean>((resolve,reject)=>{const socket=tls.connect({host:'127.0.0.1',port,...replyTlsOptions(config)},()=>{const authorized=socket.authorized;socket.destroy();resolve(authorized);});socket.once('error',error=>{socket.destroy();reject(error);});});
 assert.equal(await connect(trusted),true);
 await writeFile(caFile,untrustedCertificate);const wrong=(await readReplyConfiguration(file))!;await assert.rejects(connect(wrong),/certificate|self-signed/i);
 await assert.rejects(connect({...trusted,host:'another-host.test'}),/hostname|altnames/i);
 await writeFile(caFile,'-----BEGIN CERTIFICATE-----\nnot-a-certificate\n-----END CERTIFICATE-----');await assert.rejects(readReplyConfiguration(file),/mail_reply_config_invalid/);
 await writeFile(file,JSON.stringify({...raw,tls:{caFile,rejectUnauthorized:false}}),{mode:0o600});await assert.rejects(readReplyConfiguration(file),/mail_reply_config_invalid/);
});
