import test from 'node:test';
import assert from 'node:assert/strict';
import {testDatabase,actor} from './helpers.js';
import {Identity,requireRole} from '../src/identity/service.js';
import {InterviewGrants} from '../src/identity/grants.js';
import {Directory} from '../src/identity/directory.js';
import {RecruitingService} from '../src/recruiting/service.js';
import {InterviewService} from '../src/interviews/service.js';
import {InterviewAssistant} from '../src/interview-assistant/service.js';
async function fixture(t:any){
 const f=await testDatabase();t.after(f.cleanup);f.config.feishu={...f.config.feishu,appId:'app',tenant:'company'};
 const principal={tenant:'company',appId:'app',openId:'ou_prelogin',name:'同名员工',active:true};
 const provider={configured:()=>true,authorizeUrl:()=>'',identity:async()=>principal,contact:async(openId:string)=>({...principal,openId}),directory:async()=>[principal,{...principal,openId:'ou_other'}]};
 const identity=new Identity(f.db,f.config,provider),admin=await actor(f.db),recruiting=new RecruitingService(identity),interviews=new InterviewService(identity);
 const job=await recruiting.createJob(admin,{name:'隔离岗位',level:'P5'}),candidate=await recruiting.createCandidate(admin,{name:'隔离候选人'}),application=await recruiting.apply(admin,{jobId:job.id,candidateId:candidate.id});
 const create=(round:number)=>interviews.create(admin,{applicationId:application.id,round,startsAt:'2030-01-01T09:00:00Z',durationMinutes:45,form:'online',interviewerIds:[admin.id]});
 return {...f,identity,admin,provider,principal,application,job,interviews,first:await create(1),second:await create(2),grants:new InterviewGrants(identity)};
}
test('pre-login grants isolate scope and expire/revoke without promoting membership',async t=>{
 const f=await fixture(t),g=await f.grants.grant(f.admin,f.first.id,{openId:f.principal.openId,role:'interviewer'});
 const u=(await f.db.query('SELECT * FROM users WHERE id=$1',[g.user_id])).rows[0];assert.equal(u.status,'pending');assert.deepEqual(u.roles,[]);assert.equal((await f.db.query('SELECT count(*)::int n FROM sessions WHERE user_id=$1',[u.id])).rows[0].n,0);
 const token=await f.identity.establish(f.principal),req={cookies:{'__Host-recruit_v4_session':token}} as any,a=await f.identity.authenticate(req);
 assert.deepEqual(a.roles,[]);assert.throws(()=>requireRole(a,'recruiter'));
 const scoped=await f.identity.interviewActor(a,f.first.id).catch(async error=>{t.diagnostic(JSON.stringify((await f.db.query('SELECT g.starts_at,g.expires_at,g.revoked_at,g.revoked_reason,now() db_now,clock_timestamp() db_clock,u.status member_status,u.directory_active,i.status interview_status,i.deleted_at interview_deleted,a.deleted_at application_deleted,c.deleted_at candidate_deleted FROM interview_access_grants g JOIN users u ON u.id=g.user_id JOIN interviews i ON i.id=g.interview_id JOIN applications a ON a.id=i.application_id JOIN candidates c ON c.id=a.candidate_id WHERE g.id=$1',[g.id])).rows));throw error;});await f.identity.applicationAccess(scoped,f.application.id);
 await assert.rejects(f.identity.applicationAccess(scoped,f.application.id,true),/forbidden/);await assert.rejects(f.identity.interviewActor(a,f.second.id),/forbidden/);
 await new InterviewAssistant(f.identity).access(scoped,f.first.id);
 await f.db.query("UPDATE interview_access_grants SET expires_at=now()-interval '1 second',starts_at=now()-interval '2 seconds' WHERE id=$1",[g.id]);
 await assert.rejects(new InterviewAssistant(f.identity).access(scoped,f.first.id),/forbidden/);
 await assert.rejects(f.identity.interviewActor(await f.identity.authenticate(req),f.first.id),/forbidden/);
 await f.grants.extend(f.admin,g.id,'2030-01-04T00:00:00Z');await f.identity.interviewActor(a,f.first.id);await f.grants.revoke(f.admin,g.id);
 await assert.rejects(new InterviewAssistant(f.identity).access(scoped,f.first.id),/forbidden/);
});
test('coordinator only adjusts own schedule and cancellation preserves permanent roles',async t=>{
 const f=await fixture(t),g=await f.grants.grant(f.admin,f.first.id,{openId:f.principal.openId,role:'coordinator'}),u=(await f.db.query('SELECT * FROM users WHERE id=$1',[g.user_id])).rows[0],a={...u,csrf:''};
 await f.grants.schedule(a,f.first.id,{version:1,startsAt:'2030-01-02T09:00:00Z',location:'A'});
 assert.equal(new Date((await f.db.query('SELECT expires_at FROM interview_access_grants WHERE id=$1',[g.id])).rows[0].expires_at).toISOString(),'2030-01-04T09:45:00.000Z');
 await assert.rejects(f.grants.schedule(a,f.second.id,{version:1,location:'B'}),/forbidden/);
 await f.db.query("UPDATE users SET status='active',roles=ARRAY['recruiter'] WHERE id=$1",[u.id]);await f.db.query("UPDATE interviews SET status='cancelled' WHERE id=$1",[f.first.id]);
 const current=(await f.db.query('SELECT * FROM users WHERE id=$1',[u.id])).rows[0];assert.deepEqual(current.roles,['recruiter']);assert.equal(current.status,'active');assert.ok((await f.db.query('SELECT revoked_at FROM interview_access_grants WHERE id=$1',[g.id])).rows[0].revoked_at);
});
test('cached directory deduplicates app open_id; grants verify active tenant and never revive disabled members',async t=>{
 const f=await fixture(t);let calls=0;f.provider.directory=async()=>{calls++;return [f.principal,{...f.principal,openId:'ou_other'},f.principal];};
 const directory=new Directory(f.identity);await directory.refresh();const one=await directory.search({query:'同名',page:1,pageSize:1}),two=await directory.search({query:'同名',page:2,pageSize:1});assert.equal(one.total,2);assert.notEqual(one.items[0].openId,two.items[0].openId);assert.equal(calls,1);
 f.principal.active=false;await assert.rejects(f.grants.grant(f.admin,f.first.id,{openId:f.principal.openId,role:'interviewer'}),/directory_inactive/);f.principal.active=true;
 const g=await f.grants.grant(f.admin,f.first.id,{openId:f.principal.openId,role:'interviewer'});await f.db.query("UPDATE users SET status='disabled' WHERE id=$1",[g.user_id]);await assert.rejects(f.grants.grant(f.admin,f.second.id,{openId:f.principal.openId,role:'coordinator'}),/membership_disabled/);
 f.principal.tenant='other';await assert.rejects(f.grants.grant(f.admin,f.second.id,{openId:f.principal.openId,role:'coordinator'}),/identity_not_allowed/);
});

