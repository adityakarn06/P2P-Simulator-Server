import type { Job } from "bullmq";
import { AI_MODEL, getAIProvider } from "../ai/index.js";
import {
  buildRequisitionUserPrompt,
  type ConversationTurn,
  REQUISITION_PROMPT_VERSION,
  REQUISITION_SYSTEM_PROMPT,
} from "../ai/prompts/requisition.v1.js";
import { prisma } from "../config/prisma.js";
import { ExceptionType, Severity } from "../generated/prisma/enums.js";
import { REQUISITION_JOBS } from "../queues/requisition.queue.js";
import { enqueueSupplierDiscovery } from "../queues/supplier.queue.js";
import { recordAIProcessing } from "../services/aiLog.service.js";
import { REQUISITION_ENTITY } from "../services/audit.service.js";
import { recordException } from "../services/exception.service.js";
import {
  applyExtractionResult,
  applyFallbackClarification,
  loadRequisitionForProcessing,
  type RequisitionChatResult,
} from "../services/requisition.service.js";
import { requisitionJobSchema } from "../types/types.js";
import { AppError, type ErrorCode } from "../utils/AppError.js";
import { extractionResultSchema, parseDraft } from "../zod/requisition.schema.js";
import { parseJobData } from "./parseJobData.js";

const JOB_TYPE = REQUISITION_JOBS.EXTRACT_REQUIREMENTS;
const ENTITY_TYPE = "Requisition";

/**
 * Extracts procurement requirements from a conversational requisition.
 *
 * Order is fixed by CLAUDE.md: Gemini -> JSON.parse -> Zod -> deterministic
 * completeness checks -> database. Gemini never decides whether procurement
 * can start; src/rules/requirementRules.ts does.
 */
export async function processRequisitionJob(job: Job): Promise<RequisitionChatResult> {
  const { requisitionId, organizationId } = parseJobData(
    requisitionJobSchema,
    job.data,
    "requisition",
  );

  const requisition = await loadRequisitionForProcessing({ organizationId, requisitionId });

  // Idempotency: BullMQ may run a job more than once. Once requirements are
  // extracted the conversation is closed — never call Gemini again.
  if (requisition.status === "REQUIREMENTS_EXTRACTED") {
    // Discovery is enqueued after the extraction transaction commits, so a
    // Redis failure in that window leaves extracted requirements with no job
    // behind them. Still being REQUIREMENTS_EXTRACTED means discovery has not
    // completed, so re-enqueuing here heals that gap rather than returning
    // early and stranding the requisition.
    await enqueueSupplierDiscovery({ requisitionId, organizationId });

    return {
      requisitionId,
      status: "REQUIREMENTS_EXTRACTED",
      message: requisition.clarificationMessage ?? "Requirements already extracted.",
      missingFields: [],
      conflicts: [],
      requirements: null,
    };
  }

  const draft = parseDraft(requisition.draftRequirements);
  const history: ConversationTurn[] = requisition.messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
  const latestInput = history.at(-1)?.content ?? requisition.rawInput;

  const startedAt = Date.now();
  let raw: string;

  try {
    raw = await getAIProvider().generateStructured({
      systemPrompt: REQUISITION_SYSTEM_PROMPT,
      userPrompt: buildRequisitionUserPrompt({ draft, history, latestInput }),
      promptName: REQUISITION_PROMPT_VERSION,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Gemini request failed";
    await logAI({ organizationId, requisitionId, startedAt, success: false, error: reason });
    return handleTechnicalFailure(job, { organizationId, requisitionId, draft, reason, error });
  }

  const parsed = safeParseExtraction(raw);

  if (!parsed.ok) {
    await logAI({ organizationId, requisitionId, startedAt, success: false, error: parsed.reason });
    return handleTechnicalFailure(job, {
      organizationId,
      requisitionId,
      draft,
      reason: parsed.reason,
      error: new Error(parsed.reason),
    });
  }

  await logAI({ organizationId, requisitionId, startedAt, success: true });

  const outcome = await applyExtractionResult({
    organizationId,
    requisitionId,
    previousDraft: draft,
    result: parsed.value,
  });

  // Enqueued after the transaction commits, never inside it.
  if (outcome.status === "REQUIREMENTS_EXTRACTED") {
    await enqueueSupplierDiscovery({ requisitionId, organizationId });
  }

  return outcome;
}

type ParseOutcome =
  | { ok: true; value: ReturnType<typeof extractionResultSchema.parse> }
  | { ok: false; reason: string };

function safeParseExtraction(raw: string): ParseOutcome {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "Gemini returned malformed JSON" };
  }

  const parsed = extractionResultSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `Gemini response failed schema validation: ${parsed.error.issues
        .map((issue) => issue.path.join("."))
        .join(", ")}`,
    };
  }

  return { ok: true, value: parsed.data };
}

