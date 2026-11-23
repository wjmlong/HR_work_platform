import { createHash, timingSafeEqual } from 'node:crypto';
import { requireRole } from '../identity/service.js';
import { ApiError, fail, found } from '../http/errors.js';
import { parse, z, uuid, version } from '../http/validation.js';
import { sourceFieldAccess } from '../business-config/bindings.js';
import { confirmationCard } from './card.js';
import { FeishuConfirmationSender } from './transport.js';
const sendInput = z.object({ version, confirmed: z.literal(true) }).strict();
const actionInput = z.object({ schema: z.literal('2.0'), event_id: z.string().min(1).max(200), event_type: z.literal('card.action.trigger'), app_id: z.string().min(1), tenant_key: z.string().min(1), operator: z.object({ open_id: z.string().min(1), tenant_key: z.string().min(1) }), host: z.literal('im_message'), context: z.object({ open_message_id: z.string().min(1).max(200) }), action: z.object({ tag: z.literal('button'), value: z.object({ kind: z.literal('interview_confirmation'), id: uuid, token: z.string().max(100), decision: z.enum(['accepted', 'declined']) }), form_value: z.object({ reason: z.string().max(500).optional() }).optional() }) });
const toast = (type, content) => ({ toast: { type, content } });
const participantSql = "SELECT u.*,x.temporary_access FROM interviewers x JOIN users u ON u.id=x.user_id WHERE x.interview_id=$1 AND u.tenant=$2 AND u.app_id=$3 AND u.directory_active AND u.status IN ('active','pending') AND ((NOT x.temporary_access AND u.status='active' AND u.roles&&ARRAY['admin','manager','recruiter','interviewer']::text[]) OR (x.temporary_access AND EXISTS(SELECT 1 FROM active_interview_grants g WHERE g.interview_id=x.interview_id AND g.user_id=u.id))) ORDER BY u.id";
export class InterviewFeedback {
    identity;
    senderFactory;
    constructor(identity, senderFactory = () => new FeishuConfirmationSender(identity.config)) {
        this.identity = identity;
        this.senderFactory = senderFactory;
    }
    get db() { return this.identity.db; }
    get enabled() { const c = this.identity.config; return !!(c.feishuFeedback?.enabled && c.feishu.appId && c.feishu.appSecret && c.feishu.tenant); }
    async access(a, id) {
        requireRole(a, 'admin', 'manager', 'recruiter');
        const f = this.identity.config.feishu, u = (await this.db.query('SELECT * FROM users WHERE id=$1', [a.id])).rows[0];
        if (!u || u.version !== a.version || u.status !== 'active' || !u.directory_active || u.tenant !== f.tenant || u.app_id !== f.appId || !u.roles.some((r) => ['admin', 'manager', 'recruiter'].includes(r)))
            fail(403, 'membership_changed');
        const i = found((await this.db.query('SELECT * FROM interviews WHERE id=$1 AND deleted_at IS NULL', [id])).rows[0]);
        await this.identity.applicationAccess(a, i.application_id, true);
        return i;
    }
    async participants(id) { const f = this.identity.config.feishu; return (await this.db.query(participantSql, [id, f.tenant, f.appId])).rows; }
    token(id) { return this.identity.hash('feishu-interview-confirmation:' + id); }
    async status(a, id) {
        const i = await this.access(a, id), f = this.identity.config.feishu;
        const rows = (await this.db.query(`SELECT u.id user_id,u.name,r.id,r.interview_version,r.delivery,r.decision,r.reason,r.responded_at,r.last_error FROM interviewers x JOIN users u ON u.id=x.user_id LEFT JOIN LATERAL(SELECT * FROM feishu_interview_confirmations r WHERE r.interview_id=x.interview_id AND r.user_id=x.user_id AND r.tenant=$2 AND r.app_id=$3 ORDER BY r.interview_version DESC LIMIT 1) r ON true WHERE x.interview_id=$1 ORDER BY u.name,u.id`, [id, f.tenant, f.appId])).rows;
        const items = rows.map(r => ({ id: r.id || null, userId: r.user_id, name: r.name, version: r.interview_version || null, delivery: r.delivery || 'not_sent', decision: r.decision || 'pending', reason: r.reason || '', respondedAt: r.responded_at || null, error: r.last_error || null, stale: !!r.id && (r.interview_version !== i.version || i.status !== 'pending' || new Date(i.starts_at).getTime() <= Date.now()) }));
        return { interviewId: id, version: i.version, enabled: this.enabled, canSend: this.enabled && i.status === 'pending' && new Date(i.starts_at).getTime() > Date.now(), needsCoordination: items.some(r => !r.stale && r.decision === 'declined'), items };
    }
    async send(a, id, input) {
        // Provider delivery cannot be undone with a SQL rollback. Refuse Commands/nested transactions.
        if (this.db.sql !== this.db.pool)
            fail(409, 'feedback_outer_transaction');
        const b = parse(sendInput, input);
        await this.access(a, id);
        if (!this.enabled)
            fail(503, 'feedback_not_enabled');
        const lock = await this.db.pool.connect(), key = this.identity.config.schema + ':feishu-feedback:' + id;
        let held = false;
        try {
            held = (await lock.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) ok', [key])).rows[0].ok;
            if (!held)
                fail(409, 'feedback_busy');
            const { i, people, jobName } = await this.db.tx(async () => {
                await this.db.query('SELECT id FROM interviews WHERE id=$1 FOR UPDATE', [id]);
                const i = await this.access(a, id);
                if (i.version !== b.version)
                    fail(409, 'version_conflict');
                if (i.status !== 'pending' || new Date(i.starts_at).getTime() <= Date.now())
                    fail(409, 'feedback_interview_unavailable');
                const fields = await sourceFieldAccess(this.identity, a, { kind: 'interview', id }, { startsAt: i.starts_at, durationMinutes: i.duration_minutes, round: i.round });
                if (['startsAt', 'durationMinutes', 'round'].some(k => !fields.keys.has(k)))
                    fail(403, 'field_read_forbidden');
                const job = found((await this.db.query('SELECT j.id,j.name FROM applications a JOIN jobs j ON j.id=a.job_id WHERE a.id=$1', [i.application_id])).rows[0]);
                const jobFields = await sourceFieldAccess(this.identity, a, { kind: 'job', id: job.id }, { name: job.name });
                const people = await this.participants(id), count = Number((await this.db.query('SELECT count(*) n FROM interviewers WHERE interview_id=$1', [id])).rows[0].n);
                if (!count || count > 50 || people.length !== count)
                    fail(422, 'feedback_participant_invalid');
                const f = this.identity.config.feishu;
                for (const p of people)
                    await this.db.query('INSERT INTO feishu_interview_confirmations(interview_id,interview_version,user_id,tenant,app_id,user_open_id,requested_by) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING', [id, i.version, p.id, f.tenant, f.appId, p.open_id, a.id]);
                return { i, people, jobName: jobFields.keys.has('name') ? job.name : '招聘面试' };
            });
            const sender = this.senderFactory(), f = this.identity.config.feishu;
            for (const p of people) {
                const current = await this.access(a, id);
                if (current.version !== i.version || current.status !== 'pending')
                    fail(409, 'feedback_interview_changed');
                if (!(await this.participants(id)).some(x => x.id === p.id))
                    fail(409, 'feedback_participant_invalid');
                const row = (await this.db.query('SELECT * FROM feishu_interview_confirmations WHERE interview_id=$1 AND interview_version=$2 AND user_id=$3 AND tenant=$4 AND app_id=$5', [id, i.version, p.id, f.tenant, f.appId])).rows[0];
                if (row.delivery === 'sent' || row.decision !== 'pending')
                    continue;
                await this.db.query("UPDATE feishu_interview_confirmations SET delivery='sending',attempts=attempts+1,last_attempt_at=now(),last_error=NULL,updated_at=now() WHERE id=$1", [row.id]);
                try {
                    const result = await sender.send(p.open_id, row.id, confirmationCard({ id: row.id, round: i.round, startsAt: new Date(i.starts_at).toISOString(), durationMinutes: i.duration_minutes, token: this.token(row.id) }, jobName));
                    await this.db.query("UPDATE feishu_interview_confirmations SET delivery='sent',message_id=$2,last_error=NULL,updated_at=now() WHERE id=$1", [row.id, result.messageId]);
                    await this.identity.audit(this.db.sql, a.id, 'interview.confirmation.sent', id, { confirmationId: row.id, userId: p.id, version: i.version });
                }
                catch {
                    // Keep the durable attempt: Feishu may have accepted a request whose response was lost.
                    await this.db.query("UPDATE feishu_interview_confirmations SET delivery=CASE WHEN decision='pending' THEN 'failed' ELSE 'sent' END,last_error=CASE WHEN decision='pending' THEN 'feedback_send_failed' ELSE NULL END,updated_at=now() WHERE id=$1", [row.id]);
                }
            }
            return this.status(a, id);
        }
        finally {
            try {
                if (held)
                    await lock.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]);
            }
            finally {
                lock.release();
            }
        }
    }
    // Trusted SDK-only boundary. No public HTTP route forwards unverified payloads here.
    async handleCardAction(input) {
        const parsed = actionInput.safeParse(input);
        if (!parsed.success || !this.enabled)
            return toast('error', '无法处理此确认，请联系 HR。');
        const e = parsed.data, f = this.identity.config.feishu, v = e.action.value;
        if (e.app_id !== f.appId || e.tenant_key !== f.tenant || e.operator.tenant_key !== f.tenant)
            return toast('error', '无权操作此确认。');
        const expected = Buffer.from(this.token(v.id)), actual = Buffer.from(v.token);
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
            return toast('error', '无权操作此确认。');
        const reason = v.decision === 'declined' ? (e.action.form_value?.reason || '').trim() : '';
        if (v.decision === 'declined' && !reason)
            return toast('error', '请填写拒绝原因后再次提交。');
        const fingerprint = createHash('sha256').update(JSON.stringify([v.id, e.operator.open_id, e.context.open_message_id, v.decision, reason])).digest('hex');
        try {
            return await this.db.tx(async (c) => {
                // Callbacks must finish within three seconds; never call external services here.
                await c.query("SET LOCAL statement_timeout='1200ms'");
                await c.query("SET LOCAL lock_timeout='200ms'");
                const row = found((await c.query('SELECT * FROM feishu_interview_confirmations WHERE id=$1 FOR UPDATE', [v.id])).rows[0]);
                if (row.tenant !== f.tenant || row.app_id !== f.appId || row.user_open_id !== e.operator.open_id || !row.attempts || (row.message_id && row.message_id !== e.context.open_message_id))
                    fail(403, 'feedback_forbidden');
                const i = found((await c.query('SELECT * FROM interviews WHERE id=$1 FOR UPDATE', [row.interview_id])).rows[0]);
                if (i.version !== row.interview_version || i.deleted_at || i.status !== 'pending' || new Date(i.starts_at).getTime() <= Date.now())
                    fail(409, 'feedback_stale');
                const eligible = (await c.query(participantSql, [i.id, f.tenant, f.appId])).rows.find(p => p.id === row.user_id && p.open_id === e.operator.open_id);
                if (!eligible)
                    fail(403, 'feedback_forbidden');
                const previous = (await c.query('SELECT fingerprint,response FROM feishu_interview_callback_receipts WHERE tenant=$1 AND app_id=$2 AND event_id=$3', [f.tenant, f.appId, e.event_id])).rows[0];
                if (previous) {
                    if (previous.fingerprint !== fingerprint)
                        fail(409, 'feedback_replay_mismatch');
                    return previous.response;
                }
                if (row.decision !== 'pending')
                    fail(409, 'feedback_already_responded');
                const response = toast('success', v.decision === 'accepted' ? '已确认参加，HR 可见。' : '已提交拒绝原因，请等待 HR 协调。');
                await c.query("UPDATE feishu_interview_confirmations SET decision=$2,reason=$3,responded_at=now(),delivery='sent',message_id=coalesce(message_id,$4),last_error=NULL,updated_at=now() WHERE id=$1", [row.id, v.decision, reason, e.context.open_message_id]);
                await c.query('INSERT INTO feishu_interview_callback_receipts(tenant,app_id,event_id,confirmation_id,fingerprint,response) VALUES($1,$2,$3,$4,$5,$6)', [f.tenant, f.appId, e.event_id, row.id, fingerprint, response]);
                await this.identity.audit(c, row.user_id, 'interview.confirmation.responded', i.id, { confirmationId: row.id, version: i.version, decision: v.decision });
                return response;
            });
        }
        catch (error) {
            if (error instanceof ApiError && error.code === 'feedback_stale')
                return toast('error', '安排已更新或结束，此卡片已失效，请联系 HR。');
            if (error instanceof ApiError && error.code === 'feedback_already_responded')
                return toast('error', '你已提交答复，如需更改请联系 HR。');
            return toast('error', '未提交成功，请重试；仍失败请联系 HR。');
        }
    }
}
//# sourceMappingURL=service.js.map