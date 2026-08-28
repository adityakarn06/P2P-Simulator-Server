import type { Job } from "bullmq";
import { AI_MODEL, getAIProvider } from "../ai/index.js";
import { INVOICE_PROMPT_VERSION, INVOICE_SYSTEM_PROMPT } from "../ai/prompts/invoice.v1.js";
import type { Prisma } from "../generated/prisma/client.js";
import { InvoiceSource, InvoiceStatus } from "../generated/prisma/enums.js";
import { INVOICE_JOBS } from "../queues/invoice.queue.js";
import { enqueueMatching } from "../queues/matching.queue.js";
import { recordAIProcessing } from "../services/aiLog.service.js";
import {
  applyInvoiceExtraction,
  applyInvoiceExtractionFailure,
  claimInvoiceForExtraction,
  countExtractionRetry,
  isExtracted,
  loadInvoiceForProcessing,
} from "../services/invoice.service.js";
import { getStorageProvider } from "../storage/index.js";
import { invoiceJobSchema } from "../types/types.js";
import { AppError, type ErrorCode } from "../utils/AppError.js";
import { type InvoiceExtraction, invoiceExtractionSchema } from "../zod/invoice.schema.js";
import { parseJobData } from "./parseJobData.js";

const JOB_TYPE = INVOICE_JOBS.PROCESS_INVOICE;
const ENTITY_TYPE = "Invoice";

export interface InvoiceProcessingResult {
  invoiceId: string;
  status: InvoiceStatus;
  /** Why the job did no work, when it did none. */
  skippedReason?: string;
}

/**
 * Extracts structured data from an uploaded invoice document.
 *
 * Order is fixed by CLAUDE.md: Cloudinary -> Gemini Vision -> JSON.parse -> Zod
 * -> database. Gemini transcribes what the document says and nothing more; it
 * never reads, recomputes, or writes purchase-order values, and three-way
 * matching — not this worker — decides whether the invoice is payable.
 */
export async function processInvoiceJob(job: Job): Promise<InvoiceProcessingResult> {
  const { invoiceId, organizationId } = parseJobData(invoiceJobSchema, job.data, "invoice");

  const invoice = await loadInvoiceForProcessing({ organizationId, invoiceId });

  // A GENERATED invoice (src/services/invoice.service.ts generateInvoiceForPurchaseOrder)
  // is created straight at EXTRACTED with real totals and never queued in the
  // first place. This guard exists only in case a stray job is ever delivered
  // for one — it must never be sent to Gemini or have matching enqueued for it.
  if (invoice.source === InvoiceSource.GENERATED) {
    return { invoiceId, status: invoice.status, skippedReason: "Generated invoices are not OCR'd" };
  }

  // Idempotency: BullMQ may run a job more than once. Once a document has been
  // read, never send it to Gemini again.
  if (isExtracted(invoice.status)) {
    // Matching is enqueued after the extraction transaction commits, so a Redis
    // failure in that window leaves an extracted invoice with no job behind it.
    // Still being EXTRACTED means matching has not started, so re-enqueuing
    // heals that gap rather than stranding the invoice.
    if (invoice.status === InvoiceStatus.EXTRACTED) {
      await enqueueMatching({ invoiceId, organizationId });
    }

    return { invoiceId, status: invoice.status, skippedReason: "Invoice is already extracted" };
  }

  if (invoice.status === InvoiceStatus.FAILED) {
    // A terminal failure carries an open INVOICE_EXTRACTION_FAILED exception
    // waiting on a human. Re-driving it here would bypass that review.
    return {
      invoiceId,
      status: invoice.status,
      skippedReason: "Invoice extraction already failed",
    };
  }

  const claimed = await claimInvoiceForExtraction({ organizationId, invoiceId });

  // An unclaimed invoice that is already PROCESSING is this job's own earlier
  // attempt, so carry on. Anything else means another actor moved it.
  if (!claimed && invoice.status !== InvoiceStatus.PROCESSING) {
    return {
      invoiceId,
      status: invoice.status,
      skippedReason: `Invoice was ${invoice.status} and could not be claimed`,
    };
  }

  if (!claimed) {
    // Resuming an attempt the claim above could not count, because the invoice
    // was already PROCESSING. Without this the column under-reports every retry.
    await countExtractionRetry({ organizationId, invoiceId });
  }

  const startedAt = Date.now();
  let raw: string;

  try {
    const document = await getStorageProvider().download(
      invoice.filePublicId,
      invoice.fileMimeType,
    );

    raw = await getAIProvider().analyzeDocument({
      systemPrompt: INVOICE_SYSTEM_PROMPT,
      document,
      mimeType: invoice.fileMimeType,
      promptName: INVOICE_PROMPT_VERSION,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Invoice document analysis failed";
    await logAI({ organizationId, invoiceId, startedAt, success: false, error: reason });
    return handleTechnicalFailure(job, { organizationId, invoiceId, reason, error });
  }

  const parsed = safeParseExtraction(raw);

  if (!parsed.ok) {
    await logAI({ organizationId, invoiceId, startedAt, success: false, error: parsed.reason });
    return handleTechnicalFailure(job, {
      organizationId,
      invoiceId,
      reason: parsed.reason,
      error: new Error(parsed.reason),
    });
  }

  await logAI({ organizationId, invoiceId, startedAt, success: true });

  const updated = await applyInvoiceExtraction({
    organizationId,
    invoiceId,
    result: parsed.value,
    raw: parsed.json,
  });

  // Enqueued after the transaction commits, never inside it.
  await enqueueMatching({ invoiceId, organizationId });

  return { invoiceId, status: updated.status };
}

type ParseOutcome =
  | { ok: true; value: InvoiceExtraction; json: Prisma.InputJsonValue }
  | { ok: false; reason: string };

function safeParseExtraction(raw: string): ParseOutcome {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "Gemini returned malformed JSON" };
  }

  const parsed = invoiceExtractionSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `Gemini response failed schema validation: ${parsed.error.issues
        .map((issue) => issue.path.join("."))
        .join(", ")}`,
    };
  }

  // The parsed document is carried out rather than re-parsed by the caller: the
  // schema has already proved it is a JSON object, and parsing the same string
  // twice is pure waste on a large extraction.
  return { ok: true, value: parsed.data, json: json as Prisma.InputJsonValue };
}