test('calendar reconciliation preserves explicit manual role, one access path and cross-source revocation',async t=>{
 const f=await fixture(t),p={openId:f.principal.openId,role:'interviewer' as const};
 const manual=await f.grants.grant(f.admin,f.first.id,p);
 await f.db.tx(c=>f.grants.syncCalendarParticipants(c,f.first.id,[{...p,role:'coordinator'}],'event-1'));
 const u=(await f.db.query('SELECT * FROM users WHERE id=$1',[manual.user_id])).rows[0],a={...u,csrf:''};
 assert.equal((await f.grants.mine(a)).length,1);assert.equal((await f.grants.mine(a))[0].role,'interviewer');
 assert.equal((await f.db.query('SELECT count(*)::int n FROM interview_access_grants')).rows[0].n,1);
 const count=Number((await f.db.query("SELECT count(*) n FROM audit_events WHERE kind='interview.access.grant'")).rows[0].n);
 await f.db.tx(c=>f.grants.syncCalendarParticipants(c,f.first.id,[{...p,role:'coordinator'}],'event-1'));
 assert.equal(Number((await f.db.query("SELECT count(*) n FROM audit_events WHERE kind='interview.access.grant'")).rows[0].n),count);
 await f.db.tx(c=>f.grants.syncCalendarParticipants(c,f.first.id,[],'event-1'));
 assert.equal((await f.grants.mine(a)).length,1,'a separate manual grant is not removed by an unrelated calendar roster');
 await f.grants.revoke(f.admin,manual.id);
 await f.db.tx(c=>f.grants.syncCalendarParticipants(c,f.first.id,[p],'event-1'));
 assert.equal((await f.grants.mine(a)).length,0);
 assert.equal((await f.db.query('SELECT count(*)::int n FROM interview_access_grants')).rows[0].n,1);
 await f.grants.grant(f.admin,f.first.id,{...p,role:'coordinator'});
 await f.db.tx(c=>f.grants.syncCalendarParticipants(c,f.first.id,[p],'event-1'));
 assert.equal((await f.grants.mine(a))[0].role,'coordinator','explicit administrator reauthorization restores exactly the requested role');
});

test('review: revoking any historic parallel grant vetoes all sources until explicit reauthorization',async t=>{
 const f=await fixture(t),p={openId:f.principal.openId,role:'interviewer' as const};
 const manual=await f.grants.grant(f.admin,f.first.id,p);
 const duplicate=(await f.db.query("INSERT INTO interview_access_grants(interview_id,user_id,role,source,source_key,expires_at,created_by) SELECT interview_id,user_id,'coordinator','calendar','legacy-event',expires_at,created_by FROM interview_access_grants WHERE id=$1 RETURNING *",[manual.id])).rows[0];
 const user=(await f.db.query('SELECT * FROM users WHERE id=$1',[manual.user_id])).rows[0],a={...user,csrf:''};
 const scoped=await f.identity.interviewActor(a,f.first.id);
 await f.grants.revoke(f.admin,duplicate.id);
 assert.equal((await f.db.query("SELECT count(*)::int n FROM interview_access_grants WHERE revoked_reason='admin_revoked'")).rows[0].n,2);
 await f.db.tx(c=>f.grants.syncCalendarParticipants(c,f.first.id,[p],'new-event'));
 assert.equal((await f.grants.mine(a)).length,0);await assert.rejects(f.identity.applicationAccess(scoped,f.application.id),/forbidden/);
 await f.grants.grant(f.admin,f.first.id,p);
 await f.db.tx(c=>f.grants.syncCalendarParticipants(c,f.first.id,[p],'new-event'));
 assert.equal((await f.db.query('SELECT count(*)::int n FROM active_interview_grants')).rows[0].n,1);
 assert.equal((await f.grants.mine(a))[0].role,'interviewer');
});

