import test from "node:test";
import assert from "node:assert/strict";
import { searchEvidence } from "../src/sourcing/search.js";
test("exact schools and token boundaries avoid false positives, merged offsets reference original text", () => {
  assert.equal(
    searchEvidence("毕业于合肥工业大学", "浙江工业大学").matched,
    false,
  );
  assert.equal(searchEvidence("JavaScript 工程师", "Java").matched, false);
  assert.equal(searchEvidence("Java 与 Python", "java python").matched, true);
  assert.equal(searchEvidence("只有 Python", "java python").matched, false);
  assert.equal(
    searchEvidence("只有 Python", "java python", "any").matched,
    true,
  );
  const r = searchEvidence("研究智能机器人控制与制造", "智能机器人系统");
  assert.equal(r.matched, true);
  for (const x of r.ranges)
    assert.equal("研究智能机器人控制与制造".slice(x.start, x.end), x.text);
  const x = searchEvidence("智能机器人", "智能 机器人");
  assert.deepEqual(x.ranges, [{ start: 0, end: 5, text: "智能机器人" }]);
});
