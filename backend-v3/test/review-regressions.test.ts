import {BindingService} from '../src/business-config/bindings.js';
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { testDatabase, actor, httpSession } from "./helpers.js";
import { Identity } from "../src/identity/service.js";
import { FeishuProvider } from "../src/identity/provider.js";
import { RecruitingService } from "../src/recruiting/service.js";
import { TaskService } from "../src/tasks/service.js";
import { Worker } from "../src/tasks/worker.js";
import { FileStore } from "../src/files/storage.js";
import { MaterialService } from "../src/materials/service.js";
import { InterviewService } from "../src/interviews/service.js";
import { SourcingService, overdue } from "../src/sourcing/service.js";
import { StatisticsService } from "../src/statistics/service.js";
import { Dictionary } from "../src/dictionary/service.js";
import { backup, restore } from "../src/operations/backup.js";
import { migrateLegacy } from "../src/operations/migration.js";
import { decodeRaw } from "../src/parsing/profile.js";
import { decodeJSON } from "../src/parsing/json.js";
async function context(t: any) {
  const x = await testDatabase();
  t.after(x.cleanup);
  const dir = await mkdtemp(path.join(os.tmpdir(), "v3-review-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const a = await actor(x.db),
    id = new Identity(x.db, x.config, new FeishuProvider(x.config)),
    store = new FileStore(dir);
  await new Dictionary(x.db).seed();
  return {
    ...x,
    a,
    id,
    store,
    r: new RecruitingService(id),
    tasks: new TaskService(id, store),
    w: new Worker(id, store, "review"),
    m: new MaterialService(id, store),
  };
}
async function ingest(x: any, skills = ["Python"]) {
  const j = await x.r.createJob(x.a, {level:"P5",
    name: "回归岗位",
    requirements: { skills, education: "bachelor", experienceYears: 3 },
  });
  const u = await x.tasks.upload(x.a, {
    name: "a.txt",
    data: Buffer.from(
      "姓名：回归人员\n邮箱：regression@example.invalid\nPython\n专业：系统工程\n项目：用可重复试验验证业务需求与可靠性。",
    ),
    jobId: j.id,
  });
  await x.w.once();
  const done = await x.tasks.get(x.a, u.id);
  assert.equal(done.state, "succeeded");
  return { j, ...done.result };
}
async function waitLock(db: any, schema: string, minimum = 1) {
  for (let n = 0; n < 150; n++) {
    const r = await db.query(
      "SELECT count(*) n FROM pg_locks l LEFT JOIN pg_class c ON c.oid=l.relation LEFT JOIN pg_namespace s ON s.oid=c.relnamespace WHERE NOT l.granted AND (s.nspname=$1 OR (l.locktype='advisory' AND l.pid IN (SELECT pid FROM pg_stat_activity WHERE query LIKE '%pg_advisory_xact_lock%')))",
      [schema],
    );
    if (Number(r.rows[0].n) >= minimum) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("competing transaction did not reach lock barrier");
}
test("review: restore preserves ordinary writes committed while restore waits for table locks", async (t) => {
  const s = await context(t),
    d = await testDatabase();
  t.after(d.cleanup);
  const dir = path.join(s.store.root, "backup");
  await backup(s.db, s.store, dir);
  const blocker = await d.db.pool.connect();
  await blocker.query("BEGIN");
  await blocker.query("LOCK TABLE users IN SHARE MODE");
  const result = restore(
    d.db,
    new FileStore(path.join(s.store.root, "target")),
    dir,
  ).then(
    () => null,
    (e) => e,
  );
  try {
    await waitLock(d.db, d.config.schema);
    await d.db.query(
      'INSERT INTO candidates(profile) VALUES(\'{"name":"concurrent"}\')',
    );
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
  const error = await result;
  assert.match(String(error), /restore_target_not_empty/);
  assert.equal(
    (await d.db.query("SELECT count(*) FROM candidates")).rows[0].count,
    "1",
  );
});
test("review: switching A to B and back reuses the exact current snapshot and permits materials", async (t) => {
  const x = await context(t),
    a = await ingest(x);
  const u = await x.tasks.upload(x.a, {
    name: "b.txt",
    data: Buffer.from(
      "姓名：回归人员\n邮箱：regression@example.invalid\n本科 Python\n5年工作经验\n补充项目：验证服务一致性。",
    ),
    jobId: a.j.id,
  });
  await x.w.once();
  const b = await x.tasks.resolveDuplicate(x.a, u.id, {
    choice: "new_version",
    candidateId: a.candidateId,
    candidateVersion: 1,
  });
  while (await x.w.once()) {}
  let app = await x.r.useResume(x.a, a.applicationId, {
    version: 1,
    resumeVersionId: b.resumeVersionId,
  });
  while (await x.w.once()) {}
  app = await x.r.useResume(x.a, a.applicationId, {
    version: app.version,
    resumeVersionId: a.resumeVersionId,
  });
  while (await x.w.once()) {}
  const match = await x.tasks.matches(x.a, app.id);
  assert.equal(match.stale, false);
  assert.equal(match.latest.resume_version_id, a.resumeVersionId);
  assert.equal((await x.m.questions(x.a, app.id)).provider, "rules");
});
test("review: resume-scoped human corrections create an immutable version and require explicit adoption", async (t) => {
  const x = await context(t),
    a = await ingest(x),
    old = await x.tasks.raw(x.a, a.resumeVersionId);
  const corrected = await (x.tasks as any).correctResume(
    x.a,
    a.resumeVersionId,
    {
      baseParseResultId: old.parseResultId,
      reason: "已核对原始证明",
      corrections: { education: "master", experienceYears: 5 },
    },
  );
  assert.notEqual(corrected.resumeVersionId, a.resumeVersionId);
  assert.equal(
    (await x.r.application(x.a, a.applicationId)).resume_version_id,
    a.resumeVersionId,
  );
  await x.r.useResume(x.a, a.applicationId, {
    version: 1,
    resumeVersionId: corrected.resumeVersionId,
  });
  while (await x.w.once()) {}
  const match = await x.tasks.matches(x.a, a.applicationId);
  assert.equal(match.latest.data.education.actual, "master");
  assert.equal(match.latest.data.education.evidence.length, 0);
  assert.equal(match.latest.data.education.assertions[0].actorId, x.a.id);
  assert.equal(
    (await x.tasks.raw(x.a, corrected.resumeVersionId)).raw,
    old.raw,
  );
  assert.equal(
    (await x.tasks.raw(x.a, a.resumeVersionId)).profile.education,
    null,
  );
  assert.equal(
    (await x.m.brief(x.a, a.applicationId)).data.humanAssertions.length,
    2,
  );
});
test("review: migration roundtrips NUL and lone surrogate inside evidence and validates prepared records on dry run", async (t) => {
  const x = await context(t),
    raw = "姓名：证据\ud800员\n专业：计算机\u0000工程\nPython";
  const bundle = {
    revision: 1,
    data: {
      jobs: [{ id: "j", name: "岗位" }],
      talents: [{ id: "t", name: "合成人", jobId: "j", status: "已入职", raw }],
      interviews: [],
    },
  };
  assert.equal(
    (await migrateLegacy(x.db, x.store, x.a, bundle, true)).ready,
    true,
  );
  await migrateLegacy(x.db, x.store, x.a, bundle, false);
  const p = (await x.db.query("SELECT * FROM parse_results")).rows[0];
  assert.equal(decodeRaw(p.raw_bytes), raw);
  assert.ok(decodeJSON(p.evidence).some((e: any) => e.text.includes("\u0000")));
  const bad = structuredClone(bundle);
  bad.data.jobs[0] = { ...bad.data.jobs[0], years: 900 } as any;
  assert.equal(
    (await migrateLegacy(x.db, x.store, x.a, bad, true)).ready,
    false,
  );
});
test("review: contacted requires an actual contact and repeated contacts refresh only the real contact clock", async (t) => {
  const x = await context(t),
    s = new SourcingService(x.id),
    lead = await s.create(x.a, {
      name: "合成",
      org: "单位",
      direction: "工程",
      source: "其他",
      line: "high",
    } as any);
  await assert.rejects(
    s.transition(x.a, lead.id, { version: 1, state: "contacted" }),
    /contact_time_required/,
  );
  const at = new Date(Date.now() - 15 * 86400000).toISOString();
  let r = await s.transition(x.a, lead.id, {
    version: 1,
    state: "contacted",
    occurredAt: at,
    reason: "实际联系",
  });
  assert.equal(overdue(r), true);
  r = await s.transition(x.a, lead.id, {
    version: r.version,
    state: "contacted",
    occurredAt: new Date().toISOString(),
    reason: "再次联系",
  });
  assert.equal(overdue(r), false);
  assert.equal(
    (await x.db.query("SELECT count(*) FROM lead_followups")).rows[0].count,
    "2",
  );
});
test("review: non-admin assignment directory and granted application discovery expose only allowed records", async (t) => {
  const x = await context(t),
    {
      app,
      headers,
      actor: manager,
    } = await httpSession(x.db, x.config, ["manager"]);
  t.after(() => app.close());
  const interviewer = await actor(x.db, ["interviewer"]),
    viewer = await actor(x.db, ["viewer"]),
    pending = await actor(x.db, ["interviewer"]);
  await x.db.query("UPDATE users SET status='pending' WHERE id=$1", [
    pending.id,
  ]);
  const response = await app.inject({
    url: "/api/v4/assignment-members?role=interviewer&page=1&pageSize=25",
    headers,
  });
  assert.equal(response.statusCode, 200);
  const people = response.json().data.items;
  assert.ok(people.some((p: any) => p.id === interviewer.id));
  assert.ok(!people.some((p: any) => p.id === pending.id));
  assert.ok(people.every((p: any) => !("open_id" in p) && !("status" in p)));
  const person = await x.r.createCandidate(x.a, { name: "授权人员" }),
    j = await x.r.createJob(x.a, {level:"P5", name: "权限岗位" }),
    one = await x.r.apply(x.a, { candidateId: person.id, jobId: j.id });
  await x.db.query(
    "INSERT INTO application_grants(application_id,user_id) VALUES($1,$2)",
    [one.id, viewer.id],
  );
  const list = await x.r.applications(viewer, {});
  assert.equal(list.total, 1);
  assert.equal(list.items[0].id, one.id);
  assert.equal((await x.r.applications(interviewer, {})).total, 0);
  assert.ok(manager.id);
});
test("review: evaluation citations resolve immutable submitted versions while other authors cannot read drafts", async (t) => {
  const x = await context(t),
    a = await ingest(x),
    i = new InterviewService(x.id),
    author = await actor(x.db, ["interviewer"]);
  const interview = await i.create(x.a, {
    applicationId: a.applicationId,
    round: 1,
    startsAt: new Date().toISOString(),
    durationMinutes: 30,
    form: "现场",
    interviewerIds: [author.id],
  });
  const data = {
    professional: 3,
    evidenceNotes: "人工事实",
    summary: "第一版",
    conclusion: "yes",
    problemSolving: null,
    communication: null,
  };
  const first = await i.evaluate(author, interview.id, {
    version: 0,
    status: "submitted",
    data,
  });
  await i.evaluate(author, interview.id, {
    version: 1,
    status: "draft",
    data: { ...data, summary: "内部草稿" },
  });
  const versions = await (i as any).evaluationVersions(x.a, first.id);
  assert.equal(versions.length, 1);
  assert.equal(versions[0].version, 1);
  assert.equal(versions[0].data.summary, "第一版");
  assert.equal(
    (await (i as any).evaluationVersions(author, first.id)).length,
    2,
  );
  await assert.rejects(
    (i as any).evaluationVersion(x.a, first.id, 2),
    /forbidden/,
  );
});
test("review: unsupported skills report coverage gaps and human questions can be added and all questions removed", async (t) => {
  const x = await context(t),
    a = await ingest(x, ["Rust"]),
    q = await x.m.questions(x.a, a.applicationId);
  assert.deepEqual(q.data.missingSkills, ["Rust"]);
  assert.equal(q.data.questions.find((item:any)=>item.group==='专业深挖'&&item.skill==='Rust').source.kind, "generic_template");
  const human = {
    id: "human:rust-ownership",
    skill: "Rust",
    prompt: "请解释你在项目中如何处理所有权？",
    followups: [],
    referencePoints: [],
    source: { kind: "human" },
    basis: "unknown",
    evidence: [],
  };
  const edited = await x.m.editQuestions(x.a, q.id, {
    version: 1,
    questions: [...q.data.questions, human],
  });
  assert.equal(edited.data.questions.at(-1).source.authorId, x.a.id);
  assert.deepEqual(
    (await x.m.editQuestions(x.a, q.id, { version: 2, questions: [] })).data
      .questions,
    [],
  );
});
test("review: soft delete and restore preserve history and enforce person/application relationships", async (t) => {
  const x = await context(t),
    a = await ingest(x);
  await assert.rejects(
    (x.r as any).removeCandidate(x.a, a.candidateId, {
      version: 1,
      reason: "误建",
    }),
    /candidate_has_applications/,
  );
  const gone = await (x.r as any).removeApplication(x.a, a.applicationId, {
    version: 1,
    reason: "误建",
  });
  assert.equal((await x.r.applications(x.a, {})).total, 0);
  assert.equal(
    (await x.r.applications(x.a, { deleted: true })).items[0].id,
    a.applicationId,
  );
  const person = await (x.r as any).removeCandidate(x.a, a.candidateId, {
    version: 1,
    reason: "误建",
  });
  await assert.rejects(
    (x.r as any).removeApplication(x.a, a.applicationId, {
      version: gone.version,
      reason: "恢复",
      restore: true,
    }),
    /candidate_deleted/,
  );
  await (x.r as any).removeCandidate(x.a, a.candidateId, {
    version: person.version,
    reason: "恢复",
    restore: true,
  });
  const restored = await (x.r as any).removeApplication(x.a, a.applicationId, {
    version: gone.version,
    reason: "恢复",
    restore: true,
  });
  assert.equal(restored.status, "screening");
  assert.equal(
    (await x.tasks.raw(x.a, a.resumeVersionId)).raw.includes("回归人员"),
    true,
  );
});
test("review: historical statistics use imported baselines, rejection events and evaluation revisions", async (t) => {
  const x = await context(t),
    a = await ingest(x),
    s = new StatisticsService(x.id),
    i = new InterviewService(x.id);
  const interview = await i.create(x.a, {
    applicationId: a.applicationId,
    round: 1,
    startsAt: new Date().toISOString(),
    durationMinutes: 30,
    form: "现场",
    interviewerIds: [x.a.id],
  });
  const data = {
    professional: 3,
    evidenceNotes: "事实",
    summary: "已提交",
    conclusion: "yes",
    problemSolving: null,
    communication: null,
  };
  const e = await i.evaluate(x.a, interview.id, {
    version: 0,
    status: "submitted",
    data,
  });
  await x.db.query(
    "UPDATE applications SET created_at='2026-01-01' WHERE id=$1",
    [a.applicationId],
  );
  await x.db.query(
    "UPDATE application_events SET at='2026-01-01' WHERE application_id=$1",
    [a.applicationId],
  );
  let app = await x.r.transition(x.a, a.applicationId, {
    version: 1,
    to: "rejected",
    rejectReason: "第一次原因",
    rejectDetail: "事实记录",
    reason:'人工核对',opinion:'人工核对事实后记录结果',
  });
  await x.db.query(
    "UPDATE application_events SET at='2026-01-02' WHERE application_id=$1 AND to_state='rejected'",
    [a.applicationId],
  );
  await x.db.query(
    "UPDATE evaluation_versions SET at='2026-01-02' WHERE evaluation_id=$1",
    [e.id],
  );
  app = await x.r.transition(x.a, app.id, {
    version: app.version,
    to: "screening",
    confirm: true,
    reason: "人工重开",
    opinion:'人工核对事实后重新开启',
  });
  await x.r.transition(x.a, app.id, {
    version: app.version,
    to: "rejected",
    rejectReason: "第二次原因",
    rejectDetail: "新事实",
    reason:'人工核对',opinion:'人工核对新事实后记录结果',
  });
  await i.evaluate(x.a, interview.id, {
    version: 1,
    status: "submitted",
    data: { ...data, professional: 5 },
  });
  const report = await s.report(x.a, {
    from: "2026-01-01T00:00:00Z",
    to: "2026-02-01T00:00:00Z",
    asOf: "2026-01-03T00:00:00Z",
  });
  assert.equal(report.rejections["第一次原因"], 1);
  assert.equal(report.meanProfessionalScore, 3);
  const other = await context(t),
    bundle = {
      revision: 1,
      data: {
        jobs: [{ id: "j", name: "历史岗" }],
        talents: [
          {
            id: "t",
            name: "历史人",
            jobId: "j",
            status: "已入职",
            raw: "姓名：历史人\nPython项目",
          },
        ],
        interviews: [],
      },
    };
  await migrateLegacy(other.db, other.store, other.a, bundle, false);
  const stats = await new StatisticsService(other.id).report(other.a, {
    from: "2020-01-01T00:00:00Z",
    to: "2099-01-01T00:00:00Z",
  });
  assert.equal(stats.current.hired, 1);
  assert.equal(stats.current.screening, 0);
  assert.equal(stats.unknownHistoricalApplications, 1);
});
test("review: removing built-in aliases remains effective after recomputation and restart seeding", async (t) => {
  const x = await context(t),
    d = new Dictionary(x.db),
    a = await ingest(x, ["PyTorch"]);
  const task = await x.tasks.upload(x.a, {
    name: "torch.txt",
    data: Buffer.from("姓名：别名人员\n仅使用 torch 完成实验项目与专业验证。"),
    jobId: a.j.id,
  });
  await x.w.once();
  const done = await x.tasks.get(x.a, task.id);
  assert.equal(
    (await x.tasks.matches(x.a, done.result.applicationId)).latest.data
      .skills[0].status,
    "matched",
  );
  await d.update("PyTorch", [], "AI");
  // Publishing leaves existing bindings unchanged. Explicitly adopt the new
  // immutable dictionary snapshot before requesting its recalculation.
  const bindings=new BindingService(x.id),object={kind:'job' as const,id:a.j.id},binding=await bindings.resolveBinding(x.a,object,'matching'),preview=await bindings.preview(x.a,object,'matching',binding.templateRef);
  await bindings.adopt(x.a,{receipt:preview.receipt,objectVersion:preview.objectVersion,selectedIds:[done.result.applicationId]});
  while (await x.w.once()) {}
  assert.equal(
    (await x.tasks.matches(x.a, done.result.applicationId)).latest.data
      .skills[0].status,
    "not_matched",
  );
  await new Dictionary(x.db).seed();
  assert.ok(
    !(await d.list())
      .find((x: any) => x.name === "PyTorch")
      .aliases.includes("torch"),
  );
});
test("review: simultaneous identical uploads produce one person and a required duplicate decision", async (t) => {
  const x = await context(t),
    j = await x.r.createJob(x.a, {level:"P5", name: "并发导入" }),
    data = Buffer.from(
      "姓名：同时上传\n邮箱：concurrent@example.invalid\nPython 项目经历",
    );
  const one = await x.tasks.upload(x.a, { name: "one.txt", data, jobId: j.id }),
    two = await x.tasks.upload(x.a, { name: "two.txt", data, jobId: j.id });
  const w2 = new Worker(x.id, x.store, "second"),
    c1 = await x.w.claim(),
    c2 = await w2.claim();
  const blocker = await x.db.pool.connect();
  await blocker.query("BEGIN");
  await blocker.query("LOCK TABLE candidates IN SHARE MODE");
  const p1 = x.w.process(c1),
    p2 = w2.process(c2);
  try {
    await waitLock(x.db, x.config.schema, 2);
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
  await Promise.all([p1, p2]);
  const states = [
    (await x.tasks.get(x.a, one.id)).state,
    (await x.tasks.get(x.a, two.id)).state,
  ].sort();
  assert.deepEqual(states, ["awaiting_duplicate_decision", "succeeded"]);
  assert.equal(
    (await x.db.query("SELECT count(*) FROM candidates")).rows[0].count,
    "1",
  );
});
test("review ruling: a protected GET rejects an explicit foreign Origin", async (t) => {
  const x = await context(t),
    { app, headers } = await httpSession(x.db, x.config);
  t.after(() => app.close());
  assert.equal(
    (
      await app.inject({
        url: "/api/v4/jobs",
        headers: { ...headers, origin: "https://foreign.invalid" },
      })
    ).statusCode,
    403,
  );
});
