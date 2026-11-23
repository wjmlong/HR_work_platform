import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {maintenanceResponse} from '../src/http/maintenance.js';
test('deployment phases require a consistent backup, reject older binaries and preserve new writes through forward recovery',()=>{const code="import json\nfrom runtime_plan import deployment_transition\nr=deployment_transition({},'prepare',11,14)\nr=deployment_transition(r,'maintenance',11,14)\ntry:\n deployment_transition(r,'upgrade',11,14)\n raise AssertionError('unbacked upgrade allowed')\nexcept ValueError as e:\n assert 'backup' in str(e)\nr['backup']={'directory':'synthetic-consistent-backup'}\nr=deployment_transition(r,'upgrade',11,14)\nr=deployment_transition(r,'activate',14,14)\nassert r['phase']=='active' and r['newWrites']\ntry:\n deployment_transition(r,'recover',14,11)\n raise AssertionError('older binary allowed')\nexcept ValueError as e:\n assert 'downgrade' in str(e)\ntry:\n deployment_transition(r,'recover',14,14)\n raise AssertionError('new writes discarded')\nexcept ValueError as e:\n assert 'incremental' in str(e)\nr['incrementalBackup']={'directory':'synthetic-new-increment'}\nr=deployment_transition(r,'recover',14,14)\nprint(json.dumps(r))";const r=spawnSync('python3',['-c',code],{cwd:'scripts',encoding:'utf8'});assert.equal(r.status,0,r.stderr);const receipt=JSON.parse(r.stdout);assert.equal(receipt.phase,'maintenance');assert.equal(receipt.recovery,'forward_compatible_only');});
test('maintenance gate serves503 for cached clients and never forwards a business mutation',()=>{for(const url of ['/','/api/v4/jobs','/api/v4/applications/id/transition','/health/ready']){const r=maintenanceResponse(url,true)!;assert.equal(r.status,503);assert.ok(r.body.includes('维护')||r.body.includes('maintenance'));}assert.equal(maintenanceResponse('/api/v4/jobs',false),null);});
test("V4 installer plan isolates all runtime paths, listeners, environment keys and dual workers from existing services", () => {
  const result = spawnSync(
    "python3",
    ["scripts/install-runtime.py", "--plan"],
    { encoding: "utf8", env: {...process.env, RECRUIT_V4_LOCAL_ORIGIN: "https://workbench.example.invalid:39613"} },
  );
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.version, "4.0.0");
  assert.ok(plan.runtime.endsWith("/RecruitWorkbenchV4"));
  assert.deepEqual(plan.apiPorts, [39611, 39612]);
  assert.equal(plan.origin, "https://workbench.example.invalid:39613");
  assert.equal(
    plan.agents.filter((x: any) => x.role.startsWith("worker-")).length,
    2,
  );
  assert.equal(plan.agents.length, 7);
  const sourcing = plan.agents.find((x: any) => x.role === 'sourcing-worker');
  assert.equal(sourcing.entry, 'sourcing-discovery/worker-main.js');
  assert.equal(sourcing.port, null);
  for (const role of ['api-a', 'api-b', 'sourcing-worker']) {
    assert.equal(plan.agents.find((x: any) => x.role === role).environment.SOURCING_DEEPSEEK_CONFIG_FILE, plan.runtime + '/private/sourcing-deepseek.json');
  }
  for (const item of plan.agents) {
    assert.ok(item.label.startsWith("com.hzpc.recruit.v4."));
    assert.ok(!JSON.stringify(item).includes("RECRUIT_V3_"));
    assert.ok(!JSON.stringify(item).includes("3951"));
  }
  assert.ok(plan.preservedEntries.includes(39413));
  assert.ok(plan.preservedEntries.includes(39513));
  assert.equal(plan.database.port, 55434);
});
test('interrupted upgrade recovery drains writers and requires a fresh compatible incremental backup',()=>{const code=`from runtime_plan import deployment_transition,backup_strategy
for phase in ['upgraded','maintenance']:
 r={'phase':phase,'writersStarted':True,'newWrites':True,'backup':{'directory':'before'}}
 try:
  deployment_transition(r,'recover',14,14)
  raise AssertionError('incremental backup omitted')
 except ValueError: pass
 r['incrementalBackup']={'directory':'after'}
 assert deployment_transition(r,'recover',14,14)['phase']=='maintenance'
assert backup_strategy(11,14,11)=='installed'
assert backup_strategy(14,14,11)=='candidate_runtime'
assert backup_strategy(12,14,11)=='candidate_runtime'
`;const r=spawnSync('python3',['-c',code],{cwd:'scripts',encoding:'utf8'});assert.equal(r.status,0,r.stderr);});
test('installer forward recovery preserves increments after readiness and post-SQL receipt failures',()=>{const r=spawnSync('python3',['test/runtime-interruption.py'],{encoding:'utf8'});assert.equal(r.status,0,r.stderr||r.stdout);assert.match(r.stdout,/interruption recovery passed/);});
