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
test("PRD duplicate replace preserves one current terminal workflow across different upload jobs and adopts a new immutable resume only after explicit choice", async (t) => {
  const f = await testDatabase();
  t.after(f.cleanup);
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "duplicate-replacement-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const a = await actor(f.db),
    identity = new Identity(f.db, f.config, new FeishuProvider(f.config)),
    store = new FileStore(directory),
    r = new RecruitingService(identity),
    tasks = new TaskService(identity, store),
    worker = new Worker(identity, store, "replace-worker");
  const j1 = await r.createJob(a, {
      name: "Original synthetic job",
      level: "P5",
    }),
    j2 = await r.createJob(a, { name: "Target synthetic job", level: "P6" });
  const original = await tasks.upload(a, {
    jobId: j1.id,
    name: "first.txt",
    data: Buffer.from(
      "姓名：合成覆盖\n邮箱：replace@example.invalid\n本科\n技能：Python\n3年工作经验",
    ),
  });
  while (await worker.once()) {}
  const completed = await tasks.get(a, original.id);
  let app = await r.application(a, completed.result.applicationId);
  app = await r.transition(a, app.id, {
    version: app.version,
    to: "terminated",
    confirm: true,
    reason: "候选人意愿变化",
    opinion: "合成资料已由人工核对",
    termReason: "主动放弃",
  });
  const before = { ...app };
  const newer = await tasks.upload(a, {
    jobId: j2.id,
    name: "updated.txt",
    data: Buffer.from(
      "姓名：合成覆盖\n邮箱：replace@example.invalid\n硕士\n技能：Python / Java\n5年工作经验",
    ),
  });
  while (await worker.once()) {}
  const duplicate = await tasks.get(a, newer.id);
  assert.equal(duplicate.state, "awaiting_duplicate_decision");
  assert.equal(duplicate.comparison.incoming.profile.education, "master");
  assert.equal(
    duplicate.comparison.candidates[0].profile.education,
    "bachelor",
  );
  assert.equal(
    duplicate.comparison.candidates[0].applications[0].status,
    "terminated",
  );
  assert.equal(
    duplicate.comparison.candidates[0].applications[0].job_name,
    j1.name,
  );
  assert.equal(duplicate.comparison.incoming.file_name, "updated.txt");
  const result = await tasks.resolveDuplicate(a, newer.id, {
    choice: "replace",
    candidateId: app.candidate_id,
    candidateVersion: 1,
  });
  assert.equal(result.applicationId, app.id);
  assert.equal(result.transferRequired, true);
  assert.equal(result.requestedJobId, j2.id);
  assert.notEqual(result.resumeVersionId, app.resume_version_id);
  const after = await r.application(a, app.id);
  for (const key of [
    "status",
    "job_id",
    "source",
    "note",
    "term_reason",
    "term_detail",
    "collected_at",
    "is_current",
  ])
    assert.deepEqual(after[key], before[key], key);
  assert.equal(after.resume_version_id, result.resumeVersionId);
  const person = await r.candidate(a, app.candidate_id);
  assert.equal(person.profile.education, "master");
  assert.equal(person.resumes.length, 2);
  assert.equal(person.applications.length, 1);
  assert.equal(
    (await tasks.raw(a, completed.result.resumeVersionId)).profile.education,
    "bachelor",
  );
});
