import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { testDatabase, httpSession } from './helpers.js';
test('10,000 published leads: 20 concurrent paginated HTTP reads stay below 500ms P95', async t => {
 const f=await testDatabase();t.after(f.cleanup);const h=await httpSession(f.db,f.config);t.after(()=>h.app.close());
 const job=(await f.db.query("INSERT INTO jobs(name) VALUES('合成负载岗位') RETURNING id")).rows[0];
 const task=(await f.db.query("INSERT INTO discovery_tasks(name,job_id,owner_id,created_by,snapshot) VALUES('合成负载',$1,$2,$2,'{}') RETURNING id",[job.id,h.actor.id])).rows[0];
 await f.db.query(`INSERT INTO leads(name,org,direction,source,line,owner_id) SELECT '合成-'||n,'合成','自动化','合成','social',$1 FROM generate_series(1,10000) n`,[h.actor.id]);
 await f.db.query(`INSERT INTO discovery_subjects(entity_type,platform,identity_key,display_name,profile_url,lead_id) SELECT 'person','research',id::text,name,'https://example.com/'||id,id FROM leads`);
 await f.db.query(`INSERT INTO discovery_sources(task_id,platform,native_id,profile_url,display_name,entity_type,data,content_hash,access_method,submitted_by,status) SELECT $1,'research',identity_key,profile_url,display_name,'person','{}',id::text,'manual_import',$2,'published' FROM discovery_subjects`,[task.id,h.actor.id]);
 await f.db.query(`INSERT INTO discovery_reviews(source_id,source_version,data,actor_id) SELECT id,1,'{}',$1 FROM discovery_sources`,[h.actor.id]);
 await f.db.query(`INSERT INTO discovery_publications(subject_id,source_id,review_id,published,actor_id) SELECT s.id,o.id,r.id,'{}',$1 FROM discovery_subjects s JOIN discovery_sources o ON o.native_id=s.identity_key JOIN discovery_reviews r ON r.source_id=o.id`,[h.actor.id]);
 await f.db.query(`INSERT INTO discovery_lead_jobs(lead_id,job_id,owner_id) SELECT id,$1,$2 FROM leads`,[job.id,h.actor.id]);
 await f.db.query(`INSERT INTO discovery_contacts(subject_id,publication_id,data,availability,verified_at,valid_until,verified_by) SELECT subject_id,id,'{"type":"platform_dm","entryUrl":"https://example.com/"}','entry_observed',now(),now()+interval '30 days',$1 FROM discovery_publications`,[h.actor.id]);
 await f.db.query('ANALYZE');
 const call=async(page:number)=>{const begin=performance.now();const response=await h.app.inject({method:'POST',url:'/api/v4/sourcing/pool/query',headers:h.headers,payload:{page,pageSize:25}});assert.equal(response.statusCode,200,response.body);assert.equal(response.json().data.total,10000);assert.equal(response.json().data.items.length,25);return performance.now()-begin;};
 await call(1);const times=(await Promise.all(Array.from({length:20},(_,i)=>call(i+1)))).sort((a,b)=>a-b);const p95=times[Math.ceil(times.length*.95)-1];t.diagnostic(JSON.stringify({rows:10000,concurrency:20,p95Ms:Math.round(p95),maxMs:Math.round(times.at(-1)!)}));assert.ok(p95<500,`P95 ${p95.toFixed(1)}ms exceeds 500ms`);
});
