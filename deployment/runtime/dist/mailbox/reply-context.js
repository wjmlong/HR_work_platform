import { replyEmail, replyTemplateCatalog } from './reply-templates.js';
export const pendingReplyFields = (value) => [...new Set(value.match(/\{[^{}\n]{1,100}\}|【待补充[^】]*】/g) || [])];
export function validateProductionDraft(input) {
    const subject = input.subject.trim(), text = input.text.replace(/\r\n/g, '\n');
    if (!subject || subject.length > 2000 || /[\u0000-\u001f\u007f]/.test(subject) || !text.trim() || text.length > 16000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))
        throw Error('mail_reply_draft_invalid');
    if (pendingReplyFields(subject + '\n' + text).length || /[{}｛｝]|\bXX\b/.test(subject + '\n' + text))
        throw Error('mail_reply_placeholder');
    return { subject, text };
}
export function platformAddress(address) { return /(?:^|[.@])(?:zhaopinmail\.com|zhaopin\.com|51job\.com|51jobmail\.com|liepin\.com|zhipin\.com)$/i.test(address) || /^(?:no[-_]?reply|donotreply|mailer-daemon|notifications?)@/i.test(address); }
function singleAddress(value) {
    const angle = /^[^<>\r\n,;:@]*<([^<>]+)>$/.exec(value.trim()), address = (angle ? angle[1] : value.trim()).toLowerCase();
    return replyEmail.safeParse(address).success && !platformAddress(address) ? address : '';
}
export function replyRecipient(raw, sender, profileEmails = []) {
    const end = raw.toString('utf8').search(/\r?\n\r?\n/);
    if (end < 0 || end > 128 * 1024)
        return { address: '', source: 'missing' };
    const header = raw.toString('utf8').slice(0, end).replace(/\r?\n[ \t]+/g, ' '), values = header.split(/\r?\n/).filter(v => /^reply-to:/i.test(v));
    if (values.length) {
        const address = values.length === 1 ? singleAddress(values[0].replace(/^reply-to:\s*/i, '')) : '';
        return { address, source: address ? 'reply-to' : 'ambiguous' };
    }
    const emails = [...new Set(profileEmails.map(singleAddress).filter(Boolean))];
    if (emails.length > 1)
        return { address: '', source: 'ambiguous' };
    if (emails.length === 1)
        return { address: emails[0], source: 'candidate' };
    const address = singleAddress(sender);
    return { address, source: address ? 'sender' : 'missing' };
}
export function productionReplyDraft(templateId, context) {
    const template = replyTemplateCatalog().find(t => t.id === templateId);
    const field = (name, value) => value?.replace(/[{}\r\n\u0000-\u001f]/g, ' ').trim() || '【待补充：' + name + '】';
    const values = { '候选人姓名': field('称呼', context.name), '公司': field('公司', context.company || '山子高科'), '岗位': field('岗位', context.position), '你的姓名': field('署名', context.senderName), '职位': '人力资源部', '邮箱': field('发信邮箱', context.senderEmail), '8': '8', '60': '60', '线上视频 / 现场': '线上视频', '会议链接或地址': '会议链接' };
    const labels = { '候选人在XX方面的经验与我们团队当前的需求比较契合': '进一步沟通原因', '该岗位目前更倾向具备 XX 方向经验的候选人': '暂不推进原因', '11月10日 周二': '可选日期 A', '11月11日 周三': '可选日期 B', '11月13日 周五': '可选日期 C', '14:00-15:00': '时段 A', '10:00-11:00': '时段 B', '16:00-17:00': '时段 C', '11月9日 18:00': '回复截止时间', '手机': '联系电话' };
    const replace = (value) => value.replace(/\{([^{}]+)\}/g, (_, key) => values[key] || '【待补充：' + (labels[key] || key) + '】');
    return { subject: replace(template.subject), text: replace(template.text) };
}
//# sourceMappingURL=reply-context.js.map