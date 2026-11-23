import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {testDatabase,httpSession} from './helpers.js';
import {MailboxArchive} from '../src/mailbox/archive.js';
import {Identity} from '../src/identity/service.js';
import {BusinessConfigService} from '../src/business-config/service.js';
import {publishDefinition} from './business-config-fixture.js';

async function fixture(root:string){
 const key='a'.repeat(64),dir=path.join(root,'recruitment','messages',key),raw=Buffer.from('From: applicant@example.invalid\r\nSubject: Synthetic application\r\n\r\nSynthetic body');
 const resume=Buffer.from('姓名：合成测试人员\n邮箱：synthetic@example.invalid\nPython，5年工作经验');
 await mkdir(dir,{recursive:true});
 const hash=(v:Buffer)=>createHash('sha256').update(v).digest('hex');
 const attachment={id:'0',name:'synthetic-resume.txt',file:'attachment-0',size:resume.length,sha256:hash(resume),contentType:'text/plain',inline:false,importable:true};
 const message={id:key,mailboxId:'recruitment',subject:'Synthetic application',senderName:'Synthetic applicant',senderEmail:'applicant@example.invalid',receivedAt:'2026-11-05T00:00:00Z',archivedAt:'2026-11-05T01:00:00Z',messageId:'<synthetic@example.invalid>',rawSize:raw.length,rawSha256:hash(raw),body:'Synthetic body <script>never execute</script>',attachments:[attachment]};
 await writeFile(path.join(dir,'original.eml'),raw);await writeFile(path.join(dir,'attachment-0'),resume);await writeFile(path.join(dir,'message.json'),JSON.stringify(message));
 await writeFile(path.join(root,'recruitment','index.json'),JSON.stringify([message]));
 await writeFile(path.join(root,'recruitment','status.json'),JSON.stringify({id:'recruitment',account:'recruit@example.invalid',state:'ready',messageCount:1,lastSyncedAt:'2026-11-05T01:00:00Z'}));
 return {key,dir,raw,resume};
}

test('mailbox archive confines paths, rejects symlinks and detects modified attachments',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'mailbox-unit-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const {key,dir}=await fixture(root),archive=new MailboxArchive(root);
 assert.equal((await archive.message('recruitment',key)).subject,'Synthetic application');
 const requests=await Promise.all([archive.requestSync('recruitment'),archive.requestSync('recruitment')]);assert.equal(requests[0].requestId,requests[1].requestId);
 await assert.rejects(archive.message('..',key));await assert.rejects(archive.message('recruitment','../private'));
 await writeFile(path.join(root,'outside.txt'),'not a resume');await rm(path.join(dir,'attachment-0'));await symlink(path.join(root,'outside.txt'),path.join(dir,'attachment-0'));
 await assert.rejects(archive.file('recruitment',key,'0'));
 await rm(path.join(dir,'attachment-0'));await writeFile(path.join(dir,'attachment-0'),'tampered');
 await assert.rejects(archive.file('recruitment',key,'0'),/mailbox_integrity_error/);
});

