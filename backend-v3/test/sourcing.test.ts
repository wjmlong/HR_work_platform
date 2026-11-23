import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase, actor } from "./helpers.js";
import { Identity } from "../src/identity/service.js";
import { FeishuProvider } from "../src/identity/provider.js";
import { SourcingService, overdue } from "../src/sourcing/service.js";
import { Dictionary } from "../src/dictionary/service.js";
test("sourcing keeps setup separate, preserves real contact clock, checks versions and exports complete filtered set", async (t) => {
  const { db, config, cleanup } = await testDatabase();
  t.after(cleanup);
  const a = await actor(db),
    id = new Identity(db, config, new FeishuProvider(config)),
    s = new SourcingService(id),
    d = new Dictionary(db);
  await d.seed();
  assert.deepEqual(
    await d.normalize(["torch", "LLM", "Kubernetes", "Docker"]),
    ["PyTorch", "大模型", "Kubernetes", "Docker"],
  );
  await s.setup(a, {
    targetJob: "机器人工程师",
    line: "high",
    keywords: ["机器人"],
    sources: ["学术"],
    limit: 20,
  });
  const created = await s.create(a, {
    name: "=公式",
    org: "单位",
    school: "浙江工业大学",
    major: "机械",
    skills: ["torch"],
    direction: "机器人",
    contact: "测试",
    source: "顶会论文",
    line: "high",
  });
  await s.create(a, {
    name: "另一个",
    org: "单位",
    school: "合肥工业大学",
    major: "机械",
    skills: ["Docker"],
    direction: "算法",
    contact: "",
    source: "其他",
    line: "social",
  });
  const q = {
    line: "high" as const,
    page: 1,
    pageSize: 1,
    filters: { school: ["浙江工业大学"] },
  };
  const list = await s.query(a, q);
  assert.equal(list.total, 1);
  assert.equal(list.items[0].id, created.id);
  assert.equal((await s.getSetup(a)).keywords[0], "机器人");
  assert.equal((await s.request(a)).execution_status, "not_configured");
  const followed = await s.followup(a, created.id, {
    version: 1,
    kind: "contact",
    note: "实际联系",
    occurredAt: "2026-10-01T00:00:00+08:00",
  });
  assert.equal(followed.state, "contacted");
  const edited = await s.update(a, created.id, { version: 2, note: "改备注" });
  assert.equal(
    new Date(edited.last_contacted_at).toISOString(),
    "2026-09-30T16:00:00.000Z",
  );
  await assert.rejects(
    s.update(a, created.id, { version: 2, note: "过期写入" }),
    /version_conflict/,
  );
  const terminal = await s.transition(a, created.id, {
    version: 3,
    state: "uploaded",
    reason: "人工已上传",
    confirm: true,
  });
  assert.equal(terminal.state, "uploaded");
  await assert.rejects(
    s.transition(a, created.id, {
      version: 4,
      state: "contacted",
      reason: "",
      confirm: false,
    }),
    /terminal_confirmation/,
  );
  const csv = await s.csv(a, q, "filtered");
  assert.equal(csv.split("\r\n").length, 3);
  assert.ok(csv.includes("'=公式"));
  assert.ok(!csv.includes("另一个"));
  assert.equal(csv.split("\r\n")[0].split(",").length, 11);
  const zero = await s.query(a, { filters: { school: ["不存在"] } });
  assert.equal(zero.total, 0);
  assert.equal(
    zero.facets.school.find((x: any) => x.value === "不存在").count,
    0,
  );
  assert.equal((await s.metrics(a, { line: "high" })).conversionRate, 1);
  assert.equal((await s.query(a, { query: "浙江工业大学" })).total, 1);
  const viewer = await actor(db, ["interviewer"]);
  await assert.rejects(s.query(viewer, {}), /forbidden/);
});
test("overdue thresholds are strict and terminal followup is never overdue", () => {
  const now = new Date("2026-10-15T12:00:00+08:00");
  assert.equal(
    overdue(
      { state: "uncontacted", created_at: "2026-10-08T12:00:00+08:00" },
      now,
    ),
    false,
  );
  assert.equal(
    overdue(
      { state: "uncontacted", created_at: "2026-10-08T11:59:59+08:00" },
      now,
    ),
    true,
  );
  assert.equal(
    overdue(
      { state: "contacted", last_contacted_at: "2026-10-01T12:00:00+08:00" },
      now,
    ),
    false,
  );
  assert.equal(
    overdue(
      { state: "contacted", last_contacted_at: "2026-10-01T11:59:59+08:00" },
      now,
    ),
    true,
  );
  assert.equal(
    overdue({ state: "uploaded", created_at: "2020-01-01" }, now),
    false,
  );
});
