import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase, httpSession, actor } from "./helpers.js";
import { FeishuProvider } from "../src/identity/provider.js";
import { Identity } from "../src/identity/service.js";
test("direct Feishu exchange binds PKCE callback and tenant and requires explicit active contact flags", async (t) => {
  const { config, cleanup } = await testDatabase();
  t.after(cleanup);
  config.feishu = {
    ...config.feishu,
    appId: "app",
    appSecret: "synthetic-secret",
    tenant: "company",
  };
  let wrongTenant = false,
    inactive = false;
  const transport: typeof fetch = async (url, options) => {
    const path = String(url),
      body = options?.body ? JSON.parse(String(options.body)) : null;
    let result: any;
    if (path.endsWith("/authen/v2/oauth/token")) {
      if (
        body.code !== "synthetic-code" ||
        body.code_verifier !== "verifier" ||
        body.redirect_uri !== config.feishu.callback ||
        body.client_id !== "app" ||
        body.client_secret !== "synthetic-secret"
      )
        return new Response("{}", { status: 400 });
      result = {
        code: 0,
        access_token: "synthetic-user-token",
        token_type: "Bearer",
        expires_in: 7200,
      };
    } else if (path.endsWith("/authen/v1/user_info")) {
      if (
        (options?.headers as any).authorization !==
        "Bearer synthetic-user-token"
      )
        return new Response("{}", { status: 401 });
      result = {
        code: 0,
        data: {
          tenant_key: wrongTenant ? "other" : "company",
          open_id: "ou_test",
          name: "合成员",
          avatar_url: "",
        },
      };
    } else if (path.endsWith("/auth/v3/tenant_access_token/internal"))
      result = {
        code: 0,
        tenant_access_token: "synthetic-tenant-token",
        expire: 7200,
      };
    else if (path.includes("/contact/v3/users/ou_test?")) {
      if (
        (options?.headers as any).authorization !==
        "Bearer synthetic-tenant-token"
      )
        return new Response("{}", { status: 401 });
      result = {
        code: 0,
        data: {
          user: {
            open_id: "ou_test",
            name: "合成员",
            status: {
              is_activated: true,
              is_frozen: false,
              is_resigned: inactive,
              is_exited: false,
              is_unjoin: false,
            },
          },
        },
      };
    } else return new Response("{}", { status: 404 });
    return Response.json(result);
  };
  const provider = new FeishuProvider(config, transport);
  assert.deepEqual(await provider.identity("synthetic-code", "verifier"), {
    tenant: "company",
    appId: "app",
    openId: "ou_test",
    name: "合成员",
    active: true,
  });
  await assert.rejects(
    provider.identity("synthetic-code", "wrong"),
    /feishu_unavailable/,
  );
  wrongTenant = true;
  await assert.rejects(
    provider.identity("synthetic-code", "verifier"),
    /wrong_tenant/,
  );
  wrongTenant = false;
  inactive = true;
  assert.equal(
    (await provider.identity("synthetic-code", "verifier")).active,
    false,
  );
});
test("approval revokes pending session, retains approved role on next OAuth, and disabling revokes again", async (t) => {
  const { db, config, cleanup } = await testDatabase();
  t.after(cleanup);
  const { app, headers, provider } = await httpSession(db, config);
  t.after(() => app.close());
  const pending = await actor(db, []);
  await db.query("UPDATE users SET status='pending' WHERE id=$1", [pending.id]);
  const identity = new Identity(db, config, provider),
    person = {
      tenant: "company",
      appId: "app",
      openId: pending.open_id,
      name: pending.name,
      active: true,
    },
    old = await identity.establish(person);
  const r = await app.inject({
    method: "PATCH",
    url: "/api/v4/members/" + pending.id,
    headers: { ...headers, "idempotency-key": "approve-member" },
    payload: { version: 1, status: "active", roles: ["recruiter"] },
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().data.version, 2);
  assert.equal(
    (
      await app.inject({
        url: "/api/v4/auth/me",
        headers: { ...headers, cookie: "__Host-recruit_v4_session=" + old },
      })
    ).statusCode,
    401,
  );
  const current = await identity.establish(person),
    h = { ...headers, cookie: "__Host-recruit_v4_session=" + current };
  assert.deepEqual(
    (await app.inject({ url: "/api/v4/auth/me", headers: h })).json().data
      .roles,
    ["recruiter"],
  );
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: "/api/v4/members/" + pending.id,
        headers: { ...headers, "idempotency-key": "disable-member" },
        payload: { version: 2, status: "disabled", roles: ["recruiter"] },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await app.inject({ url: "/api/v4/auth/me", headers: h })).statusCode,
    401,
  );
});
test("expired OAuth is consumed and shared SQL rate limits reset only after their window", async (t) => {
  const { db, config, cleanup } = await testDatabase();
  t.after(cleanup);
  const { app, headers, provider } = await httpSession(db, config);
  t.after(() => app.close());
  const start = await app.inject({ url: "/api/v4/auth/feishu/start", headers }),
    state = new URL(start.headers.location!).searchParams.get("state");
  await db.query(
    "UPDATE oauth_states SET expires_at=now()-interval '1 second'",
  );
  const r = await app.inject({
    url: "/api/v4/auth/feishu/callback?code=expired&state=" + state,
    headers: {
      ...headers,
      cookie: start.cookies[0].name + "=" + start.cookies[0].value,
    },
  });
  assert.equal(r.statusCode, 401);
  assert.equal(
    (await db.query("SELECT count(*) FROM oauth_states")).rows[0].count,
    "0",
  );
  const first = new Identity(db, config, provider),
    second = new Identity(db, config, provider);
  await first.limit("shared", 2);
  await second.limit("shared", 2);
  await assert.rejects(first.limit("shared", 2), /rate_limited/);
  await db.query(
    "UPDATE rate_limits SET started_at=now()-interval '6 minutes'",
  );
  await second.limit("shared", 2);
});
