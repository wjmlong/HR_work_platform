import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase, actor, httpSession } from "./helpers.js";
import { Identity } from "../src/identity/service.js";
import { RecruitingService } from "../src/recruiting/service.js";
import { FeishuProvider } from "../src/identity/provider.js";
import { DashboardService } from "../src/dashboard/service.js";
import {ccOptions} from '../src/recruiting/cc.js';
import {ChecklistService} from '../src/recruiting/checklists.js';

async function context(t: any) {
  const f = await testDatabase();
  t.after(f.cleanup);
  const a = await actor(f.db),
    r = new RecruitingService(
      new Identity(f.db, f.config, new FeishuProvider(f.config)),
    );
  const job = await r.createJob(a, {
    level: "P5",
    name: "Synthetic source role",
  });
  const target = await r.createJob(a, {
    level: "P5",
    name: "Synthetic destination role",
  });
  return { ...f, a, r, job, target };
}
const opinion = "人工核对岗位与流程后确认";
const completeGates={编制确认:true,薪资审批:true,背调完成:true,'offer 审批':true};
async function setOfferGates(f:any,id:string,gates:Record<string,unknown>=completeGates){await f.db.query('UPDATE applications SET configuration_refs=configuration_refs||$2::jsonb WHERE id=$1',[id,{toolkit:{offerGates:gates}}]);}

test('Offer entry keeps flow validation first and requires all four explicit approvals for form, drag and batch',async t=>{
 const f=await context(t),person=await f.r.createCandidate(f.a,{name:'Synthetic offer approvals'}),app=await f.r.apply(f.a,{candidateId:person.id,jobId:f.job.id});
 const command={version:app.version,to:'offered',confirm:true,reason:'核对审批后推进',opinion};
 await assert.rejects(f.r.transition(f.a,app.id,{version:app.version,to:'offered'}),/stage_confirmation/);
 for(const key of Object.keys(completeGates)){
  await setOfferGates(f,app.id,{...completeGates,[key]:false});
  await assert.rejects(f.r.transition(f.a,app.id,command),/offer_nodes_incomplete/);
 }
 await setOfferGates(f,app.id,{...completeGates,薪资审批:'true'});
 await assert.rejects(f.r.transition(f.a,app.id,{version:app.version,to:'offered',interaction:'drag'}),/offer_nodes_incomplete/);
 const batch=await f.r.batchTransition(f.a,{items:[{id:app.id,version:app.version}],to:'offered',confirm:true,reason:command.reason,opinion});assert.equal(batch.succeeded,0);assert.equal(batch.results[0].error,'offer_nodes_incomplete');
 assert.equal((await f.r.application(f.a,app.id)).version,app.version);assert.equal((await f.r.application(f.a,app.id)).status,'screening');
 await setOfferGates(f,app.id);assert.equal((await f.r.transition(f.a,app.id,command)).status,'offered');
});

test('transfer into Offer requires approvals even from hired and carries explicit approval provenance',async t=>{
 const f=await context(t),person=await f.r.createCandidate(f.a,{name:'Synthetic transferred approvals'}),app=await f.r.apply(f.a,{candidateId:person.id,jobId:f.job.id});
 const command={version:app.version,targetJobId:f.target.id,to:'offered',confirm:true,reason:'人工核对后转岗',opinion};
 await assert.rejects(f.r.transfer(f.a,app.id,command),/offer_nodes_incomplete/);
 assert.equal((await f.r.application(f.a,app.id)).is_current,true);assert.equal((await f.r.candidate(f.a,person.id)).applications.length,1);
 const hired=await f.r.transition(f.a,app.id,{version:app.version,to:'hired',confirm:true,reason:'历史入职事实人工确认',opinion});
 await assert.rejects(f.r.transfer(f.a,app.id,{...command,version:hired.version,to:undefined}),/offer_nodes_incomplete/);
 await setOfferGates(f,app.id);
 const moved=await f.r.transfer(f.a,app.id,{...command,version:hired.version,to:undefined});
 assert.equal(moved.status,'offered');assert.deepEqual(moved.configuration_refs.toolkit.offerGates,completeGates);
 assert.deepEqual(moved.configuration_refs.toolkit.offerGateInheritance,{applicationId:app.id,jobId:f.job.id,applicationVersion:hired.version});
 assert.equal((await f.r.application(f.a,app.id)).status,'hired');
});

