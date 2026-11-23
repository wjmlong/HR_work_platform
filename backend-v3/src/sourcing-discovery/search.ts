import https from 'node:https';
import type { Actor, Identity } from '../identity/service.js';
import { fail, found } from '../http/errors.js';
import { parse, z, version, sourceInput, type SourceInput } from './schema.js';
import { SourceService } from './sources.js';
import { discoveryModelStatus } from './model.js';
import type { Lease } from './queue.js';
export const searchInput=z.object({version,query:z.string().trim().min(2).max(200),limit:z.number().int().min(1).max(3).default(3),ai:z.boolean().default(true)}).strict();
export function githubJson(url:string):Promise<any>{
 const u=new URL(url);if(u.origin!=='https://api.github.com'||!(/^\/search\/repositories$/.test(u.pathname)||/^\/users\/[A-Za-z0-9-]+$/.test(u.pathname)))throw Error('search_url_invalid');
 return new Promise((resolve,reject)=>{let done=false;const finish=(error?:Error,data?:any)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(data);};
 const req=https.get(u,{headers:{'User-Agent':'Shanzi-Recruit-Sourcing/1.0','Accept':'application/vnd.github+json'}},res=>{let size=0;const chunks:Buffer[]=[];res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>1024*1024){finish(Error('search_response_limit'));req.destroy();}else chunks.push(chunk);});res.on('error',()=>finish(Error('search_network_failed')));res.on('end',()=>{if(res.statusCode===403||res.statusCode===429)return finish(Error('search_rate_limited'));if(res.statusCode!==200)return finish(Error('search_provider_failed'));try{finish(undefined,JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{finish(Error('search_invalid_response'));}});});
 const timer=setTimeout(()=>{finish(Error('search_timeout'));req.destroy();},25000);req.on('error',()=>finish(Error('search_network_failed')));
 });
}
// Only provider-owned endpoints are requested. Repository URLs and profile links are evidence, never fetch targets.
export async function githubSearch(query:string,limit:number,read:typeof githubJson=githubJson):Promise<SourceInput[]>{
 const endpoint='https://api.github.com/search/repositories?'+new URLSearchParams({q:query,sort:'updated',per_page:String(Math.min(10,limit*2))});
 const result=await read(endpoint);if(!Array.isArray(result.items))throw Error('search_invalid_response');
 const seen=new Set<string>(),out:SourceInput[]=[];
 for(const repo of result.items){const login=repo.owner?.login;if(typeof login!=='string'||! /^[A-Za-z0-9-]+$/.test(login)||seen.has(login))continue;seen.add(login);
 const profile=await read('https://api.github.com/users/'+login);if(profile.login?.toLowerCase()!==login.toLowerCase()||!Number.isSafeInteger(profile.id))throw Error('search_identity_mismatch');
 const capturedAt=new Date().toISOString(),profileUrl='https://github.com/'+login;
 const text=['GitHub 公开账号：'+login,'账号类型：'+profile.type,'自述：'+(profile.bio||'未填写'),'公开邮箱（用途待核验）：'+(profile.email||'未公开，待人工补充联系途径'),'说明：项目维护者身份不证明求职意愿；没有观察到站内私信入口。'].join('\n').slice(0,9500);
 const evidence=[{id:'e1',text,sourceUrl:profileUrl,capturedAt}];
 if(typeof repo.full_name==='string'&&repo.full_name.toLowerCase().startsWith(login.toLowerCase()+'/')&&repo.html_url==='https://github.com/'+repo.full_name)evidence.push({id:'e2',text:['项目：'+repo.full_name,'项目说明：'+(repo.description||'未填写')].join('\n').slice(0,9500),sourceUrl:repo.html_url,capturedAt});
 out.push(sourceInput.parse({platform:'other',nativeId:'github:'+profile.id,displayName:profile.name||login,profileUrl,entityType:profile.type==='Organization'?'institution':'account',accessMethod:'public_fetch',externalModelAllowed:false,evidence}));if(out.length>=limit)break;
 }return out;
}
export class SearchService{
 readonly sources;constructor(readonly identity:Identity){this.sources=new SourceService(identity);}
 async enqueue(a:Actor,id:string,input:unknown){const b=parse(searchInput,input);await this.sources.policy.fields(a);if(b.ai&&!discoveryModelStatus(this.identity.config).configured)fail(503,'model_not_configured');
 return this.identity.db.tx(async c=>{await c.query('SELECT id FROM discovery_tasks WHERE id=$1 FOR UPDATE',[id]);const t=await this.sources.policy.assertTask(a,id,'write');if(t.version!==b.version)fail(409,'version_conflict');if(t.state!=='running')fail(409,'discovery_not_running');if(!t.snapshot.sources.includes('other'))fail(422,'github_source_not_selected');
 const r=found((await c.query('SELECT * FROM discovery_runs WHERE task_id=$1 AND ended_at IS NULL FOR UPDATE',[id])).rows[0]);const used=await this.sources.budget(r,'other');if(used.total+b.limit+1>r.limits.pages||used.source+b.limit+1>r.limits.pagesPerSource)fail(409,'discovery_budget_exhausted');
 await c.query('SELECT pg_advisory_xact_lock(hashtext(current_schema()),18002)');if(Number((await c.query("SELECT count(*) FROM discovery_queue WHERE input->>'mode'='github_search' AND created_at>now()-interval '1 minute'")).rows[0].count)>=3)fail(429,'search_rate_limited');
 if((await c.query("SELECT 1 FROM discovery_queue WHERE run_id=$1 AND input->>'mode'='github_search' AND state IN('queued','running')",[r.id])).rowCount)fail(409,'search_already_running');
 const q=(await c.query("INSERT INTO discovery_queue(run_id,kind,input) VALUES($1,'fetch',$2) RETURNING id,state",[r.id,{...b,mode:'github_search',host:'api.github.com',platform:'other',actorId:a.id,taskId:id}])).rows[0];await this.identity.audit(c,a.id,'discovery.search.enqueue',id,{query:b.query,limit:b.limit,ai:b.ai});return q;});}
 async complete(l:Lease,items:SourceInput[]){return this.identity.db.tx(async c=>{
 const t=(await c.query("SELECT t.* FROM discovery_tasks t JOIN discovery_runs r ON r.task_id=t.id WHERE r.id=$1 AND t.state='running' AND r.ended_at IS NULL FOR UPDATE OF t",[l.run_id])).rows[0];if(!t)return;
 const q=(await c.query("SELECT * FROM discovery_queue WHERE id=$1 AND claim_token=$2 AND worker_id=$3 AND state='running' AND lease_until>now() FOR UPDATE",[l.id,l.claim_token,l.worker_id])).rows[0];if(!q)return;
 const a=(await c.query("SELECT * FROM users WHERE id=$1 AND status='active' AND directory_active",[q.input.actorId])).rows[0] as Actor;if(!a)fail(403,'actor_revoked');await this.sources.policy.assertTask(a,t.id,'write');
 let count=0;for(const item of items.slice(0,q.input.limit)){const [r]=await this.sources.submit(a,t.id,{version:t.version,items:[{...item,externalModelAllowed:q.input.ai}]});await c.query("UPDATE discovery_sources SET data=data||$2::jsonb WHERE id=$1 AND status='pending'",[r.id,JSON.stringify({provenance:'github_public_api',searchQueueId:l.id})]);if(q.input.ai){const current=(await c.query('SELECT status,draft FROM discovery_sources WHERE id=$1',[r.id])).rows[0];if(current.status==='pending'&&!current.draft&&!(await c.query("SELECT 1 FROM discovery_queue WHERE source_id=$1 AND state IN('queued','running')",[r.id])).rowCount)await this.sources.enqueue(a,r.id,{version:r.version});}count++;}
 await c.query("UPDATE discovery_queue SET state='completed',lease_until=NULL,input=input||$2::jsonb WHERE id=$1",[l.id,JSON.stringify({resultCount:count,completedAt:new Date().toISOString()})]);await this.identity.audit(c,a.id,'discovery.search.completed',t.id,{resultCount:count});
 });}
}
