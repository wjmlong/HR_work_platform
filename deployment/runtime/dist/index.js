import { loadConfig } from "./config.js";
import { Database } from "./db.js";
import { buildApp } from "./http/app.js";
import { Dictionary } from "./dictionary/service.js";
import { BusinessConfigService } from './business-config/service.js';
import { Identity } from './identity/service.js';
import { FeishuProvider } from './identity/provider.js';
const config = loadConfig(), db = new Database(config);
await db.migrate();
await new Dictionary(db).seed();
await new BusinessConfigService(new Identity(db, config, new FeishuProvider(config))).seed();
const app = await buildApp({ db, config });
await app.listen({ host: "127.0.0.1", port: config.port });
console.log(JSON.stringify({
    event: "api.ready",
    instance: config.instance,
    port: config.port,
    version: "4.0.0",
}));
for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, async () => {
        await app.close();
        await db.close();
        process.exit(0);
    });
//# sourceMappingURL=index.js.map