import {realtimeUpgrades} from './http/realtime-upgrade.js';
import https from "node:https";
import http from "node:http";
import { readFileSync, statSync, existsSync } from "node:fs";
import path from 'node:path';
import {maintenanceResponse} from './http/maintenance.js';
import { loadConfig, readEnvironment } from "./config.js";
const config = loadConfig(),
  env = readEnvironment(),
  certPath = env.RECRUIT_V4_TLS_CERT,
  keyPath = env.RECRUIT_V4_TLS_KEY;
if (!certPath || !keyPath) throw Error("V4 TLS certificate paths required");
const origin = new URL(config.origin),
  targets = [39611, 39612];
let next = 0;
const options = () => ({
  cert: readFileSync(certPath),
  key: readFileSync(keyPath),
  minVersion: "TLSv1.2" as const,
});
const server = https.createServer(options(), async (req, res) => {
  res.setHeader("strict-transport-security", "max-age=31536000");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("cache-control", "no-store");
  if (req.headers.host !== origin.host) {
    res.writeHead(421);
    res.end("Canonical hostname required");
    return;
  }
  const maintenance=maintenanceResponse(req.url,existsSync(path.resolve(config.storageRoot,'..','maintenance.json')));
  if(maintenance){res.writeHead(maintenance.status,maintenance.headers);res.end(maintenance.body);return;}
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const part of req) {
      size += part.length;
      if (size > 12 * 1024 * 1024) {
        res.writeHead(413);
        res.end("Request too large");
        return;
      }
      chunks.push(part);
    }
  } catch {
    res.destroy();
    return;
  }
  const data = Buffer.concat(chunks),
    first = next++ % targets.length;
  const forward = (attempt: number) => {
    const headers: http.OutgoingHttpHeaders = {
      ...req.headers,
      host: origin.host,
      "x-forwarded-proto": "https",
      "x-forwarded-for": req.socket.remoteAddress || "unknown",
    };
    delete headers["x-forwarded-host"];
    delete headers["forwarded"];
    const upstream = http.request(
      {
        hostname: "127.0.0.1",
        port: targets[(first + attempt) % targets.length],
        method: req.method,
        path: req.url,
        headers,
        timeout: /\/api\/v4\/interviews\/[^/]+\/feishu-calendar$/.test(req.url || "") ? 110000 : /\/api\/v4\/jobs\/[^/]+\/question-bank$/.test(req.url || "") ? 110000 : /\/api\/v4\/interviews\/[^/]+\/assistant\/[^/]+\/analyze$/.test(req.url || "") ? 330000 : /\/api\/v4\/interviews\/[^/]+\/assistant\/[^/]+\/audio$/.test(req.url || "") ? 60000 : 20000,
      },
      (response) => {
        res.writeHead(response.statusCode || 502, response.headers);
        response.on("error", () => res.destroy());
        response.pipe(res);
      },
    );
    upstream.on("timeout", () => upstream.destroy(Error("timeout")));
    upstream.on("error", (e: NodeJS.ErrnoException) => {
      if (attempt === 0 && e.code === "ECONNREFUSED" && !res.headersSent) {
        forward(1);
        return;
      }
      if (!res.headersSent) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: { code: "api_unavailable", message: "服务暂时不可用" },
          }),
        );
      } else res.destroy();
    });
    upstream.end(data);
  };
  forward(0);
});
const closeRealtime=realtimeUpgrades(server,origin,targets,()=>existsSync(path.resolve(config.storageRoot,'..','maintenance.json')));
server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.maxRequestsPerSocket = 1000;
server.listen(Number(origin.port || 443), "0.0.0.0", () =>
  console.log(
    JSON.stringify({
      event: "gateway.ready",
      port: Number(origin.port || 443),
    }),
  ),
);
let mtime = statSync(certPath).mtimeMs;
const timer = setInterval(() => {
  try {
    const now = statSync(certPath).mtimeMs;
    if (now !== mtime) {
      server.setSecureContext(options());
      mtime = now;
      console.log(JSON.stringify({ event: "gateway.certificate_reloaded" }));
    }
  } catch {
    console.error(
      JSON.stringify({ event: "gateway.certificate_reload_failed" }),
    );
  }
}, 10000);
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, () => {
    clearInterval(timer);
    closeRealtime();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
