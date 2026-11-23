import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export type Config = {
  recognitionConfigFile?: string;
  recognitionPython?: string;
  mailReplyConfigFile?: string;
  feishuFeedback?: { enabled: boolean };
  cookiePrefix?: string;
  calendarSync?: {enabled:boolean;calendarId:string};
  modelConfigFile?: string;
  speechConfigFile?: string;
  databaseUrl: string;
  schema: string;
  origin: string;
  secret: string;
  storageRoot: string;
  campusKeyFile: string;
  webRoot: string;
  assetRoot?: string;
  port: number;
  instance: string;
  production: boolean;
  feishu: {
    appId: string;
    appSecret: string;
    tenant: string;
    admins: string[];
    callback: string;
  };
};
export function readEnvironment(): NodeJS.ProcessEnv {
  const result = { ...process.env },
    file = path.join(ROOT, ".env");
  if (fs.existsSync(file))
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match && result[match[1]] === undefined)
        result[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  return result;
}
export function isolatedDatabaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw Error("Missing isolated database URL");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "55434" ||
    url.pathname !== "/recruit_v4" || url.search || url.hash
  )
    throw Error("Requires isolated database 127.0.0.1:55434/recruit_v4");
  return url;
}
export function isolatedSchema(schema: string) {
  if (!/^recruit_(v4|test_[a-z0-9]{1,48})$/.test(schema))
    throw Error("Invalid isolated schema");
  return schema;
}
export function loadConfig(env: NodeJS.ProcessEnv = readEnvironment()): Config {
  const url = isolatedDatabaseUrl(env.RECRUIT_V4_DATABASE_URL || "");
  const schema = env.RECRUIT_V4_SCHEMA || "recruit_v4";
  isolatedSchema(schema);
  const secret = env.RECRUIT_V4_SECRET || "";
  if (secret.length < 40)
    throw Error("Application secret must have at least 40 characters");
  const origin =
    env.RECRUIT_V4_ORIGIN || "https://hzpc3929demacbook-pro.local:39613";
  const parsed = new URL(origin);
  if (parsed.protocol !== "https:") throw Error("HTTPS is required");
  if (parsed.origin !== origin || parsed.username || parsed.password)
    throw Error("Must configure a canonical origin without paths");
  const port = Number(env.RECRUIT_V4_PORT || 39611);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw Error("Invalid port");
  const callbackPath =
    env.RECRUIT_V4_FEISHU_CALLBACK_PATH || "/api/v4/auth/feishu/callback";
  if (
    ![
      "/api/v4/auth/feishu/callback",
      "/api/v3/auth/feishu/callback",
      "/api/auth/feishu/callback",
    ].includes(callbackPath)
  )
    throw Error("Invalid Feishu callback path");
  const cookiePrefix = env.RECRUIT_V4_COOKIE_PREFIX || "__Host-recruit_v4";
  if (!/^__Host-[a-zA-Z0-9_]+$/.test(cookiePrefix)) throw Error("Invalid cookie prefix");
  return {
    recognitionConfigFile: env.RECRUIT_V4_RECOGNITION_CONFIG_FILE || undefined,
    recognitionPython: env.RECRUIT_V4_RECOGNITION_PYTHON || undefined,
    mailReplyConfigFile: env.RECRUIT_V4_MAIL_REPLY_CONFIG_FILE || undefined,
    feishuFeedback: { enabled: env.RECRUIT_V4_FEISHU_FEEDBACK_ENABLED === 'true' },
    cookiePrefix,
    calendarSync: {enabled:env.RECRUIT_V4_CALENDAR_SYNC_ENABLED==='true',calendarId:env.RECRUIT_V4_CALENDAR_ID||''},
    modelConfigFile: env.RECRUIT_V4_MODEL_CONFIG_FILE || undefined,
    speechConfigFile: env.RECRUIT_V4_SPEECH_CONFIG_FILE || undefined,
    databaseUrl: url.href,
    campusKeyFile: path.resolve(
      env.RECRUIT_V4_CAMPUS_KEY_FILE ||
        path.join(ROOT, "private/campus-keys.json"),
    ),
    schema,
    origin,
    secret,
    webRoot: path.join(ROOT, "web-dist"),
    assetRoot: env.RECRUIT_V4_ASSET_ROOT || undefined,
    storageRoot: path.resolve(
      env.RECRUIT_V4_STORAGE || path.join(ROOT, "private/files"),
    ),
    port,
    instance: env.RECRUIT_V4_INSTANCE || "v4-a",
    production: env.RECRUIT_V4_ENV === "production",
    feishu: {
      appId: env.RECRUIT_V4_FEISHU_APP_ID || "",
      appSecret: env.RECRUIT_V4_FEISHU_APP_SECRET || "",
      tenant: env.RECRUIT_V4_FEISHU_TENANT || "",
      admins: (env.RECRUIT_V4_FEISHU_ADMINS || "").split(",").filter(Boolean),
      callback: origin + callbackPath,
    },
  };
}
