import { definitionRefSchema } from '../business-config/bindings.js';
import { z, uuid, version, text } from "../http/validation.js";
const outcome = z.enum(['pending', 'passed', 'failed', 'cancelled', 'no_show']);
const meetingUrl = z.union([z.literal(''), z.url({ protocol: /^https?$/ })]);
export const interviewInput = z
    .object({
    applicationId: uuid,
    round: z.number().int().min(1).max(50),
    startsAt: z.iso.datetime({ offset: true }),
    durationMinutes: z.number().int().min(5).max(480),
    form: text,
    interviewerIds: z.array(uuid).min(1).max(20),
    primaryInterviewerId: uuid.optional(),
    location: z.string().max(1000).default(''),
    meetingUrl: meetingUrl.default(''),
    feedback: z.string().max(10000).default(''),
    status: outcome.default('pending'),
    alsoAdvance: z.boolean().default(false),
    applicationVersion: version.optional(),
    stageConfirmation: z.boolean().default(false),
})
    .strict();
export const interviewPatch = z
    .object({
    version,
    startsAt: z.iso.datetime({ offset: true }).optional(),
    durationMinutes: z.number().int().min(5).max(480).optional(),
    form: text.optional(),
    status: outcome.optional(),
    primaryInterviewerId: uuid.optional(),
    location: z.string().max(1000).optional(),
    meetingUrl: meetingUrl.optional(),
    feedback: z.string().max(10000).optional(),
    interviewerIds: z.array(uuid).min(1).max(20).optional(),
})
    .strict();
export const evaluationData = z
    .object({
    scores: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,99}$/), z.unknown()).refine(v => Object.keys(v).length <= 50).optional(),
    professional: z.unknown().optional(),
    communication: z.unknown().optional(),
    logicalThinking: z.unknown().optional(),
    culturalFit: z.unknown().optional(),
    overallScore: z.unknown().optional(),
    problemSolving: z.unknown().optional(),
    evidenceNotes: z.string().max(10000).optional(),
    projectExperience: z.string().max(10000).optional(),
    motivation: z.string().max(10000).optional(),
    risks: z.string().max(10000).optional(),
    questionCoverage: z.string().max(10000).optional(),
    conclusion: z.enum(["strong_yes", "yes", "hold", "no"]).nullable().optional(),
    summary: z.string().max(10000).optional(),
})
    .strict();
export const evaluationInput = z
    .object({
    version: z.number().int().min(0),
    status: z.enum(["draft", "submitted"]),
    forPrimary: z.boolean().default(false),
    templateRef: definitionRefSchema.optional(),
    data: evaluationData,
})
    .strict();
export const interviewDelete = z.object({ version, restore: z.boolean().default(false) }).strict();
export const interviewQuery = z.object({ deleted: z.boolean().default(false), query: z.string().max(200).default(""), page: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(100).default(25), startsFrom: z.iso.datetime({ offset: true }).optional(), startsBefore: z.iso.datetime({ offset: true }).optional() }).strict().refine(q => (!q.startsFrom && !q.startsBefore) || !!(q.startsFrom && q.startsBefore && new Date(q.startsFrom) < new Date(q.startsBefore)), { message: 'invalid_week_range' });
//# sourceMappingURL=schema.js.map