test('HR mailbox endpoints protect real content, provide downloads and enqueue the same attachment once',async t=>{
 const {db,config,cleanup}=await testDatabase();t.after(cleanup);
 const temp=await mkdtemp(path.join(os.tmpdir(),'mailbox-http-'));t.after(()=>rm(temp,{recursive:true,force:true}));config.storageRoot=path.join(temp,'files');
 const {key,raw,dir}=await fixture(path.join(temp,'mailboxes'));
 const {app,headers,actor,provider}=await httpSession(db,config);t.after(()=>app.close());
 const list=await app.inject({url:'/api/v4/mailboxes',headers});assert.equal(list.statusCode,200,list.body);assert.equal(list.json().data.items[0].messageCount,1);
 const query=await app.inject({url:'/api/v4/mailboxes/recruitment/messages?q=Synthetic',headers});assert.equal(query.statusCode,200,query.body);assert.equal(query.json().data.total,1);assert.equal(query.json().data.items[0].body,undefined);
 const detail=await app.inject({url:'/api/v4/mailboxes/recruitment/messages/'+key,headers});assert.equal(detail.statusCode,200,detail.body);assert.match(detail.json().data.body,/Synthetic body/);
 const download=await app.inject({url:'/api/v4/mailboxes/recruitment/messages/'+key+'/file',headers});assert.equal(download.statusCode,200);assert.deepEqual(download.rawPayload,raw);assert.match(String(download.headers['content-disposition']),/^attachment/);
 const unauthorized={...headers};delete (unauthorized as Partial<typeof headers>).cookie;
 assert.equal((await app.inject({url:'/api/v4/mailboxes/recruitment/messages/'+key,headers:unauthorized})).statusCode,401);
 const {app:reader,headers:readerHeaders}=await httpSession(db,config,['interviewer']);t.after(()=>reader.close());
 assert.equal((await reader.inject({url:'/api/v4/mailboxes/recruitment/messages/'+key+'/file',headers:readerHeaders})).statusCode,403);
 const definition=(await app.inject({url:'/api/v4/business-config/effective/job',headers})).json().data;
 const job=await app.inject({method:'POST',url:'/api/v4/jobs',headers:{...headers,'idempotency-key':'mailbox-job'},payload:{definitionVersion:definition.ref.version,definitionRevision:definition.aclRevision,name:'合成邮箱测试岗位',level:'P5',requirements:{skills:['Python'],experienceYears:1,education:'bachelor'}}});assert.equal(job.statusCode,200,job.body);
 const url='/api/v4/mailboxes/recruitment/messages/'+key+'/attachments/0/import';
 const results=await Promise.all(['one','two'].map(k=>app.inject({method:'POST',url,headers:{...headers,'idempotency-key':'mailbox-import-'+k},payload:{jobId:job.json().data.id}})));
 for(const r of results)assert.equal(r.statusCode,200,r.body);
 assert.equal(results[0].json().data.id,results[1].json().data.id);assert.equal(Number((await db.query("SELECT count(*) FROM tasks WHERE payload->>'mailboxId'='recruitment'")).rows[0].count),1);
 await db.query("UPDATE tasks SET state='awaiting_duplicate_decision',result=$2 WHERE id=$1",[results[0].json().data.id,{duplicates:[{candidateId:actor.id,name:'SENSITIVE_EXISTING_CANDIDATE'}]}]);
 const linked=await app.inject({url:'/api/v4/mailboxes/recruitment/messages/'+key,headers});assert.equal(linked.statusCode,200,linked.body);assert.ok(!linked.body.includes('SENSITIVE_EXISTING_CANDIDATE'));assert.equal(linked.json().data.imports[0].result.duplicates,undefined);
 const sync=await app.inject({method:'POST',url:'/api/v4/mailboxes/recruitment/sync',headers:{...headers,'idempotency-key':'mailbox-sync'},payload:{}});assert.equal(sync.statusCode,200,sync.body);assert.equal(sync.json().data.accepted,true);
 const requestId=sync.json().data.requestId;await mkdir(path.join(temp,'mailboxes/recruitment/requests'),{recursive:true});await writeFile(path.join(temp,'mailboxes/recruitment/requests',requestId+'.json'),JSON.stringify({requestId}));
 const completion=await app.inject({url:'/api/v4/mailboxes/recruitment/sync/'+requestId,headers});assert.equal(completion.json().data.completed,true);
 const changed=JSON.parse(await readFile(path.join(dir,'message.json'),'utf8'));
 for(const [id,name,data] of [['1','bad.pdf',Buffer.from('not a PDF')],['2','second.txt',Buffer.from('姓名：另一合成人\n邮箱：second@example.invalid\n技能：Python')]] as const){await writeFile(path.join(dir,'attachment-'+id),data);changed.attachments.push({id,name,file:'attachment-'+id,size:data.length,sha256:createHash('sha256').update(data).digest('hex'),contentType:'application/octet-stream',inline:false,importable:true});}
 await writeFile(path.join(dir,'message.json'),JSON.stringify(changed));await writeFile(path.join(temp,'mailboxes/recruitment/index.json'),JSON.stringify([changed]));
 const update=await app.inject({method:'POST',url:'/api/v4/mailboxes/recruitment/update',headers:{...headers,'idempotency-key':'mailbox-update'},payload:{requestId}});assert.equal(update.statusCode,200,update.body);assert.equal(update.json().data.queued,1);assert.equal(update.json().data.processed,1);assert.equal(update.json().data.invalid,1);
 const configs=new BusinessConfigService(new Identity(db,config,provider)),def=await configs.effective(actor,'resume'),doc:any=await configs.version(actor,def.ref);
 const phone=doc.fields.find((f:any)=>f.coreKey==='phone');phone.access={...phone.access,read:['manager'],write:['manager'],export:['manager']};await publishDefinition({configs,admin:actor},doc);
 for(const url of ['/api/v4/mailboxes','/api/v4/mailboxes/recruitment/messages/'+key,'/api/v4/mailboxes/recruitment/messages/'+key+'/file'])assert.equal((await app.inject({url,headers})).statusCode,403,url);
});
