import test from "node:test";
import assert from "node:assert/strict";
import {
  RequestScope,
  businessDate,
  statisticsRange,
  evidenceResumeId,
  extractionWarnings,
  toggleMember,
  readableBrief,
  readableComparison,
  finishApplicationFlow,
} from "../src/lib/workflows.ts";
test("successful transfer opens the returned current application instead of reloading the archived source; normal moves reload in place", () => {
  const calls: string[] = [],
    actions = {
      closeForm: () => calls.push("close"),
      refresh: () => calls.push("refresh"),
      reload: () => calls.push("reload-old"),
      open: (id: string) => calls.push("open:" + id),
    };
  finishApplicationFlow("old", { id: "new" }, actions);
  assert.deepEqual(calls, ["close", "refresh", "open:new"]);
  calls.length = 0;
  finishApplicationFlow("same", { id: "same" }, actions);
  assert.deepEqual(calls, ["close", "refresh", "reload-old"]);
});
test("late A response and A→B→A cannot replace selected application materials", async () => {
  const scope = new RequestScope(),
    values: string[] = [];
  let finish!: (s: string) => void;
  const old = scope.run(
    () => new Promise<string>((r) => (finish = r)),
    (v) => values.push(v),
  );
  scope.change();
  await scope.run(
    async () => "B",
    (v) => values.push(v),
  );
  scope.change();
  finish("A");
  assert.equal(await old, false);
  assert.deepEqual(values, ["B"]);
});
test("business calendar uses Shanghai midnight and incomplete/reversed/invalid dates produce no query", () => {
  assert.equal(businessDate(new Date("2025-12-31T16:00:00Z")), "2026-01-01");
  assert.deepEqual(statisticsRange("2026-01-01", "2026-01-02"), {
    from: "2025-12-31T16:00:00.000Z",
    to: "2026-01-01T16:00:00.000Z",
  });
  for (const [from, to] of [
    ["", "2026-01-02"],
    ["2026-01-01", ""],
    ["2026-01-02", "2026-01-01"],
    ["2026-02-30", "2026-03-04"],
  ])
    assert.equal(statisticsRange(from, to), null);
});
test("evidence follows the immutable match resume while a newly adopted version is recomputing", () =>
  assert.equal(
    evidenceResumeId(
      { resume_version_id: "new" },
      { latest: { resume_version_id: "old" } },
    ),
    "old",
  ));
test("selecting a visible member preserves assignees absent from the visible page", () => {
  assert.deepEqual(toggleMember(["member-105"], "member-1"), [
    "member-105",
    "member-1",
  ]);
  assert.deepEqual(toggleMember(["member-105", "member-1"], "member-1"), [
    "member-105",
  ]);
});
test("short and missing extraction facts are explicit; zero experience is known", () => {
  const warnings = extractionWarnings({
    raw: "短简历",
    profile: { experienceYears: 0 },
  });
  assert.ok(warnings.some((w) => w.includes("50 字")));
  assert.ok(warnings.some((w) => w.includes("联系方式")));
  assert.ok(!warnings.some((w) => w.includes("工作年限")));
});
test("one known contact never hides the other missing field warning", () => {
  const warnings = extractionWarnings({
    raw: "x".repeat(60),
    profile: {
      phone: "13000000000",
      email: "",
      education: "master",
      school: "Synthetic",
      experienceYears: 2,
      location: "Synthetic",
    },
  });
  assert.ok(warnings.some((w) => w.includes("邮箱")));
  assert.ok(!warnings.some((w) => w.includes("电话")));
});
test("readable brief includes the saved human conclusion independently of editing permission", () =>
  assert.ok(
    readableBrief({
      data: { facts: [] },
      human_conclusion: { text: "合成结论" },
    }).includes("合成结论"),
  ));
test("comparison copy includes the immutable evidence version, full professional findings and manual-reference statement", () => {
  const output = readableComparison({
    resume_version_id: "resume-original",
    algorithm_version: "rules-v3",
    dictionary_version: 2,
    job_version: 3,
    data: {
      skills: [
        {
          requirement: "Python",
          status: "matched",
          evidence: [{ text: "合成项目 Python", line: 5 }],
        },
      ],
      education: { status: "unknown" },
      experience: { status: "not_matched" },
      score: { lower: 50, upper: 75, provisional: true },
    },
  });
  for (const value of [
    "resume-original",
    "Python",
    "合成项目 Python",
    "unknown",
    "not_matched",
    "rules-v3",
    "仅供人工参考",
    "不代表录用结论",
    "人工最终确认",
  ])
    assert.ok(output.includes(value), value);
});
