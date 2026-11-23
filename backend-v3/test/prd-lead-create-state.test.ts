import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase, actor } from "./helpers.js";
import { Identity } from "../src/identity/service.js";
import { FeishuProvider } from "../src/identity/provider.js";
import { SourcingService } from "../src/sourcing/service.js";
test("lead create form records the selected initial state and follow date atomically without inventing actual contact", async (t) => {
  const { db, config, cleanup } = await testDatabase();
  t.after(cleanup);
  const a = await actor(db),
    s = new SourcingService(
      new Identity(db, config, new FeishuProvider(config)),
    ),
    input = {
      name: "Synthetic",
      org: "Synthetic",
      direction: "AI",
      source: "其他",
      line: "high",
    };
  const r = await s.create(a, {
    ...input,
    state: "resume_received",
    followupDate: "2025-01-01",
  });
  assert.equal(r.state, "resume_received");
  assert.equal(r.last_contacted_at, null);
  assert.equal(r.last_followup_at.toISOString(), "2024-12-31T16:00:00.000Z");
  assert.equal(
    (
      await db.query("SELECT to_state FROM lead_events WHERE lead_id=$1", [
        r.id,
      ])
    ).rows[0].to_state,
    "resume_received",
  );
  assert.equal(
    (await db.query("SELECT kind FROM lead_followups WHERE lead_id=$1", [r.id]))
      .rows[0].kind,
    "note",
  );
  await assert.rejects(
    s.create(a, { ...input, state: "contacted" }),
    /contact_time_required/,
  );
  await assert.rejects(
    s.create(a, {
      ...input,
      state: "uncontacted",
      occurredAt: "2025-01-02T09:00:00+08:00",
    }),
    /contact_state_conflict/,
  );
  assert.equal(
    (await db.query("SELECT count(*) FROM leads")).rows[0].count,
    "1",
  );
  const contacted = await s.create(a, {
    ...input,
    state: "contacted",
    occurredAt: "2025-01-02T09:00:00+08:00",
  });
  assert.equal(
    contacted.last_contacted_at.toISOString(),
    "2025-01-02T01:00:00.000Z",
  );
});
