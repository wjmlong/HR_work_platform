import { feishuMeetingRoutes } from '../feishu-meetings/routes.js';
import { registerInterviewFeedbackRoutes } from '../feishu-feedback/routes.js';
import { resumeWorkflowRoutes } from '../resume-workflow/routes.js';
import { mailboxRoutes } from '../mailbox/routes.js';
import { BindingService } from '../business-config/bindings.js';
import { campusRoutes } from "../campus/routes.js";
import { copyRoutes } from "../operations/copy-routes.js";
import { CampusService } from "../campus/service.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import swagger from "@fastify/swagger";
import { FeishuProvider } from "../identity/provider.js";
import { Identity } from "../identity/service.js";
import { identityRoutes } from "../identity/routes.js";
import { ApiError, fail } from "./errors.js";
import { sourcingRoutes } from "../sourcing/routes.js";
import { recruitingRoutes } from "../recruiting/routes.js";
import { Commands } from "./commands.js";
import { taskRoutes } from "../tasks/routes.js";
import { interviewRoutes } from "../interviews/routes.js";
import { materialRoutes } from "../materials/routes.js";
import { statisticsRoutes } from "../statistics/routes.js";
import { toolkitRoutes } from "../toolkit/routes.js";
import { referralRoutes } from "../referrals/routes.js";
import { adminRoutes } from "../admin/routes.js";
import { contract } from "./contracts.js";
import { randomUUID } from "node:crypto";
import { dashboardRoutes } from "../dashboard/routes.js";
import { interviewerReviewRoutes } from "../interviewer-review/routes.js";
import { configurationPolicy } from '../business-config/http-policy.js';
import { queryRoutes } from '../business-config/query-routes.js';
import { businessConfigRoutes } from '../business-config/routes.js';
export async function buildApp({ db, config, provider = new FeishuProvider(config), }) {
    const app = Fastify({
        logger: false,
        genReqId: () => randomUUID(),
        bodyLimit: 12 * 1024 * 1024,
        trustProxy: (address) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address),
        // Zod applies defaults in the business boundary. AJV must not mutate union
        // branches (defaults there are ambiguous and rejected in its strict mode).
        ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } },
    });
    await app.register(cookie);
    await app.register(websocket, { options: { maxPayload: 65536, perMessageDeflate: false, handleProtocols: protocols => protocols.has("recruit-realtime") ? "recruit-realtime" : false } });
    await app.register(multipart, {
        limits: { files: 1, parts: 4, fileSize: 10 * 1024 * 1024, fields: 3 },
    });
    await app.register(swagger, {
        openapi: {
            info: { title: "招聘工作台 V4", version: "4.0.0" },
            servers: [{ url: config.origin }],
            components: {
                securitySchemes: {
                    session: {
                        type: "apiKey",
                        in: "cookie",
                        name: "__Host-recruit_v4_session",
                    },
                },
            },
        },
    });
    const identity = new Identity(db, config, provider);
    // Complete catalog bootstrap before requests compete for the connection pool.
    await new BindingService(identity).initialize();
    app.decorateRequest("actor", null);
    const publicPaths = new Set([
        "/",
        "/health/live",
        "/health/ready",
        "/api/v4/auth/providers",
        "/api/v4/auth/feishu/start",
        "/api/v4/auth/feishu/callback",
        "/api/v3/auth/feishu/callback",
        "/api/auth/feishu/callback",
    ]);
    app.addHook("onRequest", async (req, reply) => {
        reply
            .header("cache-control", "no-store")
            .header("x-content-type-options", "nosniff")
            .header("referrer-policy", "no-referrer");
        const path = req.url.split("?")[0];
        if (path.startsWith("/health/"))
            return;
        if (req.protocol !== "https" || req.host !== new URL(config.origin).host)
            fail(421, "canonical_https_required");
        if (path.startsWith("/api/v3/") && path !== "/api/v3/auth/feishu/callback")
            fail(426, "client_update_required");
        if (path.startsWith("/assets/"))
            return;
        if (publicPaths.has(path) || !req.routeOptions.url)
            return;
        if (req.headers.origin && req.headers.origin !== config.origin)
            fail(403, "origin_invalid");
        req.actor = await identity.authenticate(req, { includeTemporaryAccess: ['/api/v4/auth/me', '/api/v4/interview-assistant/capabilities'].includes(path) });
        const scopedPath = path.match(/^\/api\/v4\/interviews\/([0-9a-f-]{36})\/(assistant(?:\/.*)?|materials|schedule|evaluation|evaluation-template(?:\/preview)?)$/i);
        if (scopedPath) {
            // Preserve legacy application-level reads. Mutations require target-interview authority.
            let permanentEvaluation = false;
            if (['GET', 'HEAD'].includes(req.method) && ['evaluation', 'evaluation-template'].includes(scopedPath[2]) && req.actor.status === 'active' && req.actor.roles.some(r => ['admin', 'manager', 'recruiter', 'interviewer'].includes(r))) {
                const meeting = (await db.query('SELECT application_id FROM interviews WHERE id=$1', [scopedPath[1]])).rows[0];
                if (meeting)
                    try {
                        await identity.applicationAccess(req.actor, meeting.application_id);
                        permanentEvaluation = true;
                    }
                    catch (e) {
                        if (!(e instanceof ApiError) || e.statusCode !== 403)
                            throw e;
                    }
            }
            if (!permanentEvaluation)
                req.actor = await identity.interviewActor(req.actor, scopedPath[1], scopedPath[2] === 'schedule' ? 'coordinate' : 'read');
        }
        if (!["/api/v4/auth/me", "/api/v4/auth/logout", "/api/v4/my-interviews", "/api/v4/interview-assistant/capabilities"].includes(path) &&
            req.actor.status !== "active")
            fail(403, "approval_required");
        if (!["GET", "HEAD", "OPTIONS"].includes(req.method) &&
            (req.headers.origin !== config.origin ||
                req.headers["x-csrf-token"] !== req.actor.csrf))
            fail(403, "csrf_invalid");
    });
    app.setErrorHandler((error, req, reply) => {
        const e = error;
        let status = e instanceof ApiError ? e.statusCode : 500, code = e instanceof ApiError ? e.code : "internal_error";
        if (e.code === "23505") {
            status = 409;
            code = "duplicate_record";
        }
        if (e.code === "23503" || e.code === "22P02") {
            status = 422;
            code = "invalid_reference";
        }
        if (e.validation || e.statusCode === 400) {
            status = 422;
            code = "invalid_input";
        }
        if (e.statusCode === 413) {
            status = 413;
            code = req.url.startsWith("/api/v4/admin/backups")
                ? "backup_requires_cli"
                : "file_too_large";
        }
        if (!(e instanceof ApiError) &&
            (/^(08|57P)/.test(e.code || "") ||
                ["ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT"].includes(e.code || "") ||
                /connection terminated|connection timeout|pool after calling end|query read timeout/i.test(e.message))) {
            status = 503;
            code = "database_unavailable";
        }
        if (["40001", "40P01", "55P03"].includes(e.code || "")) {
            status = 409;
            code = "concurrent_retry";
        }
        reply.code(status).send({
            error: { code, message: code },
            fieldErrors: [],
            requestId: req.id,
        });
    });
    app.addHook("preSerialization", async (req, reply, payload) => {
        if (req.url.startsWith("/api/v4/") &&
            !req.url.startsWith("/api/v4/openapi.json") &&
            reply.statusCode >= 200 &&
            reply.statusCode < 300)
            return { data: payload, meta: { requestId: req.id } };
        return payload;
    });
    const commands = new Commands(db), campus = new CampusService(identity), campusCommands = new Commands(db, async () => (await campus.vault()).requestKey());
    app.addHook("onRoute", (route) => {
        const methods = Array.isArray(route.method) ? route.method : [route.method];
        route.schema = { ...contract(methods[0], route.url), ...route.schema };
        const mutation = !(methods.every((m) => ["GET", "HEAD", "OPTIONS"].includes(m)) ||
            !route.url.startsWith("/api/v4/") ||
            route.url.startsWith("/api/v4/auth/") ||
            route.url.startsWith("/api/v4/admin/backups") ||
            /\/(query|metrics|export|reveal)$/.test(route.url) ||
            // These POST endpoints are queries: recheck current field permissions on every read.
            ["/api/v4/candidates/matching/preview", "/api/v4/candidates/matching/cross-job",
                "/api/v4/toolkit/search", "/api/v4/referrals/check"].includes(route.url) ||
            route.url.startsWith("/api/v4/interviews/:id/assistant") ||
            route.url.startsWith("/api/v4/mailbox-replies/") ||
            route.url.startsWith("/api/v4/mailboxes/:mailboxId/messages/:messageKey/reply") ||
            route.url === "/api/v4/mailboxes/:mailboxId/messages/:messageKey/replies" ||
            route.url === "/api/v4/interviews/:id/feishu-feedback" ||
            route.url === "/api/v4/interviews/:id/feishu-calendar" ||
            route.url === "/api/v4/uploads");
        const handler = route.handler;
        route.handler = async function (req, reply) {
            return db.withRequest(req.id, () => mutation
                ? (route.url.startsWith("/api/v4/campus")
                    ? campusCommands
                    : commands).run(req.actor, req.headers["idempotency-key"], { method: req.method, path: req.url, body: req.body }, async () => handler.call(this, req, reply), configurationPolicy(identity, req, route.url))
                : handler.call(this, req, reply));
        };
    });
    app.setNotFoundHandler((req, reply) => reply.code(404).send({
        error: { code: "not_found", message: "not_found" },
        fieldErrors: [],
        requestId: req.id,
    }));
    app.get("/health/live", async () => ({ status: "ok", version: "4.0.0" }));
    const csp = "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
    app.get("/assets/*", async (req, reply) => {
        const name = req.params["*"];
        if (typeof name !== "string" ||
            !name.match(/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(js|css|woff2|svg)$/) ||
            name.includes(".."))
            fail(404, "not_found");
        let bytes;
        try {
            bytes = await readFile(path.join(config.assetRoot || path.join(config.webRoot, "assets"), name));
        }
        catch {
            fail(404, "not_found");
        }
        return reply
            .header("cache-control", "public,max-age=31536000,immutable")
            .type(name.endsWith(".js")
            ? "application/javascript; charset=utf-8"
            : name.endsWith(".css")
                ? "text/css; charset=utf-8"
                : name.endsWith(".svg")
                    ? "image/svg+xml"
                    : "font/woff2")
            .send(bytes);
    });
    app.get("/", async (req, reply) => {
        let html;
        try {
            html = await readFile(path.join(config.webRoot, "index.html"), "utf8");
        }
        catch {
            html =
                '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>招聘工作台 V4 · 后端验收</title><style>body{font:16px/1.7 system-ui;max-width:700px;margin:12vh auto;padding:24px;color:#172536}a{color:#155eef}small{color:#586577}</style><h1>招聘工作台 V4</h1><p>独立后端验收服务</p><p><a href="/api/v4/auth/feishu/start">使用企业飞书登录</a></p><p><a href="/api/v4/auth/me">查看本人身份与审批状态</a> · <a href="/api/v4/openapi.json">API 契约</a></p><small>业务页面待接入新版 API。首次登录后需管理员审批。</small></html>';
        }
        return reply
            .type("text/html; charset=utf-8")
            .header("content-security-policy", csp)
            .send(html);
    });
    app.get("/health/ready", async () => {
        await db.query("SELECT 1");
        await campus.keyStatus();
        return { status: "ready", instance: config.instance };
    });
    identityRoutes(app, identity);
    sourcingRoutes(app, identity);
    campusRoutes(app, identity);
    recruitingRoutes(app, identity);
    dashboardRoutes(app, identity);
    taskRoutes(app, identity);
    mailboxRoutes(app, identity);
    resumeWorkflowRoutes(app, identity);
    interviewRoutes(app, identity);
    feishuMeetingRoutes(app, identity);
    registerInterviewFeedbackRoutes(app, identity);
    interviewerReviewRoutes(app, identity);
    materialRoutes(app, identity);
    statisticsRoutes(app, identity);
    toolkitRoutes(app, identity);
    referralRoutes(app, identity);
    adminRoutes(app, identity);
    businessConfigRoutes(app, identity);
    queryRoutes(app, identity);
    copyRoutes(app, identity);
    app.get("/api/v4/openapi.json", async () => {
        return app.swagger();
    });
    return app;
}
//# sourceMappingURL=app.js.map