import {queueMatches} from '../business-config/bindings.js';
import {Identity} from '../identity/service.js';
import {FeishuProvider} from '../identity/provider.js';
import { recoverLegacyFacts } from "./recover-legacy.js";
import { mkdir, writeFile } from "node:fs/promises";
import type { Database } from "../db.js";
import {isolatedDatabaseUrl} from '../config.js';
import { FileStore } from "../files/storage.js";
import { TABLES, readArchive } from "./backup.js";
import { Dictionary } from "../dictionary/service.js";
import { fail } from "../http/errors.js";
import {LEGACY_V3_TABLES} from './archive-schema.js';
export const V3_TABLES=LEGACY_V3_TABLES;
const ephemeral = new Set([
  "sessions",
  "oauth_states",
  "rate_limits",
  "idempotency_keys",
]);
export async function upgradeV3(
  db: Database,
  store: FileStore,
  directory: string,
  dryRun = true,
) {
  const url = isolatedDatabaseUrl(db.config.databaseUrl);
  if (
    url.hostname !== "127.0.0.1" ||
    url.port !== "55434" ||
    url.pathname !== "/recruit_v4" ||
    !/^recruit_(v4|test_[a-z0-9]{1,48})$/.test(db.config.schema)
  )
    fail(403, "upgrade_requires_isolated_v4");
  const { manifest, tables, blobs } = await readArchive(
    db,
    store,
    directory,
    V3_TABLES,
  );
  const versions = tables.schema_migrations.map((r: any) => r.version);
  if (versions.some((v: number) => v > 4 && v < 1000))
    fail(422, "unsupported_upgrade_schema");
  const conflicts: string[] = [];
  const counts = new Map<string, number>();
  for (const app of tables.applications) {
    if (app.deleted_at) continue;
    counts.set(app.candidate_id, (counts.get(app.candidate_id) || 0) + 1);
  }
  if ([...counts.values()].some((n) => n > 1))
    conflicts.push("parallel_workflows_require_explicit_resolution");
  const admin = tables.users.find(
    (u: any) =>
      u.status === "active" && u.directory_active && u.roles.includes("admin"),
  );
  if (!admin && tables.applications.length)
    conflicts.push("approved_admin_required_for_recomputation");
  const report = {
    ready: conflicts.length === 0,
    conflicts,
    sourceHash: manifest.databaseHash,
    sourceSchema: manifest.sourceSchema,
    sourceCounts: Object.fromEntries(
      V3_TABLES.map((t) => [t, tables[t].length]),
    ),
    files: manifest.files.length,
    excluded: Object.fromEntries(
      [...ephemeral].map((t) => [t, tables[t].length]),
    ),
    warnings: [
      "sessions_require_fresh_feishu_login",
      "legacy_completed_interviews_have_no_inferred_pass_fail",
    ],
  };
  if (dryRun) return report;
  if (!report.ready) fail(409, "upgrade_conflicts");
  await db.tx(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "upgrade:" + db.config.schema,
    ]);
    await c.query(
      "LOCK TABLE " + TABLES.join(",") + " IN ACCESS EXCLUSIVE MODE",
    );
    for (const name of TABLES.filter(
      (t) => !["schema_migrations", "dictionary_versions"].includes(t),
    ))
      if (Number((await c.query("SELECT count(*) FROM " + name)).rows[0].count))
        fail(409, "upgrade_target_not_empty");
    await c.query("DELETE FROM dictionary_versions");
    for (const t of V3_TABLES) {
      if (t === "schema_migrations") {
        for (const row of tables[t].filter((r: any) => r.version >= 1000))
          await c.query(
            "INSERT INTO schema_migrations(version,applied_at) VALUES($1,$2) ON CONFLICT DO NOTHING",
            [row.version, row.applied_at],
          );
        continue;
      }
      if (ephemeral.has(t)) continue;
      const rows = tables[t].map((row: any) => ({ ...row }));
      if (t === "jobs")
        for (const row of rows) row.requirements_version = row.version;
      if (t === "interviews")
        for (const row of rows) {
          row.status =
            row.status === "completed"
              ? "legacy_completed"
              : row.status === "confirmed"
                ? "pending"
                : row.status;
          const participants = tables.interviewers.filter(
            (x: any) => x.interview_id === row.id,
          );
          row.primary_interviewer_id =
            participants.length === 1 ? participants[0].user_id : null;
        }
      if (t === "evaluations")
        for (const row of rows) row.last_editor_id = row.author_id;
      if (t === "evaluation_versions")
        for (const row of rows)
          row.editor_id =
            tables.evaluations.find((e: any) => e.id === row.evaluation_id)
              ?.author_id || null;
      if (t === "tasks")
        for (const row of rows)
          if (row.state === "running") {
            row.state = "queued";
            row.worker_id = null;
            row.lease_until = null;
            row.claim_token += 1;
          }
      if (!rows.length) continue;
      const available = new Set(
        (
          await c.query(
            "SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2",
            [db.config.schema, t],
          )
        ).rows.map((r) => r.column_name),
      );
      const columns = Object.keys(rows[0]);
      if (
        columns.some(
          (key) => !available.has(key) || !/^[a-z][a-z0-9_]*$/.test(key),
        ) ||
        rows.some(
          (row: any) =>
            Object.keys(row).length !== columns.length ||
            columns.some((key) => !Object.hasOwn(row, key)),
        )
      )
        fail(422, "upgrade_column_mismatch");
      const list = columns.join(",");
      await c.query(
        "INSERT INTO " +
          t +
          "(" +
          list +
          ") SELECT " +
          list +
          " FROM json_populate_recordset(NULL::" +
          t +
          ",$1::json)",
        [JSON.stringify(rows)],
      );
    }
    for (const name of ["lead_events", "application_events", "audit_events"])
      await c.query(
        "SELECT setval(pg_get_serial_sequence($1,'id'),coalesce((SELECT max(id) FROM " +
          name +
          "),1),(SELECT count(*)>0 FROM " +
          name +
          "))",
        [name],
      );
    await new Dictionary(db).seed();
    if (admin) await recoverLegacyFacts(db, admin.id);
    if(admin){const ids=(await c.query('SELECT id FROM applications WHERE is_current AND deleted_at IS NULL AND resume_version_id IS NOT NULL ORDER BY id')).rows.map(r=>r.id);await queueMatches(new Identity(db,db.config,new FeishuProvider(db.config)),c,ids,admin.id,{reason:'controlled_v3_upgrade'});}
    // Original archive remains private and untouched. Only content-addressed immutable blobs are copied.
    await mkdir(store.root, { recursive: true, mode: 0o700 });
    for (const [key, bytes] of blobs)
      await writeFile(store.path(key), bytes, { mode: 0o600 });
  });
  return { ...report, imported: true };
}