test('HTTP scoped flow: pre-login grant, materials, personal feedback, AI append and revoke block existing session',async t=>{
 const f=await fixture(t);const {buildApp}=await import('../src/http/app.js');
 const app=await buildApp({db:f.db,config:f.config,provider:f.provider});t.after(()=>app.close());
 const token=await f.identity.establish(f.principal),csrf=(await f.db.query('SELECT csrf FROM sessions WHERE token_hash=$1',[f.identity.hash(token)])).rows[0].csrf;
 const headers={host:new URL(f.config.origin).host,'x-forwarded-proto':'https',origin:f.config.origin,'x-csrf-token':csrf,cookie:'__Host-recruit_v4_session='+token};
 const grant=await f.grants.grant(f.admin,f.first.id,{openId:f.principal.openId,role:'interviewer'});
 const me=await app.inject({url:'/api/v4/auth/me',headers});assert.equal(me.statusCode,200,me.body);assert.equal(me.json().data.temporaryAccess,true);assert.deepEqual(me.json().data.roles,[]);assert.equal(me.json().data.status,'pending');
 assert.equal((await app.inject({url:'/api/v4/my-interviews',headers})).json().data.length,1);
 for(const url of ['/api/v4/members','/api/v4/jobs','/api/v4/candidates/'+f.application.candidate_id,'/api/v4/interviews/'+f.second.id+'/materials'])assert.equal((await app.inject({url,headers})).statusCode,403,url);
 const materials=await app.inject({url:'/api/v4/interviews/'+f.first.id+'/materials',headers});assert.equal(materials.statusCode,200,materials.body);assert.equal(materials.json().data.access.temporary,true);
 const definition=materials.json().data.evaluationDefinition;
 const body={version:0,status:'draft',forPrimary:false,definitionVersion:definition.ref.version,definitionRevision:definition.aclRevision,data:{summary:'仅本人反馈'}};
 const save=await app.inject({method:'PUT',url:'/api/v4/interviews/'+f.first.id+'/evaluation',headers:{...headers,'idempotency-key':'temp-feedback'},payload:body});assert.equal(save.statusCode,200,save.body);
 const other=await app.inject({method:'PUT',url:'/api/v4/interviews/'+f.first.id+'/evaluation',headers:{...headers,'idempotency-key':'temp-primary'},payload:{...body,forPrimary:true}});assert.equal(other.statusCode,403,other.body);
 const assistant=await app.inject({method:'POST',url:'/api/v4/interviews/'+f.first.id+'/assistant',headers,payload:{consent:true}});assert.equal(assistant.statusCode,200,assistant.body);
 const sessionId=assistant.json().data.id,url='/api/v4/interviews/'+f.first.id+'/assistant/'+sessionId;
 const segment={id:'one',sequence:1,source:'manual',speaker:'candidate',text:'合成测试证据',startMs:0,endMs:100};
 assert.equal((await app.inject({method:'POST',url:url+'/segments',headers,payload:segment})).statusCode,200);
 assert.equal((await app.inject({method:'POST',url:url+'/realtime',headers,payload:{offer:'synthetic',mode:'voice'}})).json().error.code,'temporary_realtime_relay_required');
 await f.grants.revoke(f.admin,grant.id);
 for(const request of [{method:'GET' as const,url},{method:'POST' as const,url:url+'/segments',payload:segment},{method:'PUT' as const,url:'/api/v4/interviews/'+f.first.id+'/evaluation',payload:body}])assert.equal((await app.inject({...request,headers:{...headers,'idempotency-key':'temp-feedback'}})).statusCode,403);
 assert.equal((await app.inject({url:'/api/v4/my-interviews',headers})).json().data.length,0);
});

test('grant table survives full backup and isolated restore',async t=>{
 const f=await fixture(t),g=await f.grants.grant(f.admin,f.first.id,{openId:f.principal.openId,role:'interviewer'});
 const {backup,restore}=await import('../src/operations/backup.js'),{FileStore}=await import('../src/files/storage.js'),{mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),path=await import('node:path');
 const root=await mkdtemp(path.join(tmpdir(),'grant-backup-'));t.after(()=>rm(root,{recursive:true,force:true}));const target=await testDatabase();t.after(target.cleanup);
 await backup(f.db,new FileStore(f.config.storageRoot),path.join(root,'archive'));await restore(target.db,new FileStore(path.join(root,'files')),path.join(root,'archive'));
 assert.equal((await target.db.query('SELECT role FROM interview_access_grants WHERE id=$1',[g.id])).rows[0].role,'interviewer');
});

