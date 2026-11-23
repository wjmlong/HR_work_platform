// Reject only an explicit document title corroborated by the opening text.
// Unknown documents still proceed through normal resume/name review.
import { recognizeName } from './name.js';
export function isClearlyNonResume(fileName, raw) {
    const name = fileName.replace(/\.(?:pdf|docx|txt)$/i, '').replace(/\s+/g, ''), head = raw.slice(0, 2500).replace(/\s+/g, '');
    if (/简历|履历|resume/i.test(name) || /^(?:PERSONALRESUME|个人简历)/i.test(head))
        return false;
    const first = (raw.split('\n').find(l => l.trim()) || '').replace(/\s+/g, ''), datedPublication = /^20\d{2}年\d{1,2}月刊$/.test(first), personal = recognizeName(raw);
    if (personal && personal.start < 400 && !datedPublication)
        return false;
    if (/月刊|周刊|季刊|日报/.test(name) && (datedPublication || /^[^:：]{2,60}(?:月刊|周刊|季刊|日报)$/.test(first)))
        return true;
    return /(?:制度(?:[（(]试行[）)])?|通知|报价单(?:[（(]\d+[）)])*|公司介绍(?:20\d{2})?(?:[（(]\d+[）)])*)$/.test(name) && /文件履历|发放标准|办理方式|服务项目表|标准价|解决方案|目录|CONTENTS/i.test(head);
}
//# sourceMappingURL=document.js.map