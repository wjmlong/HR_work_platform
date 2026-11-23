import test from "node:test";
import assert from "node:assert/strict";
import { credentialChange, campusExportBody } from "../src/lib/campus.ts";
test("campus credential keep and clear never resend a revealed value; replacement is explicit", () => {
  assert.deepEqual(credentialChange("keep", "stale-revealed-value"), {
    action: "keep",
  });
  assert.deepEqual(credentialChange("clear", "stale-revealed-value"), {
    action: "clear",
  });
  assert.deepEqual(credentialChange("replace", "new-synthetic"), {
    action: "replace",
    value: "new-synthetic",
  });
});
test("campus sensitive export requires an explicit warning acknowledgment", () => {
  assert.deepEqual(campusExportBody({ region: "华东" }, false, false), {
    query: { region: "华东" },
    includeCredentials: false,
    confirmation: "",
  });
  assert.throws(() => campusExportBody({}, true, false), /文件含账号密码/);
  assert.equal(
    campusExportBody({}, true, true).confirmation,
    "文件含账号密码，注意存放",
  );
});

test("revealing a second credential never extends the first credential display lifetime", async () => {
  const { unexpiredCredentials } = await import("../src/lib/campus.ts");
  const values = {
    first: { password: "synthetic-first", expiresAt: 1000 },
    second: { password: "synthetic-second", expiresAt: 2000 },
  };
  assert.deepEqual(Object.keys(unexpiredCredentials(values, 1500)), ["second"]);
  assert.deepEqual(unexpiredCredentials(values, 2000), {});
});
