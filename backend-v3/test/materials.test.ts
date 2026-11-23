import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { testDatabase, actor } from "./helpers.js";
import { Identity } from "../src/identity/service.js";
import { FeishuProvider } from "../src/identity/provider.js";
import { RecruitingService } from "../src/recruiting/service.js";
import { TaskService } from "../src/tasks/service.js";
import { Worker } from "../src/tasks/worker.js";
import { FileStore } from "../src/files/storage.js";
import { MaterialService } from "../src/materials/service.js";
test("rule questions cover gaps and briefs cite real immutable sources, edits retain versions and stale references remain explicit", async (t) => {
  const { db, config, cleanup } = await testDatabase();
  t.after(cleanup);
  const dir = await mkdtemp(path.join(os.tmpdir(), "v3-material-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const a = await actor(db),
    id = new Identity(db, config, new FeishuProvider(config)),
    store = new FileStore(dir),
    r = new RecruitingService(id),
    tasks = new TaskService(id, store),
    w = new Worker(id, store, "worker"),
    m = new MaterialService(id, store);
  const j = await r.createJob(a, {
      level: "P5",
      name: "专业工程师",
      requirements: {
        skills: ["Java", "Python"],
        experienceYears: 3,
        education: "bachelor",
      },
    }),
    u = await tasks.upload(a, {
      name: "a.txt",
      data: Buffer.from(
        "姓名：题单员\n本科，Python\n5年工作经验\n项目：以系统测试和服务监控保障可靠运行，结果需要人工核对。",
      ),
      jobId: j.id,
    });
  await w.once();
  const done = await tasks.get(a, u.id),
    appId = done.result.applicationId;
  const questions = await m.questions(a, appId);
  assert.equal(questions.provider, "rules");
  assert.ok(
    questions.data.questions.some(
      (q: any) => q.skill === "Java" && q.basis === "not_matched",
    ),
  );
  for (const q of questions.data.questions) {
    assert.ok(
      q.prompt && q.followups.length && q.referencePoints.length && q.source,
    );
  }
  const edited = await m.editQuestions(a, questions.id, {
    version: 1,
    questions: questions.data.questions.map((q: any, k: number) => ({
      ...q,
      prompt: k === 0 ? "人工修订问题" : q.prompt,
    })),
  });
  assert.equal(edited.version, 2);
  assert.equal(
    Number(
      (
        await db.query(
          "SELECT count(*) FROM material_versions WHERE kind='questions' AND material_id=$1",
          [questions.id],
        )
      ).rows[0].count,
    ),
    2,
  );
  const brief = await m.brief(a, appId);
  assert.ok(brief.data.nextSteps.length > 0);
  assert.ok(brief.data.risks.length > 0);
  assert.ok(brief.data.salaryConversation.length > 0);
  for (const item of [
    ...brief.data.nextSteps,
    ...brief.data.risks,
    ...brief.data.salaryConversation,
  ])
    assert.ok(item.text && item.citation.path);
  assert.ok(
    !JSON.stringify(brief.data.salaryConversation).includes("自动定薪"),
  );
  assert.equal(brief.human_conclusion, null);
  assert.ok(brief.data.facts.length > 0);
  for (const fact of brief.data.facts) {
    assert.ok(fact.citation.parseResultId);
    const original = await tasks.raw(a, done.result.resumeVersionId);
    assert.equal(
      original.raw.slice(fact.citation.start, fact.citation.end),
      fact.text,
    );
  }
  assert.ok(!JSON.stringify(brief.data).includes("建议淘汰"));
  await m.conclude(a, brief.id, {
    version: 1,
    conclusion: "人工结论：补充技术案例",
  });
  assert.equal((await r.application(a, appId)).status, "screening");
  await r.updateJob(a, j.id, {
    version: 1,
    requirements: { skills: ["Docker"] },
  });
  assert.equal((await m.get(a, "briefs", brief.id)).stale, true);
});
