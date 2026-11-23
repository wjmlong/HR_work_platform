import { loadConfig } from "./config.js";
import { Database } from "./db.js";
import { buildApp } from "./http/app.js";
import { Dictionary } from "./dictionary/service.js";
import { BusinessConfigService } from './business-config/service.js';
import { Identity } from './identity/service.js';
import { FeishuProvider } from './identity/provider.js';
import { Directory } from './identity/directory.js';
import { ScreeningBatches } from './feishu-feedback/screening.js';
import { startInterviewFeedbackListener } from './feishu-feedback/listener.js';
const config = loadConfig(), db = new Database(config);
await db.migrate();
await new Dictionary(db).seed();
await new BusinessConfigService(new Identity(db, config, new FeishuProvider(config))).seed();
const app = await buildApp({ db, config });
await app.listen({ host: "127.0.0.1", port: config.port });
const feedbackIdentity = new Identity(db, config, new FeishuProvider(config));
const batches = new ScreeningBatches(feedbackIdentity);
const feedbackListener = startInterviewFeedbackListener(feedbackIdentity, { screening_batch: data => batches.submit(data) });
const deliveryTimer = config.feishuFeedback?.enabled ? setInterval(() => void batches.deliver().catch(() => console.error('Screening card delivery pending retry')), 5000) : undefined;
const directoryRefresh = new Directory(new Identity(db, config, new FeishuProvider(config))).start();
console.log(JSON.stringify({
    event: "api.ready",
    instance: config.instance,
    port: config.port,
    version: "4.0.0",
}));
for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, async () => {
        clearInterval(deliveryTimer);
        feedbackListener.close();
        await directoryRefresh.close();
        await app.close();
        await db.close();
        process.exit(0);
    });
//# sourceMappingURL=index.js.map