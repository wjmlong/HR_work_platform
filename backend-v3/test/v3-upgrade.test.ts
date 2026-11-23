import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { testDatabase, actor } from "./helpers.js";
import { backup, TABLES } from "../src/operations/backup.js";
import { FileStore } from "../src/files/storage.js";
import { Identity } from "../src/identity/service.js";
import { FeishuProvider } from "../src/identity/provider.js";
import { RecruitingService } from "../src/recruiting/service.js";
import { InterviewService } from "../src/interviews/service.js";
import { migrateLegacy } from "../src/operations/migration.js";
import { upgradeV3, V3_TABLES } from "../src/operations/upgrade-v3.js";
import {verifyBusinessConfigUpgrade} from '../src/operations/business-config-upgrade.js';
const hash = (x: string) => createHash("sha256").update(x).digest("hex");
test("V3 read-only archive upgrade preserves identities, grants, profile/history/file IDs and exact bytes while retaining V4 migrations and honest legacy interview outcome", async (t) => {
  const source = await testDatabase(),
    dest = await testDatabase();
  t.after(source.cleanup);
  t.after(dest.cleanup);
  const dir = await mkdtemp(path.join(os.tmpdir(), "v3-upgrade-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FileStore(path.join(dir, "files")),
    target = new FileStore(path.join(dir, "target")),
    a = await actor(source.db);
  await migrateLegacy(
    source.db,
    store,
    a,
    {
      revision: 41,
      data: {
        jobs: [{ id: "j", name: "Synthetic preserved job" }],
        talents: [
          {
            id: "t",
            name: "Synthetic preserved profile",
            jobId: "j",
            status: "已入职",
            school: "Synthetic corrected school",
            raw: "Synthetic preserved\u0000\ud800",
            note: "Synthetic 🧪 𠀀 note",
          },
        ],
        interviews: [],
      },
    },
    false,
  );
  const app = (await source.db.query("SELECT * FROM applications")).rows[0],
    job = (await source.db.query("SELECT * FROM jobs")).rows[0];
  await source.db.query(
    "UPDATE jobs SET version=2,requirements_version=2 WHERE id=$1",
    [job.id],
  );
  await source.db.query(
    "INSERT INTO job_versions(job_id,version,requirements,actor_id) SELECT job_id,2,requirements,actor_id FROM job_versions WHERE job_id=$1",
    [job.id],
  );
  await source.db.query(
    "INSERT INTO application_grants(application_id,user_id) VALUES($1,$2)",
    [app.id, a.id],
  );
  const identity = new Identity(
    source.db,
    source.config,
    new FeishuProvider(source.config),
  );
  const iv = await new InterviewService(identity).create(a, {
    applicationId: app.id,
    round: 1,
    startsAt: "2030-01-01T00:00:00Z",
    durationMinutes: 45,
    form: "online",
    interviewerIds: [a.id],
  });
  await source.db.query(
    "INSERT INTO sessions(token_hash,user_id,csrf,user_version,expires_at) VALUES('synthetic-token',$1,'synthetic-csrf',1,now()+interval '1 day')",
    [a.id],
  );
  const archive = path.join(dir, "archive");
  await backup(source.db, store, archive);
  const tables = JSON.parse(
      await readFile(path.join(archive, "database.json"), "utf8"),
    ),
    manifest = JSON.parse(
      await readFile(path.join(archive, "manifest.json"), "utf8"),
    );
  for (const name of TABLES) if (!V3_TABLES.includes(name)) delete tables[name];
  // Emulate V3's old mapper omitting an explicit source correction; the untouched bundle retains it.
  for (const table of [
    "candidates",
    "candidate_profile_versions",
    "parse_results",
  ])
    for (const row of tables[table]) row.profile.school = "Old parser school";
  const newColumns: Record<string, string[]> = {
    jobs: [
      "requirements_version",
      "level",
      "salary_range",
      "market_salary",
      "market_source",
      "salary_note",
      "market_reference_date",
      "close_reason",
      "closed_at",
    ],
    job_versions: ["level", "internal_salary"],
    applications: [
      "is_current",
      "transfer_from_id",
      "transfer_to_id",
      "collected_at",
      "term_reason",
      "term_detail",
    ],
    application_events: [
      "opinion",
      "term_reason",
      "term_detail",
      "cc",
      "cc_snapshot",
      "from_job_id",
      "to_job_id",
      "interaction",
    ],
    candidates: ["merged_into_id"],
    match_snapshots: ["reference_score"],
    interviews: [
      "primary_interviewer_id",
      "location",
      "meeting_url",
      "feedback",
    ],
    evaluations: ["last_editor_id"],
    evaluation_versions: ["editor_id"],
  };
  for (const [name, cols] of Object.entries(newColumns))
    for (const row of tables[name]) for (const col of cols) delete row[col];
  tables.schema_migrations = tables.schema_migrations.filter(
    (r: any) => r.version <= 4 || r.version === 1001,
  );
  tables.interviews[0].status = "completed";
  // This fixture represents the historical V3 format, not today's writer.
  manifest.version=3;delete manifest.schemaRevision;delete manifest.columns;
  for(const rows of Object.values(tables) as any[][])for(const row of rows)delete row.configuration_refs;
  manifest.tables = Object.fromEntries(
    Object.entries(tables).map(([name, rows]) => [
      name,
      { count: (rows as any[]).length, hash: hash(JSON.stringify(rows)) },
    ]),
  );
  const database = JSON.stringify(tables);
  manifest.databaseHash = hash(database);
  await writeFile(path.join(archive, "database.json"), database);
  await writeFile(
    path.join(archive, "manifest.json"),
    JSON.stringify(manifest),
  );
  const dry = await upgradeV3(dest.db, target, archive, true);
  assert.equal(dry.ready, true);
  assert.equal(dry.excluded.sessions, 1);
  assert.equal(
    (await dest.db.query("SELECT count(*) FROM users")).rows[0].count,
    "0",
  );
  await upgradeV3(dest.db, target, archive, false);
  assert.deepEqual(
    (await dest.db.query("SELECT id,roles,status,version FROM users")).rows,
    (await source.db.query("SELECT id,roles,status,version FROM users")).rows,
  );
  assert.equal(
    (await dest.db.query("SELECT profile FROM candidates")).rows[0].profile
      .school,
    "Synthetic corrected school",
  );
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        (
          await dest.db.query(
            "SELECT * FROM candidate_profile_versions WHERE version=1",
          )
        ).rows,
      ),
    ),
    tables.candidate_profile_versions.map((row:any)=>({...row,configuration_refs:{}})),
  );
  assert.equal(
    (await dest.db.query("SELECT count(*) FROM candidate_profile_versions"))
      .rows[0].count,
    "2",
  );
  assert.deepEqual(
    (await dest.db.query("SELECT * FROM application_grants")).rows,
    (await source.db.query("SELECT * FROM application_grants")).rows,
  );
  const after = (await dest.db.query("SELECT * FROM applications")).rows[0];
  assert.equal(after.id, app.id);
  assert.equal(after.status, "hired");
  assert.equal(after.note, "Synthetic 🧪 𠀀 note");
  assert.equal(after.is_current, true);
  assert.equal(
    (await dest.db.query("SELECT requirements_version FROM jobs")).rows[0]
      .requirements_version,
    2,
  );
  const interview = (
    await dest.db.query("SELECT * FROM interviews WHERE id=$1", [iv.id])
  ).rows[0];
  assert.equal(interview.status, "legacy_completed");
  assert.equal(interview.primary_interviewer_id, a.id);
  assert.equal(
    (await dest.db.query("SELECT count(*) FROM sessions")).rows[0].count,
    "0",
  );
  assert.ok(
    (await dest.db.query("SELECT version FROM schema_migrations")).rows.some(
      (r) => r.version === 10,
    ),
  );
  for (const doc of tables.resume_documents)
    assert.deepEqual(
      await target.read(doc.blob_key),
      await store.read(doc.blob_key),
    );
  await dest.db.migrate();
  await assert.rejects(
    upgradeV3(dest.db, target, archive, false),
    /upgrade_target_not_empty/,
  );
  const verified=await testDatabase();t.after(verified.cleanup);
  const receipt=await verifyBusinessConfigUpgrade({archiveDirectory:archive,testConfig:verified.config,storeRoot:path.join(dir,'verified')});
  assert.equal(receipt.invariantMode,'v3_mapped_with_explicit_column_exceptions');
  assert.equal(receipt.sourceRevision,4);assert.equal(receipt.preserved,true);assert.equal(receipt.writeProbe.persisted,true);
});
