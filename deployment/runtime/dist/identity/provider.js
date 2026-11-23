import { createHash } from "node:crypto";
import { fail } from "../http/errors.js";
const id = (s) => {
    if (typeof s !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(s))
        fail(503, "invalid_identity_response");
    return s;
};
export class FeishuProvider {
    config;
    transport;
    constructor(config, transport = fetch) {
        this.config = config;
        this.transport = transport;
    }
    configured() {
        const f = this.config.feishu;
        return !!(f.appId && f.appSecret && f.tenant);
    }
    authorizeUrl(state, verifier) {
        const u = new URL("https://accounts.feishu.cn/open-apis/authen/v1/authorize");
        u.search = new URLSearchParams({
            client_id: this.config.feishu.appId,
            response_type: "code",
            redirect_uri: this.config.feishu.callback,
            state,
            code_challenge: createHash("sha256").update(verifier).digest("base64url"),
            code_challenge_method: "S256",
        }).toString();
        return u.href;
    }
    async request(path, body, token) {
        try {
            const r = await this.transport("https://open.feishu.cn/open-apis/" + path, {
                method: body ? "POST" : "GET",
                headers: {
                    ...(body ? { "content-type": "application/json" } : {}),
                    ...(token ? { authorization: "Bearer " + token } : {}),
                },
                body: body ? JSON.stringify(body) : undefined,
                redirect: "error",
                signal: AbortSignal.timeout(15000),
            });
            if (!r.ok || !r.body)
                fail(503, "feishu_unavailable");
            const reader = r.body.getReader(), parts = [];
            let size = 0;
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done)
                        break;
                    size += value.length;
                    if (size > 1024 * 1024)
                        fail(503, "feishu_response_limit");
                    parts.push(value);
                }
            }
            finally {
                await reader.cancel().catch(() => { });
            }
            const data = JSON.parse(Buffer.concat(parts).toString("utf8"));
            if (data?.code !== 0)
                fail(503, "feishu_unavailable");
            return data;
        }
        catch {
            fail(503, "feishu_unavailable");
        }
    }
    async identity(code, verifier) {
        const f = this.config.feishu, t = await this.request("authen/v2/oauth/token", {
            grant_type: "authorization_code",
            client_id: f.appId,
            client_secret: f.appSecret,
            code,
            redirect_uri: f.callback,
            code_verifier: verifier,
        });
        if (typeof t.access_token !== "string" || !t.access_token)
            fail(503, "invalid_identity_response");
        const u = (await this.request("authen/v1/user_info", undefined, t.access_token)).data;
        if (!u)
            fail(503, "invalid_identity_response");
        const tenant = id(u.tenant_key), openId = id(u.open_id);
        if (tenant !== f.tenant)
            fail(403, "wrong_tenant");
        return { ...(await this.contact(openId)), tenant, appId: f.appId };
    }
    async directory() {
        const f = this.config.feishu, t = await this.request('auth/v3/tenant_access_token/internal', { app_id: f.appId, app_secret: f.appSecret });
        if (typeof t.tenant_access_token !== 'string' || !t.tenant_access_token)
            fail(503, 'invalid_identity_response');
        const token = t.tenant_access_token, roots = new Set(), explicitUsers = new Set(), users = new Map();
        let requests = 0;
        const read = async (path) => {
            if (++requests > 2000)
                fail(503, 'directory_response_limit');
            return (await this.request(path, undefined, token)).data;
        };
        const pages = async (path, consume) => {
            let cursor = '';
            const tokens = new Set();
            do {
                const data = await read(path + (cursor ? '&page_token=' + encodeURIComponent(cursor) : ''));
                if (!data || typeof data.has_more !== 'boolean')
                    fail(503, 'invalid_identity_response');
                consume(data);
                if (!data.has_more)
                    break;
                if (typeof data.page_token !== 'string' || !data.page_token || tokens.has(data.page_token))
                    fail(503, 'invalid_identity_response');
                cursor = data.page_token;
                tokens.add(cursor);
            } while (true);
        };
        const list = (data, key) => { const values = data[key] ?? []; if (!Array.isArray(values))
            fail(503, 'invalid_identity_response'); return values; };
        const addId = (set, value) => { set.add(id(value)); if (set.size > 100000)
            fail(503, 'directory_response_limit'); };
        const addUser = (u, expected) => {
            if (!u || typeof u.name !== 'string')
                fail(503, 'invalid_identity_response');
            const openId = id(u.open_id), s = u.status;
            if (expected && openId !== expected)
                fail(503, 'invalid_identity_response');
            const active = !!s && s.is_activated === true && s.is_frozen === false && s.is_resigned === false && s.is_exited === false && s.is_unjoin === false;
            // A conflicting or incomplete status observation must never be revived by a later duplicate.
            users.set(openId, { tenant: f.tenant, appId: f.appId, openId, name: u.name, active: active && users.get(openId)?.active !== false });
            if (users.size > 100000)
                fail(503, 'directory_response_limit');
        };
        // The application may have department/user scopes without access to root department 0.
        await pages('contact/v3/scopes?user_id_type=open_id&department_id_type=open_department_id&page_size=50', data => {
            for (const value of list(data, 'department_ids'))
                addId(roots, value);
            for (const value of list(data, 'user_ids'))
                addId(explicitUsers, value);
            const groups = list(data, 'group_ids');
            groups.forEach(id);
            // Do not silently publish a partial snapshot when authorized group members are unenumerated.
            if (groups.length)
                fail(503, 'directory_group_scope_unsupported');
        });
        const departments = new Set(roots);
        const items = (data) => { if (!Array.isArray(data.items))
            fail(503, 'invalid_identity_response'); return data.items; };
        for (const root of roots)
            await pages('contact/v3/departments/' + encodeURIComponent(root) + '/children?department_id_type=open_department_id&fetch_child=true&page_size=50', data => {
                for (const department of items(data))
                    addId(departments, department.open_department_id);
            });
        for (const department of departments)
            await pages('contact/v3/users/find_by_department?department_id_type=open_department_id&user_id_type=open_id&page_size=50&department_id=' + encodeURIComponent(department), data => {
                for (const user of items(data))
                    addUser(user);
            });
        for (const openId of explicitUsers)
            addUser((await read('contact/v3/users/' + encodeURIComponent(openId) + '?user_id_type=open_id&department_id_type=open_department_id'))?.user, openId);
        return [...users.values()];
    }
    async contact(openId) {
        id(openId);
        const f = this.config.feishu, t = await this.request("auth/v3/tenant_access_token/internal", {
            app_id: f.appId,
            app_secret: f.appSecret,
        });
        if (typeof t.tenant_access_token !== "string" || !t.tenant_access_token)
            fail(503, "invalid_identity_response");
        const u = (await this.request("contact/v3/users/" +
            openId +
            "?user_id_type=open_id&department_id_type=open_department_id", undefined, t.tenant_access_token)).data?.user;
        if (!u || u.open_id !== openId || typeof u.name !== "string")
            fail(503, "invalid_identity_response");
        const s = u.status;
        return {
            tenant: f.tenant,
            appId: f.appId,
            openId,
            name: u.name,
            active: !!s &&
                s.is_activated === true &&
                s.is_frozen === false &&
                s.is_resigned === false &&
                s.is_exited === false &&
                s.is_unjoin === false,
        };
    }
}
//# sourceMappingURL=provider.js.map