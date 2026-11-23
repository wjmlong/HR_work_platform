import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {configFixture,publishDefinition} from './business-config-fixture.js';
import {actor,httpSession} from './helpers.js';
import {DiscoveryLeads} from '../src/sourcing-discovery/leads.js';

async function fixture(t:any){
 const f=await configFixture(t),job=(await f.db.query("INSERT INTO jobs(name) VALUES('合成批量岗位') RETURNING id")).rows[0],task=(await f.db.query("INSERT INTO discovery_tasks(name,job_id,owner_id,created_by,snapshot) VALUES('合成批量',$1,$2,$2,'{}') RETURNING id",[job.id,f.admin.id])).rows[0];
 const lead=(await f.db.query("INSERT INTO leads(name,org,direction,source,line,owner_id) VALUES('合成线索','合成机构','合成方向','合成渠道','social',$1) RETURNING id",[f.admin.id])).rows[0];
 await f.db.query('INSERT INTO discovery_lead_jobs(lead_id,job_id,owner_id) VALUES($1,$2,$3),($1,NULL,$3)',[lead.id,job.id,f.admin.id]);
 const subjects:any[]=[];
 for(const [index,name] of ['A','B','C','D','Z withdrawn'].entries())subjects.push((await f.db.query("INSERT INTO discovery_subjects(entity_type,platform,identity_key,display_name,profile_url,lead_id,do_not_contact) VALUES('person','research',$1,$2,'https://example.com/synthetic',$3,$4) RETURNING *",[randomUUID(),name,index===0||index===3?lead.id:null,index===3])).rows[0]);
 const publish=async(subject:any,directions:any,withdrawn=false)=>{
 const key=randomUUID(),source=(await f.db.query("INSERT INTO discovery_sources(task_id,platform,profile_url,display_name,entity_type,data,content_hash,access_method,submitted_by,status) VALUES($1,'research','https://example.com/synthetic',$2,'person','{}',$3,'manual_import',$4,'published') RETURNING id",[task.id,subject.display_name,key,f.admin.id])).rows[0],review=(await f.db.query("INSERT INTO discovery_reviews(source_id,source_version,data,actor_id) VALUES($1,1,'{}',$2) RETURNING id",[source.id,f.admin.id])).rows[0];
 return (await f.db.query('INSERT INTO discovery_publications(subject_id,source_id,review_id,published,actor_id,withdrawn_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[subject.id,source.id,review.id,{directions},f.admin.id,withdrawn?new Date():null])).rows[0];
 };
 const first=await publish(subjects[0],[{label:'自动化'},{label:'数据'},{label:'自动化'}]);await publish(subjects[0],[{label:'自动化'}]);await publish(subjects[0],[{label:'WITHDRAWN_SENTINEL'}],true);
 await publish(subjects[1],null);const third=await publish(subjects[2],[]);await publish(subjects[3],[{label:'共享线索'}]);await publish(subjects[4],[{label:'HIDDEN_SENTINEL'}],true);
 for(const [subject,publication,type,days] of [[subjects[0],first,'email',1],[subjects[0],first,'phone',-1],[subjects[2],third,'platform_dm',1]] as const)await f.db.query("INSERT INTO discovery_contacts(subject_id,publication_id,data,availability,verified_at,valid_until,verified_by) VALUES($1,$2,$3,'value_obtained',now(),now()+$4*interval '1 day',$5)",[subject.id,publication.id,{type,value:'PRIVATE_CONTACT_SENTINEL',entryUrl:'https://example.com/PRIVATE_CONTACT_SENTINEL'},days,f.admin.id]);
 return {...f,subjects,service:new DiscoveryLeads(f.identity)};
}
// Frozen previous projection is the equivalence oracle; the implementation batches by page IDs.
async function legacyPage(f:Awaited<ReturnType<typeof fixture>>,page=1,pageSize=25){
 const items=(await f.db.query('SELECT s.id,s.lead_id,s.entity_type,s.platform,s.display_name,s.profile_url,s.do_not_contact,s.version FROM discovery_subjects s WHERE EXISTS(SELECT 1 FROM discovery_publications p WHERE p.subject_id=s.id AND p.withdrawn_at IS NULL) ORDER BY s.display_name,s.id LIMIT $1 OFFSET $2',[pageSize,(page-1)*pageSize])).rows;
 for(const row of items){row.directions=[...new Set((await f.db.query("SELECT published->'directions' directions FROM discovery_publications WHERE subject_id=$1 AND withdrawn_at IS NULL",[row.id])).rows.flatMap(p=>(p.directions||[]).map((d:any)=>d.label)))];row.contacts=(await f.db.query("SELECT id,data->>'type' type,CASE WHEN valid_until<=now() THEN 'needs_recheck' ELSE availability END availability,verified_at,valid_until,version FROM discovery_contacts WHERE subject_id=$1 ORDER BY id",[row.id])).rows;row.jobs=row.lead_id?(await f.db.query('SELECT r.*,j.name job_name FROM discovery_lead_jobs r LEFT JOIN jobs j ON j.id=r.job_id WHERE r.lead_id=$1 ORDER BY r.id',[row.lead_id])).rows:[];}
 return items;
}
const json=(v:unknown)=>JSON.parse(JSON.stringify(v));
test('published pool batches page enrichment with complete legacy row equivalence and no contact disclosure',async t=>{
 const f=await fixture(t),expected=await legacyPage(f),query=f.db.query.bind(f.db);let enrichments=0;
 f.db.query=(async(sql:string,values?:unknown[])=>{if(/^SELECT (?:subject_id,)?published/.test(sql)||/^SELECT .* FROM discovery_contacts WHERE/.test(sql)||/^SELECT r\.\*,j\.name job_name/.test(sql))enrichments++;return query(sql,values);}) as typeof f.db.query;
 try{
 const result=await f.service.query(f.admin,{});assert.deepEqual(json(result.items),json(expected));assert.equal(result.total,4);assert.equal(enrichments,3,'enrichment query count is fixed per page, not per subject');
 assert.ok(!JSON.stringify(result).includes('PRIVATE_CONTACT_SENTINEL'));assert.ok(!JSON.stringify(result).includes('WITHDRAWN_SENTINEL'));assert.ok(!JSON.stringify(result).includes('HIDDEN_SENTINEL'));
 assert.deepEqual(result.items[1].directions,[]);assert.deepEqual(result.items[1].contacts,[]);assert.deepEqual(result.items[1].jobs,[]);assert.equal(result.items[0].contacts.some((c:any)=>c.availability==='needs_recheck'),true);assert.equal(result.items[0].jobs.some((j:any)=>j.job_name===null),true);assert.deepEqual(result.items[3].jobs,result.items[0].jobs);
 const second=await f.service.query(f.admin,{page:2,pageSize:2});assert.deepEqual(json(second.items),json(expected.slice(2)));const beforeNull=enrichments,nullLead=await f.service.query(f.admin,{page:2,pageSize:1});assert.deepEqual(json(nullLead.items),json(expected.slice(1,2)));assert.equal(enrichments-beforeNull,2,'a page without lead IDs skips the jobs query');const before=enrichments,empty=await f.service.query(f.admin,{page:9,pageSize:2});assert.deepEqual(empty.items,[]);assert.equal(empty.total,4);assert.equal(enrichments,before,'empty pages issue no enrichment queries');
 await f.db.query("UPDATE discovery_contacts SET valid_until=now()-interval '1 day' WHERE subject_id=$1",[f.subjects[2].id]);assert.equal((await f.service.query(f.admin,{})).items[2].contacts[0].availability,'needs_recheck');
 }finally{f.db.query=query;}
});
test('published pool retains role and current field ACL gates before page projections',async t=>{
 const f=await fixture(t),h=await httpSession(f.db,f.config,['recruiter']);t.after(()=>h.app.close());
 const req={method:'POST' as const,url:'/api/v4/sourcing/pool/query',headers:h.headers,payload:{}};
 const allowed=await h.app.inject(req);assert.equal(allowed.statusCode,200,allowed.body);assert.deepEqual(allowed.json().data.items,json(await legacyPage(f)));
 await assert.rejects(f.service.query(await actor(f.db,['viewer']),{}),/forbidden/);
 const def=await f.configs.effective(f.admin,'lead'),doc=await f.configs.version(f.admin,def.ref);doc.fields.find((v:any)=>v.coreKey==='contact').access.read=['admin'];await publishDefinition(f,doc);
 const denied=await h.app.inject(req);assert.equal(denied.statusCode,403,denied.body);assert.equal((await f.service.query(f.admin,{})).items.length,4);
});
