import { CampusService } from "../campus/service.js";
import { Identity } from "../identity/service.js";
import { FeishuProvider } from "../identity/provider.js";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { loadConfig, ROOT } from "../config.js";
import { Database } from "../db.js";
import { FileStore } from "../files/storage.js";
import { backup, restore } from "./backup.js";
import { migrateLegacy } from "./migration.js";
import { upgradeV3 } from "./upgrade-v3.js";
const [command, file, actorId, mode] = process.argv.slice(2), config = loadConfig(), db = new Database(config), store = new FileStore(config.storageRoot);
try {
    if (command === "campus-key-rotate" && file) {
        const a = (await db.query("SELECT * FROM users WHERE id=$1 AND status='active'", [
            file,
        ])).rows[0];
        if (!a)
            throw Error("Approved admin required");
        console.log(JSON.stringify(await new CampusService(new Identity(db, config, new FeishuProvider(config))).rotate(a)));
    }
    else if (command === "backup") {
        const dir = file ||
            path.join(ROOT, "private/backups", "v4-" + new Date().toISOString().replace(/[:.]/g, "-")), m = await backup(db, store, dir);
        console.log(JSON.stringify({
            ok: true,
            backupDirectory: dir,
            tables: Object.keys(m.tables).length,
            files: m.files.length,
        }));
    }
    else if (command === "upgrade-v3" &&
        file &&
        ["--dry-run", "--apply"].includes(actorId)) {
        await db.migrate();
        console.log(JSON.stringify(await upgradeV3(db, store, file, actorId === "--dry-run")));
    }
    else if (command === "restore" && file) {
        await db.migrate();
        const r = await restore(db, store, file);
        console.log(JSON.stringify({
            ok: true,
            tables: Object.keys(r.tables).length,
            files: r.files,
        }));
    }
    else if (command === "migrate" &&
        file &&
        actorId &&
        ["--dry-run", "--apply"].includes(mode)) {
        const a = (await db.query("SELECT * FROM users WHERE id=$1 AND status='active'", [
            actorId,
        ])).rows[0];
        if (!a)
            throw Error("Approved admin required");
        console.log(JSON.stringify(await migrateLegacy(db, store, a, JSON.parse(await readFile(file, "utf8")), mode === "--dry-run")));
    }
    else
        throw Error("Usage: cli backup [DIR] | restore DIR | upgrade-v3 DIR --dry-run|--apply | migrate FILE ADMIN_UUID --dry-run|--apply");
}
finally {
    await db.close();
}
//# sourceMappingURL=cli.js.map