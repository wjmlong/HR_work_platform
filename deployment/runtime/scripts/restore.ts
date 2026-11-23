import { loadConfig } from "../src/config.js";
import { Database } from "../src/db.js";
import { FileStore } from "../src/files/storage.js";
import { restore } from "../src/operations/backup.js";
const config = loadConfig();
if (!process.argv[2] || !config.schema.startsWith("recruit_test_"))
  throw Error("Restore requires archive path and isolated empty test schema");
const db = new Database(config);
try {
  await db.migrate();
  const result = await restore(
    db,
    new FileStore(config.storageRoot),
    process.argv[2],
  );
  console.log(
    JSON.stringify({
      ok: true,
      tableCount: Object.keys(result.tables).length,
      files: result.files,
    }),
  );
} finally {
  await db.close();
}
