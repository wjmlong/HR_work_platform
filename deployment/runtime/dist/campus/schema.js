import { z, uuid, version } from "../http/validation.js";
export const regions = [
    "华北",
    "华东",
    "华南",
    "华中",
    "西南",
    "西北",
    "东北",
    "海外",
];
export const tiers = [
    "C9",
    "985",
    "211",
    "双一流",
    "普通本科",
    "科研院所",
    "海外",
];
export const campusStatus = z.enum([
    "unregistered",
    "registered",
    "published",
    "renewal",
    "invalid",
]);
const emptyOr = (schema) => z.union([z.literal(""), schema]);
const date = emptyOr(z.iso.date());
const value = z.string().max(2000);
const change = z.discriminatedUnion("action", [
    z.object({ action: z.literal("keep") }).strict(),
    z.object({ action: z.literal("clear") }).strict(),
    z.object({ action: z.literal("replace"), value }).strict(),
]);
const credentials = z
    .object({ account: change.optional(), password: change.optional() })
    .strict();
const fields = {
    school: z.string().trim().min(1).max(300),
    city: z.string().max(300).default(""),
    region: z.string().max(300).default(""),
    tier: z.string().max(300).default(""),
    url: emptyOr(z.url({ protocol: /^https?$/ })).default(""),
    status: campusStatus.default("unregistered"),
    lastPost: date.default(""),
    note: z.string().max(10000).default(""),
    credentials: credentials.optional(),
};
export const campusInput = z.object(fields).strict();
// Patches preserve omitted fields, including empty old metadata and encrypted values.
export const campusPatch = z
    .object({
    version,
    school: z.string().trim().min(1).max(300).optional(),
    city: z.string().max(300).optional(),
    region: z.string().max(300).optional(),
    tier: z.string().max(300).optional(),
    url: emptyOr(z.url({ protocol: /^https?$/ })).optional(),
    status: campusStatus.optional(),
    lastPost: date.optional(),
    note: z.string().max(10000).optional(),
    credentials: credentials.optional(),
})
    .strict();
export const campusQuery = z
    .object({
    query: z.string().max(300).default(""),
    region: z.string().max(300).optional(),
    tier: z.string().max(300).optional(),
    status: campusStatus.optional(),
    accountSearch: z.boolean().default(false),
    page: z.number().int().positive().default(1),
    pageSize: z.number().int().min(1).max(100).default(25),
    deleted: z.boolean().default(false),
})
    .strict();
export const campusRemove = z
    .object({
    version,
    confirm: z.boolean().default(false),
    restore: z.boolean().default(false),
})
    .strict();
export const campusReveal = z.object({ version }).strict();
export const campusGrant = z
    .object({
    userId: uuid,
    read: z.boolean(),
    write: z.boolean(),
    export: z.boolean(),
})
    .strict();
export const campusExport = z
    .object({
    query: campusQuery.default({
        query: "",
        accountSearch: false,
        page: 1,
        pageSize: 25,
        deleted: false,
    }),
    includeCredentials: z.boolean().default(false),
    confirmation: z.string().default(""),
})
    .strict();
//# sourceMappingURL=schema.js.map