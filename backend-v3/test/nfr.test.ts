import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { testDatabase, httpSession } from "./helpers.js";
import { Database } from "../src/db.js";
import { buildApp } from "../src/http/app.js";
test("two independent API pools share sessions, concurrent writes are atomic and a terminated test-only transaction returns 503 and rolls back", async (t) => {
  const { db, config, cleanup } = await testDatabase();
  t.after(cleanup);
  const { app: a, headers, provider, actor } = await httpSession(db, config),
    db2 = new Database({ ...config, instance: "v3-b-test" }),
    b = await buildApp({ db: db2, config, provider });
  t.after(() => a.close());
  t.after(() => b.close());
  t.after(() => db2.close());
  let started!: (pid: number) => void;
  const waiting = new Promise<number>((resolve) => (started = resolve));
  a.get("/api/v4/test-transaction", async () =>
    db.tx(async (c) => {
      const pid = (await c.query("SELECT pg_backend_pid() pid")).rows[0].pid;
      await c.query(
        'INSERT INTO candidates(profile) VALUES(\'{"name":"must rollback"}\')',
      );
      started(pid);
      await c.query("SELECT pg_sleep(10)");
      return { ok: true };
    }),
  );
  assert.equal(
    (await b.inject({ url: "/api/v4/auth/me", headers })).statusCode,
    200,
  );
  const definition=(await a.inject({url:'/api/v4/business-config/effective/resume',headers})).json().data;
  const fields={definitionVersion:definition.ref.version,definitionRevision:definition.aclRevision};
  const writes = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      (i % 2 ? a : b).inject({
        method: "POST",
        url: "/api/v4/candidates",
        headers: { ...headers, "idempotency-key": "concurrent-" + i },
        payload: { name: "合成并发" + i,...fields },
      }),
    ),
  );
  assert.ok(writes.every((r) => r.statusCode === 200));
  const replay = await b.inject({
    method: "POST",
    url: "/api/v4/candidates",
    headers: { ...headers, "idempotency-key": "concurrent-1" },
    payload: { name: "合成并发1",...fields },
  });
  assert.equal(replay.statusCode, 200);
  assert.equal(
    (await db.query("SELECT count(*) FROM candidates")).rows[0].count,
    "20",
  );
  assert.equal(
    (
      await a.inject({
        url: "/api/v4/auth/me",
        headers,
        remoteAddress: "172.20.140.250",
      })
    ).statusCode,
    421,
  );
  const request = a.inject({ url: "/api/v4/test-transaction", headers });
  const pid = await waiting;
  assert.match(config.schema, /^recruit_test_/);
  const check = (await db2.query("SELECT current_schema() schema")).rows[0];
  assert.equal(check.schema, config.schema);
  await db2.query("SELECT pg_terminate_backend($1)", [pid]);
  assert.equal((await request).statusCode, 503);
  assert.equal(
    (await db2.query("SELECT count(*) FROM candidates")).rows[0].count,
    "20",
  );
  await a.close();
  assert.equal((await b.inject({ url: "/health/ready" })).statusCode, 200);
  assert.equal(
    (await b.inject({ url: "/api/v4/auth/me", headers })).statusCode,
    200,
  );
});
test("10k leads and 10k applications under 20 concurrent requests meet measured list/filter latency budget", async (t) => {
  const { db, config, cleanup } = await testDatabase();
  t.after(cleanup);
  const { app, headers, actor } = await httpSession(db, config);
  t.after(() => app.close());
  await db.query(
    "INSERT INTO leads(name,org,school,major,skills,direction,source,line,owner_id) SELECT '合成线索'||n,'单位'||(n%10),CASE WHEN n%2=0 THEN '浙江工业大学' ELSE '合肥工业大学' END,'机械',ARRAY['Python'],'机器人','合成渠道','high',$1 FROM generate_series(1,10000) n",
    [actor.id],
  );
  await db.query("INSERT INTO jobs(name) VALUES('合成负载岗位')");
  await db.query(
    "INSERT INTO candidates(profile) SELECT jsonb_build_object('name','合成候选人'||n) FROM generate_series(1,10000) n",
  );
  await db.query(
    "INSERT INTO applications(candidate_id,job_id) SELECT c.id,j.id FROM candidates c CROSS JOIN jobs j",
  );
  await db.query("ANALYZE");
  // listen() completes route/schema compilation before opening the socket.
  // Measure readiness separately; no business query or connection pool warmup.
  const readyStarted=performance.now();await app.ready();const startupReadyMs=performance.now()-readyStarted;
  const timings: { operation: string; ms: number; status: number }[] = [];
  for (let batch = 0; batch < 3; batch++)
    await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        const operation = i % 2 ? "leads" : "applications",
          start = performance.now(),
          r = await app.inject({
            method: "POST",
            url: "/api/v4/" + operation + "/query",
            headers,
            payload:
              operation === "leads"
                ? {
                    line: "high",
                    filters: { school: ["浙江工业大学"] },
                    pageSize: 25,
                  }
                : { pageSize: 25 },
          });
        timings.push({
          operation,
          ms: performance.now() - start,
          status: r.statusCode,
        });
      }),
    );
  const metrics = Object.fromEntries(
    ["leads", "applications"].map((operation) => {
      const rows = timings.filter((x) => x.operation === operation),
        times = rows.map((x) => x.ms).sort((a, b) => a - b),
        q = (p: number) => times[Math.ceil(times.length * p) - 1];
      return [
        operation,
        {
          requests: rows.length,
          p50: q(0.5),
          p95: q(0.95),
          p99: q(0.99),
          failures: rows.filter((x) => x.status !== 200).length,
        },
      ];
    }),
  );
  await mkdir("test-results", { recursive: true });
  await writeFile(
    "test-results/performance.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        rows: { leads: 10000, applications: 10000 },
        concurrency: 20,
        metrics,
        timings,
        startupReadyMs,
        memory: process.memoryUsage(),
      },
      null,
      2,
    ),
  );
  for (const result of Object.values(metrics) as any[]) {
    assert.equal(result.failures, 0);
    assert.ok(
      result.p95 <= 500,
      "Measured P95 " + Math.round(result.p95) + "ms exceeds 500ms",
    );
  }
});
