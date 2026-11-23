import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase, actor } from "./helpers.js";
import { Identity } from "../src/identity/service.js";
import { FeishuProvider } from "../src/identity/provider.js";
import { RecruitingService } from "../src/recruiting/service.js";
import { InterviewService } from "../src/interviews/service.js";
test("schedule needs explicit stage confirmation, detects overlap and restricts evaluation author with immutable revisions", async (t) => {
  const { db, config, cleanup } = await testDatabase();
  t.after(cleanup);
  const a = await actor(db),
    i = await actor(db, ["interviewer"]),
    other = await actor(db, ["interviewer"]),
    id = new Identity(db, config, new FeishuProvider(config)),
    r = new RecruitingService(id),
    s = new InterviewService(id);
  const job = await r.createJob(a, {level:"P5", name: "开发" }),
    c = await r.createCandidate(a, { name: "面试合成人员" }),
    application = await r.apply(a, { candidateId: c.id, jobId: job.id });
  const b = {
    applicationId: application.id,
    round: 1,
    startsAt: "2026-10-20T10:00:00+08:00",
    durationMinutes: 60,
    form: "线上",
    interviewerIds: [i.id],
  };
  const first = await s.create(a, b);
  assert.equal((await r.application(a, application.id)).status, "screening");
  assert.equal(first.overlaps.length, 0);
  const second = await s.create(a, {
    ...b,
    round: 2,
    startsAt: "2026-10-20T10:30:00+08:00",
    alsoAdvance: true,
    applicationVersion: 1,
    stageConfirmation: true,
  });
  assert.equal(second.overlaps.length, 1);
  assert.equal((await r.application(a, application.id)).status, "interviewing");
  await s.update(a, second.id, { version: 1, status: "cancelled" });
  assert.equal((await r.application(a, application.id)).status, "interviewing");
  const data = {
    professional: 4,
    problemSolving: 3,
    communication: 4,
    evidenceNotes: "人工核对项目经历与回答",
    conclusion: "hold",
    summary: "需补充案例",
  };
  await assert.rejects(
    s.evaluate(other, first.id, { version: 0, status: "submitted", data }),
    /forbidden/,
  );
  const draft = await s.evaluate(i, first.id, {
    version: 0,
    status: "draft",
    data,
  });
  assert.equal(draft.version, 1);
  const submitted = await s.evaluate(i, first.id, {
    version: 1,
    status: "submitted",
    data: { ...data, summary: "补充后人工判断" },
  });
  assert.equal(submitted.version, 2);
  await assert.rejects(
    s.evaluate(i, first.id, { version: 1, status: "submitted", data }),
    /version_conflict/,
  );
  assert.equal(
    Number(
      (
        await db.query(
          "SELECT count(*) FROM evaluation_versions WHERE evaluation_id=$1",
          [draft.id],
        )
      ).rows[0].count,
    ),
    2,
  );
  assert.equal((await s.list(i)).length, 1);
  assert.equal(
    (await s.evaluations(a, application.id))[0].data.conclusion,
    "hold",
  );
  assert.equal((await r.application(a, application.id)).status, "interviewing");
});
