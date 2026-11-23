import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { z, parse } from '../http/validation.js';
import { fail } from '../http/errors.js';
import { replyEmail } from './reply-templates.js';
import { readBridgeConfiguration, sendEwsBridgeReply } from './reply-bridge.js';
import { replyBody } from './reply-body.js';
const smtpSchema = z.object({ host: z.string().regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$/), port: z.union([z.literal(465), z.literal(587)]), secure: z.boolean(), auth: z.object({ user: z.string().min(1).max(254).refine(v => !/[\r\n\0]/.test(v)), pass: z.string().min(1).max(2000) }).strict(), from: z.object({ name: z.string().trim().min(1).max(120).refine(v => !/[\r\n\0{}]/.test(v)), address: replyEmail }).strict(), tls: z.object({ caFile: z.string().max(2000).refine(v => path.isAbsolute(v), 'absolute_ca_path_required') }).strict().optional() }).strict().refine(v => v.secure === (v.port === 465), 'tls_required');
export async function readReplyConfiguration(file) {
    if (!file)
        return null;
    try {
        const info = await stat(file);
        if (!info.isFile() || info.size > 16384 || (process.platform !== 'win32' && (info.mode & 0o077) !== 0))
            fail(503, 'mail_reply_config_invalid');
        const input = JSON.parse(await readFile(file, 'utf8'));
        if (input?.transport === 'ews-bridge')
            return await readBridgeConfiguration(input);
        const configuration = parse(smtpSchema, input);
        if (!configuration.tls)
            return configuration;
        const caInfo = await stat(configuration.tls.caFile);
        if (!caInfo.isFile() || caInfo.size > 256 * 1024)
            fail(503, 'mail_reply_config_invalid');
        const ca = await readFile(configuration.tls.caFile, 'utf8'), certificates = ca.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
        if (!certificates?.length || ca.replace(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g, '').trim())
            fail(503, 'mail_reply_config_invalid');
        for (const certificate of certificates)
            new X509Certificate(certificate);
        return { ...configuration, tls: { ...configuration.tls, ca } };
    }
    catch {
        fail(503, 'mail_reply_config_invalid');
    }
}
export const replyTlsOptions = (configuration) => ({ rejectUnauthorized: true, servername: configuration.host, minVersion: 'TLSv1.2', ...(configuration.tls ? { ca: configuration.tls.ca } : {}) });
export const sendSmtpReply = async (configuration, message) => {
    if (configuration.transport === 'ews-bridge')
        fail(422, 'mail_reply_transport_invalid');
    if (!replyEmail.safeParse(message.to).success || message.from.address !== configuration.from.address)
        fail(422, 'mail_reply_recipient_forbidden');
    const nodemailer = await import('nodemailer');
    const { from, tls, ...connection } = configuration;
    const transport = nodemailer.createTransport({ ...connection, requireTLS: true, tls: replyTlsOptions(configuration), connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 30000, disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false });
    try {
        const result = await transport.sendMail({ ...message, ...replyBody(message.text), envelope: { from: configuration.from.address, to: [message.to] }, disableFileAccess: true, disableUrlAccess: true });
        return { accepted: result.accepted.length === 1 && String(result.accepted[0]).toLowerCase() === message.to.toLowerCase() };
    }
    finally {
        transport.close();
    }
};
export const sendConfiguredReply = (configuration, message) => configuration.transport === 'ews-bridge' ? sendEwsBridgeReply(configuration, message) : sendSmtpReply(configuration, message);
//# sourceMappingURL=reply-smtp.js.map