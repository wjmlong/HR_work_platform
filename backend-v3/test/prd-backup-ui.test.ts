import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile, unlink } from "node:fs/promises";
import { CampusService } from "../src/campus/service.js";
import { CredentialVault } from "../src/campus/vault.js";
import path from "node:path";
import os from "node:os";
import { testDatabase, actor, httpSession } from "./helpers.js";
import { BackupCopies } from "../src/operations/copies.js";
import { Database } from "../src/db.js";
import { Identity } from "../src/identity/service.js";
import { FeishuProvider } from "../src/identity/provider.js";
import { Dictionary } from "../src/dictionary/service.js";

test("original sourcing v1 state labels, skill aliases and follow date survive import without becoming invented contact history", async (t) => {
  const { service, a, config } = await fixture(t),
    request = {
      kind: "talent_sourcing_v1",
      mapping: {},
      text: JSON.stringify({
        list: [
          {
            name: "Synthetic",
            org: "Synthetic",
            dir: "AI",
            src: "顶会论文",
            line: "high",
            state: "已拿到简历",
            skills: "torch / LLM",
            follow: "2025-01-02",
          },
        ],
      }),
    };
  const preview = await service.preview(a, request);
  assert.equal(preview.ready, true, JSON.stringify(preview));
  const result = await service.apply(a, {
      ...request,
      token: preview.token,
      confirm: true,
    }),
    db = new Database({ ...config, schema: result.schema });
  try {
    const row = (await db.query("SELECT * FROM leads")).rows[0];
    assert.equal(row.state, "resume_received");
    assert.deepEqual(row.skills, ["PyTorch", "大模型"]);
    assert.equal(
      row.last_followup_at.toISOString(),
      "2025-01-01T16:00:00.000Z",
    );
    assert.equal(row.last_contacted_at, null);
    assert.equal(
      (await db.query("SELECT count(*) FROM lead_followups")).rows[0].count,
      "0",
    );
  } finally {
    await db.close();
  }
});
async function fixture(t: any) {
  const f = await testDatabase(),
    directory = await mkdtemp(path.join(os.tmpdir(), "v4-copy-"));
  f.config.storageRoot = path.join(directory, "files");
  f.config.campusKeyFile = path.join(directory, "campus-keys.json");
  await new Dictionary(f.db).seed();
  const a = await actor(f.db),
    service = new BackupCopies(
      new Identity(f.db, f.config, new FeishuProvider(f.config)),
    );
  t.after(async () => {
    for (const r of await service.list(a)) {
      const d = new Database({ ...f.config, schema: r.schema });
      await d.query('DROP SCHEMA "' + r.schema + '" CASCADE');
      await d.close();
    }
    await f.cleanup();
    await rm(directory, { recursive: true, force: true });
  });
  return { ...f, a, service, directory };
}
test("encrypted import copies keep readiness closed after key loss even if the live campus table is empty", async (t) => {
  const { service, a, config, db } = await fixture(t),
    request = {
      kind: "talent_campus_v1",
      text: JSON.stringify([
        { school: "Synthetic", pwd: "SYNTHETIC_PASSWORD" },
      ]),
      mapping: {},
    };
  const preview = await service.preview(a, request);
  await service.apply(a, { ...request, token: preview.token, confirm: true });
  await unlink(config.campusKeyFile);
  const campus = new CampusService(
    new Identity(db, config, new FeishuProvider(config)),
  );
  await assert.rejects(campus.keyStatus(), /credential_key_missing/);
  await assert.rejects(campus.vault(), /credential_key_missing/);
  await assert.rejects(readFile(config.campusKeyFile), { code: "ENOENT" });
});
test("three legacy storage formats preview without writes and import only isolated persistent copies", async (t) => {
  const f = await fixture(t),
    { a, service, db } = f;
  const inputs = [
    {
      kind: "recruit_workbench_v1",
      data: {
        jobs: [{ id: "j", name: "Synthetic job" }],
        talents: [
          {
            id: "t",
            name: "Synthetic person",
            jobId: "j",
            status: "待筛选",
            raw: "姓名：Synthetic person\n技能：Python",
          },
        ],
        interviews: [],
      },
    },
    {
      kind: "talent_sourcing_v1",
      data: [
        {
          id: "l",
          name: "Synthetic lead",
          org: "Synthetic org",
          school: "Synthetic school",
          major: "CS",
          skills: ["Python"],
          dir: "AI",
          contact: "synthetic@example.invalid",
          source: "历史来源",
          line: "high",
          state: "已回复",
          note: "Synthetic note",
          lastContactedAt: "2025-01-01T00:00:00Z",
        },
      ],
    },
    {
      kind: "talent_campus_v1",
      data: [
        {
          id: "c",
          school: "Synthetic campus",
          region: "华东",
          tier: "985",
          url: "https://example.invalid",
          status: "已发布",
          acct: "SYNTHETIC_ACCOUNT",
          pwd: "SYNTHETIC_PASSWORD",
          lastPost: "2025-01-02",
          note: "Synthetic note",
        },
      ],
    },
  ];
  for (const input of inputs) {
    const request = {
      kind: input.kind,
      text: JSON.stringify({ [input.kind]: input.data }),
      mapping: {},
    };
    const preview = await service.preview(a, request);
    assert.equal(preview.ready, true, JSON.stringify(preview));
    assert.equal((await service.list(a)).length, inputs.indexOf(input));
    assert.ok(!JSON.stringify(preview).includes("SYNTHETIC_PASSWORD"));
    await assert.rejects(
      service.apply(a, { ...request, token: preview.token, confirm: false }),
      /import_confirmation/,
    );
    const result = await service.apply(a, {
      ...request,
      token: preview.token,
      confirm: true,
    });
    assert.ok(/^recruit_test_import[a-f0-9]{24}$/.test(result.schema));
    assert.equal(
      (
        await service.apply(a, {
          ...request,
          token: preview.token,
          confirm: true,
        })
      ).id,
      result.id,
    );
    const inspected = await service.inspect(a, result.id, 1);
    assert.equal(inspected.total, 1);
    assert.ok(!JSON.stringify(inspected).includes("SYNTHETIC_PASSWORD"));
    const copy = new Database({ ...f.config, schema: result.schema });
    if (input.kind === "talent_sourcing_v1") {
      const r = (await copy.query("SELECT * FROM leads")).rows[0];
      assert.equal(r.state, "replied");
      assert.equal(r.source, "历史来源");
      assert.equal(
        r.last_contacted_at.toISOString(),
        "2025-01-01T00:00:00.000Z",
      );
    }
    if (input.kind === "talent_campus_v1") {
      const r = (await copy.query("SELECT * FROM campuses")).rows[0];
      assert.equal(r.last_post, "2025-01-02");
      assert.ok(r.password_cipher);
      assert.equal(
        (await copy.query("SELECT count(*) FROM legacy_archives")).rows[0]
          .count,
        "0",
      );
    }
    await copy.close();
  }
  assert.equal(
    (
      await db.query(
        "SELECT (SELECT count(*) FROM candidates)+(SELECT count(*) FROM leads)+(SELECT count(*) FROM campuses) n",
      )
    ).rows[0].n,
    "0",
  );
  assert.ok(
    !JSON.stringify(
      (await db.query("SELECT * FROM migration_receipts")).rows,
    ).includes("SYNTHETIC_PASSWORD"),
  );
  for (const entry of await readdir(f.directory, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (entry.isFile())
      assert.ok(
        !(
          await readFile(path.join(entry.parentPath, entry.name), "utf8")
        ).includes("SYNTHETIC_PASSWORD"),
      );
  }
});
test("SQL backup download excludes sessions and secrets; integrity, role, token and encrypted-key gates precede copy writes", async (t) => {
  const f = await fixture(t),
    { service, a, db } = f;
  const reader = await actor(db, ["viewer"]);
  await assert.rejects(service.export(reader), /forbidden/);
  const source = {
    kind: "talent_campus_v1",
    text: JSON.stringify([
      { school: "Synthetic", password: "SYNTHETIC_PASSWORD" },
    ]),
    mapping: {},
  };
  const p = await service.preview(a, source);
  await assert.rejects(
    service.apply(a, {
      ...source,
      text: source.text + " ",
      token: p.token,
      confirm: true,
    }),
    /import_preview_invalid/,
  );
  const result = await service.apply(a, {
    ...source,
    token: p.token,
    confirm: true,
  });
  const archive = await service.export(a, result.id);
  assert.equal(archive.format, "recruit-v4-copy");
  assert.equal(archive.tables.sessions.length, 0);
  assert.ok(!JSON.stringify(archive).includes(f.config.secret));
  assert.ok(!JSON.stringify(archive).includes("SYNTHETIC_PASSWORD"));
  const request = {
    kind: "recruit-v4-copy",
    text: JSON.stringify(archive),
    mapping: {},
  };
  const preview = await service.preview(a, request);
  assert.equal(preview.ready, true);
  const restored = await service.apply(a, {
    ...request,
    token: preview.token,
    confirm: true,
  });
  assert.equal((await service.inspect(a, restored.id, 1)).total, 1);
  const tampered = structuredClone(archive);
  tampered.tables.campuses[0].school = "Tampered";
  assert.equal(
    (await service.preview(a, { ...request, text: JSON.stringify(tampered) }))
      .ready,
    false,
  );
  const campusUnknown = await service.preview(a, {
    ...source,
    text: JSON.stringify([
      { school: "Synthetic", apiSecret: "DO_NOT_ARCHIVE" },
    ]),
  });
  assert.equal(campusUnknown.ready, false);
  CredentialVault.create(path.join(f.directory, "other-keys.json"));
  const wrongKey = new BackupCopies(
    new Identity(
      db,
      { ...f.config, campusKeyFile: path.join(f.directory, "other-keys.json") },
      new FeishuProvider(f.config),
    ),
  );
  assert.equal((await wrongKey.preview(a, request)).ready, false);
  assert.equal((await service.list(a)).length, 2);
});
test("backup HTTP endpoints require admin plus origin/CSRF and never cache campus input in command receipts", async (t) => {
  const f = await fixture(t),
    session = await httpSession(f.db, f.config);
  t.after(() => session.app.close());
  const body = {
    kind: "talent_campus_v1",
    text: JSON.stringify([{ school: "Synthetic", pwd: "SYNTHETIC_PASSWORD" }]),
    mapping: {},
  };
  const denied = await session.app.inject({
    method: "POST",
    url: "/api/v4/admin/backups/preview",
    headers: { ...session.headers, "x-csrf-token": "wrong" },
    payload: body,
  });
  assert.equal(denied.statusCode, 403);
  const r = await session.app.inject({
    method: "POST",
    url: "/api/v4/admin/backups/preview",
    headers: session.headers,
    payload: body,
  });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(
    (await f.db.query("SELECT count(*) FROM idempotency_keys")).rows[0].count,
    "0",
  );
});

test("legacy interview import requires explicit identity mapping, retains source time/result and never invents evaluation scores", async (t) => {
  const { service, a, config } = await fixture(t);
  const request = {
    kind: "recruit_workbench_v1",
    mapping: {},
    text: JSON.stringify({
      jobs: [{ id: "j", name: "Synthetic" }],
      talents: [
        {
          id: "t",
          jobId: "j",
          name: "Synthetic",
          status: "面试中",
          raw: "姓名：Synthetic\nPython",
        },
      ],
      interviews: [
        {
          id: "i",
          candId: "t",
          who: "Legacy interviewer",
          date: "2025-01-01",
          time: "09:30",
          round: "二面",
          status: "已完成",
          way: "视频",
          fb: "Legacy feedback",
        },
      ],
    }),
  };
  const blocked = await service.preview(a, request);
  assert.equal(blocked.ready, false);
  assert.deepEqual(blocked.mappings, ["Legacy interviewer"]);
  const mapped = { ...request, mapping: { "Legacy interviewer": a.id } },
    preview = await service.preview(a, mapped);
  assert.equal(preview.ready, true);
  const result = await service.apply(a, {
      ...mapped,
      token: preview.token,
      confirm: true,
    }),
    db = new Database({ ...config, schema: result.schema });
  try {
    const row = (await db.query("SELECT * FROM interviews")).rows[0];
    assert.equal(row.round, 2);
    assert.equal(row.primary_interviewer_id, a.id);
    assert.equal(row.status, "legacy_completed");
    assert.equal(row.starts_at.toISOString(), "2025-01-01T01:30:00.000Z");
    assert.equal(row.feedback, "Legacy feedback");
    assert.equal(
      (await db.query("SELECT count(*) FROM evaluations")).rows[0].count,
      "0",
    );
  } finally {
    await db.close();
  }
});