test('provider enumerates paginated authorized scopes when root is denied, deduplicates and never revives inactive users',async t=>{
 const f=await testDatabase();t.after(f.cleanup);f.config.feishu={...f.config.feishu,appId:'app',tenant:'company'};
 const {FeishuProvider}=await import('../src/identity/provider.js');const urls:string[]=[];
 const active={is_activated:true,is_frozen:false,is_resigned:false,is_exited:false,is_unjoin:false},user=(open_id:string,status:any=active)=>({open_id,name:'同名员工',status});
 const provider=new FeishuProvider(f.config,async(url:any)=>{const u=new URL(String(url));urls.push(u.href);let result:any={code:0};
  if(u.pathname.endsWith('/auth/v3/tenant_access_token/internal'))result.tenant_access_token='synthetic-token';
  else if(u.pathname.includes('/departments/0/'))return new Response(JSON.stringify({code:40004,msg:'no department authority'}),{status:403});
  else if(u.pathname.endsWith('/contact/v3/scopes')){
   assert.equal(u.searchParams.get('user_id_type'),'open_id');assert.equal(u.searchParams.get('department_id_type'),'open_department_id');
   result.data=u.searchParams.has('page_token')?{department_ids:['od_1','od_2'],user_ids:['ou_direct','ou_conflict'],group_ids:[],has_more:false}:{department_ids:['od_1'],user_ids:['ou_direct'],group_ids:[],has_more:true,page_token:'next/scope'};
  }
  else if(u.pathname.endsWith('/departments/od_1/children'))result.data=u.searchParams.has('page_token')?{items:[{open_department_id:'od_2',name:'研发部',parent_department_id:'od_1'}],has_more:false}:{items:[{open_department_id:'od_child',name:'招聘组',parent_department_id:'od_1'}],has_more:true,page_token:'next/department'};
  else if(u.pathname.endsWith('/departments/od_2/children'))result.data={items:[],has_more:false};
  else if(u.pathname.endsWith('/users/find_by_department')){
   const department=u.searchParams.get('department_id');
   if(department==='od_1')result.data=u.searchParams.has('page_token')?{items:[user('ou_two')],has_more:false}:{items:[user('ou_one'),user('ou_conflict')],has_more:true,page_token:'next/user'};
   else if(department==='od_2')result.data={items:[user('ou_one'),user('ou_incomplete',{is_activated:true})],has_more:false};
   else if(department==='od_child')result.data={items:[user('ou_disabled',{...active,is_resigned:true}),user('ou_conflict',null)],has_more:false};
   else assert.fail('unscoped department queried');
  }
  else if(u.pathname.endsWith('/departments/od_1'))result.data={department:{open_department_id:'od_1',name:'技术中心',parent_department_id:'0'}};
  else if(u.pathname.endsWith('/users/ou_direct'))result.data={user:user('ou_direct')};
  else if(u.pathname.endsWith('/users/ou_conflict'))result.data={user:user('ou_conflict')};
  else assert.fail('unexpected directory request '+u.pathname);
  return new Response(JSON.stringify(result),{status:200,headers:{'content-type':'application/json'}});
 });
 const rows=await provider.directory();assert.deepEqual(rows.find(p=>p.openId==='ou_one')?.departments,['技术中心','技术中心 / 研发部']);assert.deepEqual(rows.find(p=>p.openId==='ou_direct')?.departments,[]);assert.equal(rows.length,6);assert.deepEqual(rows.filter(p=>p.active).map(p=>p.openId).sort(),['ou_direct','ou_one','ou_two']);assert.ok(rows.every(p=>p.tenant==='company'&&p.appId==='app'));
 assert.ok(urls.some(p=>p.includes('page_token=next%2Fscope')));assert.ok(urls.some(p=>p.includes('page_token=next%2Fuser')));assert.ok(urls.some(p=>p.includes('page_token=next%2Fdepartment')));assert.ok(!urls.some(p=>p.includes('/departments/0/')||p.includes('department_id=0')));
 assert.equal(urls.filter(p=>p.includes('/users/ou_direct?')).length,1);assert.equal(urls.filter(p=>p.includes('/find_by_department?')&&p.includes('department_id=od_2')).length,1);
});

test('provider rejects unsupported group scopes, malformed pagination and partial failures instead of returning a complete directory',async t=>{
 const f=await testDatabase();t.after(f.cleanup);const {FeishuProvider}=await import('../src/identity/provider.js');
 for(const scenario of ['groups','scope_cursor','department_cursor','user_cursor','direct_mismatch','partial_failure','invalid_scope'] as const){
  await t.test(scenario,async()=>{
   const provider=new FeishuProvider(f.config,async(url:any)=>{const u=new URL(String(url));let data:any;
    if(u.pathname.endsWith('/auth/v3/tenant_access_token/internal'))return Response.json({code:0,tenant_access_token:'synthetic-token'});
    if(u.pathname.endsWith('/scopes'))data=scenario==='groups'?{group_ids:['g_authorized'],department_ids:['od_allowed'],user_ids:[],has_more:false}:scenario==='scope_cursor'?{department_ids:[],user_ids:[],group_ids:[],has_more:true,page_token:'same'}:scenario==='invalid_scope'?{department_ids:'not an array',has_more:false}:{department_ids:scenario==='direct_mismatch'?[]:['od_allowed'],user_ids:scenario==='direct_mismatch'?['ou_expected']:[],group_ids:[],has_more:false};
    else if(u.pathname.includes('/children'))data=scenario==='department_cursor'?{items:[],has_more:true,page_token:'same'}:{items:[],has_more:false};
    else if(u.pathname.includes('/find_by_department')){
     if(scenario==='partial_failure'){if(u.searchParams.has('page_token'))return Response.json({code:40004},{status:403});return Response.json({code:0,data:{items:[{open_id:'ou_partial',name:'Partial',status:{}}],has_more:true,page_token:'next'}});}
     data={items:[],has_more:true,page_token:'same'};
    }else data={user:{open_id:'ou_wrong',name:'Wrong identity',status:{}}};
    return Response.json({code:0,data});
   });
   await assert.rejects(provider.directory(),scenario==='groups'?/directory_group_scope_unsupported/:scenario==='partial_failure'?/feishu_unavailable/:/invalid_identity_response/);
  });
 }
});

