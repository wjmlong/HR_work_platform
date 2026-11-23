import test from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase,actor } from './helpers.js';
import { migrateFeishuApplication } from '../src/operations/feishu-migration.js';
import { Identity } from '../src/identity/service.js';

test('application migration preserves ownership, roles and approval state and revokes old sessions',async t=>{
 const {db,config,cleanup}=await testDatabase();t.after(cleanup);
 const a=await actor(db,['admin']),pending=await actor(db,[]);
 await db.query("UPDATE users SET status='pending' WHERE id=$1",[pending.id]);
 config.feishu={...config.feishu,tenant:'company',appId:'app',admins:[]};
 const provider={configured:()=>true,authorizeUrl:()=>'',identity:async()=>{throw Error('unused')},contact:async()=>({tenant:'company',appId:'next',openId:'ou_new_a',name:'Renamed',active:true})};
 const identity=new Identity(db,config,provider);
 const token=await identity.establish({tenant:'company',appId:'app',openId:a.open_id,name:a.name,active:true});
 await db.query("INSERT INTO sourcing_setups(user_id,data) VALUES($1,'{}')",[a.id]);
 await db.query("INSERT INTO oauth_states VALUES('state','browser','verifier',now()+interval '1 hour')");
 const plan={tenant:'company',fromAppId:'app',toAppId:'next',entries:[{id:a.id,version:a.version,oldOpenId:a.open_id,newOpenId:'ou_new_a',oldUnionId:'on_a',newUnionId:'on_a'},{id:pending.id,version:pending.version,oldOpenId:pending.open_id,newOpenId:'ou_new_b',oldUnionId:'on_b',newUnionId:'on_b'}]};
 const preview=await migrateFeishuApplication(db,plan);assert.equal(preview.users,2);assert.equal((await db.query('SELECT count(*)::int n FROM sessions')).rows[0].n,1);
 await migrateFeishuApplication(db,plan,false);
 const rows=(await db.query('SELECT * FROM users ORDER BY id')).rows;
 assert.equal(rows.length,2);const migrated=rows.find(u=>u.id===a.id)!;assert.equal(migrated.app_id,'next');assert.equal(migrated.open_id,'ou_new_a');assert.deepEqual(migrated.roles,['admin']);assert.equal(migrated.version,a.version+1);
 assert.equal(rows.find(u=>u.id===pending.id)!.status,'pending');assert.equal((await db.query('SELECT user_id FROM sourcing_setups')).rows[0].user_id,a.id);
 assert.equal((await db.query('SELECT count(*)::int n FROM sessions')).rows[0].n,0);assert.equal((await db.query('SELECT count(*)::int n FROM oauth_states')).rows[0].n,0);
 config.feishu.appId='next';await assert.rejects(()=>identity.authenticate(token));
 await identity.establish(await provider.contact());assert.equal((await db.query('SELECT count(*)::int n FROM users')).rows[0].n,2);
 assert.equal((await db.query('SELECT count(*)::int n FROM audit_events WHERE kind=$1',['identity.application_migrated'])).rows[0].n,1);
});

test('migration rejects mismatched identities, omissions, collisions and stale snapshots without changing users',async t=>{
 const {db,config,cleanup}=await testDatabase();t.after(cleanup);const a=await actor(db),b=await actor(db);config.feishu={...config.feishu,tenant:'company',appId:'app'};
 const plan={tenant:'company',fromAppId:'app',toAppId:'next',entries:[a,b].map((u,i)=>({id:u.id,version:u.version,oldOpenId:u.open_id,newOpenId:'ou_new_'+i,oldUnionId:'on_'+i,newUnionId:'on_'+i}))};
 for(const variant of [
 {...plan,entries:plan.entries.slice(0,1)},
 {...plan,toAppId:'app'},
 {...plan,tenant:'other'},
 {...plan,entries:plan.entries.map((e,i)=>i?e:{...e,newUnionId:'wrong'})},
 {...plan,entries:plan.entries.map(e=>({...e,newOpenId:'same'}))},
 {...plan,entries:plan.entries.map(e=>({...e,version:99}))},
 ]){await assert.rejects(()=>migrateFeishuApplication(db,variant,false),(error:any)=>error.statusCode===409&&error.code.startsWith('migration_'));assert.equal((await db.query("SELECT count(*)::int n FROM users WHERE app_id='app'")).rows[0].n,2);}
});
