import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase, actor } from "./helpers.js";
import { Identity } from "../src/identity/service.js";
import { FeishuProvider } from "../src/identity/provider.js";
import { RecruitingService } from "../src/recruiting/service.js";
import { Commands } from "../src/http/commands.js";
test("one person has one current application, carryover preserves archived history and terminal reopen is explicit", async (t) => {
  const { db, config, cleanup } = await testDatabase();
  t.after(cleanup);
  const a = await actor(db),
    identity = new Identity(db, config, new FeishuProvider(config)),
    r = new RecruitingService(identity);
  const c = await r.createCandidate(a, { name: "合成人员", skills: ["Java"] }),
    job = await r.createJob(a, {level:"P5",
      name: "研发",
      requirements: {
        skills: ["Java"],
        experienceYears: 3,
        education: "bachelor",
      },
    });
  const app = await r.apply(a, {
    candidateId: c.id,
    jobId: job.id,
    source: "手动上传",
  });
  await assert.rejects(
    r.transition(a, app.id, { version: 1, to: "rejected" }),
    /rejection_required/,
  );
  await assert.rejects(
    r.transition(a, app.id, { version: 1, to: "offered" }),
    /stage_confirmation/,
  );
  const concurrent = await Promise.allSettled([
    r.transition(a, app.id, { version: 1, to: "screened",reason:'初筛完成',opinion:'人工核对完成后推进' }),
    r.transition(a, app.id, { version: 1, to: "screened",reason:'初筛完成',opinion:'人工核对完成后推进' }),
  ]);
  assert.equal(concurrent.filter((x) => x.status === "fulfilled").length, 1);
  const path = [
    ["screening", "screening"],
    ["screened", "screened"],
    ["interviewing", "interviewing"],
    ["offered", "offered"],
    ["hired", "offered"],
    ["rejected", "screening"],
  ];
  for (const [stage, want] of path) {
    const person = await r.createCandidate(a, { name: "阶段" + stage }),
      first = await r.apply(a, { candidateId: person.id, jobId: job.id });
    let current = first;
    if (stage !== "screening")
      current = await r.transition(a, first.id, {
        version: 1,
        to: stage,
        confirm: true,
        reason: "人工确认跨阶段",
        opinion: '人工核对完成后推进',
        rejectReason: "专业经验",
        rejectDetail: "人工评估后说明",
      });
    const target = await r.createJob(a, {level:"P5",
      name: "新岗位" + stage,
      requirements: {},
    });
    if (stage === "hired")
      await assert.rejects(
        r.transfer(a, current.id, {
          version: current.version,
          targetJobId: target.id,
          confirm: true,
        }),
        /internal_transfer_reason/,
      );
    const moved = await r.transfer(a, current.id, {
      version: current.version,
      targetJobId: target.id,
      confirm: true,
      reason: "内部转岗/新申请",
      opinion:'人工确认目标岗位与环节',
    });
    assert.equal(moved.status, want);
    assert.equal((await r.application(a, current.id)).status, stage);
    if (stage === "hired" || stage === "rejected") {
      const recruiter = await actor(db, ["recruiter"]);
      await assert.rejects(
        r.transition(recruiter, current.id, {
          version: current.version+1,
          to: "screening",
          confirm: true,
          reason: "重新开启",
          opinion:'人工核对后重新开启流程',
        }),
        /historical_application/,
      );
    }
  }
  const preview=await r.closeJobPreview(a,job.id,{version:1});
  const closed = await r.updateJob(a, job.id, { version: 1, open: false,closeConfirm:true,closePreviewHash:preview.hash });
  assert.equal(closed.open, false);
  assert.equal((await r.application(a, app.id)).job_id, job.id);
  await assert.rejects(
    r.apply(a, { candidateId: c.id, jobId: job.id }),
    /job_closed/,
  );
  const interviewer = await actor(db, ["interviewer"]);
  await assert.rejects(r.application(interviewer, app.id), /forbidden/);
  const i = (
    await db.query(
      "INSERT INTO interviews(application_id,round,starts_at,duration_minutes,form,created_by) VALUES($1,1,now(),30,'线上',$2) RETURNING id",
      [app.id, a.id],
    )
  ).rows[0];
  await db.query(
    "INSERT INTO interviewers(interview_id,user_id) VALUES($1,$2)",
    [i.id, interviewer.id],
  );
  assert.equal((await r.application(interviewer, app.id)).id, app.id);
  await assert.rejects(
    r.transition(interviewer, app.id, { version: 2, to: "interviewing" }),
    /forbidden/,
  );
});
test("idempotency is atomic across instances and conflicting payloads leave no partial writes", async (t) => {
  const { db, config, cleanup } = await testDatabase();
  t.after(cleanup);
  const a = await actor(db),
    commands = new Commands(db),
    r = new RecruitingService(
      new Identity(db, config, new FeishuProvider(config)),
    );
  const run = () =>
    commands.run(a, "one-request", { name: "唯一人员" }, () =>
      r.createCandidate(a, { name: "唯一人员" }),
    );
  const [x, y] = await Promise.all([run(), run()]);
  assert.equal(x.id, y.id);
  assert.equal(
    Number((await db.query("SELECT count(*) FROM candidates")).rows[0].count),
    1,
  );
  await assert.rejects(
    commands.run(a, "one-request", { name: "改内容" }, () =>
      r.createCandidate(a, { name: "改内容" }),
    ),
    /idempotency_conflict/,
  );
  await assert.rejects(
    commands.run(a, "rollback", { x: 1 }, async () => {
      await r.createCandidate(a, { name: "应回滚" });
      throw Error("abort");
    }),
    /abort/,
  );
  assert.equal(
    Number((await db.query("SELECT count(*) FROM candidates")).rows[0].count),
    1,
  );
});
