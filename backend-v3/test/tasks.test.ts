import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { testDatabase, actor } from "./helpers.js";
import { Identity } from "../src/identity/service.js";
import { FeishuProvider } from "../src/identity/provider.js";
import { RecruitingService } from "../src/recruiting/service.js";
import { TaskService } from "../src/tasks/service.js";
import { Worker } from "../src/tasks/worker.js";
import { FileStore } from "../src/files/storage.js";
test("durable tasks ingest once, require duplicate decision, preserve versions, fence late workers and never auto advance", async (t) => {
  const { db, config, cleanup } = await testDatabase();
  t.after(cleanup);
  const dir = await mkdtemp(path.join(os.tmpdir(), "v3-task-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const a = await actor(db),
    id = new Identity(db, config, new FeishuProvider(config)),
    store = new FileStore(dir),
    s = new TaskService(id, store),
    w = new Worker(id, store, "worker-a"),
    r = new RecruitingService(id);
  const job = await r.createJob(a, {level:"P5",
      name: "开发",
      requirements: { skills: ["Python"] },
    }),
    raw =
      "姓名：合成员\n邮箱：test@example.invalid\n本科，Python\n5年工作经验\n项目：从事系统研发与服务稳定性建设工作。";
  const task = await s.upload(a, {
    name: "resume.txt",
    data: Buffer.from(raw),
    jobId: job.id,
  });
  assert.equal(task.state, "queued");
  assert.equal(await w.once(), true);
  const done = await s.get(a, task.id);
  assert.equal(done.state, "succeeded");
  const app = await r.application(a, done.result.applicationId);
  assert.equal(app.status, "screening");
  const match = await s.matches(a, app.id);
  assert.equal(match.stale, false);
  assert.equal(match.latest.data.skills[0].status, "matched");
  const dup = await s.upload(a, {
    name: "copy.txt",
    data: Buffer.from(raw),
    jobId: job.id,
  });
  await w.once();
  const decision = await s.get(a, dup.id);
  assert.equal(decision.state, "awaiting_duplicate_decision");
  assert.equal(decision.result.duplicates[0].confidence, "high");
  await s.resolveDuplicate(a, dup.id, {
    choice: "new_version",
    candidateId: app.candidate_id,
    candidateVersion: 1,
  });
  assert.equal(
    Number(
      (await db.query("SELECT count(*) FROM resume_versions")).rows[0].count,
    ),
    2,
  );
  assert.equal(
    (await r.application(a, app.id)).resume_version_id,
    app.resume_version_id,
  );
  while (await w.once()) {}
  const queued = await s.upload(a, {
    name: "x.txt",
    data: Buffer.from("姓名：接管员\nPython\n人工补充完整的专业项目经历"),
    jobId: job.id,
  });
  const claim = await w.claim();
  assert.equal(claim.id, queued.id);
  await db.query(
    "UPDATE tasks SET lease_until=now()-interval '1 second' WHERE id=$1",
    [claim.id],
  );
  const w2 = new Worker(id, store, "worker-b"),
    claim2 = await w2.claim();
  assert.equal(claim2.id, claim.id);
  await w2.process(claim2);
  assert.equal(await w.process(claim), false);
  assert.equal(
    Number(
      (
        await db.query(
          "SELECT count(*) FROM resume_versions WHERE origin_task_id=$1",
          [claim.id],
        )
      ).rows[0].count,
    ),
    1,
  );
  const cancel = await s.upload(a, {
      name: "cancel.txt",
      data: Buffer.from("姓名：取消员"),
      jobId: job.id,
    }),
    claimed = await w.claim();
  assert.equal(claimed.id, cancel.id);
  await s.cancel(a, cancel.id);
  assert.equal(await w.process(claimed), false);
  assert.equal((await s.get(a, cancel.id)).state, "cancelled");
  await r.updateJob(a, job.id, {
    version: 1,
    requirements: { skills: ["Java"] },
  });
  assert.equal((await s.matches(a, app.id)).stale, true);
  while (await w.once()) {}
  assert.equal((await s.matches(a, app.id)).stale, false);
  const empty = await s.upload(a, {
    name: "blank.txt",
    data: Buffer.from("  \n"),
    jobId: job.id,
  });
  await w.once();
  assert.equal((await s.get(a, empty.id)).state, "needs_text");
  const nul = "姓名：原文员\nPython，工作经验待确认\n\u0000\ud800";
  await s.supplyText(a, empty.id, { text: nul });
  await w.once();
  const supplied = await s.get(a, empty.id);
  assert.equal(supplied.state, "succeeded");
  assert.equal((await s.raw(a, supplied.result.resumeVersionId)).raw, nul);
  const separate = await s.upload(a, {
    name: "same.txt",
    data: Buffer.from(raw),
    jobId: job.id,
  });
  await w.once();
  const kept = await s.resolveDuplicate(a, separate.id, {
    choice: "keep_separate",
  });
  assert.notEqual(kept.candidateId, app.candidate_id);
  while (await w.once()) {}
  const skip = await s.upload(a, {
    name: "skip.txt",
    data: Buffer.from(raw),
    jobId: job.id,
  });
  await w.once();
  await s.resolveDuplicate(a, skip.id, { choice: "skip" });
  assert.equal((await s.get(a, skip.id)).state, "cancelled");
});
test("revoking the uploader while extraction is running prevents its final commit", async (t) => {
  const { db, config, cleanup } = await testDatabase();
  t.after(cleanup);
  const dir = await mkdtemp(path.join(os.tmpdir(), "v3-revoke-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const a = await actor(db),
    id = new Identity(db, config, new FeishuProvider(config)),
    store = new FileStore(dir),
    s = new TaskService(id, store),
    w = new Worker(id, store, "revoke-worker"),
    r = new RecruitingService(id),
    job = await r.createJob(a, {level:"P5", name: "撤权测试" });
  const task = await s.upload(a, {
      name: "a.txt",
      data: Buffer.from("姓名：撤权员\nPython 专业项目经历"),
      jobId: job.id,
    }),
    claim = await w.claim();
  let release!: () => void, start!: () => void;
  const started = new Promise<void>((resolve) => (start = resolve)),
    barrier = new Promise<void>((resolve) => (release = resolve)),
    read = store.read.bind(store);
  store.read = async (key) => {
    const bytes = await read(key);
    start();
    await barrier;
    return bytes;
  };
  const running = w.process(claim);
  await started;
  await db.query(
    "UPDATE users SET status='disabled',version=version+1 WHERE id=$1",
    [a.id],
  );
  release();
  await running;
  assert.equal(
    (await db.query("SELECT state FROM tasks WHERE id=$1", [task.id])).rows[0]
      .state,
    "failed",
  );
  assert.equal(
    (await db.query("SELECT count(*) FROM resume_versions")).rows[0].count,
    "0",
  );
});
