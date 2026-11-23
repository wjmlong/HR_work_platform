import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase, actor } from "./helpers.js";
import { importMembers } from "../src/operations/members.js";
test("legacy membership migration preserves approved identities and roles, refuses conflicting authority and does not merge by display name", async (t) => {
  const { db, cleanup } = await testDatabase();
  t.after(cleanup);
  const a = await actor(db);
  const members = [
    {
      tenant_key: "company",
      app_id: "app",
      open_id: a.open_id,
      name: a.name,
      status: "active",
      role: "admin",
      directory_active: true,
      last_verified_at: "1600000000000",
      created_at: "1600000000000",
    },
    {
      tenant_key: "company",
      app_id: "app",
      open_id: "ou_synthetic_other",
      name: a.name,
      status: "active",
      role: "admin",
      directory_active: true,
      last_verified_at: 1600000000000,
      created_at: 1600000000000,
    },
    {
      tenant_key: "company",
      app_id: "app",
      open_id: "ou_synthetic_pending",
      name: "Synthetic pending",
      status: "pending",
      role: "editor",
      directory_active: true,
    },
  ];
  const dry = await importMembers(db, a, members, true);
  assert.equal(dry.create, 2);
  assert.equal(dry.existing, 1);
  assert.equal(
    (await db.query("SELECT count(*) FROM users")).rows[0].count,
    "1",
  );
  await importMembers(db, a, members, false);
  const users = (await db.query("SELECT * FROM users")).rows;
  assert.equal(users.length, 3);
  assert.equal(
    users.find((u) => u.open_id === "ou_synthetic_other").status,
    "active",
  );
  assert.deepEqual(
    users.find((u) => u.open_id === "ou_synthetic_pending").roles,
    ["recruiter"],
  );
  assert.equal(
    users.find((u) => u.open_id === "ou_synthetic_pending").status,
    "pending",
  );
  const conflict = members.map((m, n) =>
    n === 0 ? { ...m, role: "viewer" } : m,
  );
  assert.equal((await importMembers(db, a, conflict, true)).ready, false);
  await assert.rejects(
    importMembers(db, a, conflict, false),
    /membership_authority_conflict/,
  );
  assert.deepEqual(
    (await db.query("SELECT roles FROM users WHERE id=$1", [a.id])).rows[0]
      .roles,
    ["admin"],
  );
});
