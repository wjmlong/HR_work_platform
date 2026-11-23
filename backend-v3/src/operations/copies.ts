import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Database } from "../db.js";
import { Identity, requireRole, type Actor } from "../identity/service.js";
import { FeishuProvider } from "../identity/provider.js";
import { FileStore } from "../files/storage.js";
import { CampusService } from "../campus/service.js";
import { CredentialVault, preflightCampusKeys } from "../campus/vault.js";
import { campusInput } from "../campus/schema.js";
import { z, parse, uuid } from "../http/validation.js";
import { fail, found } from "../http/errors.js";
import {
  snapshot,
  restore,
  readArchive,
  TABLES,
  type Manifest,
  archiveColumns,
} from "./backup.js";
import {ARCHIVE_SCHEMA_REVISION} from './archive-schema.js';
import { migrateLegacy, instant, safe } from "./migration.js";
import { encodeRaw } from "../parsing/profile.js";
import { Dictionary } from "../dictionary/service.js";
const hash = (v: string | Buffer) =>
  createHash("sha256").update(v).digest("hex");
// Keep web download and restore symmetric within the 512 MiB service budget.
// Larger full archives use the filesystem backup/restore commands.
export const WEB_BACKUP_BYTES = 64 * 1024 * 1024;
export const WEB_BACKUP_BODY_BYTES = 2 * WEB_BACKUP_BYTES + 64 * 1024;
export const copyInput = z
  .object({
    kind: z.enum([
      "recruit-v4-copy",
      "recruit_workbench_v1",
      "talent_sourcing_v1",
      "talent_campus_v1",
    ]),
    text: z
      .string()
      .min(2)
      .max(WEB_BACKUP_BYTES),
    mapping: z.record(z.string().max(300), uuid).default({}),
  })
  .strict();
export const copyApply = copyInput.extend({
  token: z.string().max(3000),
  confirm: z.boolean(),
});
const schemaPattern = /^recruit_test_import[a-f0-9]{24}$/;
const ephemeral = [
  "sessions",
  "oauth_states",
  "rate_limits",
  "idempotency_keys",
  "reparse_previews",
];
const sourceStates: Record<string, string> = {
  已联系未回: "contacted",
  已拿到简历: "resume_received",
  已上传系统: "uploaded",
  明确拒绝: "declined",
  未联系: "uncontacted",
  已联系: "contacted",
  已回复: "replied",
  已获简历: "resume_received",
  已上传工作台: "uploaded",
  暂不考虑: "declined",
};
const campusStates: Record<string, string> = {
  未注册: "unregistered",
  "已注册·未发布": "registered",
  已注册未发布: "registered",
  已发布: "published",
  需年度续期: "renewal",
  账号失效: "invalid",
};
const hasSecret = (v: any): boolean =>
  !!v &&
  typeof v === "object" &&
  Object.entries(v).some(
    ([k, x]) =>
      /password|passwd|pwd|secret|token|campusAccount|credential/i.test(k) ||
      hasSecret(x),
  );
const string = (v: any) =>
  safe(
    v === undefined || v === null
      ? ""
      : typeof v === "string"
        ? v
        : JSON.stringify(v),
  );
