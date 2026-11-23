// Run only from an offline maintenance session after backup and preview.
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {loadConfig} from '../dist/config.js';
import {Database} from '../dist/db.js';
import {Identity} from '../dist/identity/service.js';
import {FeishuProvider} from '../dist/identity/provider.js';
import {FileStore} from '../dist/files/storage.js';
import {replayRecognitions} from '../dist/operations/recognition-replay.js';
const [manifestPath,resultDir,runId,...flags]=process.argv.slice(2),config=loadConfig();
if(config.schema==='recruit_v4'&&!flags.includes('--allow-production'))throw Error('production_flag_required');
const manifest=JSON.parse(await readFile(manifestPath,'utf8')),results=new Map();
for(const row of manifest.records.filter(r=>!r.container_only)){
 if(!/^[a-zA-Z0-9_-]+$/.test(row.id))throw Error('invalid_source_id');
 const value=JSON.parse(await readFile(path.join(resultDir,row.id+'.json'),'utf8')),sha=row.sha256||row.id;
 if(value.id!==row.id||value.status!=='ok'||value.source_sha256!==sha)throw Error('incomplete_replay:'+row.id);
 // Mail subjects/body extraction are additional evidence, not a replacement for a file with the same hash.
 if(!results.has(sha)||row.kind!=='email')results.set(sha,value);
}
const db=new Database(config);
try{console.log(JSON.stringify(await replayRecognitions(new Identity(db,config,new FeishuProvider(config)),new FileStore(config.storageRoot),results,{runId,apply:flags.includes('--apply'),fingerprint:flags.find(x=>x.startsWith('--fingerprint='))?.slice(14)})));}finally{await db.close();}
