import test from "node:test";
import assert from "node:assert/strict";
import {
  initialPage,
  skillTokens,
  transitionBody,
  togglePoints,
  questionsText,
  commitCommand,
  transferBody,
  transferStart,
} from "../src/lib/prd.ts";
test("job reassignment uses the chosen target stage, carries hired to offered and preserves selected deferred CC and termination gates", () => {
  assert.equal(transferStart("hired"), "offered");
  assert.equal(transferStart("terminated"), "screening");
  assert.equal(transferStart("collecting"), "collecting");
  const body = transferBody(
    { version: 2, status: "hired" },
    "job-target",
    "offered",
    {
      reason: "岗位调整",
      opinion: "人工核对后进行内部转岗",
      ccMethod: "deferred",
    },
  );
  assert.equal(body.targetJobId, "job-target");
  assert.equal(body.to, "offered");
  assert.equal(body.ccMethod, "deferred");
  assert.equal(body.confirm, true);
  assert.throws(
    () =>
      transferBody(
        { version: 2, status: "screening" },
        "job-target",
        "terminated",
        { reason: "其他", opinion: "人工核对终止依据" },
      ),
    /终止原因/,
  );
});
test("dashboard is the empty and invalid route default; skills accept slash and pipe without splitting generic URLs", () => {
  assert.equal(initialPage(""), "overview");
  assert.equal(initialPage("#unknown"), "overview");
  assert.equal(initialPage("#interviewer-review"), "interviewer-review");
  assert.deepEqual(skillTokens("Python/PyTorch | C++，Python\nDocker"), [
    "Python",
    "PyTorch",
    "C++",
    "Docker",
  ]);
});
test("normal drag is direct while terminal and form changes retain reasons, opinions and CC", () => {
  assert.deepEqual(
    transitionBody(
      { id: "a", version: 3, status: "screening" },
      "screened",
      {},
      "drag",
    ),
    { version: 3, to: "screened", interaction: "drag" },
  );
  assert.throws(
    () =>
      transitionBody(
        { version: 3, status: "offered" },
        "terminated",
        {},
        "drag",
      ),
    /终止原因/,
  );
  const body = transitionBody(
    { version: 3, status: "offered" },
    "terminated",
    {
      reason: "其他",
      termReason: "其他",
      termDetail: "候选人确认延期入职",
      opinion: "已和候选人核实入职安排",
    },
    "form",
  );
  assert.equal(body.termDetail, "候选人确认延期入职");
  assert.equal(body.interaction, "form");
});
test("failed commands do not close forms or mutate rendered data", async () => {
  let committed = false;
  await assert.rejects(() =>
    commitCommand(
      async () => {
        throw Error("offline");
      },
      () => {
        committed = true;
      },
    ),
  );
  assert.equal(committed, false);
  assert.equal(
    await commitCommand(
      async () => ({ version: 4 }),
      (v) => {
        committed = v.version === 4;
      },
    ),
    true,
  );
  assert.equal(committed, true);
});
test("reference points start collapsed and individual/all toggles are reversible; copy includes groups and points", () => {
  const qs = [
    {
      id: "a",
      group: "开场破冰",
      prompt: "最近关注什么？",
      referencePoints: ["能说明自己的判断"],
    },
    {
      id: "b",
      group: "专业深挖",
      prompt: "如何定位问题？",
      referencePoints: ["排查路径明确"],
    },
  ];
  let shown = togglePoints(
    [],
    qs.map((q) => q.id),
    "a",
  );
  assert.deepEqual(shown, ["a"]);
  shown = togglePoints(
    shown,
    qs.map((q) => q.id),
    "all",
  );
  assert.deepEqual(shown, ["a", "b"]);
  assert.deepEqual(togglePoints(shown, ["a", "b"], "all"), []);
  const text = questionsText(qs);
  for (const s of ["开场破冰", "最近关注什么", "能说明自己的判断", "专业深挖"])
    assert.ok(text.includes(s));
});
