import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
const root = path.resolve(import.meta.dirname, ".."),
  privateDir = path.join(root, "private");
fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
const envFile = path.join(root, ".env");
if (!fs.existsSync(envFile)) {
  const password = crypto.randomBytes(24).toString("base64url"),
    secret = crypto.randomBytes(48).toString("base64url");
  fs.writeFileSync(
    envFile,
    `RECRUIT_V4_DATABASE_URL=postgresql://recruit_v4:${password}@127.0.0.1:55434/recruit_v4\nRECRUIT_V4_SECRET=${secret}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(privateDir, "postgres.env"),
    `POSTGRES_USER=recruit_v4\nPOSTGRES_DB=recruit_v4\nPOSTGRES_PASSWORD=${password}\n`,
    { mode: 0o600 },
  );
}
const candidate = path.join(os.homedir(), ".local/bin/docker"),
  docker = fs.existsSync(candidate) ? candidate : "docker";
const run = (args: string[]) =>
  execFileSync(docker, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
let exists = false;
try {
  const info = JSON.parse(run(["inspect", "recruit-v4-postgres"]))[0];
  if (
    info.Config.Labels?.["com.hzpc.recruit.v4"] !== "true" ||
    info.HostConfig.PortBindings?.["5432/tcp"]?.[0]?.HostPort !== "55434"
  )
    throw Error("Existing container does not match V4 isolation guards");
  exists = true;
  if (!info.State.Running) run(["start", "recruit-v4-postgres"]);
} catch (e) {
  if (String(e).includes("isolation guards")) throw e;
}
if (!exists) {
  try {
    run(["network", "inspect", "recruit-v4"]);
  } catch {
    run(["network", "create", "recruit-v4"]);
  }
  run([
    "run",
    "-d",
    "--name",
    "recruit-v4-postgres",
    "--label",
    "com.hzpc.recruit.v4=true",
    "--network",
    "recruit-v4",
    "--restart",
    "unless-stopped",
    "--memory",
    "512m",
    "--cpus",
    "2",
    "-p",
    "127.0.0.1:55434:5432",
    "--env-file",
    path.join(privateDir, "postgres.env"),
    "-v",
    "recruit-v4-pg:/var/lib/postgresql/data",
    "postgres:17-alpine",
  ]);
}
for (let i = 0; i < 60; i++) {
  try {
    run([
      "exec",
      "recruit-v4-postgres",
      "pg_isready",
      "-U",
      "recruit_v4",
      "-d",
      "recruit_v4",
    ]);
    console.log(
      "Dedicated V4 PostgreSQL ready on 127.0.0.1:55434; private credentials saved, not printed.",
    );
    process.exit(0);
  } catch {
    await new Promise((r) => setTimeout(r, 500));
  }
}
throw Error("V4 PostgreSQL did not become ready");
