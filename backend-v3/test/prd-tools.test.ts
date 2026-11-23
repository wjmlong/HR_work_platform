import { InterviewService } from "../src/interviews/service.js";
import { MaterialService } from "../src/materials/service.js";
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
import { Dictionary } from "../src/dictionary/service.js";
import { CandidateTools } from "../src/recruiting/tools.js";
import { encodeRaw } from "../src/parsing/profile.js";
async function context(t: any) {
  const f = await testDatabase();
  t.after(f.cleanup);
  const root = await mkdtemp(path.join(os.tmpdir(), "candidate-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = await actor(f.db),
    identity = new Identity(f.db, f.config, new FeishuProvider(f.config)),
    store = new FileStore(root),
    r = new RecruitingService(identity),
    tasks = new TaskService(identity, store),
    worker = new Worker(identity, store, "tools-worker"),
    tools = new CandidateTools(identity);
  await new Dictionary(f.db).seed();
  const job = await r.createJob(a, {
    name: "Synthetic tools job",
    level: "P5",
    requirements: { skills: ["Python"] },
  });
  const raw =
    "姓名：合成工具\n邮箱：tools@example.invalid\n学历：硕士\n学校：合成大学\n本科院校：合成理工学院\n技能：Python\n5年工作经验\n原文保留：\u0000\ud800";
  const people: any[] = [];
  for (let n = 0; n < 2; n++) {
    const task = await tasks.upload(a, {
      jobId: job.id,
      name: "synthetic.txt",
      data: encodeRaw(raw + "\n合成项目" + n),
      paste: true,
    });
    while (await worker.once()) {}
    let done = await tasks.get(a, task.id);
    if (done.state === "awaiting_duplicate_decision") {
      await tasks.resolveDuplicate(a, task.id, { choice: "keep_separate" });
      while (await worker.once()) {}
      done = await tasks.get(a, task.id);
    }
    assert.equal(done.state, "succeeded");
    people.push({
      ...done.result,
      application: await r.application(a, done.result.applicationId),
    });
  }
  return {
    ...f,
    a,
    identity,
    store,
    r,
    tasks,
    worker,
    tools,
    job,
    raw,
    people,
  };
}
test("PRD duplicate scan is advisory; stale merge preview refuses writes, confirmed merge preserves IDs, source profiles, resumes and every event", async (t) => {
  const f = await context(t),
    [left, right] = f.people;
  const scan = await f.tools.scan(f.a);
  assert.ok(
    scan.groups.some(
      (g: any) =>
        g.candidateIds.includes(left.candidateId) &&
        g.candidateIds.includes(right.candidateId),
    ),
  );
  const meeting = await new InterviewService(f.identity).create(f.a, {
    applicationId: left.applicationId,
    round: 1,
    startsAt: "2030-01-01T00:00:00Z",
    durationMinutes: 45,
    form: "online",
    interviewerIds: [f.a.id],
  });
  const evaluation = await new InterviewService(f.identity).evaluate(
    f.a,
    meeting.id,
    {
      version: 0,
      status: "submitted",
      data: {
        professional: 3.5,
        summary: "Synthetic immutable evaluation",
        conclusion: "hold",
      },
    },
  );
  const questions = await new MaterialService(f.identity, f.store).questions(
    f.a,
    left.applicationId,
  );
  const originalEvents = (
    await f.db.query("SELECT * FROM application_events ORDER BY id")
  ).rows;
  let preview = await f.tools.mergePreview(f.a, {
    sourceId: left.candidateId,
    targetId: right.candidateId,
    keepApplicationId: right.applicationId,
  });
  const source = await f.r.candidate(f.a, left.candidateId);
  await f.r.editCandidate(f.a, left.candidateId, {
    version: source.version,
    profile: { ...source.profile, summary: "concurrent human edit" },
  });
  await assert.rejects(
    f.tools.merge(f.a, {
      sourceId: left.candidateId,
      targetId: right.candidateId,
      keepApplicationId: right.applicationId,
      previewHash: preview.hash,
      confirm: true,
      backupAcknowledged: true,
    }),
    /merge_preview_stale/,
  );
  assert.equal(
    (
      await f.db.query(
        "SELECT count(*)::int n FROM candidates WHERE deleted_at IS NULL",
      )
    ).rows[0].n,
    2,
  );
  preview = await f.tools.mergePreview(f.a, {
    sourceId: left.candidateId,
    targetId: right.candidateId,
    keepApplicationId: right.applicationId,
  });
  await assert.rejects(
    f.tools.merge(f.a, {
      sourceId: left.candidateId,
      targetId: right.candidateId,
      keepApplicationId: right.applicationId,
      previewHash: preview.hash,
      confirm: true,
      backupAcknowledged: false,
    }),
    /merge_backup_acknowledgment/,
  );
  const result = await f.tools.merge(f.a, {
    sourceId: left.candidateId,
    targetId: right.candidateId,
    keepApplicationId: right.applicationId,
    previewHash: preview.hash,
    confirm: true,
    backupAcknowledged: true,
  });
  assert.equal(result.candidateId, right.candidateId);
  const person = await f.r.candidate(f.a, right.candidateId);
  assert.equal(person.resumes.length, 2);
  assert.equal(person.applications.length, 2);
  assert.equal(
    person.applications.filter((app: any) => app.is_current).length,
    1,
  );
  assert.equal(
    person.applications.find((app: any) => app.is_current).id,
    right.applicationId,
  );
  assert.ok(
    person.history.some(
      (h: any) =>
        h.candidate_id === left.candidateId &&
        h.profile.summary === "concurrent human edit",
    ),
  );
  assert.deepEqual(
    (await f.db.query("SELECT * FROM application_events ORDER BY id")).rows,
    originalEvents,
  );
  assert.equal(
    (
      await new InterviewService(f.identity).evaluationVersions(
        f.a,
        evaluation.id,
      )
    ).length,
    1,
  );
  assert.deepEqual(
    (
      await new MaterialService(f.identity, f.store).get(
        f.a,
        "questions",
        questions.id,
      )
    ).data,
    questions.data,
  );
  const archived = await f.r.application(f.a, left.applicationId);
  await assert.rejects(
    f.r.useResume(f.a, left.applicationId, {
      version: archived.version,
      resumeVersionId: right.resumeVersionId,
    }),
    /historical_application/,
  );
  assert.equal(
    (await f.tasks.raw(f.a, left.resumeVersionId)).raw,
    f.raw + "\n合成项目0",
  );
  const merged = (
    await f.db.query("SELECT * FROM candidates WHERE id=$1", [left.candidateId])
  ).rows[0];
  assert.equal(merged.merged_into_id, right.candidateId);
  await assert.rejects(
    f.r.removeCandidate(f.a, left.candidateId, {
      version: merged.version,
      restore: true,
      reason: "attempt undo",
    }),
    /candidate_merged/,
  );
});
test("PRD bulk reparse shows differences, skips concurrent versions and preserves workflow fields and byte-exact old raw", async (t) => {
  const f = await context(t),
    [left, right] = f.people;
  let app = await f.r.transition(f.a, left.applicationId, {
    version: 1,
    to: "offered",
    confirm: true,
    reason: "人工核对",
    opinion: "人工确认进入发出 offer 环节",
  });
  await f.db.query(
    "UPDATE candidates SET profile=jsonb_set(profile,'{school}','\"Legacy parsed school\"') WHERE id=$1",
    [left.candidateId],
  );
  const preview = await f.tools.reparsePreview(f.a);
  assert.equal(preview.total, 2);
  assert.ok(
    preview.items.find((i: any) => i.candidateId === left.candidateId).changes
      .school,
  );
  const other = await f.r.candidate(f.a, right.candidateId);
  await f.r.editCandidate(f.a, right.candidateId, {
    version: other.version,
    profile: { ...other.profile, summary: "new human version" },
  });
  const oldResume = app.resume_version_id;
  const result = await f.tools.reparseApply(f.a, {
    previewId: preview.id,
    hash: preview.hash,
    confirm: true,
  });
  assert.equal(result.updated, 1);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].candidateId, right.candidateId);
  const after = await f.r.application(f.a, app.id);
  for (const key of [
    "status",
    "job_id",
    "source",
    "note",
    "collected_at",
    "term_reason",
    "reject_reason",
    "is_current",
  ])
    assert.deepEqual(after[key], app[key], key);
  assert.notEqual(after.resume_version_id, oldResume);
  assert.equal(
    (await f.r.candidate(f.a, left.candidateId)).profile.school,
    "合成大学",
  );
  assert.equal(
    (await f.r.candidate(f.a, right.candidateId)).profile.summary,
    "new human version",
  );
  assert.equal((await f.tasks.raw(f.a, oldResume)).raw, f.raw + "\n合成项目0");
  assert.equal(
    (await f.tasks.raw(f.a, after.resume_version_id)).raw,
    f.raw + "\n合成项目0",
  );
});
test("PRD recruiting ledger preserves the original fifteen-column order, uses neutral facts and includes termination separately", async (t) => {
  const f = await context(t),
    p = f.people[0];
  await f.r.transition(f.a, p.applicationId, {
    version: 1,
    to: "terminated",
    confirm: true,
    reason: "候选人意愿变化",
    opinion: "人工记录终止流程原因",
    termReason: "主动放弃",
  });
  const csv = await f.tools.ledger(f.a, {});
  assert.ok(csv.startsWith("\ufeff"));
  const header = csv
    .split("\r\n")[0]
    .replace(/^\ufeff/, "")
    .split(",")
    .map((s: string) => s.replaceAll('"', ""));
  assert.deepEqual(header, [
    "序号",
    "岗位名称",
    "姓名",
    "性别",
    "年龄",
    "学历",
    "最高学历毕业院校",
    "本科毕业院校",
    "工作经历",
    "初次就业时间",
    "工作年限",
    "初筛",
    "面试",
    "offer",
    "入职",
  ]);
  assert.ok(csv.includes("录用终止：主动放弃"));
  assert.ok(!csv.includes("已入职"));
});

