import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { testDatabase, httpSession, actor } from "./helpers.js";
import { Identity } from "../src/identity/service.js";
import { FeishuProvider } from "../src/identity/provider.js";
import { RecruitingService } from "../src/recruiting/service.js";
import { TaskService } from "../src/tasks/service.js";
import { FileStore } from "../src/files/storage.js";
import { Worker } from "../src/tasks/worker.js";
import { parseProfile } from "../src/parsing/profile.js";
import { MaterialService } from "../src/materials/service.js";
import { SourcingService } from "../src/sourcing/service.js";
import { Dictionary } from "../src/dictionary/service.js";
test("only the designated Host cookie authenticates and HTTP contracts expose exact request schema and stable errors", async (t) => {
  const { db, config, cleanup } = await testDatabase();
  t.after(cleanup);
  const { app, headers } = await httpSession(db, config);
  t.after(() => app.close());
  assert.equal(
    (
      await app.inject({
        url: "/api/v4/auth/me",
        headers: {
          ...headers,
          cookie: headers.cookie.replace(
            "__Host-recruit_v4_session",
            "__Host_recruit_v3_session",
          ),
        },
      })
    ).statusCode,
    401,
  );
  const bad = await app.inject({
    method: "POST",
    url: "/api/v4/jobs",
    headers: { ...headers, "idempotency-key": "bad-input" },
    payload: { level:'P5',name: "岗位", requirements: { skills: ["Java"], maxAge: 35 } },
  });
  assert.equal(bad.statusCode, 422);
  assert.equal(bad.json().error.code, "invalid_input");
  const openapi = await app.inject({ url: "/api/v4/openapi.json", headers });
  assert.equal(openapi.statusCode, 200);
  assert.ok(
    openapi.json().paths["/api/v4/jobs"].post.requestBody.content[
      "application/json"
    ].schema.properties.requirements,
  );
});
test("missing target job is rejected and SQL search/facets/export agree with boundary and broad recall semantics", async (t) => {
  const { db, config, cleanup } = await testDatabase();
  t.after(cleanup);
  const a = await actor(db),
    s = new SourcingService(
      new Identity(db, config, new FeishuProvider(config)),
    );
  await assert.rejects(s.setup(a, { line: "high" }), /invalid_input/);
  for (const [name, org, school, direction, skills] of [
    ["甲", "单位A", "浙江工业大学", "智能机器人控制", ["JavaScript"]],
    ["乙", "单位B", "合肥工业大学", "算法", ["Java"]],
    ["丙", "单位A", "浙江工业大学", "Python", ["Python"]],
  ] as const)
    await s.create(a, {
      name,
      org,
      school,
      direction,
      skills: [...skills],
      line: "high",
      source: "其他",
    });
  for (const [query, want] of [
    ["Java", 1],
    ["浙江工业大学", 2],
    ["智能机器人系统", 1],
    ["单位A Python", 1],
    ["Java Python", 0],
    ["C++", 0],
    [".*", 0],
  ] as const) {
    const result = await s.query(a, { query });
    assert.equal(result.total, want, query);
    const metrics = await s.metrics(a, { query });
    assert.equal(metrics.total, want);
    const csv = await s.csv(a, { query });
    assert.equal(csv.trim().split("\r\n").length, want + 1);
  }
  const result = await s.query(a, {
    filters: { org: ["单位A"], school: ["合肥工业大学"] },
  });
  assert.equal(result.total, 0);
  assert.equal(result.facets.org.find((x) => x.value === "单位B")?.count, 1);
  assert.equal(
    result.facets.school.find((x) => x.value === "浙江工业大学")?.count,
    2,
  );
});
test("unusual raw Unicode remains exact while derived parser fields and citations remain usable", async (t) => {
  const { db, config, cleanup } = await testDatabase();
  t.after(cleanup);
  const dir = await mkdtemp(path.join(os.tmpdir(), "v3-unicode-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const a = await actor(db),
    id = new Identity(db, config, new FeishuProvider(config)),
    store = new FileStore(dir),
    s = new TaskService(id, store),
    r = new RecruitingService(id),
    w = new Worker(id, store, "test"),
    m = new MaterialService(id, store);
  await new Dictionary(db).update("新术语", ["customAlias"], "custom");
  const j = await r.createJob(a, {level:"P5",
      name: "专业岗位",
      requirements: { skills: ["新术语"] },
    });
  const raw =
    "姓名：合成\ud800员\n本科，5年工作经验\n项目实际使用 customAlias 完成，提供可核对的专业项目描述与验证依据。";
  const task = await s.upload(a, {
    name: "paste.txt",
    data: Buffer.from(JSON.stringify(raw)),
    jobId: j.id,
    paste: true,
  });
  await w.once();
  const completed = await s.get(a, task.id);
  assert.equal(completed.state, "succeeded");
  assert.equal((await s.raw(a, completed.result.resumeVersionId)).raw, raw);
  const match = await s.matches(a, completed.result.applicationId);
  assert.equal(match.latest.data.skills[0].status, "matched");
  const brief = await m.brief(a, completed.result.applicationId);
  const fact = brief.data.facts.find((f: any) => f.field === "name");
  assert.equal(fact.text, raw.slice(fact.citation.start, fact.citation.end));
});
test("question edits cannot forge machine evidence or rule sources", async (t) => {
  const { db, config, cleanup } = await testDatabase();
  t.after(cleanup);
  const dir = await mkdtemp(path.join(os.tmpdir(), "v3-provenance-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const a = await actor(db),
    id = new Identity(db, config, new FeishuProvider(config)),
    store = new FileStore(dir),
    s = new TaskService(id, store),
    r = new RecruitingService(id),
    w = new Worker(id, store, "test"),
    m = new MaterialService(id, store),
    j = await r.createJob(a, {level:"P5",
      name: "岗位",
      requirements: { skills: ["Python"] },
    });
  const task = await s.upload(a, {
    name: "a.txt",
    data: Buffer.from(
      "姓名：证据员\nPython 本科，5年工作经验\n项目：经过测试验证的服务。",
    ),
    jobId: j.id,
  });
  await w.once();
  const done = await s.get(a, task.id),
    q = await m.questions(a, done.result.applicationId);
  await assert.rejects(
    m.editQuestions(a, q.id, {
      version: 1,
      questions: q.data.questions.map((x: any) => ({
        ...x,
        evidence: [{ text: "伪造引用", start: 0, end: 999 }],
      })),
    }),
    /citation_immutable/,
  );
});
