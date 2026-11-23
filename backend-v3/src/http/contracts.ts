import {reportSettings,reportQuery} from '../dashboard/report.js';
import {learningQuestion,bankRequest} from '../materials/job-questions.js';
import {evaluationUpgradePreview,evaluationUpgradeAdopt} from '../business-config/evaluation-versions.js';
import {checklistOpen,checklistItemUpdate,checklistUpgradePreview,checklistUpgradeAdopt} from '../recruiting/checklists.js';
import {checklistStage} from '../business-config/checklist-template.js';
import {selectionPurpose,selectionPreviewRequest,selectionAdoptRequest} from '../business-config/selections.js';
import {questionGenerationRequest} from '../materials/service.js';
import {bindingPreviewRequest,bindingAdoptRequest} from '../business-config/bindings.js';
import {
  mergePreviewInput,
  mergeInput,
  reparseApplyInput,
  ledgerInput,
} from "../recruiting/tools.js";
import { copyInput, copyApply } from "../operations/copies.js";
import { copyExport, copyQuery } from "../operations/copy-routes.js";
import {
  campusInput,
  campusPatch,
  campusQuery,
  campusRemove,
  campusGrant,
  campusExport,
  campusReveal,
} from "../campus/schema.js";
import { z, uuid, version } from "./validation.js";
import {
  leadInput,
  leadPatch,
  setupInput,
  queryInput,
} from "../sourcing/schema.js";
import {
  leadTransitionRequest,
  leadFollowupRequest,
} from "../sourcing/service.js";
import {
  leadDeleteRequest,
  leadExportRequest,
  dictionaryRequest,
} from "../sourcing/routes.js";
import {
  jobInput,
  jobPatch,
  profileInput,
  applyInput,
  transitionInput,
} from "../recruiting/schema.js";
import {
  candidateEditRequest,
  archiveCandidateRequest,
  transferRequest,
  useResumeRequest,
  candidatesRequest,
  applicationsRequest,
  deleteRequest,
  transferPreviewRequest,
  collectionCompletionRequest,
} from "../recruiting/service.js";
import { dashboardRequest } from "../dashboard/service.js";
import { closeJobRequest, salaryGrantRequest } from "../recruiting/jobs.js";
import { interviewerReviewRequest } from "../interviewer-review/service.js";
import {
  memberRequest,
  callbackRequest,
  assignmentQuery,
} from "../identity/routes.js";
import {
  supplyTextRequest,
  duplicateRequest,
  correctionRequest,
  tasksQuery,
} from "../tasks/service.js";
import { uploadTextRequest } from "../tasks/routes.js";
import {
  interviewInput,
  interviewPatch,
  evaluationInput,
  interviewQuery,interviewDelete,
} from "../interviews/schema.js";
import { editQuestionsRequest, concludeRequest } from "../materials/service.js";
import {
  statisticsRequest,
  protocolRequest,
  sampleRequest,
} from "../statistics/service.js";
import { auditRequest, grantsRequest } from "../admin/routes.js";
import {draftRequest,publishRequest} from '../business-config/schema.js';
import {configuredQueryRequest,configuredExportRequest} from '../business-config/query-routes.js';
import {fieldQuerySchema} from '../business-config/query.js';
import {viewRequest} from '../business-config/views.js';
import {configuredProperties,applicationFieldsRequest} from '../business-config/recruiting.js';
import {salaryScope,salaryApply} from '../business-config/salary-migration.js';
const bodies: Record<string, z.ZodType> = {
 'POST /api/v4/applications/:id/checklists/open':checklistOpen,
 'PATCH /api/v4/applications/:id/checklist-items/:itemId':checklistItemUpdate,
 'POST /api/v4/applications/:id/checklists/:stage/upgrade-preview':checklistUpgradePreview,
 'POST /api/v4/business-config/checklists/adopt':checklistUpgradeAdopt,
 'POST /api/v4/interviews/:id/evaluation-template/preview':evaluationUpgradePreview,
 'POST /api/v4/business-config/evaluations/adopt':evaluationUpgradeAdopt,
 'POST /api/v4/business-config/templates/preview':selectionPreviewRequest,
 'POST /api/v4/business-config/templates/adopt':selectionAdoptRequest,
 'POST /api/v4/applications/:id/questions':questionGenerationRequest,
 'POST /api/v4/jobs/:id/question-bank':bankRequest,
 'POST /api/v4/jobs/:id/question-bank/learn':learningQuestion,
 'POST /api/v4/dashboard/report/query':reportQuery,
 'PUT /api/v4/dashboard/preferences':reportSettings,
 'POST /api/v4/business-config/bindings/preview':bindingPreviewRequest,
 'POST /api/v4/business-config/bindings/adopt':bindingAdoptRequest,
 'POST /api/v4/business-config/objects/:kind/:id/history/export':z.object({}).strict(),
 'POST /api/v4/business-config/:kind/query':fieldQuerySchema,
 'POST /api/v4/business-config/:kind/export':z.object({scope:z.enum(['filtered','all']),query:fieldQuerySchema}).strict(),
 'POST /api/v4/applications/export':z.object({scope:z.enum(['filtered','all']),query:fieldQuerySchema}).strict(),
 'POST /api/v4/interviews/export':z.object({scope:z.enum(['filtered','all']),query:fieldQuerySchema}).strict(),
 'POST /api/v4/jobs/query':fieldQuerySchema,
 'POST /api/v4/jobs/export':z.object({scope:z.enum(['filtered','all']),query:fieldQuerySchema}).strict(),
 'POST /api/v4/views':viewRequest,
 'POST /api/v4/views/:id/delete':z.object({version}).strict(),
  'PATCH /api/v4/applications/:id/fields':applicationFieldsRequest,
  'POST /api/v4/business-config/salary/preview':salaryScope,
  'POST /api/v4/business-config/salary/apply':salaryApply,
  'POST /api/v4/business-config/drafts':draftRequest,
  'PATCH /api/v4/business-config/drafts/:id':draftRequest.omit({draftId:true}),
  'POST /api/v4/business-config/drafts/:id/preview':z.object({}).strict(),
  'POST /api/v4/business-config/drafts/:id/publish':publishRequest.extend({affected:z.number().int().nonnegative().optional(),analysis:z.unknown().optional()}),
  "POST /api/v4/admin/backups/preview": copyInput,
  "POST /api/v4/admin/backups/apply": copyApply,
  "POST /api/v4/admin/backups/query": copyQuery,
  "POST /api/v4/admin/backups/export": copyExport,
  "POST /api/v4/candidates/tools/merge-preview": mergePreviewInput,
  "POST /api/v4/candidates/tools/merge": mergeInput,
  "POST /api/v4/candidates/tools/reparse-apply": reparseApplyInput,
  "POST /api/v4/candidates/ledger/export": ledgerInput,
  "POST /api/v4/campus": campusInput.extend(configuredProperties),
  "PATCH /api/v4/campus/:id": campusPatch.extend(configuredProperties),
  "POST /api/v4/campus/query": z.union([campusQuery,configuredQueryRequest]),
  "POST /api/v4/campus/:id/delete": campusRemove,
  "POST /api/v4/campus/:id/reveal": campusReveal,
  "PUT /api/v4/campus/grants": campusGrant,
  "POST /api/v4/campus/export": z.union([campusExport,configuredExportRequest]),
  "PATCH /api/v4/members/:id": memberRequest,
  "PUT /api/v4/sourcing/setup": setupInput,
  "POST /api/v4/leads/query": z.union([queryInput,configuredQueryRequest]),
  "POST /api/v4/leads": leadInput.extend(configuredProperties),
  "PATCH /api/v4/leads/:id": leadPatch.extend(configuredProperties),
  "POST /api/v4/leads/:id/transition": leadTransitionRequest,
  "POST /api/v4/leads/:id/followups": leadFollowupRequest,
  "POST /api/v4/leads/:id/delete": leadDeleteRequest,
  "POST /api/v4/leads/metrics": queryInput,
  "POST /api/v4/leads/export": z.union([leadExportRequest,configuredExportRequest]),
  "PUT /api/v4/dictionary": dictionaryRequest,
  "POST /api/v4/jobs": jobInput.extend(configuredProperties),
  "PATCH /api/v4/jobs/:id": jobPatch.extend(configuredProperties),
  "POST /api/v4/jobs/:id/close-preview": closeJobRequest,
  "PUT /api/v4/jobs/:id/salary-grants": salaryGrantRequest,
  "POST /api/v4/candidates": profileInput.extend(configuredProperties),
  "POST /api/v4/candidates/query": candidatesRequest,
  "PATCH /api/v4/candidates/:id": candidateEditRequest.extend(configuredProperties),
  "POST /api/v4/candidates/:id/delete": deleteRequest,
  "POST /api/v4/candidates/:id/archive": archiveCandidateRequest,
  "POST /api/v4/applications/:id/delete": deleteRequest,
  "POST /api/v4/resumes/:id/corrections": correctionRequest,
  "POST /api/v4/applications": applyInput.extend(configuredProperties),
  "POST /api/v4/applications/query": z.union([applicationsRequest,configuredQueryRequest]),
  "POST /api/v4/applications/:id/transition": transitionInput,
  "POST /api/v4/applications/:id/transfer": transferRequest,
  "POST /api/v4/applications/:id/transfer-preview": transferPreviewRequest,
  "POST /api/v4/applications/:id/collection-completion":
    collectionCompletionRequest,
  "POST /api/v4/dashboard/query": dashboardRequest,
  "POST /api/v4/applications/:id/resume": useResumeRequest,
  "POST /api/v4/uploads/text": uploadTextRequest,
  "POST /api/v4/tasks/query": tasksQuery,
  "POST /api/v4/interviews/:id/delete":interviewDelete,
  "POST /api/v4/interviews/query": z.union([interviewQuery,configuredQueryRequest]),
  "POST /api/v4/interviewer-review/query": interviewerReviewRequest,
  "POST /api/v4/interviewer-review/cohorts/export": interviewerReviewRequest,
  "POST /api/v4/interviewer-review/export": interviewerReviewRequest,
  "POST /api/v4/tasks/:id/text": supplyTextRequest,
  "POST /api/v4/tasks/:id/duplicate": duplicateRequest,
  "POST /api/v4/interviews": interviewInput.extend(configuredProperties),
  "PATCH /api/v4/interviews/:id": interviewPatch.extend(configuredProperties),
  "PUT /api/v4/interviews/:id/evaluation": evaluationInput.extend(configuredProperties),
  "PATCH /api/v4/questions/:id": editQuestionsRequest,
  "POST /api/v4/briefs/:id/conclusion": concludeRequest,
  "POST /api/v4/statistics/query": statisticsRequest,
  "POST /api/v4/measurements/protocols": protocolRequest,
  "POST /api/v4/measurements/samples": sampleRequest,
  "POST /api/v4/admin/audit/query": auditRequest,
  "PUT /api/v4/applications/:id/grants": grantsRequest,
};
const json = (s: z.ZodType) => {
  const result = z.toJSONSchema(s, { target: "draft-7", io: "input" });
  delete result.$schema;
  return result;
};
export function contract(method: string, url: string): Record<string, any> {
  if (!url.startsWith("/api/v4/") || url === "/api/v4/openapi.json") return {};
  const schema: Record<string, any> = {
    summary: method + " " + url,
    tags: [url.split("/")[3]],
    security: [{ session: [] }],
  };
  if (url.includes(":id"))
    schema.params = json(
      url.includes(":version")
        ? z
            .object({
              id: uuid,
              version: z.string().regex(/^[1-9][0-9]{0,8}$/),
            })
            .strict()
        : z.object({ id: uuid }).strict(),
    );
  if(url.startsWith('/api/v4/interviews/:id/assistant/:sessionId'))schema.params=json(z.object({id:uuid,sessionId:uuid}).strict());
  if(url==='/api/v4/business-config/templates/job/:id/:purpose')schema.params=json(z.object({id:uuid,purpose:selectionPurpose}).strict());
  if(url==='/api/v4/applications/:id/checklist-items/:itemId')schema.params=json(z.object({id:uuid,itemId:uuid}).strict());
  if(url==='/api/v4/applications/:id/checklists/:stage/upgrade-preview')schema.params=json(z.object({id:uuid,stage:checklistStage}).strict());
  if(url==='/api/v4/applications/:id/cc-options')schema.querystring=json(z.object({stage:checklistStage,jobId:uuid.optional()}).strict());
  if(url.startsWith('/api/v4/business-config/objects/:kind/:id'))schema.params=json(z.object({kind:z.enum(['job','resume','application','interview','evaluation','lead','campus']),id:uuid}).strict());
  if(method==='GET'&&url==='/api/v4/interviews/:id/evaluation-template')schema.querystring=json(z.object({forPrimary:z.enum(['true','false']).optional()}).strict());
  if(method==='GET'&&url==='/api/v4/views')schema.querystring=json(z.object({entity:z.enum(['job','resume','application','interview','evaluation','lead','campus'])}).strict());
  if (url === "/api/v4/assignment-members")
    schema.querystring = json(assignmentQuery);
  if (url === "/api/v4/auth/feishu/callback")
    schema.querystring = json(callbackRequest);
  const body = bodies[method + " " + url];
  if (body) schema.body = json(body);
  if (
    !url.endsWith("/export") &&
    !url.endsWith("/file") &&
    !url.includes("/feishu/")
  )
    schema.response = {
      200: {
        type: "object",
        required: ["data", "meta"],
        properties: {
          data: {},
          meta: {
            type: "object",
            required: ["requestId"],
            properties: { requestId: { type: "string" } },
          },
        },
      },
    };
  if (url.startsWith("/api/v4/auth/")) schema.security = [];
  return schema;
}