test("PRD talent library AND-filters professional facts, keeps English skill boundaries, sorts before paging and exports the same filtered set", async (t) => {
  const f = await context(t),
    [left, right] = f.people;
  for (const [person, education, skills, experienceYears] of [
    [left, "bachelor", ["JavaScript"], 0],
    [right, "master", ["Java"], 8],
  ] as const) {
    const p = await f.r.candidate(f.a, person.candidateId);
    await f.r.editCandidate(f.a, p.id, {
      version: p.version,
      profile: {
        ...p.profile,
        education,
        skills: [...skills],
        experienceYears,
      },
    });
  }
  await f.r.transition(f.a, right.applicationId, {
    version: 1,
    to: "screened",
    reason: "人工核对",
    opinion: "人工核对后推进到初筛通过",
  });
  const java = await f.r.applications(f.a, {
    skill: "Java",
    education: "master",
    flow: "transferred",
    sort: "exp",
  });
  assert.equal(java.total, 1);
  assert.equal(java.items[0].candidate_id, right.candidateId);
  assert.equal(java.items[0].flow_count, 1);
  assert.equal(
    (await f.r.applications(f.a, { skill: "Java", education: "bachelor" }))
      .total,
    0,
  );
  const untouched = await f.r.applications(f.a, { flow: "never" });
  assert.equal(untouched.total, 1);
  assert.equal(untouched.items[0].candidate_id, left.candidateId);
  await f.db.query(
    "UPDATE match_snapshots SET reference_score=reference_score||jsonb_build_object('value',CASE WHEN application_id=$1 THEN 90 ELSE 10 END,'lower',CASE WHEN application_id=$1 THEN 90 ELSE 10 END) WHERE application_id=ANY($2::uuid[])",
    [left.applicationId, [left.applicationId, right.applicationId]],
  );
  const ranked = await f.r.applications(f.a, { sort: "match", pageSize: 1 });
  assert.ok(ranked.items[0].match, "ranking fixture must preserve immutable matching input references");
  assert.equal(ranked.items[0].candidate_id, left.candidateId);
  const ledger = await f.tools.ledger(f.a, {
    skill: "Java",
    education: "master",
    flow: "transferred",
  });
  assert.equal(ledger.trim().split("\r\n").length, 2);
});
