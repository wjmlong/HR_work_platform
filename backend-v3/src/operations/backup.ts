import { preflightCampusKeys } from "../campus/vault.js";
import {
  mkdir,
  readFile,
  writeFile,
  copyFile,
  stat,
  access,
} from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Database } from "../db.js";
import {isolatedDatabaseUrl} from '../config.js';
import {coreDefinition} from '../business-config/defaults.js';
import {validateDocument} from '../business-config/schema.js';
import { FileStore } from "../files/storage.js";
import { fail } from "../http/errors.js";
import {CURRENT_TABLES,LEGACY_V4_TABLES,CONFIGURATION_V13_TABLES,CONFIGURATION_V15_TABLES,CONFIGURATION_V16_TABLES,CONFIGURATION_V17_TABLES,CONFIGURATION_V20_TABLES,CONFIGURATION_V21_TABLES,CONFIGURATION_V22_TABLES,CONFIGURATION_V23_TABLES,CONFIGURATION_V26_TABLES,CONFIGURATION_REF_TABLES,ARCHIVE_SCHEMA_REVISION,ARCHIVE_COMPATIBLE_REVISIONS} from './archive-schema.js';
export const TABLES = CURRENT_TABLES;
const hash = (v: Buffer | string) =>
  createHash("sha256").update(v).digest("hex");
export type Manifest = {
  version: 3|4;
  // Omitted archives retain document metadata and parsed business data, but
  // contain no resume attachment bytes. Historical manifests are full backups.
  fileMode?: 'full' | 'omitted';
  schemaRevision?:number;
  columns?:Record<string,string[]>;
  sourceSchema: string;
  createdAt: string;
  databaseHash: string;
  configHash: string;
  tables: Record<string, { count: number; hash: string }>;
  files: { key: string; size: number; hash: string }[];
};
function encode(row: any) {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k,
      Buffer.isBuffer(v) ? "\\x" + v.toString("hex") : v,
    ]),
  );
}
export async function snapshot(db: Database, runtimeShape=false) {
  return db.tx(async (c) => {
    await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const actual = (
      await c.query("SELECT tablename FROM pg_tables WHERE schemaname=$1", [
        db.config.schema,
      ])
    ).rows.map((x) => x.tablename);
    const selected=(runtimeShape?[LEGACY_V4_TABLES,CONFIGURATION_V13_TABLES,CONFIGURATION_V15_TABLES,CONFIGURATION_V16_TABLES,CONFIGURATION_V17_TABLES,CONFIGURATION_V20_TABLES,CONFIGURATION_V21_TABLES,CONFIGURATION_V22_TABLES,CONFIGURATION_V23_TABLES,CONFIGURATION_V26_TABLES,CURRENT_TABLES]:[TABLES]).find(shape=>actual.length===shape.length&&actual.every(t=>shape.includes(t)));
    if(!selected)fail(500,'backup_schema_mismatch');
    const tables: Record<string, any[]> = {};
    for (const table of selected) {
      const rows = (await c.query("SELECT * FROM " + table)).rows.map(encode);
      tables[table] = rows.sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b), "en"),
      );
    }
    return tables;
  });
}
export async function backup(
  db: Database,
  store: FileStore,
  directory: string,
  runtimeShape=false,
): Promise<Manifest> {
  try {
    await access(directory);
    fail(409, "backup_destination_exists");
  } catch (e) {
    if ((e as any).code !== "ENOENT") throw e;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(path.join(directory, "files"), { mode: 0o700 });
  const tables = await snapshot(db,runtimeShape),
    database = JSON.stringify(tables),
    config = JSON.stringify(db.config);
  preflightCampusKeys(db.config.campusKeyFile, tables.campuses || []);
  const files: Manifest["files"] = [];
  for (const key of [
    ...new Set(tables.resume_documents.map((d) => d.blob_key)),
  ]) {
    const bytes = await store.read(key);
    await writeFile(path.join(directory, "files", key), bytes, { mode: 0o600 });
    files.push({ key, size: bytes.length, hash: hash(bytes) });
  }
  const manifest: Manifest = {
    version:Object.keys(tables).length===LEGACY_V4_TABLES.length?3:4,
    schemaRevision:Math.max(...tables.schema_migrations.map(r=>r.version).filter(n=>n<1000)),
    columns:Object.fromEntries(Object.entries(await archiveColumns(db)).filter(([t])=>Object.hasOwn(tables,t))),
    sourceSchema: db.config.schema,
    createdAt: new Date().toISOString(),
    databaseHash: hash(database),
    configHash: hash(config),
    tables: Object.fromEntries(
      Object.keys(tables).map((t) => [
        t,
        { count: tables[t].length, hash: hash(JSON.stringify(tables[t])) },
      ]),
    ),
    files,
  };
  await writeFile(path.join(directory, "database.json"), database, {
    mode: 0o600,
  });
  await writeFile(path.join(directory, "private-config.json"), config, {
    mode: 0o600,
  });
  await writeFile(
    path.join(directory, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    { mode: 0o600 },
  );
  return manifest;
}
export async function restore(
  db: Database,
  store: FileStore,
  directory: string,
) {
  isolatedDatabaseUrl(db.config.databaseUrl);
  if (
    !/^recruit_test_[a-z0-9]{1,48}$/.test(db.config.schema) ||
    new URL(db.config.databaseUrl).hostname !== "127.0.0.1" ||
    new URL(db.config.databaseUrl).port !== "55434" ||
    new URL(db.config.databaseUrl).pathname !== "/recruit_v4"
  )
    fail(403, "restore_requires_empty_test_schema");
  const { manifest, tables } = await readArchive(db, store, directory, TABLES, false);
  await db.tx(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "restore:" + db.config.schema,
    ]);
    // Ordinary writers do not take the restore advisory lock. Lock before the
    // empty check, so a committed write is either observed or waits until commit.
    await c.query(
      "LOCK TABLE " + TABLES.join(",") + " IN ACCESS EXCLUSIVE MODE",
    );
    for (const t of TABLES.filter(
      (t) => !["schema_migrations", "dictionary_versions"].includes(t),
    ))
      if (Number((await c.query("SELECT count(*) FROM " + t)).rows[0].count))
        fail(409, "restore_target_not_empty");
    const currentMigrations=(await c.query('SELECT * FROM schema_migrations')).rows;
    if(manifest.version===3||(manifest.schemaRevision??0)<ARCHIVE_SCHEMA_REVISION)for(const row of currentMigrations)if(!tables.schema_migrations.some((old:any)=>old.version===row.version))tables.schema_migrations.push(row);
    for(const row of tables.interviewers)if(row.temporary_access===undefined)row.temporary_access=false;
    for(const row of tables.candidates)if(row.archive_reason===undefined)row.archive_reason="";
    await c.query("TRUNCATE " + TABLES.join(",") + " RESTART IDENTITY CASCADE");
    for (const t of TABLES)
      if (tables[t].length)
        await c.query(
          "INSERT INTO " +
            t +
            " SELECT * FROM json_populate_recordset(NULL::" +
            t +
            ",$1::json)",
          [JSON.stringify(tables[t])],
        );
    for (const t of ["lead_events", "application_events", "audit_events"])
      await c.query(
        "SELECT setval(pg_get_serial_sequence($1,'id'),coalesce((SELECT max(id) FROM " +
          t +
          "),1),(SELECT count(*)>0 FROM " +
          t +
          "))",
        [t],
      );
    // Files are content addressed and immutable; a failed SQL restore may leave reclaimable blobs.
    for (const file of manifest.files) {
      const bytes = await readArchiveFile(store, directory, file);
      await mkdir(store.root, { recursive: true, mode: 0o700 });
      await writeFile(store.path(file.key), bytes, { mode: 0o600 });
    }
  });
  return {
    restored: true,
    tables: manifest.tables,
    files: manifest.files.length,
  };
}