test('provider preserves directory request and identity limits and accepts a genuinely empty scope',async t=>{
 const f=await testDatabase();t.after(f.cleanup);const {FeishuProvider}=await import('../src/identity/provider.js');
 let requests=0;const endless=new FeishuProvider(f.config,async(url:any)=>String(url).includes('/auth/v3/')?Response.json({code:0,tenant_access_token:'synthetic-token'}):Response.json({code:0,data:{department_ids:[],user_ids:[],group_ids:[],has_more:true,page_token:String(++requests)}}));
 await assert.rejects(endless.directory(),/directory_response_limit/);assert.equal(requests,2000);
 const oversized=new FeishuProvider(f.config,async(url:any)=>String(url).includes('/auth/v3/')?Response.json({code:0,tenant_access_token:'synthetic-token'}):Response.json({code:0,data:{department_ids:[],user_ids:Array.from({length:100001},(_,i)=>'u'+i.toString(36)),group_ids:[],has_more:false}}));
 await assert.rejects(oversized.directory(),/directory_response_limit/);
 const empty=new FeishuProvider(f.config,async(url:any)=>{if(String(url).includes('/auth/v3/'))return Response.json({code:0,tenant_access_token:'synthetic-token'});assert.ok(String(url).includes('/contact/v3/scopes?'));return Response.json({code:0,data:{department_ids:[],user_ids:[],group_ids:[],has_more:false}});});assert.deepEqual(await empty.directory(),[]);
});

test('directory-inactive local identity and foreign tenant sessions remain blocked',async t=>{
 const f=await fixture(t),g=await f.grants.grant(f.admin,f.first.id,{openId:f.principal.openId,role:'interviewer'}),session=await f.identity.establish(f.principal);
 await f.db.query('UPDATE users SET directory_active=false WHERE id=$1',[g.user_id]);await assert.rejects(f.identity.establish(f.principal),/membership_disabled/);
 await assert.rejects(f.identity.authenticate({cookies:{'__Host-recruit_v4_session':session}} as any),/session_invalid/);
 await f.db.query("UPDATE users SET directory_active=true,tenant='foreign' WHERE id=$1",[g.user_id]);await assert.rejects(f.identity.authenticate({cookies:{'__Host-recruit_v4_session':session}} as any),/session_invalid/);
});

async function loginFor(f:Awaited<ReturnType<typeof fixture>>,openId=f.principal.openId){
 const {buildApp}=await import('../src/http/app.js');const app=await buildApp({db:f.db,config:f.config,provider:f.provider});
 const token=await f.identity.establish({...f.principal,openId}),csrf=(await f.db.query('SELECT csrf FROM sessions WHERE token_hash=$1',[f.identity.hash(token)])).rows[0].csrf;
 return {app,headers:{host:new URL(f.config.origin).host,'x-forwarded-proto':'https',origin:f.config.origin,'x-csrf-token':csrf,cookie:'__Host-recruit_v4_session='+token}};
}

test('review: coordinator scheduling returns only identity/version receipt, including replay after ACL tightening',async t=>{
 const f=await fixture(t);await f.grants.grant(f.admin,f.first.id,{openId:f.principal.openId,role:'coordinator'});
 await f.db.query('UPDATE interviews SET feedback=$2 WHERE id=$1',[f.first.id,'PRIVATE_FEEDBACK_SENTINEL']);
 const h=await loginFor(f);t.after(()=>h.app.close());
 const restrict=async(key:string)=>{const row=(await f.db.query("SELECT c.id,c.published_version,v.document FROM business_configs c JOIN business_config_versions v ON v.config_id=c.id AND v.version=c.published_version WHERE c.key='fields.interview'")).rows[0];const doc=row.document;doc.fields.find((v:any)=>v.coreKey===key).access.read=['admin'];await f.db.query('INSERT INTO business_config_versions(config_id,version,document) VALUES($1,$2,$3)',[row.id,row.published_version+1,doc]);await f.db.query('UPDATE business_configs SET published_version=published_version+1 WHERE id=$1',[row.id]);};
 await restrict('feedback');
 const materials=await h.app.inject({url:'/api/v4/interviews/'+f.first.id+'/materials',headers:h.headers});assert.equal(materials.statusCode,200,materials.body);assert.ok(!materials.body.includes('PRIVATE_FEEDBACK_SENTINEL'));
 const request={method:'PATCH' as const,url:'/api/v4/interviews/'+f.first.id+'/schedule',headers:{...h.headers,'idempotency-key':'private-schedule'},payload:{version:1,location:'LOCATION_NOW_HIDDEN'}};
 const first=await h.app.inject(request);assert.equal(first.statusCode,200,first.body);assert.deepEqual(first.json().data,{id:f.first.id,version:2});
 await restrict('location');const replay=await h.app.inject(request);assert.equal(replay.statusCode,200,replay.body);assert.deepEqual(replay.json().data,{id:f.first.id,version:2});
 const cache=JSON.stringify((await f.db.query("SELECT response FROM idempotency_keys WHERE key='private-schedule'")).rows);assert.ok(!cache.includes('PRIVATE_FEEDBACK_SENTINEL'));assert.ok(!cache.includes('LOCATION_NOW_HIDDEN'));
});

