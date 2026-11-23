import type { Database } from '../db.js';
import { z, parse } from '../http/validation.js';
import { fail } from '../http/errors.js';
const identifier=z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const migration=z.object({
 tenant:identifier,fromAppId:identifier,toAppId:identifier,
 entries:z.array(z.object({id:z.string().uuid(),version:z.number().int().positive(),oldOpenId:identifier,newOpenId:identifier,oldUnionId:identifier,newUnionId:identifier}).strict()).min(1).max(100000),
}).strict();
/** Offline maintenance operation. Entries must come from authenticated contact
 * lookups in both apps, never from names or user-submitted identity claims.
 * Stop all writers and back up SQL/config before applying and switching config. */
export async function migrateFeishuApplication(db:Database,input:unknown,dryRun=true){
 const plan=parse(migration,input);
 if(plan.fromAppId===plan.toAppId||db.config.feishu.appId!==plan.fromAppId||db.config.feishu.tenant!==plan.tenant)fail(409,'migration_application_mismatch');
 for(const key of ['id','oldOpenId','newOpenId','oldUnionId'] as const)
  if(new Set(plan.entries.map(e=>e[key])).size!==plan.entries.length)fail(409,'migration_identity_collision');
 if(plan.entries.some(e=>e.oldUnionId!==e.newUnionId))fail(409,'migration_union_mismatch');
 return db.tx(async c=>{
  await c.query('LOCK TABLE users, sessions, oauth_states IN EXCLUSIVE MODE');
  const users=(await c.query('SELECT id,tenant,app_id,open_id,version FROM users ORDER BY id')).rows;
  if(users.length!==plan.entries.length||users.some(u=>!plan.entries.some(e=>e.id===u.id&&e.version===u.version&&e.oldOpenId===u.open_id&&u.tenant===plan.tenant&&u.app_id===plan.fromAppId)))fail(409,'migration_snapshot_changed');
  if(dryRun)return {users:users.length,dryRun:true};
  for(const e of plan.entries)await c.query('UPDATE users SET app_id=$1,open_id=$2,version=version+1,updated_at=now() WHERE id=$3',[plan.toAppId,e.newOpenId,e.id]);
  await c.query('DELETE FROM sessions');await c.query('DELETE FROM oauth_states');
  await c.query("INSERT INTO audit_events(kind,detail,instance) VALUES('identity.application_migrated',$1,$2)",[{fromAppId:plan.fromAppId,toAppId:plan.toAppId,users:users.length},db.config.instance]);
  return {users:users.length,dryRun:false};
 });
}
