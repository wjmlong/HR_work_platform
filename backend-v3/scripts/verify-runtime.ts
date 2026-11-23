import { execFileSync, spawnSync } from "node:child_process";
import { networkInterfaces } from "node:os";
import { mkdir, writeFile,readFile } from "node:fs/promises";
import path from 'node:path';
import {Database} from '../src/db.js';
import {FileStore} from '../src/files/storage.js';
import {inspectRuntimeDatabase} from '../src/operations/runtime-upgrade.js';
import {CURRENT_TABLES, CONFIGURATION_V15_TABLES, CONFIGURATION_V16_TABLES, CONFIGURATION_V17_TABLES} from '../src/operations/archive-schema.js';
import { loadConfig } from "../src/config.js";
const config = loadConfig(),
  origin = new URL(config.origin),
  host = origin.hostname,
  port = origin.port || "443",
  checks: object[] = [];
const runtime=path.resolve(config.storageRoot,'../..'),installed=JSON.parse(await readFile(path.join(runtime,'installed.json'),'utf8')),release=path.resolve(installed.release),manifest=JSON.parse(await readFile(path.join(release,'release-manifest.json'),'utf8'));
if(path.dirname(release)!==path.join(runtime,'releases')||![14,15,16,17,18].includes(manifest.schemaRevision))throw Error('Installed release identity invalid');
const db=new Database(config);let database;
try{database=await inspectRuntimeDatabase(db,new FileStore(config.storageRoot));if(database.schemaRevision!==manifest.schemaRevision||JSON.stringify(Object.keys(database.tables).sort())!==JSON.stringify([...(manifest.schemaRevision===18?CURRENT_TABLES:manifest.schemaRevision===17?CONFIGURATION_V17_TABLES:manifest.schemaRevision===16?CONFIGURATION_V16_TABLES:CONFIGURATION_V15_TABLES)].sort()))throw Error('Installed database revision differs from release');}finally{await db.close();}
checks.push({check:'installed_release_and_database',release:path.basename(release),schemaRevision:database.schemaRevision,tables:Object.keys(database.tables).length,status:'passed'});
let preferred = "";
try {
  preferred =
    execFileSync("/sbin/route", ["-n", "get", "default"], {
      encoding: "utf8",
    }).match(/interface:\s*(\S+)/)?.[1] || "";
} catch {}
const interfaces = networkInterfaces(),
  ip = [
    ...(interfaces[preferred] || []),
    ...Object.entries(interfaces)
      .filter(([name]) => name !== preferred)
      .flatMap(([, v]) => v || []),
  ].find(
    (x) =>
      x.family === "IPv4" && !x.internal && !x.address.startsWith("169.254."),
  )?.address;
if (!ip) throw Error("No current LAN IPv4 interface");
const get = (url: string, extra: string[] = []) =>
  JSON.parse(
    execFileSync(
      "/usr/bin/curl",
      [
        "--noproxy",
        "*",
        "--fail",
        "--silent",
        "--show-error",
        "--max-time",
        "10",
        ...extra,
        url,
      ],
      { encoding: "utf8" },
    ),
  );
for (const apiPort of [39611, 39612]) {
  const result = get("http://127.0.0.1:" + apiPort + "/health/ready");
  if (result.status !== "ready") throw Error("V4 API not ready");
  checks.push({
    check: "api",
    port: apiPort,
    instance: result.instance,
    status: "passed",
  });
}
for (const [check, extra] of [
  ["system_tls", []],
  ["local_lan_interface", ["--resolve", host + ":" + port + ":" + ip]],
] as [string, string[]][]) {
  if (get(config.origin + "/health/ready", extra).status !== "ready")
    throw Error("V4 gateway not ready");
  checks.push({ check, status: "passed" });
}
const wrong = spawnSync("/usr/bin/curl", [
  "--noproxy",
  "*",
  "--silent",
  "--show-error",
  "--max-time",
  "10",
  "https://127.0.0.1:" + port + "/health/ready",
]);
if (wrong.status !== 60) throw Error("Wrong-hostname certificate not rejected");
checks.push({
  check: "wrong_hostname_rejected",
  status: "passed",
  exitCode: wrong.status,
});
for (const role of ["api-a", "api-b", "worker-a", "worker-b", "gateway"]) {
  const state = execFileSync(
    "launchctl",
    ["print", "gui/" + process.getuid!() + "/com.hzpc.recruit.v4." + role],
    { encoding: "utf8" },
  );
  if (!/state = running/.test(state) || !state.match(/pid = \d+/))
    throw Error("V4 agent unavailable: " + role);
  if(!state.includes(release+'/dist/'))throw Error('V4 agent runs another release: '+role);
  checks.push({ check: "agent", role, status: "passed" });
}
const backupAgent=execFileSync('launchctl',['print','gui/'+process.getuid!()+'/com.hzpc.recruit.v4.backup'],{encoding:'utf8'});
if(!backupAgent.includes(release+'/dist/operations/cli.js'))throw Error('Backup schedule runs another release');
checks.push({check:'scheduled_backup_release',status:'passed'});
const v3 = get("https://" + host + ":39513/health/ready"),
  v2 = get("https://" + host + ":39413/api/health"),
  okr = get("http://127.0.0.1:18080/health/ready");
if (v3.status !== "ready" || !v2.ok || okr.status !== "ok")
  throw Error("Existing service readiness changed");
checks.push({
  check: "existing_recruit_v2_v3_and_okr",
  status: "passed",
  existingRecruitVersion: v2.version,
});
const report = {
  at: new Date().toISOString(),
  origin: config.origin,
  ip,
  release:path.basename(release),schemaRevision:database.schemaRevision,tableCounts:Object.fromEntries(Object.entries(database.tables).map(([t,v])=>[t,v.count])),fileCount:database.files.length,
  checks,
  limits: [
    "LAN interface tested from this Mac; no second computer tested",
    "Readiness is separate from actual Feishu browser login and business acceptance",
  ],
};
await mkdir("test-results", { recursive: true });
await writeFile(
  "test-results/runtime-v4.json",
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
