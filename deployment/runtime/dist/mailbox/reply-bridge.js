import http from 'node:http';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { z, parse } from '../http/validation.js';
import { fail } from '../http/errors.js';
import { TEST_RECIPIENT, replyEmail } from './reply-templates.js';
const schema = z.object({ transport: z.literal('ews-bridge'), socketPath: z.string().max(2000).refine(v => path.isAbsolute(v)), tokenFile: z.string().max(2000).refine(v => path.isAbsolute(v)), from: z.object({ name: z.string().trim().min(1).max(120).refine(v => !/[\r\n\0{}]/.test(v)), address: replyEmail }).strict() }).strict();
function request(configuration, route, body) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
        if (data && data.length > 64 * 1024) {
            reject(Error('ews_bridge_request_limit'));
            return;
        }
        const req = http.request({ socketPath: configuration.socketPath, method: data ? 'POST' : 'GET', path: route, headers: { authorization: 'Bearer ' + configuration.token, ...(data ? { 'content-type': 'application/json', 'content-length': String(data.length) } : {}) } }, res => {
            let bytes = 0;
            const chunks = [];
            res.on('data', (chunk) => { bytes += chunk.length; if (bytes > 8192) {
                res.destroy();
                reject(Error('ews_bridge_response_limit'));
            }
            else
                chunks.push(chunk); });
            res.on('error', reject);
            res.on('end', () => { try {
                const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if (res.statusCode !== 200)
                    reject(Object.assign(Error('ews_bridge_rejected'), { code: value.state === 'failed' ? 'EWS_REJECTED' : 'EWS_UNKNOWN' }));
                else
                    resolve(value);
            }
            catch {
                reject(Error('ews_bridge_response_invalid'));
            } });
        });
        req.setTimeout(data ? 45000 : 3000, () => req.destroy(Error('ews_bridge_timeout')));
        req.on('error', reject);
        req.end(data);
    });
}
export async function readBridgeConfiguration(input) {
    const value = parse(schema, input), info = await stat(value.tokenFile);
    if (!info.isFile() || info.size > 200 || (process.platform !== 'win32' && (info.mode & 0o077) !== 0))
        fail(503, 'mail_reply_config_invalid');
    if (process.platform !== 'win32') {
        const socket = await stat(value.socketPath);
        if (!socket.isSocket() || (socket.mode & 0o077) !== 0)
            fail(503, 'mail_reply_config_invalid');
    }
    const token = (await readFile(value.tokenFile, 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/.test(token))
        fail(503, 'mail_reply_config_invalid');
    const status = await request({ ...value, token }, '/status');
    if (status.ready !== true || status.account !== value.from.address || status.recipient !== TEST_RECIPIENT || status.singleRecipientReplies !== true || !/^[a-f0-9]{64}$/.test(status.configurationRevision))
        fail(503, 'mail_reply_config_invalid');
    return { transport: 'ews-bridge', socketPath: value.socketPath, token, from: value.from, configurationRevision: status.configurationRevision };
}
export async function sendEwsBridgeReply(configuration, message) {
    if (!replyEmail.safeParse(message.to).success || message.from.address !== configuration.from.address)
        fail(422, 'mail_reply_recipient_forbidden');
    const result = await request(configuration, '/send', { configurationRevision: configuration.configurationRevision, message });
    if (result.state !== 'sent' || result.accepted !== true || result.messageId !== message.messageId)
        throw Object.assign(Error('ews_bridge_delivery_unconfirmed'), { code: result.state === 'failed' ? 'EWS_REJECTED' : 'EWS_UNKNOWN' });
    return { accepted: true };
}
//# sourceMappingURL=reply-bridge.js.map