import {parseArgs} from 'node:util';
import {loadConfig} from '../dist/config.js';
import {Database} from '../dist/db.js';
import {Identity} from '../dist/identity/service.js';
import {FeishuProvider} from '../dist/identity/provider.js';
import {previewInboxMaintenance,applyInboxMaintenance} from '../dist/recruiting/inbox-maintenance.js';
const {values}=parseArgs({options:{'candidate-id':{type:'string',multiple:true},'all-inbox':{type:'boolean'},'repair-generic-intent':{type:'boolean'},'force-recompute':{type:'boolean'},apply:{type:'boolean'},'preview-hash':{type:'string'},'actor-id':{type:'string'}}});
const ids=values['candidate-id'];
if((!ids?.length&&!values['all-inbox'])||(ids?.length&&values['all-inbox'])||ids?.some(s=>!/^[-a-f0-9]{36}$/i.test(s)))throw Error('Specify --candidate-id UUID (repeatable) or --all-inbox');
if(values.apply&&(!/^[a-f0-9]{64}$/.test(values['preview-hash']||'')||!values['actor-id']))throw Error('Apply requires reviewed --preview-hash and --actor-id');
const config=loadConfig(),db=new Database(config),identity=new Identity(db,config,new FeishuProvider(config));
const scope={candidateIds:ids,repairGenericIntent:!!values['repair-generic-intent'],forceRecompute:!!values['force-recompute']};
try{
 // No migration, model request, queue mutation or repair during the default preview.
 if(!values.apply)console.log(JSON.stringify({dryRun:true,...await previewInboxMaintenance(identity,scope)},null,2));
 else{
  const user=(await db.query("SELECT * FROM users WHERE id=$1 AND status='active' AND directory_active",[values['actor-id']])).rows[0];if(!user)throw Error('active_actor_required');
  console.log(JSON.stringify(await applyInboxMaintenance(identity,{...user,csrf:''},scope,values['preview-hash']),null,2));
 }
}finally{await db.close();}
