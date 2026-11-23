import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
const base = {
  RECRUIT_V4_DATABASE_URL:
    "postgresql://recruit_v4:fixture@127.0.0.1:55434/recruit_v4",
  RECRUIT_V4_SECRET: "s".repeat(48),
};
test("database and schema guards cannot point at current recruiting or OKR", () => {
  assert.equal(loadConfig(base).schema, "recruit_v4");
  for (const url of [
    "postgresql://u:p@127.0.0.1:55432/recruit_lab",
    "postgresql://u:p@127.0.0.1:15432/okr",
    "postgresql://u:p@127.0.0.1:55433/recruit_v3",
    "postgresql://u:p@example.com:55433/recruit_v3",
  ])
    assert.throws(
      () => loadConfig({ ...base, RECRUIT_V4_DATABASE_URL: url }),
      /isolated database/,
    );
  for (const schema of [
    "public",
    "recruit_lab",
    "recruit_v3",
    "recruit_v3;DROP TABLE users",
    "recruit_test_",
  ])
    assert.throws(
      () => loadConfig({ ...base, RECRUIT_V4_SCHEMA: schema }),
      /schema/,
    );
});
test("production requires secrets and a fixed HTTPS origin", () => {
  assert.throws(
    () => loadConfig({ ...base, RECRUIT_V4_SECRET: "short" }),
    /secret/,
  );
  assert.throws(
    () => loadConfig({ ...base, RECRUIT_V4_ORIGIN: "http://localhost:39613" }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      loadConfig({ ...base, RECRUIT_V4_ORIGIN: "https://example.com/path" }),
    /origin/,
  );
  assert.equal(
    loadConfig({ ...base, RECRUIT_V4_SCHEMA: "recruit_test_ab12" }).schema,
    "recruit_test_ab12",
  );
});

test("test cookie names are configurable without changing production defaults", () => {
 assert.equal(loadConfig(base).cookiePrefix, "__Host-recruit_v4");
 assert.equal(loadConfig({...base, RECRUIT_V4_COOKIE_PREFIX:"__Host-recruit_v4_test"}).cookiePrefix,"__Host-recruit_v4_test");
 assert.throws(()=>loadConfig({...base,RECRUIT_V4_COOKIE_PREFIX:"bad;cookie"}));
});