function decode(b: any) {
  try {
    let v = JSON.parse(b.text);
    if (v?.[b.kind] !== undefined) v = v[b.kind];
    if (typeof v === "string") v = JSON.parse(v);
    return v;
  } catch {
    fail(422, "invalid_backup_json");
  }
}
const countKeys = [
  "candidates",
  "jobs",
  "applications",
  "interviews",
  "leads",
  "campuses",
] as const;
export class BackupCopies {
  constructor(readonly identity: Identity) {}
  get db() {
    return this.identity.db;
  }
  async key() {
    return await new CampusService(this.identity).vault();
  }
  private fingerprint(b: any, v: CredentialVault) {
    return v
      .digest(
        JSON.stringify([b.kind, b.text, Object.entries(b.mapping).sort()]),
      )
      .toString("hex");
  }
  private async withArchive<T>(
    archive: any,
    db: Database,
    store: FileStore,
    fn: (dir: string) => Promise<T>,
  ) {
    if (
      archive?.format !== "recruit-v4-copy" ||
      !archive.tables ||
      !Array.isArray(archive.files)
    )
      fail(422, "backup_integrity");
    const manifest = { ...archive.manifest };
    if (archive.liteBackup !== undefined && typeof archive.liteBackup !== 'boolean') fail(422, 'backup_integrity');
    if (archive.liteBackup === true) {
      if (manifest.fileMode === 'full') fail(422, 'backup_integrity');
      // Accept previously exported lite copies only when their file lists are empty.
      manifest.fileMode ??= 'omitted';
    }
    if (!Array.isArray(manifest.files) || archive.files.length !== manifest.files.length ||
      new Set(archive.files.map((f:any)=>f.key)).size !== archive.files.length ||
      archive.files.some((f:any)=>!manifest.files.some((m:any)=>m.key===f.key&&m.hash===f.hash&&m.size===f.size)) ||
      (manifest.fileMode === 'omitted' && archive.files.length)) fail(422, 'backup_integrity');
    preflightCampusKeys(
      this.identity.config.campusKeyFile,
      archive.tables.campuses || [],
    );
    const directory = await mkdtemp(path.join(os.tmpdir(), "recruit-v4-copy-"));
    try {
      await mkdir(path.join(directory, "files"), { mode: 0o700 });
      await writeFile(
        path.join(directory, "database.json"),
        JSON.stringify(archive.tables),
        { mode: 0o600 },
      );
      await writeFile(
        path.join(directory, "private-config.json"),
        JSON.stringify(archive.config),
        { mode: 0o600 },
      );
      await writeFile(
        path.join(directory, "manifest.json"),
        JSON.stringify(manifest),
        { mode: 0o600 },
      );
      for (const f of archive.files) {
        store.path(f.key);
        if (typeof f.base64 !== "string" || f.base64.length > 14 * 1024 * 1024)
          fail(422, "backup_integrity");
        await writeFile(
          path.join(directory, "files", f.key),
          Buffer.from(f.base64, "base64"),
          { flag: "wx", mode: 0o600 },
        );
      }
      return await fn(directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  private async validate(a: Actor, b: z.infer<typeof copyInput>) {
    if (Buffer.byteLength(b.text) > WEB_BACKUP_BYTES)
      fail(413, "backup_requires_cli");
    const data = decode(b),
      conflicts: string[] = [],
      warnings: string[] = [],
      counts: Record<string, number> = {},
      prepared: any[] = [];
    let mappings: string[] = [], fileMode: Manifest['fileMode'];
    if (b.kind === "recruit-v4-copy") {
      try {
        await this.withArchive(
          data,
          this.db,
          new FileStore(this.identity.config.storageRoot),
          async (dir) => {
            const archive = await readArchive(
              this.db,
              new FileStore(this.identity.config.storageRoot),
              dir,
              TABLES,
              false,
            );
            const columns = (
              await this.db.query(
                "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1",
                [this.db.config.schema],
              )
            ).rows;
            for (const table of TABLES) {
              const fields = columns
                .filter((x) => x.table_name === table)
                .map((x) => x.column_name);
              if (
                archive.tables[table].some(
                  (row: any) =>
                    !row ||
                    typeof row !== "object" ||
                    Object.keys(row).length !== fields.length ||
                    fields.some((k) => !Object.hasOwn(row, k)),
                )
              )
                conflicts.push("backup_column_mismatch");
            }
            for (const k of countKeys) counts[k] = archive.tables[k].length;
            fileMode = archive.manifest.fileMode || 'full';
            if (archive.manifest.fileMode === 'omitted') warnings.push('resume_attachments_omitted');
            if (ephemeral.some((k) => archive.tables[k].length))
              conflicts.push("backup_contains_authentication_state");
          },
        );
      } catch {
        conflicts.push("backup_integrity_or_credential_key");
      }
    } else if (b.kind === "recruit_workbench_v1") {
      if (hasSecret(data)) conflicts.push("credentials_require_campus_import");
      const report = await migrateLegacy(
        this.db,
        new FileStore(this.identity.config.storageRoot),
        a,
        data,
        true,
        b.mapping,
      );
      conflicts.push(...report.conflicts);
      warnings.push(...report.warnings);
      Object.assign(counts, report.counts);
      mappings = [
        ...new Set<string>(
          (data?.data?.interviews || data?.interviews || [])
            .map((i: any) => string(i.who))
            .filter(Boolean),
        ),
      ];
    } else {
      const rows = Array.isArray(data)
        ? data
        : Array.isArray(data?.list)
          ? data.list
          : Array.isArray(data?.items)
            ? data.items
            : b.kind === "talent_sourcing_v1"
              ? data?.leads
              : data?.campuses;
      if (!Array.isArray(rows) || rows.length > 10000)
        fail(422, "invalid_legacy_bundle");
      const ids = new Set<string>();
      for (const [n, row] of rows.entries()) {
        try {
          if (!row || typeof row !== "object" || Array.isArray(row))
            throw Error();
          if (b.kind === "talent_campus_v1") {
            const known = new Set([
              "id",
              "school",
              "name",
              "city",
              "region",
              "tier",
              "url",
              "status",
              "lastPost",
              "lastPub",
              "note",
              "account",
              "acct",
              "password",
              "pwd",
              "created",
              "updated",
            ]);
            if (Object.keys(row).some((k) => !known.has(k)))
              throw Error("unsupported_campus_fields");
            const value = campusInput.parse({
              school: row.school || row.name,
              city: row.city,
              region: row.region,
              tier: row.tier,
              url: row.url,
              status: campusStates[row.status] || row.status,
              lastPost: row.lastPost ?? row.lastPub,
              note: row.note,
              credentials: {
                account: {
                  action: "replace",
                  value: string(row.account ?? row.acct),
                },
                password: {
                  action: "replace",
                  value: string(row.password ?? row.pwd),
                },
              },
            });
            const key = value.school
              .normalize("NFKC")
              .toLowerCase()
              .replace(/\s+/g, "");
            if (ids.has(key)) throw Error("duplicate_school");
            ids.add(key);
            prepared.push({
              value,
              created: instant(row.created),
              updated: instant(row.updated),
            });
          } else {
            if (hasSecret(row))
              throw Error("credentials_require_campus_import");
            const originalState = string(row.state).replace(/^[①②③④⑤⑥]\s*/, ""),
              state =
                sourceStates[originalState] || originalState || "uncontacted",
              line =
                ({ 重点: "focus", 高端: "high", 普通: "social" } as any)[
                  row.line
                ] || row.line;
            if (
              !["high", "focus", "social"].includes(line) ||
              ![
                "uncontacted",
                "contacted",
                "replied",
                "resume_received",
                "uploaded",
                "declined",
              ].includes(state)
            )
              throw Error("source_state_or_line_mapping_required");
            if (
              !string(row.name).trim() ||
              !string(row.org).trim() ||
              !string(row.dir ?? row.direction).trim() ||
              !string(row.source ?? row.src).trim()
            )
              throw Error("source_required_fields");
            const rawSkills = Array.isArray(row.skills)
              ? row.skills.map(string)
              : string(row.skills)
                  .split(/[,，、;；/|]+/)
                  .filter(Boolean);
            const skills = await new Dictionary(this.db).normalize(rawSkills),
              follow = row.lastFollowupAt ?? row.lastFollowup ?? row.follow,
              contacted = instant(row.lastContactedAt ?? row.lastContacted),
              followed = instant(
                typeof follow === "string" && /^\d{4}-\d{2}-\d{2}$/.test(follow)
                  ? follow + "T00:00:00+08:00"
                  : follow,
              );
            if (follow && !followed) throw Error("invalid_follow_date");
            if (state !== "uncontacted" && !contacted)
              warnings.push("legacy_contact_time_unknown");
            prepared.push({
              name: string(row.name),
              org: string(row.org),
              school: string(row.school),
              major: string(row.major),
              skills,
              direction: string(row.dir ?? row.direction),
              contact: string(row.contact),
              source: string(row.source ?? row.src),
              line,
              state,
              note: string(row.note),
              raw: string(row.raw),
              contacted,
              followed,
              created: instant(row.created),
              updated: instant(row.updated),
            });
          }
        } catch (e) {
          conflicts.push(
            "row_" +
              (n + 1) +
              ":" +
              ((e as Error).message.startsWith("[")
                ? "invalid_fields"
                : (e as Error).message || "invalid_fields"),
          );
        }
      }
      counts[b.kind === "talent_campus_v1" ? "campuses" : "leads"] =
        rows.length;
      if (b.kind === "talent_campus_v1")
        warnings.push("credentials_encrypted_without_plaintext_archive");
      else
        warnings.push(
          "legacy_owner_preserved_in_archive_import_admin_assigned",
        );
    }
    return {
      data,
      prepared,
      report: {
        kind: b.kind,
        ready: !conflicts.length,
        counts,
        conflicts: [...new Set(conflicts)],
        warnings: [...new Set(warnings)],
        mappings,
        fileMode,
      },
    };
  }
  async preview(a: Actor, input: unknown) {
    requireRole(a, "admin");
    const b = parse(copyInput, input),
      v = await this.key(),
      { report } = await this.validate(a, b);
    if (Buffer.byteLength(b.text) > WEB_BACKUP_BYTES)
      fail(413, "backup_requires_cli");
    const payload = Buffer.from(
      JSON.stringify({
        hash: this.fingerprint(b, v),
        actor: a.id,
        version: a.version,
        expires: Date.now() + 15 * 60 * 1000,
      }),
    ).toString("base64url");
    return {
      ...report,
      token:
        payload + "." + v.digest("import-preview:" + payload).toString("hex"),
    };
  }
  async list(a: Actor) {
    requireRole(a, "admin");
    return (
      await this.db.query(
        "SELECT manifest FROM migration_receipts WHERE manifest->>'kind'='import-copy' ORDER BY created_at DESC",
      )
    ).rows.map((r) => r.manifest);
  }
  private async receipt(a: Actor, id: string) {
    requireRole(a, "admin");
    if (!/^[a-f0-9]{24}$/.test(id)) fail(422, "invalid_reference");
    const r = found(
      (
        await this.db.query(
          "SELECT manifest FROM migration_receipts WHERE manifest->>'kind'='import-copy' AND manifest->>'id'=$1",
          [id],
        )
      ).rows[0],
    ).manifest;
    if (!schemaPattern.test(r.schema)) fail(422, "invalid_reference");
    return r;
  }
  private config(schema: string) {
    if (!schemaPattern.test(schema)) fail(422, "invalid_reference");
    return {
      ...this.identity.config,
      schema,
      storageRoot: path.join(
        this.identity.config.storageRoot,
        "import-copies",
        schema,
      ),
    };
  }
  async inspect(a: Actor, id: string, page = 1, section?: string) {
    const receipt = await this.receipt(a, id),
      db = new Database(this.config(receipt.schema));
    try {
      const counts: Record<string, number> = {};
      for (const k of countKeys)
        counts[k] = Number(
          (await db.query("SELECT count(*) FROM " + k)).rows[0].count,
        );
      const kind =
        section ||
        ["candidates", "leads", "campuses"].find((k) => counts[k]) ||
        "candidates";
      if (
        !["candidates", "leads", "campuses", "jobs", "interviews"].includes(
          kind,
        ) ||
        !Number.isInteger(page) ||
        page < 1
      )
        fail(422, "invalid_input");
      const selects: Record<string, string> = {
        candidates:
          "SELECT id,profile->>'name' name,profile->>'school' school,created_at FROM candidates",
        leads:
          "SELECT id,name,org,school,direction,state,source,created_at FROM leads",
        campuses:
          'SELECT id,school,city,region,tier,url,status,last_post,account_cipher IS NOT NULL AS "hasAccount",password_cipher IS NOT NULL AS "hasPassword" FROM campuses',
        jobs: "SELECT id,name,department,open FROM jobs",
        interviews:
          "SELECT id,application_id,round,starts_at,status,primary_interviewer_id FROM interviews",
      };
      return {
        receipt,
        counts,
        section: kind,
        total: counts[kind],
        page,
        pageSize: 25,
        items: (
          await db.query(selects[kind] + " ORDER BY id LIMIT 25 OFFSET $1", [
            (page - 1) * 25,
          ])
        ).rows,
      };
    } finally {
      await db.close();
    }
  }
  async export(a: Actor, copyId?: string, includeFiles?: boolean) {
    requireRole(a, "admin");
    const receipt = copyId ? await this.receipt(a, copyId) : null;
    const omitted = receipt?.fileMode === 'omitted' ||
      (!receipt?.fileMode && receipt?.warnings?.includes('resume_attachments_omitted'));
    if (omitted && includeFiles === true) fail(422, 'backup_attachments_omitted');
    includeFiles ??= !omitted;
    const db = receipt ? new Database(this.config(receipt.schema)) : this.db,
      store = new FileStore(db.config.storageRoot);
    try {
      const tables = await snapshot(db);
      for (const key of ephemeral) tables[key] = [];
      preflightCampusKeys(this.identity.config.campusKeyFile, tables.campuses);
      const config = { format: 4, credentialKeys: "stored_separately" },
        files: { key: string; size: number; hash: string; base64: string }[] = [],
        cap = WEB_BACKUP_BYTES;
      let size = Buffer.byteLength(JSON.stringify(tables));
      if (size > cap) fail(413, "backup_requires_cli");
      if (includeFiles)
        for (const key of new Set<string>(
          tables.resume_documents.map((d) => d.blob_key),
        )) {
          const bytes = await store.read(key);
          size += Math.ceil(bytes.length / 3) * 4 + 300;
          if (size > cap) fail(413, "backup_requires_cli");
          files.push({
            key,
            size: bytes.length,
            hash: hash(bytes),
            base64: bytes.toString("base64"),
          });
        }
      const manifest: Manifest = {
        version: 4,
        fileMode: includeFiles ? 'full' : 'omitted',
        schemaRevision:ARCHIVE_SCHEMA_REVISION,
        columns:await archiveColumns(db),
        sourceSchema: db.config.schema,
        createdAt: new Date().toISOString(),
        databaseHash: hash(JSON.stringify(tables)),
        configHash: hash(JSON.stringify(config)),
        tables: Object.fromEntries(
          TABLES.map((k) => [
            k,
            { count: tables[k].length, hash: hash(JSON.stringify(tables[k])) },
          ]),
        ),
        files: files.map(({ base64, ...f }) => f),
      };
      const result: any = {
        format: "recruit-v4-copy",
        version: 4,
        manifest,
        config,
        tables,
        files,
      };
      // 轻量备份不含原始简历文件，导入后仅恢复业务表；在顶层显式标记，避免被当作完整备份。
      if (!includeFiles) result.liteBackup = true;
      if (Buffer.byteLength(JSON.stringify(result)) > cap)
        fail(413, "backup_requires_cli");
      await this.identity.audit(
        this.db.sql,
        a.id,
        "backup.download",
        copyId || null,
        { tables: TABLES.length, files: files.length },
      );
      return result;
    } finally {
      if (receipt) await db.close();
    }
  }
  async apply(a: Actor, input: unknown) {
    requireRole(a, "admin");
    const b = parse(copyApply, input);
    if (!b.confirm) fail(422, "import_confirmation");
    const v = await this.key(),
      fingerprint = this.fingerprint(b, v),
      parts = b.token.split(".");
    let token: any;
    try {
      const expected = v.digest("import-preview:" + parts[0]),
        actual = Buffer.from(parts[1] || "", "hex");
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        throw Error();
      token = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    } catch {
      fail(409, "import_preview_invalid");
    }
    if (
      token.hash !== fingerprint ||
      token.actor !== a.id ||
      token.version !== a.version ||
      token.expires < Date.now()
    )
      fail(409, "import_preview_invalid");
    const prepared = await this.validate(a, b);
    if (!prepared.report.ready) fail(409, "migration_conflicts");
    let copy: Database | undefined,
      created = false;
    try {
      return await this.db.tx(async (c) => {
        await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "import-copy:" + fingerprint,
        ]);
        const current = found(
          (await c.query("SELECT * FROM users WHERE id=$1 FOR SHARE", [a.id]))
            .rows[0],
        );
        requireRole(current, "admin");
        if (current.version !== a.version || !current.directory_active)
          fail(403, "forbidden");
        const prior = (
          await c.query(
            "SELECT manifest FROM migration_receipts WHERE source_sha256=$1",
            [fingerprint],
          )
        ).rows[0];
        if (prior) return prior.manifest;
        const id = randomBytes(12).toString("hex"),
          schema = "recruit_test_import" + id;
        copy = new Database(this.config(schema));
        await copy.migrate();
        created = true;
        const copyIdentity = new Identity(
          copy,
          copy.config,
          new FeishuProvider(copy.config),
        );
        if (b.kind === "recruit-v4-copy")
          await this.withArchive(
            prepared.data,
            copy,
            new FileStore(copy.config.storageRoot),
            (dir) =>
              restore(copy!, new FileStore(copy!.config.storageRoot), dir),
          );
        else {
          await new Dictionary(copy).seed();
          // A legacy copy uses the same reviewed dictionary as the importing service.
          const skills = (await c.query("SELECT * FROM skills")).rows,
            aliases = (await c.query("SELECT * FROM skill_aliases")).rows;
          if (skills.length) {
            await copy.query("DELETE FROM skill_aliases");
            await copy.query("DELETE FROM skills");
            await copy.query(
              "INSERT INTO skills SELECT * FROM json_populate_recordset(NULL::skills,$1::json)",
              [JSON.stringify(skills)],
            );
            await copy.query(
              "INSERT INTO skill_aliases SELECT * FROM json_populate_recordset(NULL::skill_aliases,$1::json)",
              [JSON.stringify(aliases)],
            );
            await copy.query(
              "UPDATE dictionary_versions SET version=$1 WHERE id=1",
              [
                (
                  await c.query(
                    "SELECT version FROM dictionary_versions WHERE id=1",
                  )
                ).rows[0].version,
              ],
            );
          }
          const userIds = [...new Set([a.id, ...Object.values(b.mapping)])],
            users = (
              await c.query("SELECT * FROM users WHERE id=ANY($1::uuid[])", [
                userIds,
              ])
            ).rows;
          await copy.query(
            "INSERT INTO users SELECT * FROM json_populate_recordset(NULL::users,$1::json)",
            [JSON.stringify(users)],
          );
          if (b.kind === "recruit_workbench_v1")
            await migrateLegacy(
              copy,
              new FileStore(copy.config.storageRoot),
              a,
              prepared.data,
              false,
              b.mapping,
            );
          else if (b.kind === "talent_campus_v1") {
            const service = new CampusService(copyIdentity);
            await copy.tx(async (sql) => {
              for (const row of prepared.prepared) {
                const result = await service.create(a, row.value);
                await sql.query(
                  "UPDATE campuses SET created_at=coalesce($2,created_at),updated_at=coalesce($3,$2,updated_at) WHERE id=$1",
                  [result.id, row.created, row.updated],
                );
              }
            });
          } else
            await copy.tx(async (sql) => {
              await sql.query(
                "INSERT INTO migration_receipts(source_sha256,source_revision,manifest) VALUES($1,$2,$3)",
                [fingerprint, "legacy-source", prepared.report],
              );
              await sql.query(
                "INSERT INTO legacy_archives(source_sha256,kind,source_key,data_bytes) VALUES($1,'bundle','talent_sourcing_v1',$2)",
                [fingerprint, encodeRaw(b.text)],
              );
              for (const row of prepared.prepared)
                await sql.query(
                  "INSERT INTO leads(name,org,school,major,skills,direction,contact,source,line,state,owner_id,note,raw,last_contacted_at,last_followup_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,coalesce($16,now()),coalesce($17,$16,now()))",
                  [
                    row.name,
                    row.org,
                    row.school,
                    row.major,
                    row.skills,
                    row.direction,
                    row.contact,
                    row.source,
                    row.line,
                    row.state,
                    a.id,
                    row.note,
                    row.raw,
                    row.contacted,
                    row.followed,
                    row.created,
                    row.updated,
                  ],
                );
            });
        }
        const receipt = {
          kind: "import-copy",
          sourceKind: b.kind,
          id,
          schema,
          createdAt: new Date().toISOString(),
          actorId: a.id,
          counts: prepared.report.counts,
          warnings: prepared.report.warnings,
          fileMode: prepared.report.fileMode || 'full',
          credentialKeyIds: (
            await copy.query(
              "SELECT account_cipher->>'keyId' key_id FROM campuses WHERE account_cipher IS NOT NULL UNION SELECT password_cipher->>'keyId' key_id FROM campuses WHERE password_cipher IS NOT NULL",
            )
          ).rows.map((r) => r.key_id),
        };
        await c.query(
          "INSERT INTO migration_receipts(source_sha256,source_revision,manifest) VALUES($1,$2,$3)",
          [fingerprint, "import-copy-v4", receipt],
        );
        await this.identity.audit(c, a.id, "backup.import_copy", id, {
          sourceKind: b.kind,
          counts: receipt.counts,
        });
        return receipt;
      });
    } catch (e) {
      if (copy && created) {
        await copy
          .query('DROP SCHEMA "' + copy.config.schema + '" CASCADE')
          .catch(() => {});
        await rm(copy.config.storageRoot, { recursive: true, force: true });
      }
      throw e;
    } finally {
      if (copy) await copy.close();
    }
  }
}
