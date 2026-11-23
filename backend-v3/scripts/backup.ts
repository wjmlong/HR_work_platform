import path from "node:path";
import { loadConfig, ROOT } from "../src/config.js";
import { Database } from "../src/db.js";
import { FileStore } from "../src/files/storage.js";
import { backup } from "../src/operations/backup.js";
const config = loadConfig(),
  db = new Database(config);
try {
  const dir =
    process.argv[2] ||
    path.join(
      ROOT,
      "private/backups",
      "v4-" + new Date().toISOString().replace(/[:.]/g, "-"),
    );
  const m = await backup(db, new FileStore(config.storageRoot), dir);
  console.log(
    JSON.stringify({
      ok: true,
      directory: dir,
      tables: Object.keys(m.tables).length,
      files: m.files.length,
    }),
  );
} finally {
  await db.close();
}
