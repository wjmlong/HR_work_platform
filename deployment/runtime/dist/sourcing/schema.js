import { z, text, uuid, version } from "../http/validation.js";
export const line = z.enum(["high", "focus", "social"]);
export const leadSourceValues = [
    "顶会论文",
    "导师主页",
    "实验室官网",
    "领英",
    "脉脉",
    "内推",
    "校友引荐",
    "工厂/展会",
    "论坛/社区",
    "抖音/社媒",
    "其他",
];
export const state = z.enum([
    "uncontacted",
    "contacted",
    "replied",
    "resume_received",
    "uploaded",
    "declined",
]);
export const leadInput = z
    .object({
    name: text,
    org: text,
    school: z.string().max(300).default(""),
    major: z.string().max(300).default(""),
    skills: z.array(z.string().min(1).max(100)).max(100).default([]),
    direction: text,
    contact: z.string().max(500).default(""),
    source: z.string().trim().min(1).max(300),
    line,
    state: state.default("uncontacted"),
    occurredAt: z.iso.datetime({ offset: true }).optional(),
    followupDate: z.iso.date().optional(),
    ownerId: uuid.optional(),
    note: z.string().max(10000).default(""),
    raw: z.string().max(100000).default(""),
})
    .strict();
export const leadPatch = z
    .object({
    name: text.optional(),
    org: text.optional(),
    school: z.string().max(300).optional(),
    major: z.string().max(300).optional(),
    skills: z.array(z.string().min(1).max(100)).max(100).optional(),
    direction: text.optional(),
    contact: z.string().max(500).optional(),
    source: text.optional(),
    line: line.optional(),
    ownerId: uuid.optional(),
    note: z.string().max(10000).optional(),
    raw: z.string().max(100000).optional(),
    version,
})
    .strict();
export const setupInput = z
    .object({
    targetJob: z.string().trim().min(1).max(300),
    targetJobs: z.array(text).min(1).max(30).optional(),
    lines: z.array(line).min(1).max(3).optional(),
    exclusions: z.array(text).max(30).default([]),
    saveTemplate: z.boolean().default(false),
    line,
    keywords: z.array(text).max(100).default([]),
    sources: z.array(text).max(50).default([]),
    limit: z.number().int().min(1).max(1000).default(30),
    schools: z.array(text).max(100).default([]),
    majors: z.array(text).max(100).default([]),
    skills: z.array(text).max(100).default([]),
    organizations: z.array(text).max(100).default([]),
    regions: z.array(text).max(100).default([]),
    education: z.array(text).max(20).default([]),
    experience: z.string().max(100).default(""),
    notes: z.string().max(5000).default(""),
})
    .strict();
export const filterNames = [
    "org",
    "school",
    "major",
    "skills",
    "direction",
    "source",
    "state",
    "owner_id",
    "contactAvailability",
    "followupAge",
];
const values = z.array(z.string().max(500)).max(100);
export const queryInput = z
    .object({
    line: z.enum(["high", "focus", "social", "all"]).optional(),
    query: z.string().max(500).default(""),
    matchMode: z.enum(["all", "any"]).default("all"),
    deleted: z.boolean().default(false),
    filters: z
        .object({
        org: values.optional(),
        school: values.optional(),
        major: values.optional(),
        skills: values.optional(),
        direction: values.optional(),
        source: values.optional(),
        state: values.optional(),
        owner_id: values.optional(),
        contactAvailability: values.max(1).optional(),
        followupAge: values.max(1).optional(),
    })
        .strict()
        .default({}),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(100).default(25),
})
    .strict();
//# sourceMappingURL=schema.js.map