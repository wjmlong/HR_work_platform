import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, writeFile, mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {actor, testDatabase, httpSession} from './helpers.js';
import {Database} from '../src/db.js';
import {Identity} from '../src/identity/service.js';
import {FeishuProvider} from '../src/identity/provider.js';
import {BackupCopies, copyInput} from '../src/operations/copies.js';
import {FileStore} from '../src/files/storage.js';
import {restore} from '../src/operations/backup.js';

async function fixture(t:any) {
  const f=await testDatabase(), directory=await mkdtemp(path.join(os.tmpdir(),'backup-roundtrip-'));
  f.config.storageRoot=path.join(directory,'files');
  f.config.campusKeyFile=path.join(directory,'keys.json');
  const a=await actor(f.db), service=new BackupCopies(new Identity(f.db,f.config,new FeishuProvider(f.config))), store=new FileStore(f.config.storageRoot);
  t.after(async()=>{
    for(const receipt of await service.list(a)) {
      const copy=new Database({...f.config,schema:receipt.schema});
      await copy.query('DROP SCHEMA "'+receipt.schema+'" CASCADE');
      await copy.close();
    }
    await f.cleanup(); await rm(directory,{recursive:true,force:true});
  });
  async function document(bytes:Buffer,name='synthetic.txt') {
    const file=await store.put(name,bytes);
    await f.db.query('INSERT INTO resume_documents(blob_key,sha256,file_name,file_size,kind,owner_id) VALUES($1,$1,$2,$3,$4,$5)',[file.sha256,file.name,file.size,file.kind,a.id]);
    return file;
  }
  return {...f,a,service,store,document};
}
const request=(archive:any)=>({kind:'recruit-v4-copy',text:JSON.stringify(archive),mapping:{}});

test('full and lite downloads restore synthetic rows with explicit attachment semantics',async t=>{
  const f=await fixture(t), bytes=Buffer.from('合成简历附件 roundtrip'),file=await f.document(bytes);
  await f.db.query("INSERT INTO candidates(profile) VALUES('{\"name\":\"Synthetic candidate\"}')");
  for(const includeFiles of [true,false]) {
    const archive=await f.service.export(f.a,undefined,includeFiles),input=request(archive);
    const preview=await f.service.preview(f.a,input);
    assert.equal(preview.ready,true,JSON.stringify(preview));
    assert.equal(archive.manifest.fileMode,includeFiles?'full':'omitted');
    assert.equal(preview.warnings.includes('resume_attachments_omitted'),!includeFiles);
    const receipt=await f.service.apply(f.a,{...input,token:preview.token,confirm:true});
    const db=new Database({...f.config,schema:receipt.schema});
    try {
      assert.equal((await db.query('SELECT count(*) FROM candidates')).rows[0].count,'1');
      assert.equal((await db.query('SELECT blob_key FROM resume_documents')).rows[0].blob_key,file.sha256);
      const location=path.join(f.config.storageRoot,'import-copies',receipt.schema,file.sha256);
      if(includeFiles)assert.deepEqual(await readFile(location),bytes);
      else await assert.rejects(readFile(location),{code:'ENOENT'});
      assert.deepEqual(await f.store.read(file.sha256),bytes,'lite restore preserves the source attachment');
    } finally {await db.close();}
  }
});

test('full backup rejects missing, extra, duplicate and corrupt large attachments before creating a copy',async t=>{
  const f=await fixture(t);await f.document(Buffer.alloc(6*1024*1024,97));
  const archive=await f.service.export(f.a);
  for(const mutate of [
    (v:any)=>{v.files=[];},
    (v:any)=>{v.files.push({...v.files[0]});},
    (v:any)=>{v.files[0].base64='Yg=='+v.files[0].base64.slice(4);},
    (v:any)=>{v.manifest.files=[];},
    (v:any)=>{v.manifest.files[0].hash='0'.repeat(64);},
    (v:any)=>{v.liteBackup=true;},
  ]) {
    const broken=structuredClone(archive);mutate(broken);
    assert.equal((await f.service.preview(f.a,request(broken))).ready,false);
  }
  assert.equal((await f.service.list(f.a)).length,0);
});

test('web export refuses an archive larger than its own web import limit',async t=>{
  const f=await fixture(t);
  for(let i=0;i<7;i++)await f.document(Buffer.alloc(8*1024*1024,65+i));
  await assert.rejects(f.service.export(f.a),/backup_requires_cli/);
  const lite=await f.service.export(f.a,undefined,false);
  assert.equal(copyInput.safeParse(request(lite)).success,true);
  assert.equal((await f.service.preview(f.a,request(lite))).ready,true);
});

