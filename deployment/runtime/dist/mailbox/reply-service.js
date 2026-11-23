import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { requireRole } from '../identity/service.js';
import { assertLegacySource } from '../business-config/legacy-fields.js';
import { fail, ApiError } from '../http/errors.js';
import { z, parse } from '../http/validation.js';
import { parseReplyHeaders, renderReplyTemplate, replyTemplateCatalog, TEST_RECIPIENT, replyDraftSchema, validateReplyDraft, defaultReplyDraft } from './reply-templates.js';
import { readReplyConfiguration, sendConfiguredReply } from './reply-smtp.js';
import { replyRecipient, productionReplyDraft, validateProductionDraft, platformAddress } from './reply-context.js';
import { replyEmail } from './reply-templates.js';
const baseInput = z.object({ templateId: z.enum(['advance', 'decline']), templateVersion: z.string().regex(/^[a-f0-9]{64}$/), testMode: z.literal(true), retryReceiptId: z.uuid().optional() });
const parameterInput = baseInput.extend({ parameters: z.record(z.string(), z.unknown()) }).strict(), draftInput = baseInput.extend({ draft: replyDraftSchema }).strict();
const productionInput = baseInput.extend({ testMode: z.literal(false), recipient: replyEmail, recipientConfirmed: z.literal(true), draft: replyDraftSchema }).strict();
const inputSchema = z.union([parameterInput, draftInput, productionInput]), confirmation = { previewToken: z.string().max(600), confirmed: z.literal(true) };
const sendSchema = z.union([parameterInput.extend(confirmation).strict(), draftInput.extend(confirmation).strict(), productionInput.extend(confirmation).strict()]);
const synthetic = { mailboxId: 'synthetic-test', messageKey: 'synthetic-test' };
const digest = (input) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
export class MailboxReplyService {
    identity;
    archive;
    options;
    constructor(identity, archive, options = {}) {
        this.identity = identity;
        this.archive = archive;
        this.options = options;
    }
    now() { return this.options.now?.() || new Date(); }
    async authorize(actor) {
        const member = (await this.identity.db.query('SELECT * FROM users WHERE id=$1', [actor.id])).rows[0];
        if (!member || member.version !== actor.version || !member.directory_active || member.tenant !== this.identity.config.feishu.tenant || member.app_id !== this.identity.config.feishu.appId)
            fail(403, 'membership_changed');
        const current = { ...actor, ...member };
        requireRole(current, 'admin', 'manager', 'recruiter');
        if (actor.temporaryScope)
            fail(403, 'forbidden');
        await assertLegacySource(this.identity, current, ['resume']);
    }
    async configuration() { return this.options.configuration ? this.options.configuration() : readReplyConfiguration(this.identity.config.mailReplyConfigFile); }
    async catalog(actor) {
        await this.authorize(actor);
        let configuration = null, configurationError;
        try {
            configuration = await this.configuration();
        }
        catch {
            configurationError = 'mail_reply_config_invalid';
        }
        return { templates: replyTemplateCatalog().map(template => ({ ...template, draft: defaultReplyDraft(template.id, actor.name, configuration?.from.address, this.now()) })), testMode: true, recipient: TEST_RECIPIENT, configured: !!configuration, configurationError, from: configuration?.from };
    }
    async context(actor, source) {
        await this.authorize(actor);
        const original = await this.archive.file(source.mailboxId, source.messageKey);
        const profiles = (await this.identity.db.query("SELECT DISTINCT c.id,c.profile FROM tasks t JOIN candidates c ON c.id::text=t.result->>'candidateId' WHERE t.payload->>'mailboxId'=$1 AND t.payload->>'mailMessageKey'=$2 AND c.deleted_at IS NULL", [source.mailboxId, source.messageKey])).rows;
        const profile = profiles.length === 1 ? profiles[0].profile : {};
        const recipient = replyRecipient(original.data, original.message.senderEmail, profiles.map(p => p.profile.email).filter(v => typeof v === 'string'));
        const jobs = (await this.identity.db.query('SELECT name FROM jobs WHERE open')).rows;
        const positions = jobs.filter(j => original.message.subject.includes(j.name) || profile.intent === j.name);
        const name = profile.realName || profile.name || original.message.body.match(/([\u4e00-\u9fff]{1,8}(?:先生|女士))\s*投递了您的职位/)?.[1] || '';
        let configuration = null, configurationError;
        try {
            configuration = await this.configuration();
        }
        catch {
            configurationError = 'mail_reply_config_invalid';
        }
        return { recipient, configured: !!configuration, configurationError, from: configuration?.from, templates: replyTemplateCatalog().map(t => ({ ...t, draft: productionReplyDraft(t.id, { name, position: positions.length === 1 ? positions[0].name : undefined, senderName: actor.name, senderEmail: configuration?.from.address }) })) };
    }
    async prepare(actor, source, input) {
        const body = parse(inputSchema, input), template = replyTemplateCatalog().find(value => value.id === body.templateId);
        if (!body.testMode && (!source || platformAddress(body.recipient)))
            fail(422, 'mail_reply_recipient_unconfirmed');
        let rendered;
        try {
            rendered = 'draft' in body ? { ...(body.testMode ? validateReplyDraft(body.templateId, body.draft, this.now()) : validateProductionDraft(body.draft)), templateVersion: template.version } : renderReplyTemplate(body.templateId, body.parameters, this.now());
        }
        catch (error) {
            if (error instanceof ApiError)
                throw error;
            fail(422, error.message);
        }
        if (body.templateVersion !== rendered.templateVersion)
            fail(409, 'mail_reply_template_stale');
        let sourceHash = 'synthetic-v1', headers = {}, originalSubject;
        if (source) {
            const original = await this.archive.file(source.mailboxId, source.messageKey);
            sourceHash = original.message.rawSha256;
            headers = parseReplyHeaders(original.data);
            originalSubject = original.message.subject;
        }
        let configuration = null, configurationError;
        try {
            configuration = await this.configuration();
        }
        catch {
            configurationError = 'mail_reply_config_invalid';
        }
        const recipient = body.testMode ? TEST_RECIPIENT : body.recipient.toLowerCase();
        if (!body.testMode && recipient === configuration?.from.address.toLowerCase())
            fail(422, 'mail_reply_recipient_unconfirmed');
        const testMode = body.testMode || recipient === TEST_RECIPIENT;
        const snapshot = { from: configuration?.from || null, to: recipient, subject: 'draft' in body ? rendered.subject : '[模板测试] ' + rendered.subject, text: rendered.text, ...headers };
        const deliveryHash = digest({ source: source || synthetic, sourceHash, templateVersion: rendered.templateVersion, snapshot, testMode });
        const requestHash = digest({ actorId: actor.id, actorVersion: actor.version, deliveryHash, configurationHash: configuration ? this.identity.hash(JSON.stringify(configuration)) : null });
        return { body, rendered, sourceHash, configuration, configurationError, snapshot, deliveryHash, requestHash, originalSubject, testMode };
    }
    async preview(actor, source, input) {
        await this.authorize(actor);
        const prepared = await this.prepare(actor, source, input), expiresAt = this.now().getTime() + 15 * 60 * 1000;
        const payload = Buffer.from(JSON.stringify({ hash: prepared.requestHash, expiresAt })).toString('base64url');
        return { ...prepared.snapshot, templateId: prepared.body.templateId, templateVersion: prepared.rendered.templateVersion, testMode: prepared.testMode, configured: !!prepared.configuration, configurationError: prepared.configurationError, originalSubject: prepared.originalSubject, previewToken: payload + '.' + this.identity.hash(payload), expiresAt: new Date(expiresAt).toISOString() };
    }
    verifyPreview(token, requestHash) {
        const [payload, signature, ...extra] = token.split('.'), expected = this.identity.hash(payload || '');
        if (extra.length || !signature || !/^[a-f0-9]{64}$/.test(signature) || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected)))
            fail(409, 'mail_reply_preview_stale');
        let parsed;
        try {
            parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        }
        catch {
            fail(409, 'mail_reply_preview_stale');
        }
        if (parsed.hash !== requestHash || !Number.isFinite(parsed.expiresAt) || parsed.expiresAt < this.now().getTime())
            fail(409, 'mail_reply_preview_stale');
    }
    project(row) { return { id: row.id, requestKey: row.request_key, templateId: row.template_id, templateVersion: row.template_version, state: row.state === 'sending' && this.now().getTime() - new Date(row.updated_at).getTime() > 120000 ? 'unknown' : row.state, recipient: row.recipient, subject: row.snapshot.subject, messageId: row.message_id, errorCode: row.error_code, createdAt: row.created_at, sentAt: row.sent_at, testMode: row.test_mode }; }
    async receipts(actor, source) {
        await this.authorize(actor);
        if (source)
            await this.archive.message(source.mailboxId, source.messageKey);
        const s = source || synthetic, rows = (await this.identity.db.query('SELECT * FROM mailbox_reply_receipts WHERE mailbox_id=$1 AND message_key=$2 ORDER BY created_at DESC LIMIT 50', [s.mailboxId, s.messageKey])).rows;
        return { items: rows.map(row => this.project(row)) };
    }
    async send(actor, source, input, key) {
        await this.authorize(actor);
        // Guard future route refactors: an outer transaction would roll back the durable claim.
        if (this.identity.db.sql !== this.identity.db.pool)
            fail(503, 'mail_reply_transaction_boundary');
        if (typeof key !== 'string' || !/^[A-Za-z0-9_.:-]{3,200}$/.test(key))
            fail(422, 'idempotency_key_required');
        const parsed = parse(sendSchema, input), { previewToken, confirmed, ...body } = parsed;
        const prepared = await this.prepare(actor, source, body);
        this.verifyPreview(previewToken, prepared.requestHash);
        if (!prepared.configuration)
            fail(503, prepared.configurationError || 'mail_reply_not_configured');
        const configuration = prepared.configuration, s = source || synthetic;
        const claimed = await this.identity.db.tx(async (c) => {
            await c.query('SELECT id FROM users WHERE id=$1 FOR SHARE', [actor.id]);
            await this.authorize(actor);
            await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['mail-reply-key:' + actor.id + ':' + key]);
            await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['mail-reply-source:' + s.mailboxId + ':' + s.messageKey + ':' + prepared.snapshot.to]);
            await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['mail-reply:' + prepared.deliveryHash]);
            const priorKey = (await c.query('SELECT * FROM mailbox_reply_receipts WHERE actor_id=$1 AND request_key=$2', [actor.id, key])).rows[0];
            if (priorKey) {
                if (priorKey.request_hash !== prepared.requestHash)
                    fail(409, 'idempotency_conflict');
                return { row: priorKey, created: false };
            }
            const uncertain = (await c.query("SELECT * FROM mailbox_reply_receipts WHERE mailbox_id=$1 AND message_key=$2 AND recipient=$3 AND state IN ('sending','unknown') ORDER BY created_at DESC LIMIT 1", [s.mailboxId, s.messageKey, prepared.snapshot.to])).rows[0];
            if (uncertain)
                return { row: uncertain, created: false };
            const priorDelivery = (await c.query('SELECT * FROM mailbox_reply_receipts WHERE delivery_hash=$1', [prepared.deliveryHash])).rows[0];
            if (priorDelivery) {
                if (priorDelivery.state !== 'failed' || body.retryReceiptId !== priorDelivery.id)
                    return { row: priorDelivery, created: false };
                await this.identity.audit(c, actor.id, 'mailbox.reply.retry', priorDelivery.id, { previousMessageId: priorDelivery.message_id, previousError: priorDelivery.error_code });
                const row = (await c.query("UPDATE mailbox_reply_receipts SET actor_id=$2,actor_version=$3,request_key=$4,request_hash=$5,message_id=$6,state='sending',error_code=NULL,updated_at=now() WHERE id=$1 RETURNING *", [priorDelivery.id, actor.id, actor.version, key, prepared.requestHash, '<' + randomUUID() + '@' + configuration.from.address.split('@')[1] + '>'])).rows[0];
                return { row, created: true };
            }
            const messageId = '<' + randomUUID() + '@' + configuration.from.address.split('@')[1] + '>';
            const row = (await c.query("INSERT INTO mailbox_reply_receipts(actor_id,actor_version,request_key,request_hash,delivery_hash,mailbox_id,message_key,source_hash,template_id,template_version,test_mode,recipient,message_id,snapshot,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'sending') RETURNING *", [actor.id, actor.version, key, prepared.requestHash, prepared.deliveryHash, s.mailboxId, s.messageKey, prepared.sourceHash, body.templateId, body.templateVersion, prepared.testMode, prepared.snapshot.to, messageId, prepared.snapshot])).rows[0];
            await this.identity.audit(c, actor.id, 'mailbox.reply.requested', row.id, { templateId: body.templateId, testMode: prepared.testMode, recipient: prepared.snapshot.to });
            return { row, created: true };
        });
        if (!claimed.created)
            return this.project(claimed.row);
        // The durable claim survives SMTP timeouts and process exits; no path automatically resends it.
        let state = 'unknown', errorCode = null;
        try {
            await this.authorize(actor);
            const result = await (this.options.transport || sendConfiguredReply)(configuration, { ...prepared.snapshot, from: configuration.from, messageId: claimed.row.message_id });
            state = result.accepted ? 'sent' : 'failed';
            errorCode = result.accepted ? null : 'smtp_recipient_rejected';
        }
        catch (error) {
            const code = error?.code;
            // A DATA/socket timeout may have reached the server. Never claim it is safe to retry.
            state = error instanceof ApiError || ['EAUTH', 'ECONNECTION', 'EDNS', 'EENVELOPE', 'EWS_REJECTED'].includes(code) ? 'failed' : 'unknown';
            errorCode = error instanceof ApiError ? error.code : configuration.transport === 'ews-bridge' ? (state === 'failed' ? 'ews_send_failed' : 'ews_result_unknown') : state === 'failed' ? 'smtp_send_failed' : 'smtp_result_unknown';
        }
        const row = (await this.identity.db.query("UPDATE mailbox_reply_receipts SET state=$2,error_code=$3,updated_at=now(),sent_at=CASE WHEN $2='sent' THEN now() ELSE NULL END WHERE id=$1 RETURNING *", [claimed.row.id, state, errorCode])).rows[0];
        await this.identity.audit(this.identity.db.sql, actor.id, 'mailbox.reply.' + state, row.id, { testMode: prepared.testMode, errorCode });
        return this.project(row);
    }
}
//# sourceMappingURL=reply-service.js.map