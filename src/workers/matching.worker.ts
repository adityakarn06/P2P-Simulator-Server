import type { Job } from "bullmq";
import { InvoiceSource, InvoiceStatus, MatchStatus } from "../generated/prisma/enums.js";
import { enqueuePayment } from "../queues/payment.queue.js";
import { threeWayMatch } from "../rules/threeWayMatch.js";
import { evaluateInvoice } from "../services/anomaly.service.js";
import {
  applyMatchResult,
  claimInvoiceForMatching,
  loadMatchingContext,
  loadPriorInvoices,
  recordMatchingSystemFailure,
  toMatchInput,
} from "../services/matching.service.js";
import { matchingJobSchema } from "../types/types.js";
import { AppError, type ErrorCode } from "../utils/AppError.js";
import { parseJobData } from "./parseJobData.js";

export interface MatchingResult {
  invoiceId: string;
  status: MatchStatus | null;
  /** Why the job did no work, when it did none. */
  skippedReason?: string;
}

/**
 * Runs three-way matching for one extracted invoice.
 *
 * The verdict comes entirely from src/rules/threeWayMatch.ts — deterministic
 * TypeScript, no Gemini anywhere in this path (CLAUDE.md §9). This worker only
 * loads state, hands it to the rule module, persists what came back, and queues
 * payment when — and only when — the match passed.
 *
 * A MISMATCHED verdict is a business outcome, not an error: it returns normally
 * so BullMQ never retries a decision that cannot change.
 */
export async function processMatchingJob(job: Job): Promise<MatchingResult> {
  // Same as every other worker: a malformed payload is terminal, and it belongs
  // in BullMQ's failed set. Returning a "skipped" result here instead would
  // report the job as completed and put the *job id* in the invoiceId field,
  // naming an entity that does not exist.
  const { invoiceId, organizationId } = parseJobData(matchingJobSchema, job.data, "matching");

  try {
    const context = await loadMatchingContext({ organizationId, invoiceId });

    // Same guard as the invoice worker: a GENERATED invoice never enters
    // matching. Nothing enqueues one, but a stray job must still no-op.
    if (context.source === InvoiceSource.GENERATED) {
      return {
        invoiceId,
        status: null,
        skippedReason: "Generated invoices are not matched",
      };
    }

    // Idempotency: a match already exists, so this is a re-delivery.
    if (context.threeWayMatch) {
      const existing = context.threeWayMatch.status;

      // Payment is enqueued after the match transaction commits, so a Redis
      // failure in that window leaves an approved invoice with no job behind
      // it. A MATCHED invoice sitting at APPROVED with no payment row can only
      // be that gap, so re-enqueuing heals it rather than stranding the money.
      if (
        existing === MatchStatus.MATCHED &&
        context.status === InvoiceStatus.APPROVED &&
        !context.payment
      ) {
        await enqueuePayment({ invoiceId, organizationId });
      }

      return {
        invoiceId,
        status: existing,
        skippedReason: `Invoice has already been matched (${existing})`,
      };
    }

    const claimed = await claimInvoiceForMatching({ organizationId, invoiceId });

    if (!claimed) {
      return {
        invoiceId,
        status: null,
        skippedReason: `Invoice was ${context.status} and could not be claimed for matching`,
      };
    }

    const priorInvoices = await loadPriorInvoices({
      organizationId,
      invoiceId,
      invoiceNumber: context.invoiceNumber,
    });

    const result = threeWayMatch(toMatchInput(context, priorInvoices));

    const status = await applyMatchResult({
      organizationId,
      invoiceId,
      purchaseOrder: context.purchaseOrder,
      goodsReceiptId: context.purchaseOrder.shipment?.goodsReceipt?.id ?? null,
      result,
    });

    // Advisory only, and deliberately after the verdict is persisted: an
    // anomaly signal can never change a match or block a payment. Run before
    // the payment enqueue purely so a buyer looking at a just-paid invoice
    // already sees whatever the history had to say about it.
    await evaluateInvoice({ organizationId, invoiceId });

    // Enqueued after the transaction commits, never inside it — and never at
    // all for a mismatch, whose payment row is already BLOCKED.
    if (status === MatchStatus.MATCHED) {
      await enqueuePayment({ invoiceId, organizationId });
    }

    return { invoiceId, status };
  } catch (error) {
    return handleTechnicalFailure(job, { organizationId, invoiceId, error });
  }
}

/**
 * Error codes that will fail identically on every attempt — a missing invoice,
 * or a payload that will never parse. Retrying them only delays the human who
 * has to look. Everything else (DB blips, Redis hiccups) is worth another
 * attempt. CONFLICT is absent deliberately: it is not a failure at all, and is
 * handled ahead of this set.
 */
const PERMANENT_ERROR_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "VALIDATION_ERROR",
  "NOT_FOUND",
]);

async function handleTechnicalFailure(
  job: Job,
  params: { organizationId: string; invoiceId: string; error: unknown },
): Promise<MatchingResult> {
  const { organizationId, invoiceId, error } = params;
  const reason = error instanceof Error ? error.message : "Three-way matching failed";

  // A CONFLICT means another attempt already matched this invoice — that is a
  // successful outcome for the workflow, so it must not raise an exception.
  if (error instanceof AppError && error.code === "CONFLICT") {
    return { invoiceId, status: null, skippedReason: reason };
  }

  const maxAttempts = job.opts.attempts ?? 1;
  const isFinalAttempt = job.attemptsMade + 1 >= maxAttempts;
  const isPermanent = error instanceof AppError && PERMANENT_ERROR_CODES.has(error.code);

  if (!isFinalAttempt && !isPermanent) {
    throw error instanceof Error ? error : new Error(reason);
  }

  console.error(
    `Invoice ${invoiceId}: matching gave up after ${job.attemptsMade + 1} attempt(s) — ${reason}`,
  );

  await recordMatchingSystemFailure({ organizationId, invoiceId, reason });

  return { invoiceId, status: null, skippedReason: reason };
}
