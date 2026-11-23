import type {Sql} from '../db.js';
export const meetingStageOptions=[
 {id:'hired_other',label:'录用到其他',aliases:[],order:9,active:true,coreCode:'hired_other'},
 {id:'on_hold',label:'待定',aliases:[],order:10,active:true,coreCode:'on_hold'},
 {id:'reserve',label:'人才储备',aliases:[],order:11,active:true,coreCode:'reserve'},
];
// An additive initialization is needed after restoring an old archive too:
// migrations alone cannot upgrade its restored configuration documents.
export async function ensureMeetingStages(c:Sql){
 if((await c.query('SELECT 1 FROM schema_migrations WHERE version=1004')).rowCount)return;
 const rows=(await c.query("SELECT c.*,v.document FROM business_configs c JOIN business_config_versions v ON v.config_id=c.id AND v.version=c.published_version WHERE c.key='dictionary.recruiting_statuses' FOR UPDATE OF c")).rows;
 for(const row of rows){const additions=meetingStageOptions.filter(o=>!row.document.options.some((p:any)=>p.id===o.id));if(!additions.length)continue;const version=(await c.query('SELECT coalesce(max(version),0)+1 n FROM business_config_versions WHERE config_id=$1',[row.id])).rows[0].n;await c.query('INSERT INTO business_config_versions(config_id,version,document) VALUES($1,$2,$3)',[row.id,version,{...row.document,options:[...row.document.options,...additions]}]);await c.query('UPDATE business_configs SET published_version=$2,version=version+1 WHERE id=$1',[row.id,version]);}
 await c.query('INSERT INTO schema_migrations(version) VALUES(1004) ON CONFLICT DO NOTHING');
}