/**
 * Error codes that will fail identically on every attempt: the document is
 * missing from storage, or it is not a readable invoice at all. Retrying them
 * only delays the human who has to look at the document.
 *
 * Malformed AI output is deliberately absent — Gemini is non-deterministic, so
 * the next attempt may well parse.
 */
const PERMANENT_ERROR_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "VALIDATION_ERROR",
  "NOT_FOUND",
  // A rejected Gemini request — bad API key, unknown model, malformed request.
  // Distinct from a Gemini *outage*, which stays DEPENDENCY_UNAVAILABLE and
  // keeps its retries. See src/ai/GeminiProvider.ts.
  "AI_PROCESSING_FAILED",
]);

/**
 * Cloudinary outages, Gemini outages and malformed AI output are technical
 * failures, so we let BullMQ retry them. Once the attempts are spent the
 * invoice goes terminal with an exception for a human, rather than sitting in
 * PROCESSING forever.
 *
 * A PERMANENT_ERROR_CODES failure skips the retries and goes terminal at once.
 */
async function handleTechnicalFailure(
  job: Job,
  params: {
    organizationId: string;
    invoiceId: string;
    reason: string;
    error: unknown;
  },
): Promise<InvoiceProcessingResult> {
  const maxAttempts = job.opts.attempts ?? 1;
  const isFinalAttempt = job.attemptsMade + 1 >= maxAttempts;
  const isPermanent =
    params.error instanceof AppError && PERMANENT_ERROR_CODES.has(params.error.code);

  if (!isFinalAttempt && !isPermanent) {
    throw params.error instanceof Error ? params.error : new Error(params.reason);
  }

  console.error(
    `Invoice ${params.invoiceId}: giving up after ${job.attemptsMade + 1} attempt(s) — ${params.reason}`,
  );

  const failed = await applyInvoiceExtractionFailure({
    organizationId: params.organizationId,
    invoiceId: params.invoiceId,
    reason: params.reason,
  });

  return { invoiceId: params.invoiceId, status: failed.status, skippedReason: params.reason };
}

function logAI(params: {
  organizationId: string;
  invoiceId: string;
  startedAt: number;
  success: boolean;
  error?: string;
}): Promise<void> {
  return recordAIProcessing({
    organizationId: params.organizationId,
    entityType: ENTITY_TYPE,
    entityId: params.invoiceId,
    jobType: JOB_TYPE,
    model: AI_MODEL,
    promptVersion: INVOICE_PROMPT_VERSION,
    success: params.success,
    latencyMs: Date.now() - params.startedAt,
    error: params.error ?? null,
  });
}