test('review: permanent interviewer retains application-level evaluation reads across rounds while assistant stays exact',async t=>{
 const f=await fixture(t),member=await actor(f.db,['interviewer']);await f.db.query('INSERT INTO interviewers(interview_id,user_id) VALUES($1,$2)',[f.first.id,member.id]);
 const h=await loginFor(f,member.open_id);t.after(()=>h.app.close());
 const {EvaluationUpgradeService}=await import('../src/business-config/evaluation-versions.js');await new EvaluationUpgradeService(f.identity).effective(member,f.second.id);
 for(const suffix of ['evaluation-template','evaluation']){const read=await h.app.inject({url:'/api/v4/interviews/'+f.second.id+'/'+suffix,headers:h.headers});assert.equal(read.statusCode,200,read.body);}
 assert.equal((await h.app.inject({url:'/api/v4/interviews/'+f.second.id+'/assistant',headers:h.headers})).statusCode,403);
 await f.db.query('DELETE FROM interviewers WHERE interview_id=$1 AND user_id=$2',[f.first.id,member.id]);
 assert.equal((await h.app.inject({url:'/api/v4/interviews/'+f.second.id+'/evaluation-template',headers:h.headers})).statusCode,403);
});

test('directory reads shared persistent cache, refreshes every ten minutes and retains complete snapshots on failure',async t=>{
 const f=await fixture(t);let now=Date.now(),calls=0;
 f.provider.directory=async()=>{calls++;return [{...f.principal,departments:['技术中心 / 研发部']}];};
 const directory=new Directory(f.identity,()=>now),query={query:'',page:1,pageSize:25};
 const cold=await directory.search(query);assert.equal(cold.cachedAt,null);assert.equal(calls,0,'opening never calls Feishu');
 await directory.refresh();const complete=await directory.search(query);assert.equal(complete.total,1);assert.deepEqual(complete.items[0].departments,['技术中心 / 研发部']);assert.equal((await directory.search({...query,query:'研发部'})).total,1);const decorated=await directory.decorate([{id:'local',open_id:f.principal.openId},{id:'missing',open_id:'unknown'}],p=>p.open_id);assert.deepEqual(decorated.map(p=>p.departments),[['技术中心 / 研发部'],[]]);
 const replica=new Directory(f.identity,()=>now);assert.deepEqual(await replica.search(query),complete,'restart and another API instance reuse persisted snapshot');
 await Promise.all([directory.refresh(),replica.refresh()]);assert.equal(calls,1);
 now+=599999;await replica.refresh();assert.equal(calls,1);
 now+=1;let release!:()=>void,started!:()=>void;const entered=new Promise<void>(r=>started=r);
 f.provider.directory=async()=>{calls++;started();await new Promise<void>(r=>release=r);throw Error('private failure');};
 const pending=directory.refresh();await entered;
 await replica.refresh();assert.equal(calls,2,'only one replica pulls Feishu');
 assert.deepEqual((await replica.search(query)).items,complete.items,'old list stays readable while pulling');
 release();await pending;assert.deepEqual((await directory.search(query)).items,complete.items);
 f.provider.directory=async()=>{calls++;return [{...f.principal,openId:'ou_new'}];};
 await replica.refresh();assert.equal((await new Directory(f.identity).search(query)).items[0].openId,'ou_new');
 const before=calls;await replica.search({query:'同名',page:2,pageSize:1});assert.equal(calls,before,'search and paging never call Feishu');
});