export async function archiveColumns(db:Database):Promise<Record<string,string[]>>{
 const rows=(await db.query('SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 ORDER BY table_name,column_name',[db.config.schema])).rows;
 return Object.fromEntries(TABLES.map(t=>[t,rows.filter(r=>r.table_name===t).map(r=>r.column_name)]));
}
export async function readArchive(
  db: Database,
  store: FileStore,
  directory: string,
  expected: readonly string[] = TABLES,
  loadBlobs = true,
) {
  const manifest = JSON.parse(
      await readFile(path.join(directory, "manifest.json"), "utf8"),
    ) as Manifest,
    database = await readFile(path.join(directory, "database.json")),
    config = await readFile(path.join(directory, "private-config.json"));
  if (
    ![3,4].includes(manifest.version) ||
    database.length > 512 * 1024 * 1024 ||
    hash(database) !== manifest.databaseHash ||
    hash(config) !== manifest.configHash
  )
    fail(422, "backup_integrity");
  const tables = JSON.parse(database.toString("utf8"));
  const sourceTables=expected===TABLES?(manifest.version===3?LEGACY_V4_TABLES:(manifest.schemaRevision??0)<14?CONFIGURATION_V13_TABLES:(manifest.schemaRevision??0)<16?CONFIGURATION_V15_TABLES:manifest.schemaRevision===16?CONFIGURATION_V16_TABLES:manifest.schemaRevision===17?CONFIGURATION_V17_TABLES:manifest.schemaRevision!<21?CONFIGURATION_V20_TABLES:manifest.schemaRevision===21?CONFIGURATION_V21_TABLES:manifest.schemaRevision===22?CONFIGURATION_V22_TABLES:manifest.schemaRevision===23?CONFIGURATION_V23_TABLES:(manifest.schemaRevision??0)<27?CONFIGURATION_V26_TABLES:TABLES):expected;
  if(manifest.version===4&&(!ARCHIVE_COMPATIBLE_REVISIONS.includes(manifest.schemaRevision!)||!manifest.columns))fail(422,'backup_integrity');
  if (Object.keys(tables).length !== sourceTables.length||Object.keys(manifest.tables).length!==sourceTables.length)
    fail(422, "backup_integrity");
  for (const t of sourceTables)
    if (
      !Array.isArray(tables[t]) ||
      manifest.tables[t]?.count !== tables[t].length ||
      manifest.tables[t]?.hash !== hash(JSON.stringify(tables[t]))
    )
      fail(422, "backup_integrity");
  if(manifest.version===4){
   const columns=await archiveColumns(db);
   if(Object.keys(manifest.columns!).length!==sourceTables.length)fail(422,'backup_integrity');
   for(const t of sourceTables){
    const fields=manifest.columns![t];
    const targetFields=columns[t].filter(k=>!(manifest.schemaRevision!<15&&((t==='users'&&k==='dashboard_preferences')||(t==='jobs'&&k==='question_bank')))&&!(manifest.schemaRevision!<19&&t==='candidates'&&['archived_at','archive_reason'].includes(k))&&!(manifest.schemaRevision!<20&&t==='interviews'&&k==='deleted_at')&&!(manifest.schemaRevision!<22&&t==='interviewers'&&k==='temporary_access')&&!(manifest.schemaRevision!<26&&t==='parse_results'&&k==='recognition'));
    if(!Array.isArray(fields)||JSON.stringify([...fields].sort())!==JSON.stringify(targetFields)||tables[t].some((r:any)=>!r||typeof r!=='object'||Array.isArray(r)||JSON.stringify(Object.keys(r).sort())!==JSON.stringify(targetFields)))fail(422,'backup_integrity');
   }
  }else{
   // Historical formats allow absent later columns, never unknown source
   // columns: json_populate_recordset otherwise silently discards their data.
   const columns=await archiveColumns(db);
   for(const t of sourceTables)for(const row of tables[t])if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).some(k=>!columns[t]?.includes(k)))fail(422,'backup_column_mismatch:'+t);
   for(const t of CONFIGURATION_REF_TABLES)for(const row of tables[t]||[])if(!Object.hasOwn(row,'configuration_refs'))row.configuration_refs={};
  }
  if(expected===TABLES)for(const t of TABLES)if(!tables[t])tables[t]=[];
  for(const header of tables.business_configs||[]){
   if(!header.published_version)continue;
   const current=(tables.business_config_versions||[]).find((r:any)=>r.config_id===header.id&&r.version===header.published_version);
   if(!current)fail(422,'backup_configuration_unsupported');
   const doc=validateDocument(current.document);
   if(doc.kind==='fields'&&doc.fields.some(f=>f.coreKey&&!coreDefinition(doc.entity).fields.some(c=>c.coreKey===f.coreKey&&c.fieldId===f.fieldId&&c.type===f.type)))fail(422,'backup_configuration_unsupported');
  }
  preflightCampusKeys(db.config.campusKeyFile, tables.campuses || []);
  const keys = [
    ...new Set<string>(tables.resume_documents.map((d: any) => d.blob_key)),
  ];
  if (!Array.isArray(manifest.files) ||
    (manifest.fileMode !== undefined && !['full','omitted'].includes(manifest.fileMode)) ||
    (manifest.fileMode === 'omitted' ? manifest.files.length !== 0 : (
      keys.length !== manifest.files.length ||
      new Set(manifest.files.map(f=>f.key)).size !== manifest.files.length ||
      keys.some((k) => !manifest.files.some((f) => f.key === k))
    )))
    fail(422, "backup_integrity");
  const blobs = new Map<string, Buffer>();
  for (const f of manifest.files) {
    const bytes = await readArchiveFile(store, directory, f);
    if (loadBlobs) blobs.set(f.key, bytes);
  }
  return { manifest, tables, blobs };
}

async function readArchiveFile(store: FileStore, directory: string, file: Manifest['files'][number]) {
  store.path(file.key);
  const location = path.join(directory, 'files', file.key), info = await stat(location);
  if (!info.isFile() || info.size !== file.size || info.size > 10 * 1024 * 1024 || file.hash !== file.key)
    fail(422, 'backup_integrity');
  const bytes = await readFile(location);
  if (bytes.length !== file.size || hash(bytes) !== file.hash) fail(422, 'backup_integrity');
  return bytes;
}
