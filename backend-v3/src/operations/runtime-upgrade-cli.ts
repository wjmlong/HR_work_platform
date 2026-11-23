import {backup} from './backup.js';
import {loadConfig} from '../config.js';
import {Database} from '../db.js';
import {FileStore} from '../files/storage.js';
import {inspectRuntimeDatabase,offlineUpgrade} from './runtime-upgrade.js';
const config=loadConfig(),db=new Database(config),store=new FileStore(config.storageRoot),[command,directory]=process.argv.slice(2);
try{if(command==='inspect')console.log(JSON.stringify(await inspectRuntimeDatabase(db,store)));else if(command==='backup-runtime'&&directory){const result=await backup(db,store,directory,true);console.log(JSON.stringify({ok:true,tables:Object.keys(result.tables).length,files:result.files.length}));}else if(command==='upgrade'&&directory)console.log(JSON.stringify(await offlineUpgrade(db,store,directory)));else throw Error('Usage: runtime-upgrade-cli inspect | upgrade BACKUP_DIRECTORY');}finally{await db.close();}
