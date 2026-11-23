import {ARCHIVE_SCHEMA_REVISION} from '../src/operations/archive-schema.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {configFixture,fieldDefinition} from './business-config-fixture.js';
import {testDatabase,actor,httpSession} from './helpers.js';
import {backup,restore,TABLES} from '../src/operations/backup.js';
import {LEGACY_V4_TABLES} from '../src/operations/archive-schema.js';
import {FileStore} from '../src/files/storage.js';

test('catalog_seed_idempotent: stable definitions survive restart without resurrecting edited fields',async t=>{
 const f=await configFixture(t),first=await f.configs.effective(f.admin,'job');
 const document=await f.configs.version(f.admin,first.ref);
 assert.ok(document.kind==='fields'&&document.fields.some((x:any)=>x.coreKey==='name'));
 await f.configs.seed();await f.configs.seed();
 assert.deepEqual((await f.configs.effective(f.admin,'job')).ref,first.ref);
 const count=await f.db.query('SELECT count(*)::int n FROM business_config_versions WHERE config_id=$1',[first.ref.configId]);
 assert.equal(count.rows[0].n,1);
});

test('catalog_publish_conflict_and_history: one concurrent publish wins and prior definitions stay immutable',async t=>{
 const f=await configFixture(t),old=await f.configs.effective(f.admin,'job');
 const before=await f.configs.version(f.admin,old.ref);
 const document={...before,fields:[...before.fields,fieldDefinition()]};
 const d1=await f.configs.saveDraft(f.admin,{key:'fields.job',baseVersion:old.ref.version,document});
 const d2=await f.configs.saveDraft(f.admin,{key:'fields.job',baseVersion:old.ref.version,document:{...document,fields:[...document.fields,fieldDefinition({fieldId:'custom.other',label:'补充'})]}});
 const p1=await f.configs.preview(f.admin,d1.id),p2=await f.configs.preview(f.admin,d2.id);
 const results=await Promise.allSettled([f.configs.publish(f.admin,p1),f.configs.publish(f.admin,p2)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.deepEqual(await f.configs.version(f.admin,old.ref),before);
 assert.equal((await f.db.query('SELECT count(*)::int n FROM business_config_versions WHERE config_id=$1',[old.ref.configId])).rows[0].n,2);
 await assert.rejects(f.db.query("UPDATE business_config_versions SET document='{}' WHERE config_id=$1",[old.ref.configId]),/immutable/);
 const manager=await actor(f.db,['manager']);
 await assert.rejects(f.configs.saveDraft(manager,{key:'fields.job',baseVersion:2,document}),/forbidden/);
 await assert.rejects(f.configs.publish(f.admin,{...p1,inputHash:'0'.repeat(64)}),/preview_invalid|version_conflict/);
});

test('catalog preview binds the actor and observed business version, and strict documents reject unsafe fields',async t=>{
 const f=await configFixture(t),current=await f.configs.effective(f.admin,'job'),document=await f.configs.version(f.admin,current.ref);
 const job=(await f.db.query("INSERT INTO jobs(name) VALUES('Synthetic preview') RETURNING id")).rows[0];
 const draft=await f.configs.saveDraft(f.admin,{key:'fields.job',baseVersion:1,document});
 const receipt=await f.configs.preview(f.admin,draft.id),other=await actor(f.db);
 await assert.rejects(f.configs.publish(other,receipt),/preview_invalid/);
 await f.db.query('UPDATE jobs SET version=version+1 WHERE id=$1',[job.id]);
 await assert.rejects(f.configs.publish(f.admin,receipt),/preview_stale/);
 await assert.rejects(f.configs.saveDraft(f.admin,{key:'fields.job',baseVersion:1,document:{...document,fields:[...document.fields,fieldDefinition({type:'javascript',expression:'alert(1)'})]}}),/invalid_input/);
});

test('configuration routes enforce admin publication and idempotent HTTP receipt replay',async t=>{
 const f=await configFixture(t),h=await httpSession(f.db,f.config);t.after(()=>h.app.close());
 const response=await h.app.inject({url:'/api/v4/business-config/effective/job',headers:h.headers});
 assert.equal(response.statusCode,200);
 const initial=response.json().data;
 const document=await f.configs.version(h.actor,initial.ref);
 const req={method:'POST' as const,url:'/api/v4/business-config/drafts',headers:{...h.headers,'idempotency-key':'config-draft-create'},payload:{key:'fields.job',baseVersion:initial.ref.version,document}};
 const a=await h.app.inject(req),b=await h.app.inject(req);
 assert.equal(a.statusCode,200,a.body);assert.deepEqual(a.json().data,b.json().data);
 const viewer=await httpSession(f.db,f.config,['viewer']);t.after(()=>viewer.app.close());
 assert.equal((await viewer.app.inject({...req,headers:{...viewer.headers,'idempotency-key':'viewer-draft-attempt'}})).statusCode,403);
});

test('archive_old_and_new_shapes: configuration history restores and old 43-table V4 data upgrades without loss',async t=>{
 const f=await configFixture(t),dest=await testDatabase(),legacy=await testDatabase();t.after(dest.cleanup);t.after(legacy.cleanup);
 const dir=await mkdtemp(path.join(os.tmpdir(),'config-backup-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const files=new FileStore(path.join(dir,'files')),archive=path.join(dir,'archive');
 await f.db.query("INSERT INTO jobs(name) VALUES('Synthetic old data')");
 const manifest=await backup(f.db,files,archive);
 assert.equal(manifest.version,4);assert.equal(manifest.schemaRevision,ARCHIVE_SCHEMA_REVISION);
 assert.equal(Object.keys(manifest.tables).length,TABLES.length);
 await restore(dest.db,new FileStore(path.join(dir,'dest')),archive);
 assert.deepEqual((await dest.db.query('SELECT * FROM business_config_versions ORDER BY config_id,version')).rows,(await f.db.query('SELECT * FROM business_config_versions ORDER BY config_id,version')).rows);
 const tables=JSON.parse(await readFile(path.join(archive,'database.json'),'utf8'));
 for(const key of Object.keys(tables))if(!LEGACY_V4_TABLES.includes(key))delete tables[key];
 for(const rows of Object.values(tables) as any[][])for(const row of rows)delete row.configuration_refs;
 tables.schema_migrations=tables.schema_migrations.filter((r:any)=>r.version<=11||r.version>=1000);
 const bytes=JSON.stringify(tables),sha=(v:string)=>createHash('sha256').update(v).digest('hex');
 await writeFile(path.join(archive,'database.json'),bytes);
 const old:any={...manifest,version:3,databaseHash:sha(bytes),tables:Object.fromEntries(Object.entries(tables).map(([k,v]:any)=>[k,{count:v.length,hash:sha(JSON.stringify(v))}]))};delete old.schemaRevision;delete old.columns;
 await writeFile(path.join(archive,'manifest.json'),JSON.stringify(old));
 await restore(legacy.db,new FileStore(path.join(dir,'legacy')),archive);
 assert.equal((await legacy.db.query('SELECT name FROM jobs')).rows[0].name,'Synthetic old data');
 assert.deepEqual((await legacy.db.query('SELECT configuration_refs FROM jobs')).rows[0].configuration_refs,{});
 assert.ok((await legacy.db.query('SELECT version FROM schema_migrations WHERE version=12')).rowCount);
});