test('a full archive just below the web cap restores all large attachment bytes within the service memory budget',async t=>{
  const f=await fixture(t), files=[];
  for(let i=0;i<6;i++) files.push(await f.document(Buffer.alloc((i===5?6:8)*1024*1024,70+i)));
  const archive=await f.service.export(f.a),input=request(archive);
  assert.ok(Buffer.byteLength(input.text)>60*1024*1024);
  assert.ok(Buffer.byteLength(input.text)<=64*1024*1024);
  const preview=await f.service.preview(f.a,input);assert.equal(preview.ready,true,JSON.stringify(preview));
  const receipt=await f.service.apply(f.a,{...input,token:preview.token,confirm:true});
  const target=new FileStore(path.join(f.config.storageRoot,'import-copies',receipt.schema));
  for(const file of files)assert.equal((await target.read(file.sha256)).length,file.size);
});

test('HTTP export downloads a raw restore-compatible archive and historical lite copies carry an explicit warning',async t=>{
  const f=await fixture(t);await f.document(Buffer.from('synthetic HTTP attachment'));
  const session=await httpSession(f.db,f.config);t.after(()=>session.app.close());
  const response=await session.app.inject({method:'POST',url:'/api/v4/admin/backups/export',headers:session.headers,payload:{}});
  assert.equal(response.statusCode,200,response.body);
  const archive=response.json();assert.equal(archive.format,'recruit-v4-copy');
  delete archive.manifest.fileMode;
  assert.equal((await f.service.preview(f.a,request(archive))).ready,true,'historical complete backups remain supported');
  archive.liteBackup=true;archive.files=[];archive.manifest.files=[];
  const preview=await f.service.preview(f.a,request(archive));
  assert.equal(preview.ready,true);assert.ok(preview.warnings.includes('resume_attachments_omitted'));
});

test('lite restore leaves existing target storage untouched and creates no omitted attachment',async t=>{
  const f=await fixture(t),dest=await testDatabase();t.after(dest.cleanup);
  const file=await f.document(Buffer.from('omitted synthetic attachment')),archive=await f.service.export(f.a,undefined,false);
  const directory=path.join(f.config.storageRoot,'lite-archive'),target=new FileStore(path.join(f.config.storageRoot,'existing-target'));
  await mkdir(directory,{recursive:true});
  await writeFile(path.join(directory,'database.json'),JSON.stringify(archive.tables));
  await writeFile(path.join(directory,'private-config.json'),JSON.stringify(archive.config));
  await writeFile(path.join(directory,'manifest.json'),JSON.stringify(archive.manifest));
  const existing=await target.put('existing.txt',Buffer.from('already stored synthetic bytes'));
  await restore(dest.db,target,directory);
  assert.equal((await target.read(existing.sha256)).toString(),'already stored synthetic bytes');
  await assert.rejects(readFile(target.path(file.sha256)),{code:'ENOENT'});
  assert.equal((await dest.db.query('SELECT blob_key FROM resume_documents')).rows[0].blob_key,file.sha256);
});

test('lite copy default downloads retain their persisted attachment mode and restore again',async t=>{
  const f=await fixture(t),file=await f.document(Buffer.from('attachment omitted across copy downloads'));
  const input=request(await f.service.export(f.a,undefined,false)),preview=await f.service.preview(f.a,input);
  const receipt=await f.service.apply(f.a,{...input,token:preview.token,confirm:true});
  const downloaded=await f.service.export(f.a,receipt.id);
  assert.equal(downloaded.manifest.fileMode,'omitted');assert.deepEqual(downloaded.files,[]);
  assert.equal((await f.service.list(f.a)).find(row=>row.id===receipt.id).fileMode,'omitted');
  await assert.rejects(f.service.export(f.a,receipt.id,true),/backup_attachments_omitted/);
  const again=request(downloaded),checked=await f.service.preview(f.a,again);
  assert.equal(checked.ready,true);assert.ok(checked.warnings.includes('resume_attachments_omitted'));
  const second=await f.service.apply(f.a,{...again,token:checked.token,confirm:true});
  assert.equal(second.fileMode,'omitted');
  await assert.rejects(readFile(path.join(f.config.storageRoot,'import-copies',second.schema,file.sha256)),{code:'ENOENT'});
  const session=await httpSession(f.db,f.config);t.after(()=>session.app.close());
  const response=await session.app.inject({method:'POST',url:'/api/v4/admin/backups/export',headers:session.headers,payload:{copyId:receipt.id}});
  assert.equal(response.statusCode,200,response.body);assert.equal(response.json().manifest.fileMode,'omitted');
  // Receipts created before the explicit field was added already persisted this warning.
  await f.db.query("UPDATE migration_receipts SET manifest=manifest-'fileMode' WHERE manifest->>'id'=$1",[receipt.id]);
  assert.equal((await f.service.export(f.a,receipt.id)).manifest.fileMode,'omitted');
});
