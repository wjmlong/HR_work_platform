import test from 'node:test';
import assert from 'node:assert/strict';
import {testDatabase,httpSession} from './helpers.js';
test('V4 isolates browser sessions and rejects obsolete business clients before writes',async t=>{
 const {db,config,cleanup}=await testDatabase();t.after(cleanup);
 const {app,headers}=await httpSession(db,config);t.after(()=>app.close());
 const publicHeaders={host:headers.host,'x-forwarded-proto':'https'};
 const start=await app.inject({url:'/api/v4/auth/feishu/start',headers:publicHeaders});
 assert.equal(start.statusCode,302);assert.match(String(start.headers['set-cookie']),/__Host-recruit_v4_oauth=/);assert.doesNotMatch(String(start.headers['set-cookie']),/recruit_v3/);
 const obsolete=await app.inject({method:'POST',url:'/api/v3/jobs',headers,payload:{name:'obsolete'}});
 assert.equal(obsolete.statusCode,426);assert.equal(obsolete.json().error.code,'client_update_required');
 const oldCookie=await app.inject({url:'/api/v4/auth/me',headers:{...headers,cookie:headers.cookie.replace('recruit_v4','recruit_v3')}});
 assert.equal(oldCookie.statusCode,401);
 for(const callback of ['/api/v3/auth/feishu/callback','/api/auth/feishu/callback']){
  const response=await app.inject({url:callback+'?state=invalid-state&code=invalid',headers:publicHeaders});
  assert.equal(response.statusCode,401);assert.equal(response.json().error.code,'oauth_state_invalid');
 }
});
