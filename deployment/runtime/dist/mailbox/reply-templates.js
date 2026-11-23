import { createHash } from 'node:crypto';
import { z, parse } from '../http/validation.js';
import { fail } from '../http/errors.js';
export const TEST_RECIPIENT = 'recruiting-operator@example.invalid';
// The supplied EML headers contain sample identities. Only its subject/body are templates.
const originals = {
    advance: { name: '进入后续流程', subject: '{公司} · {岗位} 后续流程沟通 — {候选人姓名}', text: `{候选人姓名} 您好：

感谢您投递{公司}的{岗位}，也谢谢您花时间准备这份简历。我们仔细看过您的经历，{候选人在XX方面的经验与我们团队当前的需求比较契合}，希望能与您进一步沟通。

为推进后续流程，想跟您确认两件事：

一、关于性格测评
请问您近 6 个月内是否做过 MBTI 测评？
· 做过：方便的话，请回复一下您的类型结果（如 INTJ、ENFJ 即可）；
· 没做过：链接：[MBTI十六型人格免费测试 - 专业深度测评平台 | 16personalities](https://www.16personality.com.cn/#version=48)，请抽空完成。

二、关于面试时间
请告知您未来一周内方便面试的时间，以下时段可任选（可多选），也可直接填写其他时间：
A. {11月10日 周二} {14:00-15:00}
B. {11月11日 周三} {10:00-11:00}
C. {11月13日 周五} {16:00-17:00}
D. 其他时间：________________（请您填写方便的具体日期与时间段，我们会尽量协调安排）

面试预计 {60} 分钟，形式为{线上视频 / 现场}，{会议链接或地址}会在时间确认后一并发您。

麻烦您于 {11月9日 18:00} 前回复本邮件，收到后我会尽快与您确认最终时间。

期待与您交流。

祝好
{公司} 人力资源部
` },
    decline: { name: '暂不推进', subject: '{公司} · {岗位} 投递反馈 — {候选人姓名}', text: `{候选人姓名} 您好：

感谢您投递{公司}的{岗位}，也谢谢您愿意花时间了解我们。

经过对岗位需求的整体评估，本次我们暂未推进您的申请——{该岗位目前更倾向具备 XX 方向经验的候选人}。这并非对您能力的否定，只是当前岗位与您的经历匹配度还不够高。

您的简历我们已存入公司人才库，后续如有与您背景更契合的岗位，我们会主动与您联系；也欢迎您持续关注我们的招聘信息，随时再次投递。

祝您求职顺利，早日找到合适的机会。

祝好
{公司} 人力资源部
` },
};
const placeholder = /[{}｛｝]|\bXX\b|example\.(?:com|org|net|invalid)|yourcompany|待填写|待补充|候选人姓名|你的姓名|会议链接或地址/i;
const line = (max = 200) => z.string().trim().min(1).max(max).refine(v => !/[\u0000-\u001f\u007f]/.test(v) && !placeholder.test(v), 'invalid_template_parameter');
export const replyEmail = line(254).refine(v => /^[A-Z0-9.!#$%&'*+/=?^_`|~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}$/i.test(v), 'invalid_email');
const common = { candidateName: line(80), company: line(120), position: line(120), senderName: line(80), senderTitle: line(120), reason: line(600).refine(v => v.length >= 5, 'reason_required') };
const slot = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) }).strict();
const advanceSchema = z.object({ ...common, questionnaireMinutes: z.number().int().min(1).max(60), interviewMinutes: z.number().int().min(5).max(240), interviewFormat: z.enum(['线上视频', '现场']), locationNotice: line(200), senderPhone: line(40).refine(v => /^[+\d][\d ()-]{5,39}$/.test(v), 'invalid_phone'), senderEmail: replyEmail, slots: z.array(slot).length(3), replyDeadline: z.string().regex(/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/) }).strict();
const declineSchema = z.object(common).strict();
export function replyTemplateCatalog() { return Object.keys(originals).map(id => ({ id, ...originals[id], version: createHash('sha256').update('mail-reply-v1:' + JSON.stringify(originals[id])).digest('hex') })); }
function calendar(value) {
    const date = new Date(value + 'T00:00:00Z');
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value)
        fail(422, 'mail_reply_date_invalid');
    return `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月${date.getUTCDate()}日 周${'日一二三四五六'[date.getUTCDay()]}`;
}
export function renderReplyTemplate(templateId, input, now = new Date()) {
    if (!Object.hasOwn(originals, templateId))
        fail(422, 'mail_reply_template_invalid');
    const p = parse(templateId === 'advance' ? advanceSchema : declineSchema, input);
    const replacements = { '候选人姓名': p.candidateName, '公司': p.company, '岗位': p.position, '你的姓名': p.senderName, '职位': p.senderTitle, '候选人在XX方面的经验与我们团队当前的需求比较契合': p.reason, '该岗位目前更倾向具备 XX 方向经验的候选人': p.reason };
    if (templateId === 'advance') {
        const a = parse(advanceSchema, input), deadlineDate = a.replyDeadline.slice(0, 10);
        calendar(deadlineDate);
        const deadline = Date.parse(a.replyDeadline + ':00+08:00');
        if (deadline <= now.getTime())
            fail(422, 'mail_reply_date_invalid');
        const dateKeys = ['11月10日 周二', '11月11日 周三', '11月13日 周五'], timeKeys = ['14:00-15:00', '10:00-11:00', '16:00-17:00'];
        a.slots.forEach((s, i) => { replacements[dateKeys[i]] = calendar(s.date); if (s.end <= s.start || Date.parse(`${s.date}T${s.start}:00+08:00`) <= deadline)
            fail(422, 'mail_reply_date_invalid'); replacements[timeKeys[i]] = s.start + '-' + s.end; });
        Object.assign(replacements, { '8': String(a.questionnaireMinutes), '60': String(a.interviewMinutes), '线上视频 / 现场': a.interviewFormat, '会议链接或地址': a.locationNotice, '11月9日 18:00': calendar(deadlineDate).split(' 周')[0] + ' ' + a.replyDeadline.slice(11), '手机': a.senderPhone, '邮箱': a.senderEmail });
    }
    const template = replyTemplateCatalog().find(t => t.id === templateId);
    const replace = (v) => v.replace(/\{([^{}]+)\}/g, (_, key) => replacements[key] ?? fail(422, 'mail_reply_placeholder'));
    const subject = replace(template.subject), text = replace(template.text);
    if (placeholder.test(subject) || placeholder.test(text) || /[\r\n]/.test(subject))
        fail(422, 'mail_reply_placeholder');
    return { templateId, templateVersion: template.version, subject, text, parameters: p };
}
export const replyDraftSchema = z.object({ subject: z.string().min(1).max(2000), text: z.string().min(1).max(16000) }).strict();
export function validateReplyDraft(templateId, input, now = new Date()) {
    const draft = parse(replyDraftSchema, input);
    if (!draft.subject.trim() || /[\u0000-\u001f\u007f]/.test(draft.subject) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(draft.text))
        fail(422, 'mail_reply_draft_invalid');
    const subject = draft.subject.startsWith('[模板测试] ') ? draft.subject : '[模板测试] ' + draft.subject, text = draft.text.replace(/\r\n/g, '\n');
    if (subject.length > 2000 || !text.trim() || /\r/.test(text))
        fail(422, 'mail_reply_draft_invalid');
    if (placeholder.test(subject) || placeholder.test(text))
        fail(422, 'mail_reply_placeholder');
    if (templateId === 'advance') {
        const instant = (value, clock, weekday) => {
            const match = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(value);
            if (!match || !/^([01]\d|2[0-3]):[0-5]\d$/.test(clock))
                fail(422, 'mail_reply_date_invalid');
            const date = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`, formatted = calendar(date);
            if (weekday && formatted.split(' 周')[1] !== weekday)
                fail(422, 'mail_reply_date_invalid');
            return Date.parse(date + 'T' + clock + ':00+08:00');
        };
        const deadline = /麻烦您于\s*(\d{4}年\d{1,2}月\d{1,2}日)\s+([^\s]+)\s*前回复本邮件/.exec(text);
        if (!deadline)
            fail(422, 'mail_reply_date_invalid');
        const deadlineAt = instant(deadline[1], deadline[2]);
        if (deadlineAt <= now.getTime())
            fail(422, 'mail_reply_date_invalid');
        const lines = [...text.matchAll(/^([ABC])\.\s*(.*)$/gm)];
        if (lines.length !== 3 || new Set(lines.map(row => row[1])).size !== 3)
            fail(422, 'mail_reply_date_invalid');
        for (const row of lines) {
            const slot = /^(\d{4}年\d{1,2}月\d{1,2}日)\s+周([日一二三四五六])\s+(\d{2}:\d{2})-(\d{2}:\d{2})\s*$/.exec(row[2]);
            if (!slot)
                fail(422, 'mail_reply_date_invalid');
            const start = instant(slot[1], slot[3], slot[2]), end = instant(slot[1], slot[4]);
            if (start <= deadlineAt || end <= start)
                fail(422, 'mail_reply_date_invalid');
        }
    }
    return { subject, text };
}
export function defaultReplyDraft(templateId, actorName, senderEmail, now = new Date()) {
    const day = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    day.setUTCHours(0, 0, 0, 0);
    const date = (offset) => new Date(day.getTime() + offset * 86400000).toISOString().slice(0, 10);
    const common = { candidateName: '测试候选人（合成示例）', company: '山子高科', position: '招聘专员（测试岗位）', senderName: actorName.replace(/[\u0000-\u001f\u007f{}]/g, ' ').trim().slice(0, 80) || '招聘同事', senderTitle: '招聘测试', reason: templateId === 'advance' ? '您在招聘协作方面的经验与我们团队当前的需求比较契合（合成测试内容）' : '该岗位目前更倾向具备技术招聘经验的候选人（合成测试内容）' };
    const parameters = templateId === 'advance' ? { ...common, questionnaireMinutes: 8, interviewMinutes: 60, interviewFormat: '线上视频', locationNotice: '会议链接', senderPhone: '000 0000 0000', senderEmail: senderEmail || TEST_RECIPIENT, slots: [{ date: date(2), start: '14:00', end: '15:00' }, { date: date(3), start: '10:00', end: '11:00' }, { date: date(4), start: '16:00', end: '17:00' }], replyDeadline: date(1) + 'T18:00' } : common;
    const rendered = renderReplyTemplate(templateId, parameters, now);
    let text = rendered.text.replace('000 0000 0000', '000 0000 0000（合成测试号码）');
    if (!senderEmail && templateId === 'advance')
        text = text.replace(TEST_RECIPIENT, '发信邮箱尚未配置');
    return validateReplyDraft(templateId, { subject: '[模板测试] ' + rendered.subject, text }, now);
}
// Never copy arbitrary raw headers into SMTP. Read only validated RFC Message-ID tokens.
export function parseReplyHeaders(raw) {
    const boundary = raw.indexOf('\r\n\r\n'), lfBoundary = raw.indexOf('\n\n'), end = boundary >= 0 ? boundary : lfBoundary;
    if (end < 0 || end > 128 * 1024)
        fail(422, 'mail_reply_headers_invalid');
    const source = raw.subarray(0, end).toString('utf8').replace(/\r?\n[ \t]+/g, ' '), values = {};
    for (const line of source.split(/\r?\n/)) {
        const match = /^(message-id|references|in-reply-to):[ \t]*(.*)$/i.exec(line);
        if (!match)
            continue;
        const key = match[1].toLowerCase();
        if (values[key] !== undefined)
            fail(422, 'mail_reply_headers_invalid');
        values[key] = match[2];
    }
    const tokens = (value) => { if (value === undefined)
        return []; if (value.length > 16000)
        fail(422, 'mail_reply_headers_invalid'); const ids = value.trim().split(/ +/); if (ids.length > 100 || ids.some(v => !/^<[!-~]+@[!-~]+>$/.test(v) || /[<>]/.test(v.slice(1, -1))))
        fail(422, 'mail_reply_headers_invalid'); return ids; };
    const own = tokens(values['message-id']);
    if (own.length > 1)
        fail(422, 'mail_reply_headers_invalid');
    const prior = tokens(values.references), inReplyTo = tokens(values['in-reply-to']);
    const references = [...new Set([...(prior.length ? prior : inReplyTo), ...own])];
    return { ...(own.length ? { inReplyTo: own[0] } : {}), ...(references.length ? { references } : {}) };
}
//# sourceMappingURL=reply-templates.js.map