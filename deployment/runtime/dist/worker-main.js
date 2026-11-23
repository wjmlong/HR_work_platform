import { CalendarSync } from './feishu-meetings/sync.js';
import { BindingService } from './business-config/bindings.js';
import { loadConfig } from "./config.js";
import { Database } from "./db.js";
import { Identity } from "./identity/service.js";
import { FeishuProvider } from "./identity/provider.js";
import { FileStore } from "./files/storage.js";
import { Worker } from "./tasks/worker.js";
import { Dictionary } from './dictionary/service.js';
const config = loadConfig(), db = new Database(config), worker = new Worker(new Identity(db, config, new FeishuProvider(config)), new FileStore(config.storageRoot), config.instance);
await db.migrate();
await new Dictionary(db).seed();
await new BindingService(worker.identity).initialize();
const calendarSync = new CalendarSync(worker.identity);
await calendarSync.initialize();
let nextCalendar = 0, calendarRunning = null;
let nextRefresh = 0;
let stop = false;
for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => (stop = true));
console.log(JSON.stringify({ event: "worker.ready", instance: config.instance }));
while (!stop) {
    try {
        if (config.calendarSync?.enabled && !calendarRunning && (Date.now() >= nextCalendar || (await db.query('SELECT 1 FROM calendar_sync_state WHERE scope=$1 AND requested_at IS NOT NULL', [calendarSync.scope])).rowCount)) {
            nextCalendar = Date.now() + 60000;
            calendarRunning = calendarSync.run().catch(() => console.error(JSON.stringify({ event: 'calendar.sync_failed' }))).finally(() => { calendarRunning = null; });
        }
        if (Date.now() >= nextRefresh) {
            await worker.enqueueStaleMatches();
            nextRefresh = Date.now() + 60000;
        }
        if (await worker.once())
            continue;
    }
    catch {
        console.error(JSON.stringify({ event: "worker.dependency_unavailable" }));
    }
    await new Promise((r) => setTimeout(r, 1000));
}
if (calendarRunning)
    await calendarRunning;
await db.close();
//# sourceMappingURL=worker-main.js.map