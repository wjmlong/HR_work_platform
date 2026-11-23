import { createHash } from "node:crypto";
import { catalog } from "../dictionary/data.js";
import { profileInput } from "../recruiting/schema.js";
import { recognizeName } from './name.js';
export const encodeRaw = (raw) => Buffer.from(JSON.stringify(raw), "utf8");
export const decodeRaw = (raw) => JSON.parse(raw.toString("utf8"));
export function termRanges(raw, word) {
    const ranges = [];
    let from = 0;
    const lower = raw.toLowerCase(), w = word.toLowerCase();
    for (;;) {
        const start = lower.indexOf(w, from);
        if (start < 0)
            break;
        const end = start + w.length;
        from = Math.max(end, start + 1);
        if (/^[a-z0-9_]+$/i.test(w) &&
            (/[a-z0-9_]/i.test(raw[start - 1] || "") ||
                /[a-z0-9_]/i.test(raw[end] || "")))
            continue;
        ranges.push({ start, end });
    }
    return ranges;
}
export function parseProfile(raw, extraAliases = catalog.map(([name, , aliases]) => ({ name, aliases: [name, ...aliases] })), now = new Date()) {
    const profile = profileInput.parse({ name: "待确认" }), evidence = [];
    const add = (field, start, end) => {
        const text = raw.slice(start, end), id = createHash("sha256")
            .update(field + ":" + start + ":" + end + ":" + text)
            .digest("hex")
            .slice(0, 16);
        if (!evidence.some((x) => x.id === id))
            evidence.push({
                id,
                field,
                start,
                end,
                line: raw.slice(0, start).split("\n").length,
                text,
            });
    };
    function capture(field, re) {
        const m = re.exec(raw);
        if (!m)
            return null;
        const value = m[1], start = m.index + m[0].indexOf(value);
        add(field, start, start + value.length);
        return value.trim();
    }
    // 简历里常把「现居地 / 户籍 / 政治面貌」挤在同一行，直接取整行会把
    // 「中共党员（含预备党员）」当成所在地区。字段值只保留第一个标签之前的内容，
    // 证据 span 也同步收窄到真正取用的片段。
    const inlineStop = /(?:户籍|籍贯|户口所在地|户口|政治面貌|中共党员|共青团员|群众|婚姻状况|婚否|民族|出生年月|身份证|邮箱|电话|\s{2,})/;
    function captureFirst(field, re, stopPattern = inlineStop) {
        const m = re.exec(raw);
        if (!m)
            return null;
        const full = m[1], start = m.index + m[0].indexOf(full), stop = full.search(stopPattern), value = (stop >= 0 ? full.slice(0, stop) : full).trim();
        if (!value)
            return null;
        add(field, start, start + value.length);
        return value;
    }
    const name = recognizeName(raw);
    if (name) {
        profile.name = name.name;
        add('name', name.start, name.end);
    }
    const email = capture("email", /([a-z0-9.!#$%&'*+/=?^_{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+)/i);
    if (email)
        profile.email = email;
    const phone = capture("phone", /(?:电话|手机号|手机|联系电话|phone|mobile)\s*[:：]\s*(\+?[\d ()-]{5,40})/i) || capture("phone", /(?<!\d)(1[3-9]\d{9})(?!\d)/);
    if (phone)
        profile.phone = phone;
    const major = captureFirst("major", /(?:专业)\s*[:：]\s*([^\n\r,，。;；]{1,100})/, /(?:\s{2,}|(?:户籍|籍贯|政治面貌|婚姻状况|民族|出生年月|身份证|邮箱|电话)\s*[:：])/);
    if (major)
        profile.major = major;
    const levels = [
        ["doctor", ["博士", "PhD", "Ph.D."]],
        ["master", ["硕士", "Master"]],
        ["bachelor", ["本科", "学士", "Bachelor"]],
        ["associate", ["大专", "专科"]],
        ["secondary", ["高中", "中专"]],
    ];
    for (const [level, terms] of levels) {
        const hit = terms.flatMap((t) => termRanges(raw, t))[0];
        if (hit) {
            profile.education = level;
            add("education", hit.start, hit.end);
            break;
        }
    }
    const schools = [];
    let lineStart = 0;
    for (const line of raw.split("\n")) {
        let degree = levels.findIndex(([, terms]) => terms.some((term) => termRanges(line, term).length));
        if (degree < 0 &&
            /^\s*(?:最高学历院校|毕业院校|学校|院校)\s*[:：]/.test(line) &&
            profile.education)
            degree = levels.findIndex(([level]) => level === profile.education);
        for (const match of line.matchAll(/([\u4e00-\u9fffA-Za-z]{2,45}(?:大学|学院|研究院|学校)|[A-Za-z][A-Za-z .'-]{1,70}\b(?:University|College|Institute))/gi)) {
            const value = match[1].replace(/^(?:毕业于|就读于|毕业院校|本科院校|硕士院校|博士院校|学校|院校|本科|硕士|博士|学士)/, "");
            const start = lineStart + match.index + match[1].indexOf(value);
            schools.push({
                value,
                level: degree < 0 ? -1 : 5 - degree,
                start,
                end: start + value.length,
            });
            if (/本科|学士|bachelor/i.test(line) && !profile.bachelorSchool) {
                profile.bachelorSchool = value;
                add("bachelorSchool", start, start + value.length);
            }
        }
        lineStart += line.length + 1;
    }
    const highest = schools.toSorted((a, b) => b.level - a.level)[0];
    if (highest) {
        profile.school = highest.value;
        add("school", highest.start, highest.end);
    }
    const location = captureFirst("location", /(?:所在地|所在城市|现居(?:住地)?|居住地|城市)\s*[:：]\s*([^\n\r\0,，。;；]{1,100})/);
    if (location)
        profile.location = location;
    const intent = capture("intent", /(?:求职意向|意向岗位|应聘岗位|目标岗位)\s*[:：]\s*([^\n\r\0]{1,1000})/);
    if (intent)
        profile.intent = intent;
    const expectedSalary = capture("expectedSalary", /(?:期望年包|期望年薪|期望月薪|期望薪资|薪资期望|期望薪酬|Expected (?:annual |monthly )?salary)\s*[:：]\s*([^\n\r\0]{1,1000})/i);
    if (expectedSalary)
        profile.expectedSalary = expectedSalary;
    const summary = capture("summary", /(?:个人简介|个人优势|自我评价)\s*[:：]\s*([^\n\r\0]{1,1000})/);
    if (summary)
        profile.summary = summary;
    const age = capture("age", /(?:年龄|Age)\s*[:：]\s*(\d{1,3})(?:\s*岁)?/i);
    if (age !== null && Number(age) <= 120)
        profile.age = Number(age);
    const gender = capture("gender", /(?:性别|Gender)\s*[:：]\s*([^\n\r\0,，。;；]{1,30})/i);
    if (gender)
        profile.gender = gender;
    for (const match of raw.matchAll(/(?:工作单位|任职单位|公司名称|公司)\s*[:：]\s*([^\n\r\0,，。;；]{1,200})/g)) {
        const value = match[1].trim(), start = match.index + match[0].indexOf(match[1]);
        profile.companies.push(value);
        add("companies", start, start + match[1].length);
    }
    if (!profile.companies.length)
        for (const match of raw.matchAll(/[\u4e00-\u9fffA-Za-z]{2,45}(?:有限责任公司|股份有限公司|有限公司|集团|公司)/g)) {
            const value = match[0].replace(/^(?:任职于|就职于|曾任职于|工作于)/, ""), start = match.index + match[0].indexOf(value);
            profile.companies.push(value);
            add("companies", start, start + value.length);
        }
    profile.companies = [...new Set(profile.companies)];
    const years = capture("experienceYears", /(\d{1,2}(?:\.\d)?)\s*年(?:工作|相关|研发)?经验/) ??
        capture("experienceYears", /(?:工作经验|工作年限|相关经验)\s*[:：]\s*(\d{1,2}(?:\.\d)?)\s*年/);
    if (years !== null && Number(years) <= 80)
        profile.experienceYears = Number(years);
    const first = capture("firstEmployment", /(?:首次就业|初次就业时间|初次就业|参加工作|工作起始)\s*[:：]\s*((?:19|20)\d{2}(?:[-/.年]\d{1,2})?)/);
    if (first) {
        const m = first.match(/^(\d{4})(?:[-/.年](\d{1,2}))?/);
        const y = Number(m[1]), month = Number(m[2] || 1);
        if (month >= 1 && month <= 12 && y <= now.getUTCFullYear()) {
            profile.firstEmployment = y + "-" + String(month).padStart(2, "0");
            if (profile.experienceYears === null)
                profile.experienceYears = Math.max(0, Math.floor(((now.getUTCFullYear() - y) * 12 + now.getUTCMonth() + 1 - month) /
                    12));
        }
    }
    const skills = extraAliases;
    for (const item of skills) {
        const hits = item.aliases.flatMap((term) => termRanges(raw, term));
        if (hits.length) {
            profile.skills.push(item.name);
            for (const h of hits)
                add("skill:" + item.name, h.start, h.end);
        }
    }
    profile.skills = [...new Set(profile.skills)];
    const invalid = /\0|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
    for (const key of Object.keys(profile))
        if (typeof profile[key] === "string")
            profile[key] = profile[key].replace(invalid, "\uFFFD");
    return {
        profile,
        evidence,
        warnings: [
            ...(raw.trim().length < 50 ? ["short_raw"] : []),
            ...(!raw.trim() ? ["empty_raw"] : []),
            ...(profile.name === "待确认" ? ["name_unknown"] : []),
            ...[
                "phone",
                "email",
                "education",
                "school",
                "bachelorSchool",
                "experienceYears",
                "location",
            ]
                .filter((key) => profile[key] === null || profile[key] === "")
                .map((key) => "missing_" + key),
        ],
        parserVersion: "rules-4.0.3",
    };
}
//# sourceMappingURL=profile.js.map