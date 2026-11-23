import { z, text, version, uuid } from "../http/validation.js";
export const education = z.enum([
    "none",
    "secondary",
    "associate",
    "bachelor",
    "master",
    "doctor",
]);
export const profileInput = z
    .object({
    name: text,
    realName: z.string().trim().max(40).optional(),
    phone: z.string().max(100).default(""),
    email: z.string().max(300).default(""),
    school: z.string().max(300).default(""),
    bachelorSchool: z.string().max(300).default(""),
    companies: z.array(z.string().max(300)).max(100).default([]),
    intent: z.string().max(1000).default(""),
    expectedSalary: z.string().max(1000).default(""),
    age: z.number().min(0).max(120).nullable().default(null),
    gender: z.string().max(100).default(""),
    major: z.string().max(300).default(""),
    education: education.nullable().default(null),
    experienceYears: z.number().min(0).max(80).nullable().default(null),
    firstEmployment: z.string().max(30).nullable().default(null),
    skills: z.array(z.string().min(1).max(100)).max(100).default([]),
    summary: z.string().max(10000).default(""),
    location: z.string().max(300).default(""),
})
    .strict();
export const requirementsInput = z
    .object({
    skills: z.array(z.string().min(1).max(100)).max(100).default([]),
    experienceYears: z.number().min(0).max(80).nullable().default(null),
    experienceMaxYears: z.number().min(0).max(80).nullable().default(null),
    experienceDescription: z.string().max(300).default(""),
    schoolPreferences: z
        .array(z.string().trim().min(1).max(300))
        .max(100)
        .default([]),
    education: education.nullable().default(null),
    description: z.string().max(30000).default(""),
})
    .strict();
// Membership is checked against the currently published dictionary in SQL.
export const jobLevel = z.string().trim().min(1).max(300);
const salaryFields = {
    salaryRange: z.string().max(1000).default(""),
    marketSalary: z.string().max(2000).default(""),
    marketSource: z.string().max(2000).default(""),
    salaryNote: z.string().max(3000).default(""),
    marketReferenceDate: z.string().max(100).default(""),
};
export const jobInput = z
    .object({
    name: text,
    level: jobLevel,
    ...salaryFields,
    department: z.string().max(300).default(""),
    urgency: z.string().trim().min(1).max(300).default("normal"),
    headcount: z.number().int().min(1).max(10000).default(1),
    requirements: requirementsInput.default({
        skills: [],
        experienceYears: null,
        experienceMaxYears: null,
        experienceDescription: "",
        schoolPreferences: [],
        education: null,
        description: "",
    }),
})
    .strict();
export const jobPatch = z
    .object({
    version,
    level: jobLevel.optional(),
    salaryRange: salaryFields.salaryRange.removeDefault().optional(),
    marketSalary: salaryFields.marketSalary.removeDefault().optional(),
    marketSource: salaryFields.marketSource.removeDefault().optional(),
    salaryNote: salaryFields.salaryNote.removeDefault().optional(),
    marketReferenceDate: salaryFields.marketReferenceDate.removeDefault().optional(),
    closeReason: z.string().max(2000).optional(),
    closeConfirm: z.boolean().default(false),
    closePreviewHash: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    name: text.optional(),
    department: z.string().max(300).optional(),
    urgency: z.string().trim().min(1).max(300).optional(),
    headcount: z.number().int().min(1).max(10000).optional(),
    open: z.boolean().optional(),
    requirements: requirementsInput.optional(),
})
    .strict();
export const stage = z.enum([
    "screening",
    "screened",
    "interviewing",
    "collecting",
    "background_check",
    "offered",
    "hired",
    "terminated",
    "rejected",
    "hired_other",
    "on_hold",
    "reserve",
]);
export const applyInput = z
    .object({
    candidateId: uuid,
    startNew: z.boolean().default(false),
    jobId: uuid,
    resumeVersionId: uuid.optional(),
    inboxMatchHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    source: z.string().min(1).max(300).default("手动上传"),
})
    .strict();
export const transitionInput = z
    .object({
    version,
    to: stage,
    confirm: z.boolean().default(false),
    reason: z.string().max(2000).default(""),
    rejectReason: z.string().max(300).default(""),
    rejectDetail: z.string().max(3000).default(""),
    termReason: z.string().max(300).default(""),
    termDetail: z.string().max(3000).default(""),
    opinion: z.string().max(3000).default(""),
    interaction: z.enum(["form", "drag"]).default("form"),
    ccTemplateRef: z.object({ configId: uuid.transform(v => v.toLowerCase()), version }).strict().optional(),
    ccRecipientIds: z.array(uuid.transform(v => v.toLowerCase())).max(50).optional(),
    ccMethod: z
        .enum(["both", "feishu", "email", "oral", "deferred"])
        .optional(),
})
    .strict();
export const ranks = {
    screening: 0,
    screened: 1,
    interviewing: 2,
    collecting: 3,
    background_check: 4,
    offered: 5,
    hired: 6,
};
//# sourceMappingURL=schema.js.map