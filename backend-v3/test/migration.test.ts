import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { testDatabase, actor } from "./helpers.js";
import { migrateLegacy } from "../src/operations/migration.js";
import { FileStore } from "../src/files/storage.js";
import { decodeRaw } from "../src/parsing/profile.js";
test("legacy import dry-run is read-only, receipt is idempotent, missing relations block and raw archives remain lossless", async (t) => {
  const { db, cleanup } = await testDatabase();
  t.after(cleanup);
  const a = await actor(db),
    dir = await mkdtemp(path.join(os.tmpdir(), "v3-migrate-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FileStore(dir),
    raw = "历史合成\u0000\ud800",
    bundle = {
      revision: 40,
      data: {
        jobs: [
          { id: "j1", name: "历史岗位", status: "在招", skills: ["Python"] },
        ],
        talents: [
          { id: "t1", name: "历史候选人", jobId: "j1", status: "待筛选", raw },
        ],
        interviews: [],
      },
      snapshots: [{ raw }],
    };
  const dry = await migrateLegacy(db, store, a, bundle, true);
  assert.equal(dry.ready, true);
  assert.equal(
    (await db.query("SELECT count(*) FROM candidates")).rows[0].count,
    "0",
  );
  const first = await migrateLegacy(db, store, a, bundle, false);
  assert.equal(first.imported, true);
  const second = await migrateLegacy(db, store, a, bundle, false);
  assert.equal(second.alreadyImported, true);
  assert.equal(
    (await db.query("SELECT count(*) FROM candidates")).rows[0].count,
    "1",
  );
  assert.equal(
    decodeRaw(
      (await db.query("SELECT raw_bytes FROM parse_results")).rows[0].raw_bytes,
    ),
    raw,
  );
  const archival = (
    await db.query("SELECT data_bytes FROM legacy_archives WHERE kind='bundle'")
  ).rows[0];
  assert.deepEqual(JSON.parse(decodeRaw(archival.data_bytes)), bundle);
  const bad = { ...bundle, revision: 41, data: { ...bundle.data, jobs: [] } };
  assert.equal((await migrateLegacy(db, store, a, bad, true)).ready, false);
  await assert.rejects(
    migrateLegacy(db, store, a, bad, false),
    /migration_conflicts/,
  );
  const changed = {
    ...bundle,
    revision: 41,
    data: {
      ...bundle.data,
      talents: [{ ...bundle.data.talents[0], name: "新名字" }],
    },
  };
  await assert.rejects(
    migrateLegacy(db, store, a, changed, false),
    /migration_target_not_empty/,
  );
});

test("v1 flat backup preserves explicit corrected profile, all nine stages, dates and provenance without inventing originals", async (t) => {
  const { db, cleanup } = await testDatabase();
  t.after(cleanup);
  const a = await actor(db),
    dir = await mkdtemp(path.join(os.tmpdir(), "legacy-flat-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stages = [
    "待筛选",
    "初筛通过",
    "面试中",
    "资料收集中",
    "背调中",
    "已发 offer",
    "已入职",
    "录用终止",
    "已淘汰",
  ];
  const bundle = {
    v: 1,
    jobs: [
      {
        id: "j1",
        name: "Synthetic legacy job",
        level: "P6",
        salary: "20-30k",
        mktSalary: "25-35k",
        mktSource: "Synthetic internal reference",
        exp: "3-5年",
        school: "Synthetic preferred school",
        created: 1600000000000,
      },
    ],
    talents: stages.map((status, n) => ({
      id: "t" + n,
      name: "Synthetic legacy 🧪 " + n,
      jobId: "j1",
      status,
      raw: "姓名：原解析姓名\n学校：原解析学校\n技能：Python\u0000\ud800",
      school: "人工更正学校",
      bachelorSchool: "人工更正本科",
      edu: "硕士",
      years: 7,
      firstJobYear: 2019,
      phone: "13000000000",
      skills: ["Java"],
      companies: ["Synthetic Company"],
      age: 31,
      gender: "未注明",
      created: 1610000000000,
      updated: 1620000000000,
      source: "Synthetic source",
      note: "Preserve note",
      termReason: "主动放弃",
      termDetail: "Synthetic reason",
      collectedAt: 1615000000000,
      rejectReason: "岗位调整",
      revisions: [{ at: 1618000000000, note: "Synthetic correction" }],
    })),
    interviews: [],
  };
  const dry = await migrateLegacy(db, new FileStore(dir), a, bundle, true);
  assert.equal(dry.ready, true);
  assert.ok(dry.warnings.includes("original_binary_unavailable"));
  await migrateLegacy(db, new FileStore(dir), a, bundle, false);
  const rows = (
    await db.query(
      "SELECT p.profile,p.created_at,p.updated_at,a.status,a.note,a.collected_at,a.term_reason,a.reject_reason FROM candidates p JOIN applications a ON a.candidate_id=p.id ORDER BY p.profile->>'name'",
    )
  ).rows;
  assert.deepEqual(
    rows.map((x) => x.status),
    [
      "screening",
      "screened",
      "interviewing",
      "collecting",
      "background_check",
      "offered",
      "hired",
      "terminated",
      "rejected",
    ],
  );
  for (const r of rows) {
    assert.ok(r.profile.name.includes("🧪"));
    assert.equal(r.profile.school, "人工更正学校");
    assert.equal(r.profile.bachelorSchool, "人工更正本科");
    assert.equal(r.profile.education, "master");
    assert.equal(r.profile.experienceYears, 7);
    assert.deepEqual(r.profile.skills, ["Java"]);
    assert.equal(r.created_at.getTime(), 1610000000000);
    assert.equal(r.updated_at.getTime(), 1620000000000);
    assert.equal(r.note, "Preserve note");
    assert.equal(r.collected_at.getTime(), 1615000000000);
  }
  assert.equal(rows[7].term_reason, "主动放弃");
  assert.equal(rows[8].reject_reason, "岗位调整");
  const j = (await db.query("SELECT * FROM jobs")).rows[0];
  assert.equal(j.level, "P6");
  assert.equal(j.salary_range, "20-30k");
  assert.equal(j.market_source, "Synthetic internal reference");
  const requirements = (await db.query("SELECT requirements FROM job_versions"))
    .rows[0].requirements;
  assert.equal(requirements.experienceYears, 3);
  assert.equal(requirements.experienceMaxYears, 5);
  assert.deepEqual(requirements.schoolPreferences, [
    "Synthetic preferred school",
  ]);
  assert.equal(
    (await db.query("SELECT count(*) FROM application_events")).rows[0].count,
    "0",
  );
  const parsed = (
    await db.query(
      "SELECT evidence,human_corrections FROM parse_results LIMIT 1",
    )
  ).rows[0];
  assert.ok(!parsed.evidence.some((e: any) => e.field === "school"));
  assert.ok(
    parsed.human_corrections.some(
      (x: any) =>
        x.field === "school" &&
        x.value === "人工更正学校" &&
        x.reason.includes("历史"),
    ),
  );
  assert.equal(
    (await db.query("SELECT count(*) FROM resume_documents WHERE kind='paste'"))
      .rows[0].count,
    "9",
  );
  assert.deepEqual(
    JSON.parse(
      decodeRaw(
        (
          await db.query(
            "SELECT data_bytes FROM legacy_archives WHERE kind='bundle'",
          )
        ).rows[0].data_bytes,
      ),
    ),
    bundle,
  );
});

test("legacy school credentials require the encrypted campus import path and never enter plaintext archives", async (t) => {
  const { db, cleanup } = await testDatabase();
  t.after(cleanup);
  const a = await actor(db),
    dir = await mkdtemp(path.join(os.tmpdir(), "legacy-secret-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bundle = {
    jobs: [],
    talents: [],
    interviews: [],
    campuses: [{ account: "Synthetic account", password: "Synthetic secret" }],
  };
  const dry = await migrateLegacy(db, new FileStore(dir), a, bundle, true);
  assert.equal(dry.ready, false);
  assert.ok(
    dry.conflicts.includes("campus_credentials_require_encrypted_import"),
  );
  await assert.rejects(
    migrateLegacy(db, new FileStore(dir), a, bundle, false),
    /migration_conflicts/,
  );
  assert.equal(
    (await db.query("SELECT count(*) FROM legacy_archives")).rows[0].count,
    "0",
  );
});