test('new applications reject client-supplied advanced stages',async t=>{
 const f=await context(t),person=await f.r.createCandidate(f.a,{name:'Synthetic creation boundary'});
 for(const status of ['offered','hired'])await assert.rejects(f.r.apply(f.a,{candidateId:person.id,jobId:f.job.id,status}),/invalid_input/);
 assert.equal((await f.r.candidate(f.a,person.id)).applications.length,0);
});

test('interview entry uses the same real-name gate for direct transitions and explicit or carried transfers',async t=>{
 const f=await context(t),person=await f.r.createCandidate(f.a,{name:'张先生'}),app=await f.r.apply(f.a,{candidateId:person.id,jobId:f.job.id});
 const command={version:app.version,to:'interviewing',confirm:true,reason:'人工核对后安排面试',opinion};
 await assert.rejects(f.r.transition(f.a,app.id,command),/real_name_required/);
 await assert.rejects(f.r.transfer(f.a,app.id,{...command,targetJobId:f.target.id}),/real_name_required/);
 assert.equal((await f.r.application(f.a,app.id)).is_current,true);assert.equal((await f.r.candidate(f.a,person.id)).applications.length,1);
 // A pre-existing interview stage is not proof that its masked name was resolved.
 await f.db.query("UPDATE applications SET status='interviewing' WHERE id=$1",[app.id]);
 await assert.rejects(f.r.transfer(f.a,app.id,{...command,to:undefined,targetJobId:f.target.id}),/real_name_required/);
 await f.db.query("UPDATE applications SET status='screening' WHERE id=$1",[app.id]);
 await f.r.editCandidate(f.a,person.id,{version:person.version,profile:{name:'张先生',realName:'张合成'}});
 const interviewed=await f.r.transition(f.a,app.id,command);
 const moved=await f.r.transfer(f.a,app.id,{...command,version:interviewed.version,to:undefined,targetJobId:f.target.id});
 assert.equal(moved.status,'interviewing');
});

test('transfer keeps writer authorization, target CC validation and atomic source history',async t=>{
 const f=await context(t),person=await f.r.createCandidate(f.a,{name:'Synthetic transfer permissions'}),app=await f.r.apply(f.a,{candidateId:person.id,jobId:f.job.id}),viewer=await actor(f.db,['viewer']);
 await f.db.query('INSERT INTO application_grants(application_id,user_id) VALUES($1,$2)',[app.id,viewer.id]);
 const command={version:app.version,to:'collecting',confirm:true,reason:'人工核对后转岗',opinion};
 await assert.rejects(f.r.transition(viewer,app.id,command),/forbidden/);
 await assert.rejects(f.r.transfer(viewer,app.id,{...command,targetJobId:f.target.id}),/forbidden/);
 await assert.rejects(f.r.batchTransition(viewer,{items:[{id:app.id,version:app.version}],to:command.to,confirm:true,reason:command.reason,opinion}),/forbidden/);
 await assert.rejects(new ChecklistService(f.r.identity).open(viewer,app.id,{stage:'collecting',applicationVersion:app.version,confirm:true}),/forbidden/);
 const cc=await ccOptions(f.r.identity,f.a,app.id,'collecting',f.target.id),stale={...cc.template.ref,version:cc.template.ref.version+1};
 await assert.rejects(f.r.transfer(f.a,app.id,{...command,targetJobId:f.target.id,ccTemplateRef:stale}),/configuration_changed/);
 assert.equal((await f.r.application(f.a,app.id)).is_current,true);assert.equal((await f.r.application(f.a,app.id)).version,app.version);assert.equal((await f.r.candidate(f.a,person.id)).applications.length,1);
 const moved=await f.r.transfer(f.a,app.id,{...command,targetJobId:f.target.id,ccTemplateRef:cc.template.ref,ccMethod:'deferred'});
 const event=(await f.db.query('SELECT cc_snapshot FROM application_events WHERE application_id=$1',[moved.id])).rows[0];assert.equal(event.cc_snapshot.method,'deferred');assert.deepEqual(event.cc_snapshot.templateRef,cc.template.ref);
});