/**
 * A rejected Gemini request — bad API key, unknown model, malformed request —
 * fails identically on every attempt, so it skips the retries rather than
 * burning three of them rediscovering that.
 */
const PERMANENT_ERROR_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "VALIDATION_ERROR",
  "AI_PROCESSING_FAILED",
]);

/**
 * Malformed AI output and Gemini outages are technical failures, so we let
 * BullMQ retry them. Once the attempts are spent — or immediately, for a
 * permanent error — we degrade to a deterministic clarification instead of
 * leaving the conversation stuck in PROCESSING.
 *
 * The clarification alone would be misleading, though: a systemic failure (a
 * revoked GEMINI_API_KEY, a retired model) would silently tell every user in a
 * row to reword a request that was perfectly clear, with nothing anywhere for an
 * operator to notice. So giving up also raises a SYSTEM_FAILURE exception, the
 * same way the supplier-discovery and purchase-order workers do.
 */
async function handleTechnicalFailure(
  job: Job,
  params: {
    organizationId: string;
    requisitionId: string;
    draft: ReturnType<typeof parseDraft>;
    reason: string;
    error: unknown;
  },
): Promise<RequisitionChatResult> {
  const maxAttempts = job.opts.attempts ?? 1;
  const isFinalAttempt = job.attemptsMade + 1 >= maxAttempts;
  const isPermanent =
    params.error instanceof AppError && PERMANENT_ERROR_CODES.has(params.error.code);

  if (!isFinalAttempt && !isPermanent) {
    throw params.error instanceof Error ? params.error : new Error(params.reason);
  }

  console.error(
    `Requisition ${params.requisitionId}: giving up after ${job.attemptsMade + 1} attempt(s) — ${params.reason}`,
  );

  // Idempotent: recordException upserts on
  // @@unique([organizationId, type, entityId]), so a redelivered job cannot
  // stack duplicates for one requisition.
  await recordException(prisma, {
    organizationId: params.organizationId,
    type: ExceptionType.SYSTEM_FAILURE,
    severity: Severity.CRITICAL,
    entityType: REQUISITION_ENTITY,
    entityId: params.requisitionId,
    title: "Requirement extraction failed",
    description: params.reason,
    metadata: { attempts: job.attemptsMade + 1, permanent: isPermanent },
  });

  return applyFallbackClarification({
    organizationId: params.organizationId,
    requisitionId: params.requisitionId,
    draft: params.draft,
    reason: params.reason,
  });
}

function logAI(params: {
  organizationId: string;
  requisitionId: string;
  startedAt: number;
  success: boolean;
  error?: string;
}): Promise<void> {
  return recordAIProcessing({
    organizationId: params.organizationId,
    entityType: ENTITY_TYPE,
    entityId: params.requisitionId,
    jobType: JOB_TYPE,
    model: AI_MODEL,
    promptVersion: REQUISITION_PROMPT_VERSION,
    success: params.success,
    latencyMs: Date.now() - params.startedAt,
    error: params.error ?? null,
  });
}
