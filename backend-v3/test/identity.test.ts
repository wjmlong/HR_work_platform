import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./helpers.js";
import { buildApp } from "../src/http/app.js";
import { FeishuProvider, type Principal } from "../src/identity/provider.js";
const principal: Principal = {
  tenant: "company",
  appId: "app",
  openId: "ou_admin",
  name: "管理员",
  active: true,
};
test("OAuth binds browser, consumes state once, bootstraps exact identity, shares and revokes sessions", async (t) => {
  const { db, config, cleanup } = await testDatabase();
  t.after(cleanup);
  config.feishu = {
    ...config.feishu,
    appId: "app",
    tenant: "company",
    admins: ["ou_admin"],
  };
  let person = { ...principal };
  const provider = {
    configured: () => true,
    authorizeUrl: (s: string, v: string) =>
      new FeishuProvider(config).authorizeUrl(s, v),
    identity: async () => ({ ...person }),
    contact: async () => ({ ...person }),
  };
  const a = await buildApp({ db, config, provider }),
    b = await buildApp({ db, config, provider });
  t.after(() => a.close());
  t.after(() => b.close());
  const headers = {
    host: new URL(config.origin).host,
    "x-forwarded-proto": "https",
  };
  async function begin() {
    const r = await a.inject({ url: "/api/v4/auth/feishu/start", headers });
    assert.equal(r.statusCode, 302);
    const u = new URL(r.headers.location!);
    assert.equal(u.searchParams.get("code_challenge_method"), "S256");
    assert.equal(u.searchParams.get("redirect_uri"), config.feishu.callback);
    return {
      state: u.searchParams.get("state")!,
      cookie: r.cookies[0].name + "=" + r.cookies[0].value,
    };
  }
  const first = await begin();
  let r = await a.inject({
    url: "/api/v4/auth/feishu/callback?code=one&state=" + first.state,
    headers: { ...headers, cookie: "__Host-recruit_v4_oauth=wrong" },
  });
  assert.equal(r.statusCode, 401);
  r = await a.inject({
    url: "/api/v4/auth/feishu/callback?code=one&state=" + first.state,
    headers: { ...headers, cookie: first.cookie },
  });
  assert.equal(r.statusCode, 401);
  const login = await begin();
  r = await a.inject({
    url: "/api/v4/auth/feishu/callback?code=ok&state=" + login.state,
    headers: { ...headers, cookie: login.cookie },
  });
  assert.equal(r.statusCode, 302);
  const session = r.cookies.find(
    (c) => c.name === "__Host-recruit_v4_session",
  )!;
  assert.ok(session.secure);
  assert.ok(session.httpOnly);
  const authenticated = {
    ...headers,
    cookie: session.name + "=" + session.value,
  };
  r = await b.inject({ url: "/api/v4/auth/me", headers: authenticated });
  assert.equal(r.statusCode, 200);
  const me = r.json().data;
  assert.deepEqual(me.roles, ["admin"]);
  assert.equal(me.status, "active");
  assert.equal(
    (await b.inject({ url: "/api/v4/members", headers: authenticated }))
      .statusCode,
    200,
  );
  assert.equal(
    (
      await b.inject({
        url: "/api/v4/auth/me",
        headers: { ...authenticated, "x-forwarded-proto": "http" },
      })
    ).statusCode,
    421,
  );
  assert.equal(
    (
      await b.inject({
        url: "/api/v4/auth/me",
        headers: { ...authenticated, host: "evil.example" },
      })
    ).statusCode,
    421,
  );
  assert.equal(
    (
      await b.inject({
        method: "POST",
        url: "/api/v4/auth/logout",
        headers: authenticated,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await b.inject({
        method: "POST",
        url: "/api/v4/auth/logout",
        headers: {
          ...authenticated,
          origin: "https://evil.example",
          "x-csrf-token": me.csrf,
        },
      })
    ).statusCode,
    403,
  );
  await db.query("UPDATE users SET version=version+1 WHERE id=$1", [me.id]);
  assert.equal(
    (await b.inject({ url: "/api/v4/auth/me", headers: authenticated }))
      .statusCode,
    401,
  );
  person = { ...principal, openId: "ou_other", name: "管理员" };
  const other = await begin();
  r = await a.inject({
    url: "/api/v4/auth/feishu/callback?code=ok&state=" + other.state,
    headers: { ...headers, cookie: other.cookie },
  });
  assert.equal(r.statusCode, 302);
  const otherCookie = r.cookies.find(
    (c) => c.name === "__Host-recruit_v4_session",
  )!;
  const pending = {
    ...headers,
    cookie: otherCookie.name + "=" + otherCookie.value,
  };
  assert.equal(
    (await b.inject({ url: "/api/v4/auth/me", headers: pending })).json().data
      .status,
    "pending",
  );
  assert.equal(
    (await b.inject({ url: "/api/v4/members", headers: pending })).statusCode,
    403,
  );
  for (const bad of [
    { ...principal, tenant: "other" },
    { ...principal, appId: "other" },
    { ...principal, active: false },
  ]) {
    person = bad;
    const x = await begin();
    assert.equal(
      (
        await a.inject({
          url: "/api/v4/auth/feishu/callback?code=ok&state=" + x.state,
          headers: { ...headers, cookie: x.cookie },
        })
      ).statusCode,
      403,
    );
  }
  assert.equal(
    (await a.inject({ method: "POST", url: "/api/auth/register", headers }))
      .statusCode,
    404,
  );
});
test("sessions fail closed on stale directory failure and disable departed users", async (t) => {
  const { db, config, cleanup } = await testDatabase();
  t.after(cleanup);
  config.feishu = {
    ...config.feishu,
    appId: "app",
    tenant: "company",
    admins: ["ou_admin"],
  };
  let unavailable = false,
    active = true;
  const provider = {
    configured: () => true,
    authorizeUrl: (s: string) => "https://example.org/?state=" + s,
    identity: async () => principal,
    contact: async () => {
      if (unavailable) throw Error("upstream");
      return { ...principal, active };
    },
  };
  const app = await buildApp({ db, config, provider });
  t.after(() => app.close());
  const headers = {
    host: new URL(config.origin).host,
    "x-forwarded-proto": "https",
  };
  const start = await app.inject({ url: "/api/v4/auth/feishu/start", headers }),
    state = new URL(start.headers.location!).searchParams.get("state");
  const cb = await app.inject({
    url: "/api/v4/auth/feishu/callback?code=ok&state=" + state,
    headers: {
      ...headers,
      cookie: start.cookies[0].name + "=" + start.cookies[0].value,
    },
  });
  const cookie = cb.cookies.find(
    (c) => c.name === "__Host-recruit_v4_session",
  )!;
  const h = { ...headers, cookie: cookie.name + "=" + cookie.value };
  await db.query("UPDATE users SET verified_at=now()-interval '11 minutes'");
  unavailable = true;
  assert.equal(
    (await app.inject({ url: "/api/v4/auth/me", headers: h })).statusCode,
    503,
  );
  unavailable = false;
  active = false;
  assert.equal(
    (await app.inject({ url: "/api/v4/auth/me", headers: h })).statusCode,
    401,
  );
  assert.equal(
    (await db.query("SELECT status FROM users")).rows[0].status,
    "disabled",
  );
});