async function mixedPrimaryFixture(t:any){
 const f=await fixture(t),member=await actor(f.db,['interviewer']);
 await f.db.query('INSERT INTO interviewers(interview_id,user_id) VALUES($1,$2)',[f.first.id,member.id]);
 await f.db.query('UPDATE interviews SET primary_interviewer_id=$2 WHERE id=$1',[f.first.id,member.id]);
 const meeting=await f.interviews.create(f.admin,{applicationId:f.application.id,round:3,startsAt:'2030-01-01T09:00:00Z',durationMinutes:45,form:'online',interviewerIds:[member.id],primaryInterviewerId:member.id},new Set([member.id]));
 const grant=await f.grants.grant(f.admin,meeting.id,{openId:member.open_id,role:'interviewer'}),h=await loginFor(f,member.open_id);t.after(()=>h.app.close());
 const materials=await h.app.inject({url:'/api/v4/interviews/'+meeting.id+'/materials',headers:h.headers});assert.equal(materials.statusCode,200,materials.body);
 const def=materials.json().data.evaluationDefinition;
 const payload=(forPrimary:boolean,version=0)=>({version,status:'draft',forPrimary,definitionVersion:def.ref.version,definitionRevision:def.aclRevision,data:{summary:'个人意见'}});
 const request=(id:string,body:any,key:string)=>({method:'PUT' as const,url:'/api/v4/interviews/'+id+'/evaluation',headers:{...h.headers,'idempotency-key':key},payload:body});
 return {...f,member,meeting,grant,h,payload,request};
}
for(const loss of ['expire','revoke'] as const)test('mixed permanent/temporary primary: '+loss+' blocks writes, template adoption and successful receipt replays',async t=>{
 const f=await mixedPrimaryFixture(t),{h,meeting}=f,url='/api/v4/interviews/'+meeting.id;
 const primary=await h.app.inject(f.request(meeting.id,f.payload(true),'temp-primary'));assert.equal(primary.statusCode,403,primary.body);
 await assert.rejects(f.interviews.evaluate(f.member,meeting.id,{version:0,status:'draft',forPrimary:true,data:{summary:'blocked'}}),/forbidden/);
 const ownRequest=f.request(meeting.id,f.payload(false),'temp-personal'),own=await h.app.inject(ownRequest);assert.equal(own.statusCode,200,own.body);
 const {EvaluationUpgradeService}=await import('../src/business-config/evaluation-versions.js'),upgrades=new EvaluationUpgradeService(f.identity),target=(await upgrades.effective(f.member,meeting.id)).template.ref;
 const previewRequest=(forPrimary:boolean,key:string)=>({method:'POST' as const,url:url+'/evaluation-template/preview',headers:{...h.headers,'idempotency-key':key},payload:{target,forPrimary}});
 assert.equal((await h.app.inject(previewRequest(true,'temp-primary-preview'))).statusCode,403);
 await assert.rejects(upgrades.preview(f.member,meeting.id,target,true),/forbidden/);
 const personalPreview=previewRequest(false,'temp-personal-preview'),preview=await h.app.inject(personalPreview);assert.equal(preview.statusCode,200,preview.body);
 const p=preview.json().data,adoptRequest={method:'POST' as const,url:'/api/v4/business-config/evaluations/adopt',headers:{...h.headers,'idempotency-key':'temp-personal-adopt'},payload:{receipt:p.receipt,objectVersion:p.objectVersion}};
 const adopted=await h.app.inject(adoptRequest);assert.equal(adopted.statusCode,200,adopted.body);
 // A second unapplied receipt must also be invalid once authority is lost.
 const pending=await upgrades.preview(f.member,meeting.id,target,false);
 if(loss==='expire')await f.db.query("UPDATE interview_access_grants SET starts_at=now()-interval '2 seconds',expires_at=now()-interval '1 second' WHERE id=$1",[f.grant.id]);else await f.grants.revoke(f.admin,f.grant.id);
 for(const req of [f.request(meeting.id,f.payload(true,2),'lost-primary'),f.request(meeting.id,f.payload(false,2),'lost-personal'),ownRequest,personalPreview,adoptRequest,{...adoptRequest,headers:{...h.headers,'idempotency-key':'lost-new-adopt'},payload:{receipt:pending.receipt,objectVersion:pending.objectVersion}}]){const r=await h.app.inject(req);assert.equal(r.statusCode,403,r.body);}
 await assert.rejects(f.interviews.evaluate(f.member,meeting.id,{version:2,status:'draft',forPrimary:false,data:{summary:'blocked'}}),/forbidden/);
 await assert.rejects(upgrades.adopt(f.member,{receipt:pending.receipt,objectVersion:pending.objectVersion}),/forbidden/);
 await assert.rejects(upgrades.adopt(f.member,adoptRequest.payload),/forbidden/);
 assert.equal((await f.db.query('SELECT version FROM evaluations WHERE interview_id=$1 AND author_id=$2',[meeting.id,f.member.id])).rows[0].version,2);
 for(const suffix of ['evaluation','evaluation-template'])assert.equal((await h.app.inject({url:url+'/'+suffix,headers:h.headers})).statusCode,200,'legacy cross-round reads remain');
 assert.equal((await h.app.inject({url:url+'/materials',headers:h.headers})).statusCode,403);
});
test('permanent target primary and administrator retain evaluation and template writes',async t=>{
 const f=await mixedPrimaryFixture(t);
 for(const [member,id] of [[f.member,f.first.id],[f.admin,f.second.id]] as const){
 const h=member===f.member?f.h:await loginFor(f,member.open_id);if(h!==f.h)t.after(()=>h.app.close());
 const materials=await h.app.inject({url:'/api/v4/interviews/'+id+'/materials',headers:h.headers});assert.equal(materials.statusCode,200,materials.body);const def=materials.json().data.evaluationDefinition;
 const saved=await h.app.inject({...f.request(id,{...f.payload(true),definitionVersion:def.ref.version,definitionRevision:def.aclRevision},'permanent-primary-'+id),headers:{...h.headers,'idempotency-key':'permanent-primary-'+id}});assert.equal(saved.statusCode,200,saved.body);
 const target=saved.json().data.template.ref,preview=await h.app.inject({method:'POST',url:'/api/v4/interviews/'+id+'/evaluation-template/preview',headers:{...h.headers,'idempotency-key':'permanent-preview-'+id},payload:{target,forPrimary:true}});assert.equal(preview.statusCode,200,preview.body);
 const p=preview.json().data,adopt=await h.app.inject({method:'POST',url:'/api/v4/business-config/evaluations/adopt',headers:{...h.headers,'idempotency-key':'permanent-adopt-'+id},payload:{receipt:p.receipt,objectVersion:p.objectVersion}});assert.equal(adopt.statusCode,200,adopt.body);
 }
});

