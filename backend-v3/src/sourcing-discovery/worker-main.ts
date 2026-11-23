import { loadConfig } from '../config.js';
import { Database } from '../db.js';
import { Identity } from '../identity/service.js';
import { FeishuProvider } from '../identity/provider.js';
import { DiscoveryWorker } from './worker.js';
const config = loadConfig(), db = new Database(config), worker = new DiscoveryWorker(new Identity(db, config, new FeishuProvider(config)), config.instance + '-sourcing');
await db.migrate();
let stop = false;
for (const signal of ['SIGTERM', 'SIGINT'])
    process.once(signal, () => { stop = true; });
while (!stop) {
    try {
        if (await worker.once())
            continue;
    }
    catch {
        console.error(JSON.stringify({ event: 'discovery.worker.unavailable' }));
    }
    await new Promise(r => setTimeout(r, 1000));
}
await db.close();
