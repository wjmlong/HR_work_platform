import { randomUUID } from 'node:crypto';
import { requireRole } from '../identity/service.js';
import { fail, found } from '../http/errors.js';
import { parse, uuid, z } from '../http/validation.js';
import { RecruitingService } from '../recruiting/service.js';
import { transitionInput } from '../recruiting/schema.js';
import { currentMatchSql, matchingReadAccess } from '../business-config/bindings.js';
import { decodeJSON } from '../parsing/json.js';
import { FeishuConfirmationSender } from './transport.js';
const reasons = ['核心技能不匹配', '项目经历不匹配', '岗位职责不匹配'];
const plain = (content) => ({ tag: 'plain_text', content });
const outcome = (n) => n === 0 ? '初筛通过' : reasons[n - 1];
const toast = (type, content) => ({ toast: { type, content } });
export function screeningCard(id, items, revision = 0) {
    const elements = items.flatMap((item, index) => [
        { tag: 'div', text: plain(item.name + ' · ' + (item.score === null ? '待人工评定' : item.score + ' 分') + '\n' + item.basis) },
        { tag: 'select_static', name: 'choice' + index, required: true, placeholder: plain('请选择初筛结果'),
            options: ['能力匹配（进入面试）', ...reasons.map(r => '未通过 · ' + r)].map((label, n) => ({ text: plain(label), value: String(n) })) }
    ]);
    elements.push({ tag: 'button', name: 'submit', text: plain('批量提交'), type: 'primary', form_action_type: 'submit',
        behaviors: [{ type: 'callback', value: { kind: 'screening_batch', id, revision } }] });
    return { schema: '2.0', config: { enable_forward: false, update_multi: true }, header: { title: plain('用人部门初筛 · ' + items.length + ' 人') }, body: { elements: [{ tag: 'form', name: 'screening', elements }] } };
}
function resultCard(b, reviewer) {
    const items = b.items;
    const title = b.decisions ? (reviewer ? '初筛已提交' : b.revision > 1 ? '用人部门已重新提交初筛' : '用人部门已完成初筛') : '初筛已撤销 · 等待重新评审';
    const elements = [{ tag: 'div', text: plain(b.decisions ? items.map((item, i) => item.name + ' · ' + outcome(Number(b.decisions[i]))).join('\n') : '上一版结果已撤销，请以重新提交的结果为准。') }];
    if (reviewer && b.decisions)
        elements.push({ tag: 'button', text: plain('撤销并重新评审'), confirm: { title: plain('撤销这批初筛结果？'), text: plain('整批候选人将回到待筛选，HR 的汇总也会更新。') }, behaviors: [{ type: 'callback', value: { kind: 'screening_batch', id: b.id, revision: b.revision, undo: true } }] });
    return { schema: '2.0', config: { enable_forward: false, update_multi: true }, header: { title: plain(title) }, body: { elements } };
}
function reviewCard(b) { return b.decisions ? resultCard(b, true) : screeningCard(b.id, b.items, b.revision); }
function response(b, message) { return { ...toast('success', message), card: { type: 'raw', data: reviewCard(b) } }; }
export class ScreeningBatches {
    identity;
    sender;
    constructor(identity, sender = new FeishuConfirmationSender(identity.config)) {
        this.identity = identity;
        this.sender = sender;
    }
    get db() { return this.identity.db; }
    async reviewer(job, user) {
        const f = this.identity.config.feishu;
        return found((await this.db.query(`SELECT u.* FROM users u JOIN active_job_screening_grants g ON g.user_id=u.id
    JOIN jobs j ON j.id=g.job_id WHERE g.job_id=$1 AND u.id=$2 AND j.open AND u.status='active' AND u.app_id=$3 AND u.tenant=$4`, [job, user, f.appId, f.tenant])).rows[0]);
    }
    async create(a, body) {
        requireRole(a, 'admin', 'manager', 'recruiter');
        if (!this.identity.config.feishuFeedback?.enabled)
            fail(503, 'feedback_not_enabled');
        const { jobId, userId } = parse(z.object({ jobId: uuid, userId: uuid }).strict(), body);
        return this.db.tx(async (c) => {
            const reviewer = await this.reviewer(jobId, userId);
            await c.query('SELECT id FROM jobs WHERE id=$1 FOR UPDATE', [jobId]);
            const rows = (await c.query(`SELECT a.id,a.version,a.resume_version_id,c.profile,jv.requirements,p.profile resume_profile,
      m.id match_id,m.reference_score,m.data FROM applications a JOIN candidates c ON c.id=a.candidate_id
      JOIN jobs j ON j.id=a.job_id JOIN job_versions jv ON jv.job_id=j.id AND jv.version=j.requirements_version
      LEFT JOIN resume_versions rv ON rv.id=a.resume_version_id LEFT JOIN parse_results p ON p.id=rv.parse_result_id
      LEFT JOIN LATERAL(SELECT m.* FROM match_snapshots m WHERE ${currentMatchSql('m', 'a', 'j')} ORDER BY m.created_at DESC LIMIT 1) m ON true
      WHERE a.job_id=$1 AND a.is_current AND a.status='screening' AND a.deleted_at IS NULL AND c.deleted_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM screening_batches b WHERE b.job_id=a.job_id AND b.decisions IS NULL
        AND b.created_at>now()-interval '24 hours' AND b.items @>jsonb_build_array(jsonb_build_object('id',a.id::text,'version',a.version)))
      ORDER BY a.created_at,a.id LIMIT 10`, [jobId])).rows;
            if (!rows.length)
                fail(409, 'no_pending_screening_applications');
            const items = [];
            for (const r of rows) {
                const actor = { ...reviewer, screeningScope: [jobId] };
                const access = await matchingReadAccess(this.identity, actor, { id: jobId, requirements: r.requirements }, r.resume_version_id ? { id: r.resume_version_id, profile: r.resume_profile } : null, c);
                const match = access.allowed && r.data ? decodeJSON(r.data) : null;
                const score = r.reference_score || match?.score;
                const pending = !!match && (!!score?.provisional || (match.skills || []).some((s) => s.status !== 'matched' && !s.assertions?.length));
                const hints = (match?.skills || []).filter((s) => s.status === 'matched').slice(0, 3).map((s) => String(s.label || s.requirement).slice(0, 60));
                items.push({ id: r.id, version: r.version, name: access.nameVisible ? String(r.profile.name || '候选人').slice(0, 60) : '候选人 ' + (items.length + 1),
                    score: match && Number.isFinite(score?.value) ? (pending ? 60 : score.value) : null, matchId: r.match_id,
                    basis: [hints.length ? '匹配技能：' + hints.join('、') : '', pending ? '初筛参考分 60（中等），部分要求缺少明确依据，请人工评定' : ''].filter(Boolean).join('；') || '请结合岗位要求核对履历' });
            }
            await c.query('INSERT INTO screening_batches(job_id,reviewer_id,hr_id,items) VALUES($1,$2,$3,$4)', [jobId, userId, a.id, JSON.stringify(items)]);
            return { count: items.length };
        });
    }
    async submit(raw) {
        const f = this.identity.config.feishu;
        if (raw?.app_id !== f.appId || raw?.tenant_key !== f.tenant || raw.operator?.tenant_key !== f.tenant || raw.host !== 'im_message' || !raw.context?.open_message_id || raw.action?.tag !== 'button')
            return toast('error', '卡片身份校验失败');
        try {
            return await this.db.tx(async (c) => {
                const id = parse(uuid, raw.action.value.id);
                const b = found((await c.query('SELECT * FROM screening_batches WHERE id=$1 FOR UPDATE', [id])).rows[0]);
                const reviewer = await this.reviewer(b.job_id, b.reviewer_id);
                if (reviewer.open_id !== raw.operator.open_id || b.review_message !== raw.context.open_message_id)
                    fail(403, 'forbidden');
                const submittedRevision = raw.action.value.revision ?? 0;
                if (submittedRevision !== b.revision)
                    return response(b, '卡片已更新，以下是当前结果');
                if (raw.action.value.undo === true) {
                    if (!b.decisions)
                        return response(b, '已撤销，可以重新评审');
                    const recruiting = new RecruitingService(this.identity);
                    for (const [i, item] of b.items.entries()) {
                        const expected = b.decisions[i] === '0' ? 'screened' : 'rejected';
                        const eligible = await c.query(`SELECT a.id FROM applications a WHERE a.id=$1 AND a.job_id=$2 AND a.version=$3 AND a.status=$4 AND a.deleted_at IS NULL AND a.is_current
       AND NOT EXISTS(SELECT 1 FROM interviews x WHERE x.application_id=a.id AND x.created_at>= $5 AND x.deleted_at IS NULL) FOR UPDATE OF a`, [item.id, b.job_id, item.version + 1, expected, b.submitted_at]);
                        if (!eligible.rowCount)
                            fail(409, 'screening_already_advanced');
                        const updated = await recruiting.transitionTx(c, reviewer, item.id, transitionInput.parse({ version: item.version + 1, to: 'screening', confirm: true, reason: '用人部门撤销初筛', opinion: '撤销本批结果并重新评审' }));
                        item.version = updated.version;
                    }
                    await this.identity.audit(c, reviewer.id, 'screening_batch.withdraw', b.id, { decisions: b.decisions, revision: b.revision });
                    const cleared = (await c.query('UPDATE screening_batches SET items=$2,decisions=NULL,notices=notices || $3::jsonb,revision=revision+1,created_at=now(),next_attempt=now() WHERE id=$1 RETURNING *', [id, JSON.stringify(b.items), JSON.stringify([{ revision: b.revision + 1, key: randomUUID(), decisions: null }])])).rows[0];
                    return response(cleared, '已撤销，可重新选择并提交');
                }
                if (b.decisions)
                    return response(b, '已提交，保留第一次的结果');
                if (Date.now() - new Date(b.created_at).getTime() >= 86400000)
                    fail(409, 'expired');
                const items = b.items, decisions = items.map((_, i) => raw.action.form_value?.['choice' + i]);
                if (decisions.some(v => typeof v !== 'string' || !['0', '1', '2', '3'].includes(v)))
                    return toast('error', '请为每位候选人选择结果');
                const recruiting = new RecruitingService(this.identity);
                for (const [i, item] of items.entries()) {
                    const row = (await c.query("SELECT id FROM applications WHERE id=$1 AND job_id=$2 AND status='screening' AND is_current AND version=$3 FOR UPDATE", [item.id, b.job_id, item.version])).rows[0];
                    if (!row)
                        fail(409, 'stale');
                    const n = Number(decisions[i]), reason = outcome(n);
                    await recruiting.transitionTx(c, reviewer, item.id, transitionInput.parse({ version: item.version, to: n ? 'rejected' : 'screened',
                        reason, opinion: '用人部门初筛：' + reason, rejectReason: n ? reason : '', rejectDetail: n ? reason : '' }));
                }
                const saved = (await c.query('UPDATE screening_batches SET decisions=$2,notices=notices || $3::jsonb,submitted_at=now(),revision=revision+1,next_attempt=now() WHERE id=$1 RETURNING *', [id, JSON.stringify(decisions), JSON.stringify([{ revision: b.revision + 1, key: randomUUID(), decisions }])])).rows[0];
                return response(saved, '整批结果已保存');
            });
        }
        catch (error) {
            return toast('error', error?.code === 'screening_already_advanced' ? '已有候选人进入后续流程，整批未撤销，请联系 HR。' : '整批未提交。请核对岗位授权与最新候选人状态。');
        }
    }
    async deliver() {
        const b = await this.db.tx(async (c) => (await c.query(`UPDATE screening_batches SET next_attempt=now()+interval '2 minutes'
    WHERE id=(SELECT id FROM screening_batches WHERE next_attempt<=now() AND
    ((review_revision<revision AND (review_message IS NOT NULL OR created_at>now()-interval '24 hours')) OR hr_revision<revision)
    ORDER BY next_attempt LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`)).rows[0]);
        if (!b)
            return;
        if (b.review_revision < b.revision) {
            const user = await this.reviewer(b.job_id, b.reviewer_id);
            let message = b.review_message;
            if (message)
                await this.sender.update(message, reviewCard(b));
            else
                message = (await this.sender.send(user.open_id, b.id, reviewCard(b))).messageId;
            await this.db.query('UPDATE screening_batches SET review_message=$2,review_revision=$3 WHERE id=$1', [b.id, message, b.revision]);
        }
        if (b.hr_revision < b.revision) {
            const f = this.identity.config.feishu;
            const hr = found((await this.db.query("SELECT open_id FROM users WHERE id=$1 AND directory_active AND status='active' AND roles&&ARRAY['admin','manager','recruiter']::text[] AND app_id=$2 AND tenant=$3", [b.hr_id, f.appId, f.tenant])).rows[0]);
            for (const notice of b.notices.filter((n) => n.revision > b.hr_revision)) {
                const card = resultCard({ ...b, revision: notice.revision, decisions: notice.decisions }, false);
                const message = await this.sender.send(hr.open_id, notice.key, card);
                await this.db.query('UPDATE screening_batches SET hr_message=$2,hr_revision=$3,notified_at=now() WHERE id=$1 AND hr_revision<$3', [b.id, message.messageId, notice.revision]);
            }
        }
    }
}
//# sourceMappingURL=screening.js.map