test("PRD one current workflow: racing applications and transfers never produce parallel current applications", async (t) => {
  const f = await context(t),
    p = await f.r.createCandidate(f.a, { name: "Synthetic current workflow" });
  const results = await Promise.allSettled([
    f.r.apply(f.a, { candidateId: p.id, jobId: f.job.id }),
    f.r.apply(f.a, { candidateId: p.id, jobId: f.target.id }),
  ]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  const app = (
    results.find((x) => x.status === "fulfilled") as PromiseFulfilledResult<any>
  ).value;
  const targetId = app.job_id === f.job.id ? f.target.id : f.job.id;
  await assert.rejects(
    f.r.transfer(f.a, app.id, {
      version: 1,
      targetJobId: targetId,
      confirm: true,
      reason: "岗位匹配调整",
      opinion: "短",
    }),
    /flow_opinion_required/,
  );
  const moves = await Promise.allSettled(
    [0, 1].map(() =>
      f.r.transfer(f.a, app.id, {
        version: 1,
        targetJobId: targetId,
        confirm: true,
        reason: "岗位匹配调整",
        opinion,
      }),
    ),
  );
  assert.equal(moves.filter((x) => x.status === "fulfilled").length, 1);
  const counts = (
    await f.db.query(
      "SELECT count(*)::int total,count(*) FILTER(WHERE is_current)::int current FROM applications WHERE candidate_id=$1",
      [p.id],
    )
  ).rows[0];
  assert.deepEqual(counts, { total: 2, current: 1 });
  assert.equal((await f.r.applications(f.a, {})).total, 1);
  const original = await f.r.application(f.a, app.id);
  assert.equal(original.is_current, false);
  await assert.rejects(
    f.r.transition(f.a, app.id, {
      version: original.version,
      to: "screened",
      interaction: "drag",
    }),
    /historical_application/,
  );
  let current = (await f.r.applications(f.a, {})).items[0];
  const preview = await f.r.transferPreview(f.a, current.id, {
    version: current.version,
    targetJobId: app.job_id,
  });
  assert.equal(preview.parallelApplication, false);
  assert.equal(preview.proposedStage, "screening");
  current = await f.r.collectionCompletion(f.a, current.id, {
    version: current.version,
    completed: true,
    confirm: true,
  });
  assert.ok(current.collected_at);
  await assert.rejects(
    f.r.collectionCompletion(f.a, current.id, {
      version: 1,
      completed: false,
      confirm: true,
    }),
    /version_conflict/,
  );
  await f.r.transfer(f.a, current.id, {
    version: current.version,
    targetJobId: app.job_id,
    confirm: true,
    reason: "返回原岗位",
    opinion,
  });
  await f.db.migrate(); // Restart must not recreate the obsolete per-job uniqueness rule.
  assert.equal((await f.r.applications(f.a, {})).total, 1);
  const { app: http, headers } = await httpSession(f.db, f.config);
  t.after(() => http.close());
  const head = (await f.r.applications(f.a, {})).items[0];
  assert.ok(head.collected_at); // A direct reassignment preserves the person's completed collection marker.
  const events = await http.inject({
    url: "/api/v4/applications/" + head.id + "/events",
    headers,
  });
  assert.equal(events.statusCode, 200, events.body);
  assert.equal(events.json().data.length, 3); // Original entry and both transfers stay in the current person's timeline.
});

test("PRD reassignment retains earlier collection flows in the same person timeline for the missing-material warning", async (t) => {
  const f = await context(t),
    p = await f.r.createCandidate(f.a, {
      name: "Synthetic collected before transfer",
    });
  let current = await f.r.apply(f.a, { candidateId: p.id, jobId: f.job.id });
  await setOfferGates(f,current.id);
  current = await f.r.transition(f.a, current.id, {
    version: 1,
    to: "collecting",
    reason: "人工推进",
    opinion,
    confirm: true,
  });
  current = await f.r.transition(f.a, current.id, {
    version: current.version,
    to: "offered",
    reason: "人工推进",
    opinion,
    confirm: true,
  });
  await f.r.transfer(f.a, current.id, {
    version: current.version,
    targetJobId: f.target.id,
    confirm: true,
    reason: "岗位匹配调整",
    opinion,
  });
  const dashboard = await new DashboardService(f.r.identity).query(f.a, {});
  assert.equal(dashboard.kpis.offered, 1);
  assert.ok(!dashboard.warnings.some((w) => w.code === "W1"));
});

test("PRD transitions: reasons, deferred CC, termination, reactivation and immutable history use the same gate", async (t) => {
  const f = await context(t),
    p = await f.r.createCandidate(f.a, { name: "Synthetic transition gates" });
  let app = await f.r.apply(f.a, { candidateId: p.id, jobId: f.job.id });
  await assert.rejects(
    f.r.transition(f.a, app.id, {
      version: 1,
      to: "screened",
      reason: "流程推进",
      opinion: "短",
    }),
    /flow_opinion_required/,
  );
  await assert.rejects(
    f.r.transition(f.a, app.id, {
      version: 1,
      to: "terminated",
      confirm: true,
      reason: "流程终止",
      opinion,
    }),
    /termination_required/,
  );
  await assert.rejects(
    f.r.transition(f.a, app.id, {
      version: 1,
      to: "rejected",
      interaction: "drag",
    }),
    /rejection_required/,
  );
  app = await f.r.transition(f.a, app.id, {
    version: 1,
    to: "collecting",
    interaction: "drag",
  });
  let event = (
    await f.db.query(
      "SELECT * FROM application_events WHERE application_id=$1 ORDER BY id DESC LIMIT 1",
      [app.id],
    )
  ).rows[0];
  assert.equal(event.cc, null); // A drag only reminds; it must not invent a CC record.
  app = await f.r.transition(f.a, app.id, {
    version: app.version,
    to: "background_check",
    reason: "资料已核对",
    opinion,
    ccMethod: "deferred",
  });
  event = (
    await f.db.query(
      "SELECT * FROM application_events WHERE application_id=$1 ORDER BY id DESC LIMIT 1",
      [app.id],
    )
  ).rows[0];
  assert.match(event.cc, /未实际抄送/);
  assert.deepEqual(event.cc_snapshot.to, ["用人部门", "人力（背调机构）"]);
  app = await f.r.transition(f.a, app.id, {
    version: app.version,
    to: "terminated",
    confirm: true,
    reason: "流程终止",
    opinion,
    termReason: "主动放弃",
  });
  assert.equal(app.term_reason, "主动放弃");
  const terminatedEvent = (
    await f.db.query(
      "SELECT * FROM application_events WHERE application_id=$1 AND to_state='terminated'",
      [app.id],
    )
  ).rows[0];
  const recruiter = await actor(f.db, ["recruiter"]);
  await assert.rejects(
    f.r.transition(f.a, app.id, {
      version: app.version,
      to: "screening",
      interaction: "drag",
    }),
    /reopen_confirmation/,
  );
  app = await f.r.transition(recruiter, app.id, {
    version: app.version,
    to: "screening",
    confirm: true,
    reason: "重新激活",
    opinion,
  });
  assert.equal(app.term_reason, null);
  assert.equal(app.reject_reason, null);
  assert.deepEqual(
    (
      await f.db.query("SELECT * FROM application_events WHERE id=$1", [
        terminatedEvent.id,
      ])
    ).rows[0],
    terminatedEvent,
  );
  assert.equal(
    (
      await f.db.query(
        "SELECT count(*)::int n FROM application_events WHERE application_id=$1",
        [app.id],
      )
    ).rows[0].n,
    5,
  );
});

test("PRD transfer carries all nine source stages, including hired to offered and both failures to screening", async (t) => {
  const f = await context(t),
    recruiter = await actor(f.db, ["recruiter"]);
  for (const [from, to] of [
    ["screening", "screening"],
    ["screened", "screened"],
    ["interviewing", "interviewing"],
    ["collecting", "collecting"],
    ["background_check", "background_check"],
    ["offered", "offered"],
    ["hired", "offered"],
    ["terminated", "screening"],
    ["rejected", "screening"],
  ]) {
    const p = await f.r.createCandidate(f.a, {
      name: "Synthetic carry " + from,
    });
    let app = await f.r.apply(f.a, { candidateId: p.id, jobId: f.job.id });
    if(from==='offered'||from==='hired')await setOfferGates(f,app.id);
    if (from !== "screening")
      app = await f.r.transition(f.a, app.id, {
        version: 1,
        to: from,
        confirm: true,
        reason: "人工确认",
        opinion,
        rejectReason: "岗位要求",
        rejectDetail: "人工核对后说明原因",
        termReason: "主动放弃",
      });
    const moved = await f.r.transfer(recruiter, app.id, {
      version: app.version,
      targetJobId: f.target.id,
      confirm: true,
      reason: "岗位匹配调整",
      opinion,
    });
    assert.equal(moved.status, to);
    assert.equal(moved.transfer_from_id, app.id);
    assert.equal((await f.r.candidate(f.a, p.id)).applications.length, 2);
  }
});

test("PRD dashboard hand fixture: 11 KPI, four warnings, explicit cumulative funnel and capped priorities", async (t) => {
  const f = await testDatabase();
  t.after(f.cleanup);
  const { app, headers, actor: a } = await httpSession(f.db, f.config);
  t.after(() => app.close());
  const job = (
    await f.db.query(
      "INSERT INTO jobs(name) VALUES('Synthetic ungraded') RETURNING id",
    )
  ).rows[0];
  for (const status of [
    "screening",
    "screened",
    "interviewing",
    "collecting",
    "background_check",
    "offered",
    "hired",
    "terminated",
    "rejected",
  ]) {
    const p = (
      await f.db.query(
        "INSERT INTO candidates(profile) VALUES($1) RETURNING id",
        [{ name: "Fixture " + status }],
      )
    ).rows[0];
    await f.db.query(
      "INSERT INTO applications(candidate_id,job_id,status) VALUES($1,$2,$3)",
      [p.id, job.id, status],
    );
  }
  await f.db.query(
    'INSERT INTO candidates(profile) VALUES(\'{"name":"Unassigned"}\')',
  );
  const application = (
    await f.db.query("SELECT id FROM applications WHERE status='interviewing'")
  ).rows[0];
  await f.db.query(
    "INSERT INTO application_events(application_id,actor_id,from_state,to_state,interaction,reason,opinion) VALUES($1,$2,'screened','interviewing','form','synthetic reason','synthetic opinion')",
    [application.id, a.id],
  );
  for (let i = 0; i < 6; i++)
    await f.db.query(
      "INSERT INTO interviews(application_id,round,starts_at,duration_minutes,form,created_by) VALUES($1,$2,now()-make_interval(days=>$2),30,'online',$3)",
      [application.id, i + 1, a.id],
    );
  const res = await app.inject({
    method: "POST",
    url: "/api/v4/dashboard/query",
    headers,
    payload: {},
  });
  assert.equal(res.statusCode, 200, res.body);
  const d = res.json().data;
  assert.equal(
    d.board.find((column: any) => column.stage === "interviewing").items[0]
      .flow_count,
    1,
  );
  assert.deepEqual(d.kpis, {
    candidates: 10,
    inProcess: 6,
    screening: 1,
    interviewing: 1,
    collectionAndBackground: 2,
    offered: 1,
    hired: 1, hiredOther: 0, onHold: 0, reserve: 0,
    terminated: 1,
    rejected: 1,
    offerConversion: 0.5,
    jobs: { open: 1, total: 1 },
  });
  assert.deepEqual(
    d.funnel.map((x: any) => x.count),
    [7, 6, 5, 4, 3, 2, 1],
  );
  assert.deepEqual(
    d.warnings.map((x: any) => [x.code, x.count]),
    [
      ["W1", 1],
      ["W2", 4],
      ["W3", 1],
      ["W4", 1],
    ],
  );
  assert.equal(d.todos.filter((x: any) => x.kind === "interview").length, 4);
  assert.equal(d.todos.length, 7);
  const filtered = await app.inject({
    method: "POST",
    url: "/api/v4/dashboard/query",
    headers,
    payload: { query: "not present" },
  });
  assert.equal(filtered.json().data.kpis.candidates, 0);
  assert.equal(filtered.json().data.kpis.offerConversion, null);
});
