import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {testDatabase,httpSession} from './helpers.js';
import {Identity} from '../src/identity/service.js';
import {BusinessConfigService} from '../src/business-config/service.js';
import {publishDefinition} from './business-config-fixture.js';

test('preview endpoints enforce authorization, integrity and allowed types while preserving original downloads and audit',async t=>{
 const {db,config,cleanup}=await testDatabase();t.after(cleanup);
 const temp=await mkdtemp(path.join(os.tmpdir(),'mailbox-preview-'));t.after(()=>rm(temp,{recursive:true,force:true}));config.storageRoot=path.join(temp,'files');
 const key='b'.repeat(64),dir=path.join(temp,'mailboxes','recruitment','messages',key);await mkdir(dir,{recursive:true});
 const raw=Buffer.from('Subject: synthetic attachment preview\r\n\r\nSynthetic body'),hash=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
 const contents=[Buffer.from('%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n'),Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000049454e44ae426082','hex'),Buffer.from('<svg onload="alert(1)"/>'),Buffer.from('<html><script>alert(1)</script></html>')];
 const attachments=contents.map((data,index)=>({id:String(index),name:['简历.pdf','作品.png','图形.svg','伪装.pdf'][index],file:'attachment-'+index,size:data.length,sha256:hash(data),contentType:['application/octet-stream','image/png','image/svg+xml','application/pdf'][index],inline:false,importable:index===0}));
 for(const a of attachments)await writeFile(path.join(dir,a.file),contents[Number(a.id)]);
 await writeFile(path.join(dir,'original.eml'),raw);await writeFile(path.join(dir,'message.json'),JSON.stringify({id:key,mailboxId:'recruitment',subject:'合成预览验证',senderName:'合成人员',senderEmail:'fixture@example.invalid',receivedAt:'2026-11-16T00:00:00Z',archivedAt:'2026-11-16T00:00:00Z',messageId:'<fixture@example.invalid>',rawSize:raw.length,rawSha256:hash(raw),body:'合成正文',attachments}));
 const {app,headers,actor,provider}=await httpSession(db,config);t.after(()=>app.close());
 const url=(id:string)=>'/api/v4/mailboxes/recruitment/messages/'+key+'/attachments/'+id+'/preview';
 for(const [id,type] of [['0','application/pdf'],['1','image/png']]){
  const response=await app.inject({url:url(id),headers});assert.equal(response.statusCode,200,response.body);assert.deepEqual(response.rawPayload,contents[Number(id)]);assert.equal(response.headers['content-type'],type);assert.match(String(response.headers['content-disposition']),/^inline; /);if(type==='application/pdf')assert.doesNotMatch(String(response.headers['content-security-policy']),/sandbox/);else assert.match(String(response.headers['content-security-policy']),/sandbox/);assert.match(String(response.headers['content-security-policy']),/script-src 'none'/);assert.match(String(response.headers['content-security-policy']),/frame-ancestors 'self'/);assert.equal(response.headers['x-content-type-options'],'nosniff');assert.equal(response.headers['cache-control'],'no-store');
 }
 const head=await app.inject({method:'HEAD',url:url('0'),headers});assert.equal(head.statusCode,200);assert.equal(head.body,'');assert.equal(head.headers['content-type'],'application/pdf');
 for(const id of ['2','3']){const rejected=await app.inject({url:url(id),headers});assert.equal(rejected.statusCode,415,rejected.body);const download=await app.inject({url:url(id).replace(/preview$/,'file'),headers});assert.equal(download.statusCode,200);assert.deepEqual(download.rawPayload,contents[Number(id)]);assert.match(String(download.headers['content-disposition']),/^attachment/);}
 const unauthorized={...headers};delete (unauthorized as Partial<typeof headers>).cookie;assert.equal((await app.inject({url:url('0'),headers:unauthorized})).statusCode,401);
 const {app:reader,headers:readerHeaders}=await httpSession(db,config,['interviewer']);t.after(()=>reader.close());assert.equal((await reader.inject({url:url('0'),headers:readerHeaders})).statusCode,403);
 assert.equal((await app.inject({url:url('999'),headers})).statusCode,404);
 assert.equal((await app.inject({url:url('0'),headers:{...headers,origin:'https://external.invalid'}})).statusCode,403);
 assert.equal(Number((await db.query("SELECT count(*) FROM audit_events WHERE actor_id=$1 AND kind='mailbox.preview'",[actor.id])).rows[0].count),3);
 await writeFile(path.join(dir,'attachment-0'),'tampered');assert.equal((await app.inject({url:url('0'),headers})).statusCode,503);
 const configs=new BusinessConfigService(new Identity(db,config,provider)),def=await configs.effective(actor,'resume'),doc:any=await configs.version(actor,def.ref),phone=doc.fields.find((f:any)=>f.coreKey==='phone');phone.access={...phone.access,read:['manager'],write:['manager'],export:['manager']};await publishDefinition({configs,admin:actor},doc);assert.equal((await app.inject({url:url('1'),headers})).statusCode,403);
 const html=await app.inject({url:'/',headers});assert.match(String(html.headers['content-security-policy']),/frame-src 'self'/);
});
