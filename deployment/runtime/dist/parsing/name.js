const titles = new Set(['待确认', '未知', '未填写', '未注明', '个人简历', '个人信息', '基本信息', '基本资料', '个人资料', '教育背景', '教育经历', '工作经历', '工作经验', '项目经验', '项目经历', '项目背景', '求职意向', '个人优势', '自我评价', '联系方式', '专业技能', '应聘简历', '简历', '姓名', '照片', '人才简历']);
const surnames = new Set('李王张刘陈杨黄赵吴周徐孙马朱胡郭何林高罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱戴覃武严莫孔向常汤康施文牛洪葛安易乔伍庞颜倪温庄章鲁翟殷詹欧耿关兰焦俞左柳聂甘祝包宁尚符舒阮柯纪梅童凌毕单季裴霍涂成苗谷盛曲翁桑刁蓝路游辛管华穆齐滕钱翟鲍费解席尉赖全邬屈喻牟仇臧敖苗连冷靳井邢樊晏岑车窦宗翦骆裘卞褚计耿沙蔺冉奚阎'.split(''));
export const normalizeName = (value) => /^[\p{Script=Han}\s·]+$/u.test(value) ? value.replace(/\s+/g, '') : value.trim().replace(/[ \t]+/g, ' ');
export function plausibleName(value) { const name = normalizeName(value); return !titles.has(name) && /^[\p{L}][\p{L}\p{M}\d .·'’_-]{0,59}$/u.test(name) && !/(?:姓名|性别|出生|年龄|籍贯|电话|手机|邮箱|求职意向|大学|学院|有限公司|工作经历)/.test(name) && !(/[\p{Script=Han}]/u.test(name) && /\d/.test(name)) && (!/^[\p{Script=Han}]+$/u.test(name) || name.length <= 6); }
function candidate(raw, text, start) {
    const boundary = text.search(/(?:性\s*别|出\s*生(?:日期|年月)?|年\s*龄|籍\s*贯|电\s*话|手\s*机|邮\s*箱|民\s*族|婚姻状况|Email|Phone|Gender|Date of birth)\s*[:：]?|\s+(?:(?:19|20)\d{2}|\d{1,3}\s*岁)/i);
    const value = (boundary < 0 ? text : text.slice(0, boundary)).split(/[|｜,，;；\t]/)[0].trim();
    // Invalid Unicode belongs to the immutable raw citation; derived profile text
    // is sanitized by parseProfile. Do not discard an explicit name's evidence.
    const validation = value.replace(/\0|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
    if (!plausibleName(validation))
        return null;
    const offset = start + text.indexOf(value);
    return { name: normalizeName(value), start: offset, end: offset + value.length };
}
export function recognizeName(raw) {
    const labeled = /(?:^|\n)[ \t]*(?:(?:个人信息|基本信息|个人资料|基本资料)[ \t]+)?(?:姓[ \t]*名|Name)\s*(?:[:：][ \t]*|\r?\n[ \t]*|[ \t]+)([^\n\r\0]{1,160})/gi;
    for (const hit of raw.matchAll(labeled)) {
        const found = candidate(raw, hit[1], hit.index + hit[0].lastIndexOf(hit[1]));
        if (found)
            return found;
    }
    // Only short standalone personal names at the top are eligible. Section titles
    // and employer names are never promoted from the rest of the document.
    const header = raw.slice(0, 1500).split(/紧急联系人|推荐人|证明人|联系猎头|猎头顾问|工作经历|工作经验|工作履历|项目经历|项目经验|教育经历|教育背景/)[0];
    if (!/(?:电话|手机|联系方式|邮箱|求职意向|性别|出生日期|年龄)\s*[:：]|1[3-9]\d{9}|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(header))
        return null;
    let start = 0, nonempty = 0;
    for (const line of header.split('\n')) {
        const value = line.trim(), name = normalizeName(value);
        if (value && ++nonempty > 12)
            break;
        if (/^[\p{Script=Han}]{2,4}$/u.test(name) && surnames.has(name[0]) && !titles.has(name) && !/(?:信息|资料|简历|经历|经验|背景|能力|优势|技能|评价|意向|成果|介绍|分析|设计|管理|工作|项目|教育)$/.test(name) && plausibleName(name)) {
            const offset = start + line.indexOf(value);
            return { name, start: offset, end: offset + value.length };
        }
        start += line.length + 1;
    }
    if (/简历编号\s*[:：]|关联职位\s*[:：]/.test(header)) {
        const salutation = /(?:^|\n)\s*([\p{Script=Han}]{1,2}(?:先生|女士))(?=\s*(?:在职|离职|应届|求职|看看新机会|\r?$))/mu.exec(header);
        if (salutation) {
            const start = salutation.index + salutation[0].lastIndexOf(salutation[1]);
            return { name: salutation[1], start, end: start + salutation[1].length };
        }
    }
    return null;
}
//# sourceMappingURL=name.js.map