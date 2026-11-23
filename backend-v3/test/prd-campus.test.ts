import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { testDatabase, httpSession, actor } from "./helpers.js";
import { Identity } from "../src/identity/service.js";
import { CampusService } from "../src/campus/service.js";
import { CredentialVault } from "../src/campus/vault.js";
async function context(t: any) {
  const f = await testDatabase();
  t.after(f.cleanup);
  const root = await mkdtemp(path.join(os.tmpdir(), "campus-synthetic-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  f.config.campusKeyFile = path.join(root, "keys.json");
  const h = await httpSession(f.db, f.config);
  t.after(() => h.app.close());
  const service = new CampusService(new Identity(f.db, f.config, h.provider));
  return { ...f, ...h, root, service };
}
const input = (n: number, status = "unregistered") => ({
  school: "Synthetic School " + n,
  city: n % 2 ? "Hangzhou" : "Beijing",
  region: n % 2 ? "华东" : "华北",
  tier: n % 2 ? "985" : "211",
  url: n === 0 ? "" : "https://example.invalid/career",
  status,
  note: "Synthetic campus fixture",
  lastPost: status === "published" ? "2026-10-19" : "",
});
test("PRD campus has independent five KPI, AND filters, ciphertext credentials and permission-aware account search", async (t) => {
  const f = await context(t),
    states = ["unregistered", "registered", "published", "renewal", "invalid"];
  let first: any;
  for (let n = 0; n < 5; n++) {
    const row = await f.service.create(f.actor, {
      ...input(n, states[n]),
      ...(n === 0
        ? {
            credentials: {
              account: { action: "replace", value: "synthetic-admin-account" },
              password: { action: "replace", value: "synthetic-only-pass-123" },
            },
          }
        : {}),
    });
    if (n === 0) first = row;
    assert.ok(!JSON.stringify(row).includes("synthetic-only-pass-123"));
  }
  await f.db.migrate();
  const all = await f.service.query(f.actor, {});
  assert.deepEqual(all.kpis, {
    total: 5,
    registered: 4,
    published: 1,
    missingUrl: 1,
    coverage: 0.2,
  });
  assert.equal(all.total, 5);
  assert.equal(
    all.items.find((row) => row.status === "published")?.last_post,
    "2026-10-19",
  );
  assert.ok(!JSON.stringify(all).includes("synthetic-only-pass-123"));
  const filtered = await f.service.query(f.actor, {
    region: "华东",
    tier: "985",
    status: "registered",
    query: "Hangzhou",
  });
  assert.equal(filtered.total, 1);
  assert.equal(
    (
      await f.service.query(f.actor, {
        query: "admin-account",
        accountSearch: true,
      })
    ).total,
    1,
  );
  const dbrow = (
    await f.db.query("SELECT * FROM campuses WHERE id=$1", [first.id])
  ).rows[0];
  for (const value of ["synthetic-admin-account", "synthetic-only-pass-123"])
    assert.ok(!JSON.stringify(dbrow).includes(value));
  assert.equal(
    (await f.db.query("SELECT count(*)::int n FROM leads")).rows[0].n,
    0,
  );
  assert.deepEqual(await f.service.reveal(f.actor, first.id, {version:first.version}), {
    account: "synthetic-admin-account",
    password: "synthetic-only-pass-123",
  });
  const recruiter = await actor(f.db, ["recruiter"]);
  await assert.rejects(
    f.service.reveal(recruiter, first.id, {version:first.version}),
    /credential_forbidden/,
  );
  await assert.rejects(
    f.service.query(recruiter, { query: "admin-account", accountSearch: true }),
    /credential_forbidden/,
  );
  assert.equal(
    (await f.service.query(recruiter, { query: "admin-account" })).total,
    0,
  );
  await f.service.grant(f.actor, {
    userId: recruiter.id,
    read: true,
    write: false,
    export: false,
  });
  assert.equal(
    (await f.service.reveal(recruiter, first.id, {version:first.version})).account,
    "synthetic-admin-account",
  );
  await assert.rejects(
    f.service.update(recruiter, first.id, {
      version: first.version,
      credentials: { password: { action: "replace", value: "unauthorized" } },
    }),
    /credential_forbidden/,
  );
  await assert.rejects(
    f.service.export(recruiter, {
      includeCredentials: true,
      confirmation: "文件含账号密码，注意存放",
    }),
    /credential_forbidden/,
  );
  const publicCsv = await f.service.export(f.actor, {});
  assert.ok(publicCsv.startsWith("\ufeff"));
  assert.ok(!publicCsv.includes("synthetic-only-pass-123"));
  await assert.rejects(
    f.service.export(f.actor, { includeCredentials: true }),
    /sensitive_export_confirmation/,
  );
  const csv = await f.service.export(f.actor, {
    includeCredentials: true,
    confirmation: "文件含账号密码，注意存放",
  });
  assert.ok(csv.includes("synthetic-only-pass-123"));
});
test("PRD campus HTTP writes keep plaintext out of command/audit rows, reveal is uncached and keep/replace/clear is explicit", async (t) => {
  const f = await context(t);
  let counter = 0;
  const definition=(await f.app.inject({url:'/api/v4/business-config/effective/campus',headers:f.headers})).json().data;
  const send = (method: any, url: string, payload: any) =>
    f.app.inject({
      method,
      url: "/api/v4" + url,
      headers: { ...f.headers, "idempotency-key": "campus-" + ++counter },
      payload:((method==='POST'&&url==='/campus')||(method==='PATCH'&&/^\/campus\/[^/]+$/.test(url)))?{...payload,definitionVersion:definition.ref.version,definitionRevision:definition.aclRevision}:payload,
    });
  const created = await send("POST", "/campus", {
    ...input(1),
    credentials: {
      account: { action: "replace", value: "synthetic-account-x" },
      password: { action: "replace", value: "synthetic-password-x" },
    },
  });
  assert.equal(created.statusCode, 200, created.body);
  const row = created.json().data;
  assert.ok(!created.body.includes("synthetic-password-x"));
  assert.ok(!created.body.includes("synthetic-account-x"));
  for (const table of ["idempotency_keys", "audit_events"]) {
    const rows = (
      await f.db.query("SELECT row_to_json(t) data FROM " + table + " t")
    ).rows;
    assert.ok(!JSON.stringify(rows).includes("synthetic-password-x"));
    assert.ok(!JSON.stringify(rows).includes("synthetic-account-x"));
  }
  const before = (
    await f.db.query("SELECT count(*)::int n FROM idempotency_keys")
  ).rows[0].n;
  const reveal = await send("POST", "/campus/" + row.id + "/reveal", {version:row.version});
  assert.equal(reveal.statusCode, 200, reveal.body);
  assert.equal(reveal.headers["cache-control"], "no-store");
  assert.equal(reveal.json().data.password, "synthetic-password-x");
  assert.equal(
    (await f.db.query("SELECT count(*)::int n FROM idempotency_keys")).rows[0]
      .n,
    before,
  );
  let next = await f.service.update(f.actor, row.id, {
    version: row.version,
    note: "only metadata",
    credentials: { password: { action: "keep" } },
  });
  assert.equal(
    (await f.service.reveal(f.actor, row.id, {version:(await f.service.query(f.actor, {})).items.find((x:any)=>x.id===row.id)!.version})).password,
    "synthetic-password-x",
  );
  next = await f.service.update(f.actor, row.id, {
    version: next.version,
    credentials: { password: { action: "clear" } },
  });
  assert.equal((await f.service.reveal(f.actor, row.id, {version:(await f.service.query(f.actor, {})).items.find((x:any)=>x.id===row.id)!.version})).password, "");
  assert.equal(next.hasPassword, false);
  await assert.rejects(
    f.service.remove(f.actor, row.id, { version: next.version }),
    /campus_delete_confirmation/,
  );
  await f.service.remove(f.actor, row.id, {
    version: next.version,
    confirm: true,
  });
  assert.equal((await f.service.query(f.actor, {})).total, 0);
});
test("PRD campus AES-GCM binds row and field, rejects tampering/wrong keys and rotates with old-backup key retention", async (t) => {
  const f = await context(t);
  const row = await f.service.create(f.actor, {
    ...input(1),
    credentials: {
      password: { action: "replace", value: "synthetic-rotation-pass" },
    },
  });
  const old = (
    await f.db.query("SELECT password_cipher FROM campuses WHERE id=$1", [
      row.id,
    ])
  ).rows[0].password_cipher;
  const vault = CredentialVault.load(f.config.campusKeyFile);
  assert.equal(
    vault.decrypt(row.id, "password", old),
    "synthetic-rotation-pass",
  );
  assert.throws(
    () => vault.decrypt(crypto.randomUUID(), "password", old),
    /credential_integrity/,
  );
  assert.throws(
    () => vault.decrypt(row.id, "account", old),
    /credential_integrity/,
  );
  const tampered = { ...old, data: Buffer.from("tamper").toString("base64") };
  assert.throws(
    () => vault.decrypt(row.id, "password", tampered),
    /credential_integrity/,
  );
  const other = CredentialVault.create(path.join(f.root, "wrong.json"));
  assert.throws(
    () => other.decrypt(row.id, "password", old),
    /credential_key_missing/,
  );
  await f.service.rotate(f.actor);
  const rotated = (
    await f.db.query("SELECT password_cipher FROM campuses WHERE id=$1", [
      row.id,
    ])
  ).rows[0].password_cipher;
  assert.notEqual(rotated.keyId, old.keyId);
  assert.equal(
    (await f.service.reveal(f.actor, row.id, {version:(await f.service.query(f.actor, {})).items.find((x:any)=>x.id===row.id)!.version})).password,
    "synthetic-rotation-pass",
  );
  assert.equal(
    CredentialVault.load(f.config.campusKeyFile).decrypt(
      row.id,
      "password",
      old,
    ),
    "synthetic-rotation-pass",
  );
});

test("PRD campus backup recovery requires the separate matching keyring before any target write", async (t) => {
  const f = await context(t),
    { backup, restore, snapshot } = await import("../src/operations/backup.js"),
    { FileStore } = await import("../src/files/storage.js");
  await f.service.create(f.actor, {
    ...input(1, "published"),
    credentials: {
      password: { action: "replace", value: "synthetic-separate-backup-pass" },
    },
  });
  const directory = path.join(f.root, "backup");
  await backup(f.db, new FileStore(path.join(f.root, "files")), directory);
  const database = await readFile(
      path.join(directory, "database.json"),
      "utf8",
    ),
    configuration = await readFile(
      path.join(directory, "private-config.json"),
      "utf8",
    ),
    keyring = await readFile(f.config.campusKeyFile, "utf8");
  assert.ok(!database.includes("synthetic-separate-backup-pass"));
  assert.ok(!configuration.includes(JSON.parse(keyring).digest));
  const target = await testDatabase();
  t.after(target.cleanup);
  target.config.campusKeyFile = path.join(f.root, "missing-recovery-key.json");
  const targetFiles = new FileStore(path.join(f.root, "restored-files"));
  await assert.rejects(
    restore(target.db, targetFiles, directory),
    /credential_key_missing/,
  );
  assert.equal(
    (await target.db.query("SELECT count(*)::int n FROM campuses")).rows[0].n,
    0,
  );
  target.config.campusKeyFile = f.config.campusKeyFile;
  await restore(target.db, targetFiles, directory);
  assert.deepEqual(await snapshot(target.db), await snapshot(f.db));
  const recovered = new CampusService(
    new Identity(target.db, target.config, f.provider),
  );
  const row = (await recovered.query(f.actor, {})).items[0];
  assert.equal(row.last_post, "2026-10-19");
  assert.equal(
    (await recovered.reveal(f.actor, row.id, {version:(await f.service.query(f.actor, {})).items.find((x:any)=>x.id===row.id)!.version})).password,
    "synthetic-separate-backup-pass",
  );
});

test("PRD campus metadata paging and a 10k-row ledger stay bounded under 20 concurrent queries", async (t) => {
  const f = await context(t);
  await f.db.query(
    "INSERT INTO campuses(school,school_key,city,status,created_by) SELECT 'Synthetic Load Campus '||n,'synthetic-load-'||n,'Synthetic City','unregistered',$1 FROM generate_series(1,10000) n",
    [f.actor.id],
  );
  await f.db.query("ANALYZE campuses");
  const samples: number[] = [];
  await Promise.all(
    Array.from({ length: 20 }, async (_, i) => {
      const start = performance.now();
      const r = await f.service.query(f.actor, { page: i + 1, pageSize: 25 });
      samples.push(performance.now() - start);
      assert.equal(r.items.length, 25);
      assert.equal(r.total, 10000);
      assert.equal(r.kpis.total, 10000);
    }),
  );
  samples.sort((a, b) => a - b);
  assert.ok(
    samples[18] < 500,
    "Campus P95 " + Math.round(samples[18]) + "ms exceeds 500ms",
  );
});

test("PRD campus key loss makes readiness fail and cannot silently replace the only decryption key", async (t) => {
  const f = await context(t),
    { rename, access } = await import("node:fs/promises");
  await f.service.create(f.actor, {
    ...input(1),
    credentials: {
      password: { action: "replace", value: "synthetic-key-loss-secret" },
    },
  });
  await rename(f.config.campusKeyFile, f.config.campusKeyFile + ".saved");
  assert.equal((await f.app.inject({ url: "/health/ready" })).statusCode, 503);
  await assert.rejects(f.service.vault(), /credential_key_missing/);
  await assert.rejects(access(f.config.campusKeyFile));
  await rename(f.config.campusKeyFile + ".saved", f.config.campusKeyFile);
  assert.equal((await f.app.inject({ url: "/health/ready" })).statusCode, 200);
});

test("PRD campus authorized account search scans beyond one batch while returning only the requested page", async (t) => {
  const f = await context(t),
    vault = await f.service.vault();
  const rows = Array.from({ length: 620 }, (_, n) => {
    const id = crypto.randomUUID();
    return {
      id,
      school: "Synthetic " + String(n).padStart(4, "0"),
      school_key: "synthetic-" + n,
      city: "Synthetic",
      region: "华东",
      tier: "985",
      status: "registered",
      account_cipher: vault.encrypt(
        id,
        "account",
        n % 2 ? "search-target-" + n : "other-" + n,
      ),
      created_by: f.actor.id,
    };
  });
  await f.db.query(
    "INSERT INTO campuses SELECT * FROM json_populate_recordset(NULL::campuses,$1::json)",
    [
      JSON.stringify(
        rows.map((row) => ({
          ...row,
          url: "",
          note: "",
          version: 1,
          configuration_refs:{},
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })),
      ),
    ],
  );
  const result = await f.service.query(f.actor, {
    query: "search-target",
    accountSearch: true,
    region: "华东",
    page: 12,
    pageSize: 25,
  });
  assert.equal(result.total, 310);
  assert.equal(result.items.length, 25);
  assert.equal(result.items[0].school, "Synthetic 0551");
  assert.ok(!JSON.stringify(result).includes("search-target"));
  const exported = await f.service.export(f.actor, {
    query: { query: "search-target", accountSearch: true },
  });
  assert.equal(exported.trim().split("\r\n").length, 311);
});
