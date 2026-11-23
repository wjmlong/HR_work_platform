import { readFile } from "node:fs/promises";
import { loadConfig } from "../src/config.js";
import { Database } from "../src/db.js";
import { FileStore } from "../src/files/storage.js";
import { migrateLegacy } from "../src/operations/migration.js";
import type { Actor } from "../src/identity/service.js";
const [file, actorId, mode] = process.argv.slice(2);
if (!file || !actorId || !["--dry-run", "--apply"].includes(mode))
  throw Error("Usage: migrate-legacy FILE ADMIN_UUID --dry-run|--apply");
const config = loadConfig(),
  db = new Database(config);
try {
  const a = (
    await db.query("SELECT * FROM users WHERE id=$1 AND status=$2", [
      actorId,
      "active",
    ])
  ).rows[0] as Actor;
  if (!a) throw Error("Approved administrator required");
  const bundle = JSON.parse(await readFile(file, "utf8")),
    report = await migrateLegacy(
      db,
      new FileStore(config.storageRoot),
      a,
      bundle,
      mode === "--dry-run",
    );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await db.close();
}
