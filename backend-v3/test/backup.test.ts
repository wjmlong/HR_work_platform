import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { testDatabase, actor } from "./helpers.js";
import { FileStore } from "../src/files/storage.js";
import { backup, restore } from "../src/operations/backup.js";
import { encodeRaw, decodeRaw } from "../src/parsing/profile.js";
test("backup restores actual relational rows private files raw NUL and sequences into empty guarded schema", async (t) => {
  const source = await testDatabase(),
    dest = await testDatabase();
  t.after(source.cleanup);
  t.after(dest.cleanup);
  const dir = await mkdtemp(path.join(os.tmpdir(), "v3-backup-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const a = await actor(source.db),
    files = new FileStore(path.join(dir, "source")),
    target = new FileStore(path.join(dir, "target")),
    f = await files.put("a.txt", Buffer.from("合成原文件"));
  const doc = (
    await source.db.query(
      "INSERT INTO resume_documents(blob_key,sha256,file_name,file_size,kind,owner_id) VALUES($1,$1,$2,$3,$4,$5) RETURNING id",
      [f.sha256, f.name, f.size, f.kind, a.id],
    )
  ).rows[0];
  const raw = "合成原文\u0000\ud800";
  await source.db.query(
    "INSERT INTO parse_results(document_id,raw_bytes,profile,evidence,parser_version) VALUES($1,$2,'{}','[]','test')",
    [doc.id, encodeRaw(raw)],
  );
  await source.db.query(
    "INSERT INTO audit_events(actor_id,kind,instance) VALUES($1,'backup-test','test')",
    [a.id],
  );
  const archive = path.join(dir, "archive"),
    manifest = await backup(source.db, files, archive);
  assert.equal(manifest.files.length, 1);
  await restore(dest.db, target, archive);
  assert.equal(
    decodeRaw(
      (await dest.db.query("SELECT raw_bytes FROM parse_results")).rows[0]
        .raw_bytes,
    ),
    raw,
  );
  assert.deepEqual(await target.read(f.sha256), await files.read(f.sha256));
  const audit = (
    await dest.db.query(
      "INSERT INTO audit_events(kind,instance) VALUES('after-restore','test') RETURNING id",
    )
  ).rows[0];
  assert.equal(audit.id, "2");
  await assert.rejects(
    restore(dest.db, target, archive),
    /restore_target_not_empty/,
  );
  const file = path.join(archive, "database.json");
  await writeFile(file, (await readFile(file, "utf8")) + " ");
  const empty = await testDatabase();
  t.after(empty.cleanup);
  await assert.rejects(restore(empty.db, target, archive), /backup_integrity/);
  assert.equal(
    (await empty.db.query("SELECT count(*) FROM users")).rows[0].count,
    "0",
  );
});
