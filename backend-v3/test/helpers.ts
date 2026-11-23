import { randomBytes } from "node:crypto";
import { loadConfig, readEnvironment } from "../src/config.js";
import { Database } from "../src/db.js";
import type { Actor, Role } from "../src/identity/service.js";
import { Identity } from "../src/identity/service.js";
import { buildApp } from "../src/http/app.js";
export async function httpSession(
  db: Database,
  config: ReturnType<typeof loadConfig>,
  roles: Role[] = ["admin"],
) {
  config.feishu = { ...config.feishu, appId: "app", tenant: "company" };
  const a = await actor(db, roles),
    person = {
      tenant: "company",
      appId: "app",
      openId: a.open_id,
      name: a.name,
      active: true,
    },
    provider = {
      configured: () => true,
      authorizeUrl: (s: string) => "https://example.invalid/?state=" + s,
      identity: async () => person,
      contact: async () => person,
    };
  const identity = new Identity(db, config, provider),
    session = await identity.establish(person),
    csrf = (
      await db.query("SELECT csrf FROM sessions WHERE token_hash=$1", [
        identity.hash(session),
      ])
    ).rows[0].csrf;
  const app = await buildApp({ db, config, provider }),
    headers = {
      host: new URL(config.origin).host,
      "x-forwarded-proto": "https",
      origin: config.origin,
      "x-csrf-token": csrf,
      cookie: "__Host-recruit_v4_session=" + session,
    };
  return { app, headers, actor: { ...a, csrf }, provider };
}
export async function actor(
  db: Database,
  roles: Role[] = ["admin"],
): Promise<Actor> {
  const n = randomBytes(5).toString("hex"),
    u = (
      await db.query(
        "INSERT INTO users(tenant,app_id,open_id,name,status,roles) VALUES('company','app',$1,$1,'active',$2) RETURNING *",
        ["ou_" + n, roles],
      )
    ).rows[0];
  return { ...u, csrf: "test-csrf" } as Actor;
}
export async function testDatabase() {
  const config = loadConfig({
    ...readEnvironment(),
    RECRUIT_V4_SCHEMA: "recruit_test_" + randomBytes(8).toString("hex"),
  });
  const db = new Database(config);
  await db.migrate();
  return {
    db,
    config,
    cleanup: async () => {
      await db.query(`DROP SCHEMA "${config.schema}" CASCADE`);
      await db.close();
    },
  };
}
// Downgrade fixtures must remove dependencies before columns; this models real old archives.
export async function dropScreening27(db:Database){
 await db.query('DROP VIEW IF EXISTS active_job_screening_grants');
 await db.query('DROP TABLE IF EXISTS job_screening_grants');
 await db.query('DELETE FROM schema_migrations WHERE version=27');
}
export async function dropRecognition26(db:Database){
 await dropScreening27(db);
 await db.query('ALTER TABLE parse_results DROP COLUMN IF EXISTS recognition');
 await db.query('DELETE FROM schema_migrations WHERE version=26');
}
export async function dropFeedback24(db:Database){
 await dropRecognition26(db);
 await db.query('DROP TABLE feishu_interview_callback_receipts,feishu_interview_confirmations');
 await db.query('DELETE FROM schema_migrations WHERE version IN (24,25)');
}
export async function dropMailReplies23(db:Database){
 await dropFeedback24(db);
 await db.query('DROP TABLE mailbox_reply_receipts');
 await db.query('DELETE FROM schema_migrations WHERE version=23');
}
export async function dropCalendar22(db:Database){
 await dropMailReplies23(db);
 await db.query('DROP TRIGGER calendar_interview_change ON interviews');
 await db.query('DROP TRIGGER calendar_attendee_change ON interviewers');
 await db.query('DROP TRIGGER calendar_participant_removed ON interviewers');
 await db.query('DROP FUNCTION enqueue_calendar_schedule(),revoke_removed_calendar_participant()');
 await db.query('DROP TABLE calendar_sync_outbox,calendar_sync_inbox,calendar_event_links,calendar_sync_state');
 await db.query('ALTER TABLE interviewers DROP COLUMN temporary_access');
 await db.query('DELETE FROM schema_migrations WHERE version=22');
}
export async function dropGrants21(db:Database){
 await dropCalendar22(db);
 await db.query('DROP VIEW active_interview_grants');await db.query('DROP TRIGGER interview_access_schedule ON interviews');await db.query('DROP FUNCTION maintain_interview_access()');await db.query('DROP TABLE interview_access_grants');await db.query('DELETE FROM schema_migrations WHERE version=21');
}
export function historicalArchiveColumns(tables:Record<string,any[]>,columns:Record<string,string[]>,revision:number){
 if(revision<26){for(const row of tables.parse_results||[])delete row.recognition;if(columns.parse_results)columns.parse_results=columns.parse_results.filter(k=>k!=='recognition');}
 if(revision<24)for(const table of ['feishu_interview_callback_receipts','feishu_interview_confirmations']){delete tables[table];delete columns[table];}
 if(revision<23){delete tables.mailbox_reply_receipts;delete columns.mailbox_reply_receipts;}
 const additions:Record<string,string[]>={users:revision<15?['dashboard_preferences']:[],jobs:revision<15?['question_bank']:[],candidates:revision<19?['archived_at','archive_reason']:[],interviews:revision<20?['deleted_at']:[],interviewers:revision<22?['temporary_access']:[]};
 for(const [table,names] of Object.entries(additions)){for(const row of tables[table]||[])for(const name of names)delete row[name];if(columns[table])columns[table]=columns[table].filter(k=>!names.includes(k));}
 if(revision<22)for(const t of ['calendar_sync_state','calendar_event_links','calendar_sync_inbox','calendar_sync_outbox'])delete tables[t];
 if(revision<21)delete tables.interview_access_grants;
}
