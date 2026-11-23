import { fail } from '../http/errors.js';
export class FeishuConfirmationSender {
    config;
    transport;
    constructor(config, transport = fetch) {
        this.config = config;
        this.transport = transport;
    }
    async request(path, body, token = '', method = 'POST') {
        let response;
        try {
            response = await this.transport('https://open.feishu.cn/open-apis/' + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(10000) });
        }
        catch {
            fail(503, 'feedback_send_failed');
        }
        const text = await response.text();
        if (text.length > 1024 * 1024)
            fail(502, 'feedback_send_failed');
        let value;
        try {
            value = JSON.parse(text);
        }
        catch {
            fail(502, 'feedback_send_failed');
        }
        if (!response.ok || value.code !== 0)
            fail(502, 'feedback_send_failed');
        return value;
    }
    async token() {
        const f = this.config.feishu;
        if (!this.config.feishuFeedback?.enabled || !f.appId || !f.appSecret || !f.tenant)
            fail(503, 'feedback_not_enabled');
        const auth = await this.request('auth/v3/tenant_access_token/internal', { app_id: f.appId, app_secret: f.appSecret });
        if (typeof auth.tenant_access_token !== 'string' || !auth.tenant_access_token)
            fail(502, 'feedback_send_failed');
        return auth.tenant_access_token;
    }
    async update(messageId, card) {
        await this.request('im/v1/messages/' + encodeURIComponent(messageId), { content: JSON.stringify(card) }, await this.token(), 'PATCH');
    }
    async send(openId, key, card) {
        const token = await this.token();
        const result = await this.request('im/v1/messages?receive_id_type=open_id', { receive_id: openId, msg_type: 'interactive', content: JSON.stringify(card), uuid: key }, token);
        if (typeof result.data?.message_id !== 'string' || !result.data.message_id)
            fail(502, 'feedback_send_failed');
        return { messageId: result.data.message_id };
    }
}
//# sourceMappingURL=transport.js.map