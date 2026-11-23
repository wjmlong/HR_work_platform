import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { testDatabase, httpSession } from "./helpers.js";
import { Identity } from "../src/identity/service.js";
import { Worker } from "../src/tasks/worker.js";
import { FileStore } from "../src/files/storage.js";
test("HTTP business loop persists uploads, application, interview, human evaluation, materials and editable profile history with request audit", async (t) => {
  const { db, config, cleanup } = await testDatabase();
  t.after(cleanup);
  config.storageRoot = await mkdtemp(path.join(os.tmpdir(), "v3-http-"));
  t.after(() => rm(config.storageRoot, { recursive: true, force: true }));
  const { app, headers, actor, provider } = await httpSession(db, config);
  t.after(() => app.close());
  let key = 0;
  const request = async (method: any, url: string, payload?: unknown) => {
    const kind=method==='POST'&&url==='/api/v4/interviews'?'interview':method==='PUT'&&url.endsWith('/evaluation')?'evaluation':method==='POST'&&url==='/api/v4/jobs'?'job':method==='PATCH'&&/^\/api\/v4\/candidates\/[^/]+$/.test(url)?'resume':null;
    if(kind){const def=(await app.inject({url:'/api/v4/business-config/effective/'+kind,headers})).json().data;payload={...(payload as object),definitionVersion:def.ref.version,definitionRevision:def.aclRevision};}
    const r = await app.inject({
      method,
      url,
      headers: { ...headers, "idempotency-key": "flow-" + ++key },
      payload,
    });
    assert.equal(r.statusCode, 200, url + ": " + r.body);
    return { data: r.json().data, requestId: r.json().meta.requestId };
  };
  const job = (
    await request("POST", "/api/v4/jobs", {level:"P5",
      name: "合成闭环岗位",
      requirements: {
        skills: ["Python", "Java"],
        experienceYears: 3,
        education: "bachelor",
      },
    })
  ).data;
  const task = (
    await request("POST", "/api/v4/uploads/text", {
      jobId: job.id,
      text: "姓名：闭环员\n本科，Python，5年工作经验\n完成过有测试、监控与复盘的系统项目，项目结果由人工核对。",
    })
  ).data;
  const worker = new Worker(
    new Identity(db, config, provider),
    new FileStore(config.storageRoot),
    "http-worker",
  );
  await worker.once();
  const done = (await request("GET", "/api/v4/tasks/" + task.id)).data;
  assert.equal(done.state, "succeeded");
  const application = (
    await request("GET", "/api/v4/applications/" + done.result.applicationId)
  ).data;
  assert.equal(application.status, "screening");
  const questions = (
    await request(
      "POST",
      "/api/v4/applications/" + application.id + "/questions",
      {},
    )
  ).data;
  assert.ok(questions.data.questions.some((q: any) => q.skill === "Java"));
  const screened = await request(
    "POST",
    "/api/v4/applications/" + application.id + "/transition",
    { version: 1, to: "screened",reason:'人工推进',opinion:'核对简历信息后进入初筛通过' },
  );
  const interview = (
    await request("POST", "/api/v4/interviews", {
      applicationId: application.id,
      round: 1,
      startsAt: "2026-10-25T10:00:00+08:00",
      durationMinutes: 45,
      form: "线上",
      interviewerIds: [actor.id],
      alsoAdvance: true,
      applicationVersion: screened.data.version,
      stageConfirmation:true,
    })
  ).data;
  await request("PUT", "/api/v4/interviews/" + interview.id + "/evaluation", {
    version: 0,
    status: "submitted",
    data: {
      professional: 4,
      problemSolving: 4,
      communication: 3,
      evidenceNotes: "人工检查了项目案例",
      conclusion: "yes",
      summary: "人工评估结论，下一步由负责人确认",
    },
  });
  const brief = (
    await request(
      "POST",
      "/api/v4/applications/" + application.id + "/briefs",
      {},
    )
  ).data;
  assert.equal(brief.human_conclusion, null);
  assert.equal(brief.data.evaluations.length, 1);
  await request("POST", "/api/v4/briefs/" + brief.id + "/conclusion", {
    version: 1,
    conclusion: "负责人已核对，继续人工沟通",
  });
  const person = (
    await request("GET", "/api/v4/candidates/" + application.candidate_id)
  ).data;
  assert.equal(person.resumes.length, 1);
  await request("PATCH", "/api/v4/candidates/" + person.id, {
    version: person.version,
    profile: { ...person.profile, name: "人工修订姓名" },
  });
  const edited = (await request("GET", "/api/v4/candidates/" + person.id)).data;
  assert.equal(edited.history.length, 2);
  assert.equal(edited.history[0].profile.name, "闭环员");
  const materials = (
    await request(
      "GET",
      "/api/v4/applications/" + application.id + "/materials",
    )
  ).data;
  assert.equal(materials.questions.length, 1);
  assert.equal(materials.briefs.length, 1);
  const audit = (
    await db.query(
      "SELECT request_id FROM audit_events WHERE kind='application.transition' AND entity_id=$1 ORDER BY id",
      [application.id],
    )
  ).rows;
  assert.equal(audit[0].request_id, screened.requestId);
  const file = await app.inject({
    url: "/api/v4/resumes/" + done.result.resumeVersionId + "/file",
    headers,
  });
  assert.equal(file.statusCode, 200);
  assert.ok(file.headers["content-disposition"]?.startsWith("attachment"));
  assert.equal(
    (await request("GET", "/api/v4/applications/" + application.id)).data
      .status,
    "interviewing",
  );
});
