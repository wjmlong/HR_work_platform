import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase, actor } from "./helpers.js";
import { Identity } from "../src/identity/service.js";
import { FeishuProvider } from "../src/identity/provider.js";
import { RecruitingService } from "../src/recruiting/service.js";
import { StatisticsService } from "../src/statistics/service.js";
test("cohort funnel counts historical reached stages, current status and actual dwell separately with half-open dates", async (t) => {
  const { db, config, cleanup } = await testDatabase();
  t.after(cleanup);
  const a = await actor(db),
    id = new Identity(db, config, new FeishuProvider(config)),
    r = new RecruitingService(id),
    s = new StatisticsService(id),
    j = await r.createJob(a, {level:"P5", name: "统计岗位" });
  const apps = [];
  for (let k = 0; k < 3; k++) {
    const c = await r.createCandidate(a, { name: "合成统计" + k }),
      app = await r.apply(a, {
        candidateId: c.id,
        jobId: j.id,
        source: k === 0 ? "内推" : "公开",
      });
    apps.push(app);
    await db.query("DELETE FROM application_events WHERE application_id=$1", [
      app.id,
    ]);
    await db.query(
      "UPDATE applications SET created_at=$2,status=$3,reject_reason=$4 WHERE id=$1",
      [
        app.id,
        "2026-10-0" + (k + 1) + "T00:00:00+08:00",
        k === 0 ? "hired" : k === 1 ? "rejected" : "screening",
        k === 1 ? "专业经验" : null,
      ],
    );
  }
  for (const [index, events] of [
    [
      0,
      [
        ["screening", 1],
        ["screened", 2],
        ["interviewing", 3],
        ["hired", 4],
      ],
    ],
    [
      1,
      [
        ["screening", 2],
        ["screened", 3],
        ["rejected", 4],
      ],
    ],
    [2, [["screening", 3]]],
  ] as const) {
    let prior: string | null = null;
    for (const [state, day] of events) {
      await db.query(
        "INSERT INTO application_events(application_id,actor_id,from_state,to_state,at) VALUES($1,$2,$3,$4,$5)",
        [
          apps[index].id,
          a.id,
          prior,
          state,
          "2026-10-0" + day + "T00:00:00+08:00",
        ],
      );
      prior = state;
    }
  }
  const report = await s.report(a, {
    from: "2026-10-01T00:00:00+08:00",
    to: "2026-10-03T00:00:00+08:00",
    asOf: "2026-10-10T00:00:00+08:00",
  });
  assert.equal(report.counts.applications, 2);
  assert.equal(report.counts.people, 2);
  assert.equal(report.current.hired, 1);
  assert.equal(report.current.rejected, 1);
  assert.deepEqual(
    report.historicalFunnel.map((x: any) => x.count),
    [2, 2, 1, 0, 0, 0, 1],
  );
  assert.deepEqual(report.funnel.map(x=>x.count),[1,1,1,1,1,1,1]);
  assert.equal(report.cohort.funnel,'current_rank_excluding_rejected_and_terminated');
  assert.equal(report.jumps, 1);
  assert.equal(report.dwell.screening.totalSeconds, 172800);
  assert.equal(report.dwell.screened.totalSeconds, 172800);
  assert.equal(report.dwell.interviewing.totalSeconds, 86400);
  assert.equal(report.dwell.offered.samples, 0);
  assert.equal(report.channels.find((x: any) => x.source === "内推").hired, 1);
  assert.equal(report.meanProfessionalScore, null);
});
test("screening measurements use explicit comparable protocol, reject invalid samples and require 20 per group before efficiency conclusion", async (t) => {
  const { db, config, cleanup } = await testDatabase();
  t.after(cleanup);
  const a = await actor(db),
    s = new StatisticsService(
      new Identity(db, config, new FeishuProvider(config)),
    ),
    protocol = await s.protocol(a, {
      name: "统一阅读协议",
      definition: "开始阅读到完成人工初筛记录",
    });
  // Isolated relational fixture: one immutable resume per sample, all synthetic and no real files.
  const c = (
      await db.query(
        'INSERT INTO candidates(profile) VALUES(\'{"name":"合成样本"}\') RETURNING id',
      )
    ).rows[0],
    doc = (
      await db.query(
        "INSERT INTO resume_documents(blob_key,sha256,file_name,file_size,kind,owner_id) VALUES('unused','unused','synthetic.txt',1,'txt',$1) RETURNING id",
        [a.id],
      )
    ).rows[0],
    parsed = (
      await db.query(
        "INSERT INTO parse_results(document_id,raw_bytes,profile,evidence,parser_version) VALUES($1,$2,'{}','[]','test') RETURNING id",
        [doc.id, Buffer.from('""')],
      )
    ).rows[0];
  const resumes = [];
  for (let k = 0; k < 20; k++)
    resumes.push(
      (
        await db.query(
          "INSERT INTO resume_versions(candidate_id,parse_result_id,created_by) VALUES($1,$2,$3) RETURNING id",
          [c.id, parsed.id, a.id],
        )
      ).rows[0].id,
    );
  await assert.rejects(
    s.sample(a, {
      resumeVersionId: resumes[0],
      protocolId: protocol.id,
      mode: "manual",
      seconds: -1,
    }),
    /invalid_input/,
  );
  for (const mode of ["manual", "assisted"] as const)
    for (let k = 0; k < 19; k++)
      await s.sample(a, {
        resumeVersionId: resumes[k],
        protocolId: protocol.id,
        mode,
        seconds: mode === "manual" ? 100 : 60,
      });
  assert.equal((await s.measurements(a, protocol.id)).efficiency, null);
  await s.sample(a, {
    resumeVersionId: resumes[19],
    protocolId: protocol.id,
    mode: "manual",
    seconds: 100,
  });
  await s.sample(a, {
    resumeVersionId: resumes[19],
    protocolId: protocol.id,
    mode: "assisted",
    seconds: 60,
  });
  const result = await s.measurements(a, protocol.id);
  assert.equal(result.manual.count, 20);
  assert.equal(result.manual.median, 100);
  assert.equal(result.assisted.median, 60);
  assert.equal(result.efficiency, 0.4);
  await assert.rejects(
    s.sample(a, {
      resumeVersionId: resumes[0],
      protocolId: protocol.id,
      mode: "manual",
      seconds: 50,
    }),
    /duplicate_sample/,
  );
  const different = await s.protocol(a, {
    name: "另一协议",
    definition: "不同测量口径",
  });
  assert.equal((await s.measurements(a, different.id)).efficiency, null);
});