test('temporary-access navigation hints are lazy while capabilities and scoped access stay live',async t=>{
 const f=await fixture(t),grant=await f.grants.grant(f.admin,f.first.id,{openId:f.principal.openId,role:'interviewer'}),h=await loginFor(f);t.after(()=>h.app.close());
 const query=f.db.query.bind(f.db);let hintReads=0;f.db.query=(async(sql:string,values?:unknown[])=>{if(sql==='SELECT 1 FROM active_interview_grants WHERE user_id=$1 LIMIT 1')hintReads++;return query(sql,values);}) as typeof f.db.query;
 try{
 const me=await h.app.inject({url:'/api/v4/auth/me',headers:h.headers});assert.equal(me.statusCode,200,me.body);assert.equal(me.json().data.temporaryAccess,true);assert.deepEqual(me.json().data.roles,[]);assert.equal(hintReads,1);
 assert.equal((await h.app.inject({url:'/api/v4/interview-assistant/capabilities',headers:h.headers})).statusCode,200);assert.equal(hintReads,2);
 assert.equal((await h.app.inject({url:'/api/v4/interviews/'+f.first.id+'/materials',headers:h.headers})).statusCode,200);assert.equal(hintReads,2,'materials use live exact-interview authority without the global navigation hint');
 assert.equal((await h.app.inject({method:'POST',url:'/api/v4/leads/query',headers:h.headers,payload:{}})).statusCode,403);assert.equal(hintReads,2,'omitting the navigation hint never promotes a pending account');
 await f.grants.revoke(f.admin,grant.id);
 assert.equal((await h.app.inject({url:'/api/v4/interviews/'+f.first.id+'/materials',headers:h.headers})).statusCode,403);
 assert.equal((await h.app.inject({url:'/api/v4/auth/me',headers:h.headers})).json().data.temporaryAccess,false);
 assert.equal((await h.app.inject({url:'/api/v4/interview-assistant/capabilities',headers:h.headers})).statusCode,403);
 const admin=await loginFor(f,f.admin.open_id);t.after(()=>admin.app.close());const before=hintReads;
 const list=await admin.app.inject({method:'POST',url:'/api/v4/leads/query',headers:admin.headers,payload:{}});assert.equal(list.statusCode,200,list.body);assert.equal(hintReads,before,'ordinary lists do not query the unrelated temporary-access hint');
 }finally{f.db.query=query;}
});

test('department labels decorate members, grants, roster and interview primary without changing identifiers or eligibility',async t=>{
 const f=await fixture(t);
 f.provider.directory=async()=>[{...f.principal,departments:['人力资源部']},{...f.principal,openId:f.admin.open_id,name:f.admin.name,departments:['技术中心 / 研发部']}];
 await new Directory(f.identity).refresh();
 const meetings=await f.interviews.query(f.admin,{page:1,pageSize:25});
 assert.deepEqual(meetings.items[0].primary_interviewer_departments,['技术中心 / 研发部']);
 assert.equal(meetings.items[0].primary_interviewer_id,f.admin.id);assert.equal('primary_open_id' in meetings.items[0],false);
 const {DirectoryScheduling}=await import('../src/feishu-meetings/scheduling.js');
 assert.deepEqual((await new DirectoryScheduling(f.identity).roster(f.admin,f.first.id))[0].departments,['技术中心 / 研发部']);
 await f.grants.grant(f.admin,f.first.id,{openId:f.principal.openId,role:'interviewer'});
 assert.deepEqual((await f.grants.list(f.admin,f.first.id))[0].departments,['人力资源部']);
 const {httpSession}=await import('./helpers.js');const h=await httpSession(f.db,f.config);t.after(()=>h.app.close());
 const response=await h.app.inject({url:'/api/v4/assignment-members?role=interviewer',headers:h.headers});assert.equal(response.statusCode,200,response.body);
 const people=response.json().data.items;assert.deepEqual(people.find((p:any)=>p.id===f.admin.id).departments,['技术中心 / 研发部']);
 assert.ok(people.every((p:any)=>!p.open_id));assert.ok(!people.some((p:any)=>p.name===f.principal.name),'pending temporary member does not gain permanent assignability');
});
