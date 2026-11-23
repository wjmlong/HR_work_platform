import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read=(path:string)=>readFileSync(new URL(path,import.meta.url),'utf8');

test('the board only honours one forward step for a screening grant',()=>{
  const source=read('../src/features/People.tsx');
  assert.match(source,/const canScreen = !canWrite && !!user\.screeningScope\?\.length/);
  assert.match(source,/a\.status === "screening" && to === "screened"/);
  assert.match(source,/临时权限只能把「待筛选」推进到「初筛通过」/);
  assert.match(source,/draggable=\{canWrite \|\| \(canScreen && a\.status === "screening"\)\}/);
  assert.match(source,/interaction: "drag"/);
});

test('the screening callout names the expiry instead of promising permanent access',()=>{
  const source=read('../src/features/People.tsx');
  assert.match(source,/user\.screeningUntil \? " · 至 " \+ date\(user\.screeningUntil\)/);
  assert.match(source,/完成后由 HR 继续安排面试/);
});

test('admins open screening grants from the board header and the dialog fixes the term at 14 days',()=>{
  const dashboard=read('../src/features/Dashboard.tsx'),dialog=read('../src/features/ScreeningAccess.tsx');
  assert.match(dashboard,/isAdmin && <button className="small" onClick=\{\(\) => setScreening\(true\)\}>临时权限<\/button>/);
  assert.match(dashboard,/<ScreeningAccess jobs=\{jobs\} initialJob=\{job \|\| undefined\}/);
  assert.match(dialog,/const DAYS=14;/);
  assert.doesNotMatch(dialog,/有效期（天）/);
  assert.doesNotMatch(dialog,/inputMode="numeric"/);
  assert.match(dialog,/api\('\/job-screening-grants',\{method:'POST',body:\{jobId:job,openId:member\.openId\}\}\)/);
  assert.match(dialog,/method:'DELETE'/);
  assert.match(dialog,/电话、邮箱显示为 \*\*\*/);
});

test('the server keeps granting admin-only and the one-step rule on the write path',()=>{
  const admin=read('../../backend-v3/src/admin/routes.ts');
  const service=read('../../backend-v3/src/recruiting/service.ts');
  const grants=admin.slice(admin.indexOf('job-screening-grants'));
  assert.match(grants,/requireRole\(req\.actor, "admin"\)/);
  assert.match(grants,/job_screening\.grant/);
  assert.match(grants,/job_screening\.revoke/);
  assert.match(grants,/14 \* 86400000/);
  assert.match(service,/b\.to !== "screened" \|\| b\.interaction !== "drag"/);
  assert.match(service,/active_job_screening_grants g WHERE g\.job_id=a\.job_id AND g\.user_id=\$2/);
});

test('screening grants are scoped in the list queries rather than filtered in the browser',()=>{
  const query=read('../../backend-v3/src/recruiting/query.ts');
  const jobs=read('../../backend-v3/src/recruiting/jobs.ts');
  assert.match(query,/EXISTS\(SELECT 1 FROM active_job_screening_grants sg WHERE sg\.job_id=a\.job_id AND sg\.user_id=\$5\)/);
  assert.match(jobs,/EXISTS\(SELECT 1 FROM active_job_screening_grants sg WHERE sg\.job_id=j\.id AND sg\.user_id=\$2\)/);
});
