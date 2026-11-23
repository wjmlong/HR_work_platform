import {legacyDefinition,legacyKeys,assertLegacyField,projectLegacyCore} from '../business-config/legacy-fields.js';
import type {EffectiveDefinition} from '../business-config/types.js';
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { Identity, requireRole, type Actor } from "../identity/service.js";
import {BusinessDictionaryService,validateOption} from '../business-config/dictionaries.js';
import { parse, z, uuid } from "../http/validation.js";
import { fail, found } from "../http/errors.js";
import { csvDocument } from "../http/csv.js";
import { CredentialVault } from "./vault.js";
import {
  campusInput,
  campusPatch,
  campusQuery,
  campusRemove,
  campusGrant,
  campusExport,
  campusReveal,
} from "./schema.js";
const writers = ["admin", "manager", "recruiter"] as const;
const statuses: Record<string, string> = {
  unregistered: "未注册",
  registered: "已注册·未发布",
  published: "已发布",
  renewal: "需年度续期",
  invalid: "账号失效",
};
const metadata = (row: any) => {
  const { account_cipher, password_cipher, ...rest } = row;
  return {
    ...rest,
    hasAccount: !!account_cipher,
    hasPassword: !!password_cipher,
  };
};
export class CampusService {
  constructor(readonly identity: Identity) {}
  get db() {
    return this.identity.db;
  }
  async keyStatus() {
    const ids = (
      await this.db.query(
        "SELECT account_cipher->>'keyId' key_id FROM campuses WHERE account_cipher IS NOT NULL UNION SELECT password_cipher->>'keyId' key_id FROM campuses WHERE password_cipher IS NOT NULL UNION SELECT jsonb_array_elements_text(coalesce(manifest->'credentialKeyIds','[]'::jsonb)) key_id FROM migration_receipts WHERE manifest->>'kind'='import-copy'",
      )
    ).rows;
    if (!ids.length) return;
    const vault = await this.vault();
    if (ids.some((row) => !vault.hasKey(row.key_id)))
      fail(503, "credential_key_missing");
  }
  async vault() {
    const file = this.identity.config.campusKeyFile;
    if (!existsSync(file)) {
      if (
        (
          await this.db.query(
            "SELECT 1 FROM campuses WHERE account_cipher IS NOT NULL OR password_cipher IS NOT NULL UNION SELECT 1 FROM migration_receipts WHERE manifest->>'kind'='import-copy' AND jsonb_array_length(coalesce(manifest->'credentialKeyIds','[]'::jsonb))>0 LIMIT 1",
          )
        ).rowCount
      )
        fail(503, "credential_key_missing");
      return CredentialVault.create(file);
    }
    return CredentialVault.load(file);
  }
  async permissions(a: Actor) {
    requireRole(a, ...writers);
    if (a.roles.includes("admin"))
      return { read: true, write: true, export: true, manage: true };
    const row = (
      await this.db.query(
        "SELECT * FROM campus_credential_grants WHERE user_id=$1",
        [a.id],
      )
    ).rows[0];
    return {
      read: !!row?.can_read,
      write: !!row?.can_write,
      export: !!row?.can_export,
      manage: false,
    };
  }
  private async allowed(a: Actor, permission: "read" | "write" | "export") {
    const permissions = await this.permissions(a);
    if (!permissions[permission]) fail(403, "credential_forbidden");
    return permissions;
  }
  async grant(a: Actor, input: unknown) {
    requireRole(a, "admin");
    const b = parse(campusGrant, input);
    const user = found(
      (
        await this.db.query(
          "SELECT roles FROM users WHERE id=$1 AND status='active' AND directory_active",
          [b.userId],
        )
      ).rows[0],
    );
    if (!user.roles.some((role: string) => writers.includes(role as any)))
      fail(422, "credential_grantee_invalid");
    return this.db.tx(async (c) => {
      await c.query(
        "INSERT INTO campus_credential_grants(user_id,can_read,can_write,can_export,granted_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id) DO UPDATE SET can_read=$2,can_write=$3,can_export=$4,granted_by=$5,updated_at=now()",
        [b.userId, b.read, b.write, b.export, a.id],
      );
      await this.identity.audit(c, a.id, "campus.credential_grant", b.userId, {
        read: b.read,
        write: b.write,
        export: b.export,
      });
      return b;
    });
  }
  async grants(a: Actor) {
    requireRole(a, "admin");
    return (
      await this.db.query(
        "SELECT g.*,u.name FROM campus_credential_grants g JOIN users u ON u.id=g.user_id ORDER BY u.name,g.user_id",
      )
    ).rows;
  }
  private async selected(a: Actor, input: unknown, paginated = false,definition?:EffectiveDefinition) {
    requireRole(a, ...writers);
    const q = parse(campusQuery, input);
    definition??=await legacyDefinition(this.identity,a,'campus');const readable=legacyKeys(definition,a);if(q.region)assertLegacyField(definition,a,'region');if(q.tier)assertLegacyField(definition,a,'tier');
    if (q.deleted) requireRole(a, "admin");
    if (q.accountSearch) await this.allowed(a, "read");
    const params: unknown[] = [
      q.deleted,
      q.region || null,
      q.tier || null,
      q.status || null,
    ];
    const where =
      "(deleted_at IS NOT NULL)=$1 AND ($2::text IS NULL OR region=$2) AND ($3::text IS NULL OR tier=$3) AND ($4::text IS NULL OR status=$4)";
    const term = q.query.normalize("NFKC").toLowerCase().trim();
    if (!term || !q.accountSearch) {
      const condition =
        where +
        (term
          ? " AND (" +
            ["school", "city", "url", "note"].filter(k=>readable.has(k))
              .map(
                (field) => "strpos(lower(normalize(" + field + ",NFKC)),$5)>0",
              )
              .join(" OR ").replace(/^$/,"false") +
            ")"
          : "");
      if (term) params.push(term);
      const total = Number(
        (
          await this.db.query(
            "SELECT count(*)::int total FROM campuses WHERE " + condition,
            params,
          )
        ).rows[0].total,
      );
      const pagination = paginated
        ? " LIMIT $" + (params.length + 1) + " OFFSET $" + (params.length + 2)
        : "";
      const rows = (
        await this.db.query(
          "SELECT * FROM campuses WHERE " +
            condition +
            " ORDER BY school,id" +
            pagination,
          paginated
            ? [...params, q.pageSize, (q.page - 1) * q.pageSize]
            : params,
        )
      ).rows;
      return { q, rows, total };
    }
    // Search authorized accounts in bounded batches; never send a credential corpus to the browser.
    const vault = await this.vault(),
      rows: any[] = [];
    let total = 0,
      cursorSchool: string | null = null,
      cursorId: string | null = null;
    for (;;) {
      const batch: Record<string, any>[] = (
        await this.db.query(
          "SELECT * FROM campuses WHERE " +
            where +
            " AND ($5::text IS NULL OR (school,id)>($5,$6::uuid)) ORDER BY school,id LIMIT 500",
          [...params, cursorSchool, cursorId],
        )
      ).rows;
      for (const row of batch) {
        const publicMatch = ['school','city','url','note'].filter(k=>readable.has(k)).map(k=>row[k]).some(
          (value) => value.normalize("NFKC").toLowerCase().includes(term),
        );
        if (
          publicMatch ||
          vault
            .decrypt(row.id, "account", row.account_cipher)
            .normalize("NFKC")
            .toLowerCase()
            .includes(term)
        ) {
          if (
            !paginated ||
            (total >= (q.page - 1) * q.pageSize && rows.length < q.pageSize)
          )
            rows.push(row);
          total++;
        }
      }
      if (batch.length < 500) break;
      cursorSchool = batch.at(-1)!.school;
      cursorId = batch.at(-1)!.id;
    }
    return { q, rows, total };
  }
  async query(a: Actor, input: unknown) {
    const definition=await legacyDefinition(this.identity,a,'campus');
    return this.db.tx(async (c) => {
      await c.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const { q, rows, total } = await this.selected(a, input, true,definition);
      const k = (
        await c.query(
          "SELECT count(*)::int total,count(*) FILTER(WHERE status<>'unregistered')::int registered,count(*) FILTER(WHERE status='published')::int published,count(*) FILTER(WHERE btrim(url)='')::int missing_url FROM campuses WHERE deleted_at IS NULL",
        )
      ).rows[0];
      return {
        items: rows.map(r=>projectLegacyCore(definition,a,metadata(r))),
        total,
        page: q.page,
        pageSize: q.pageSize,
        kpis: {
          total: k.total,
          registered: k.registered,
          published: k.published,
          missingUrl:legacyKeys(definition,a).has('url')?k.missing_url:null,
          coverage: k.total ? k.published / k.total : null,
        },
        permissions: await this.permissions(a),
      };
    });
  }
  private async changedCredentials(
    a: Actor,
    id: string,
    old: any,
    changes: any,
  ) {
    if (
      !changes ||
      Object.values(changes).every((change: any) => change.action === "keep")
    )
      return {
        account: old?.account_cipher || null,
        password: old?.password_cipher || null,
      };
    await this.allowed(a, "write");
    const vault = await this.vault();
    const result: Record<string, any> = {};
    for (const field of ["account", "password"]) {
      const change = changes[field];
      result[field] =
        !change || change.action === "keep"
          ? old?.[field + "_cipher"] || null
          : change.action === "clear"
            ? null
            : vault.encrypt(id, field, change.value);
    }
    return result;
  }
  async create(a: Actor, input: unknown) {
    requireRole(a, ...writers);
    const b = parse(campusInput, input),
      id = randomUUID();
    const encrypted = await this.changedCredentials(a, id, null, b.credentials);
    return this.db.tx(async (c) => {
      const dictionaries=new BusinessDictionaryService(this.identity);
      if(b.region)validateOption((await dictionaries.dictionary(a,'campus_regions')).options,b.region);
      if(b.tier)validateOption((await dictionaries.dictionary(a,'campus_tiers')).options,b.tier);
      const row = (
        await c.query(
          "INSERT INTO campuses(id,school,school_key,city,region,tier,url,status,last_post,note,account_cipher,password_cipher,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *",
          [
            id,
            b.school,
            b.school.normalize("NFKC").toLowerCase().replace(/\s+/g, ""),
            b.city,
            b.region,
            b.tier,
            b.url,
            b.status,
            b.lastPost || null,
            b.note,
            encrypted.account,
            encrypted.password,
            a.id,
          ],
        )
      ).rows[0];
      await this.identity.audit(c, a.id, "campus.create", row.id, {
        hasAccount: !!encrypted.account,
        hasPassword: !!encrypted.password,
      });
      return metadata(row);
    });
  }
  async update(a: Actor, id: string, input: unknown) {
    requireRole(a, ...writers);
    const b = parse(campusPatch, input) as any;
    return this.db.tx(async (c) => {
      const old = found(
        (
          await c.query(
            "SELECT * FROM campuses WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
            [id],
          )
        ).rows[0],
      );
      if (old.version !== b.version) fail(409, "version_conflict");
      const dictionaries=new BusinessDictionaryService(this.identity);
      if(b.region)validateOption((await dictionaries.dictionary(a,'campus_regions')).options,b.region,old.region);
      if(b.tier)validateOption((await dictionaries.dictionary(a,'campus_tiers')).options,b.tier,old.tier);
      const encrypted = await this.changedCredentials(
          a,
          id,
          old,
          b.credentials,
        ),
        school = b.school ?? old.school;
      const row = (
        await c.query(
          "UPDATE campuses SET school=$2,school_key=$3,city=$4,region=$5,tier=$6,url=$7,status=$8,last_post=$9,note=$10,account_cipher=$11,password_cipher=$12,version=version+1,updated_at=now() WHERE id=$1 RETURNING *",
          [
            id,
            school,
            school.normalize("NFKC").toLowerCase().replace(/\s+/g, ""),
            b.city ?? old.city,
            b.region ?? old.region,
            b.tier ?? old.tier,
            b.url ?? old.url,
            b.status ?? old.status,
            b.lastPost === undefined ? old.last_post : b.lastPost || null,
            b.note ?? old.note,
            encrypted.account,
            encrypted.password,
          ],
        )
      ).rows[0];
      await this.identity.audit(c, a.id, "campus.edit", id, {
        version: row.version,
        credentialsChanged:
          !!b.credentials &&
          Object.values(b.credentials).some((v: any) => v.action !== "keep"),
      });
      return metadata(row);
    });
  }
  async reveal(a: Actor, id: string, input: unknown) {
    await this.allowed(a, "read");
    const b = parse(campusReveal,input);
    // Shared SQL limiter commits before the reveal transaction, including stale
    // attempts. Neither its key nor its response contains credential plaintext.
    await this.identity.limit('campus-reveal:'+a.id,10);
    return this.db.tx(async (c) => {
      const row = found(
        (
          await c.query(
            "SELECT id,version,account_cipher,password_cipher FROM campuses WHERE id=$1 AND deleted_at IS NULL FOR SHARE",
            [id],
          )
        ).rows[0],
      );
      if(row.version!==b.version)fail(409,'version_conflict');
      const vault = await this.vault();
      const result = {
        account: vault.decrypt(id, "account", row.account_cipher),
        password: vault.decrypt(id, "password", row.password_cipher),
      };
      await this.identity.audit(c, a.id, "campus.credential_reveal", id);
      return result;
    });
  }
  async remove(a: Actor, id: string, input: unknown) {
    requireRole(a, ...writers);
    const b = parse(campusRemove, input);
    if (!b.confirm) fail(409, "campus_delete_confirmation");
    if (b.restore) requireRole(a, "admin");
    return this.db.tx(async (c) => {
      const row = (
        await c.query(
          "UPDATE campuses SET deleted_at=CASE WHEN $3 THEN NULL ELSE now() END,version=version+1,updated_at=now() WHERE id=$1 AND version=$2 AND (deleted_at IS NOT NULL)=$3 RETURNING *",
          [id, b.version, b.restore],
        )
      ).rows[0];
      if (!row) fail(409, "version_conflict");
      await this.identity.audit(
        c,
        a.id,
        b.restore ? "campus.restore" : "campus.delete",
        id,
      );
      return metadata(row);
    });
  }
  async export(a: Actor, input: unknown) {
    requireRole(a, ...writers);
    const b = parse(campusExport, input);
    const fieldDefinition=await legacyDefinition(this.identity,a,'campus');for(const key of ['school','city','region','tier','url','note'])assertLegacyField(fieldDefinition,a,key,'export');
    if (b.includeCredentials) {
      await this.allowed(a, "read");
      await this.allowed(a, "export");
      if (b.confirmation !== "文件含账号密码，注意存放")
        fail(409, "sensitive_export_confirmation");
    }
    const { rows } = await this.selected(a, b.query),
      vault = b.includeCredentials ? await this.vault() : undefined;
    const csv = csvDocument([
      [
        "院校",
        "城市",
        "地区",
        "层次",
        "就业网",
        ...(b.includeCredentials ? ["账号", "密码"] : []),
        "状态",
        "最近发布",
        "备注",
      ],
      ...rows.map((row) => [
        row.school,
        row.city,
        row.region,
        row.tier,
        row.url,
        ...(vault
          ? [
              vault.decrypt(row.id, "account", row.account_cipher),
              vault.decrypt(row.id, "password", row.password_cipher),
            ]
          : []),
        statuses[row.status],
        row.last_post || "",
        row.note,
      ]),
    ]);
    await this.db.tx((c) =>
      this.identity.audit(c, a.id, "campus.export", "campus", {
        count: rows.length,
        includesCredentials: b.includeCredentials,
      }),
    );
    return csv;
  }
  async rotate(a: Actor) {
    requireRole(a, "admin");
    return this.db.tx(async (c) => {
      await c.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('campus-key-rotation',0))",
      );
      await c.query("LOCK TABLE campuses IN SHARE ROW EXCLUSIVE MODE");
      const rows = (
          await c.query(
            "SELECT id,account_cipher,password_cipher FROM campuses ORDER BY id FOR UPDATE",
          )
        ).rows,
        vault = await this.vault();
      const plain = rows.map((row) => ({
        id: row.id,
        account: vault.decrypt(row.id, "account", row.account_cipher),
        password: vault.decrypt(row.id, "password", row.password_cipher),
      }));
      const keyId = vault.rotate();
      for (const row of plain)
        await c.query(
          "UPDATE campuses SET account_cipher=$2,password_cipher=$3 WHERE id=$1",
          [
            row.id,
            vault.encrypt(row.id, "account", row.account),
            vault.encrypt(row.id, "password", row.password),
          ],
        );
      await this.identity.audit(c, a.id, "campus.key_rotate", "campus", {
        rows: rows.length,
        keyId,
      });
      return { rotated: true, keyId, rows: rows.length };
    });
  }
}
