import type { Job } from "bullmq";
import { PaymentStatus } from "../generated/prisma/enums.js";
import { getPaymentProvider } from "../payments/index.js";
import { evaluatePayment, isOverriddenPayment } from "../rules/paymentRules.js";
import { countOpenExceptions } from "../services/exception.service.js";
import {
  applyPaymentCompletion,
  applyPaymentFailure,
  claimPaymentForProcessing,
  loadPaymentContext,
} from "../services/payment.service.js";
import { paymentJobSchema } from "../types/types.js";
import { AppError, type ErrorCode } from "../utils/AppError.js";
import { parseJobData } from "./parseJobData.js";

export interface PaymentResult {
  invoiceId: string;
  status: PaymentStatus | null;
  /** Why the job did no work, when it did none. */
  skippedReason?: string;
}

/**
 * Settles one matched, approved invoice against the simulated provider.
 *
 * Every reason money does or does not move lives in
 * src/rules/paymentRules.ts — this worker loads state, asks, and obeys. A
 * refusal returns normally rather than throwing: an invoice in EXCEPTION, a
 * failed match or an already-settled payment will still be refused on the next
 * attempt, so retrying it would only burn attempts.
 */
export async function processPaymentJob(job: Job): Promise<PaymentResult> {
  const { invoiceId, organizationId } = parseJobData(paymentJobSchema, job.data, "payment");

  const context = await loadPaymentContext({ organizationId, invoiceId });
  const matchStatus = context.threeWayMatch?.status ?? null;
  const openExceptionCount = await countOpenExceptions({ organizationId, entityId: invoiceId });

  const decision = evaluatePayment({
    invoiceStatus: context.status,
    matchStatus,
    paymentStatus: context.payment?.status ?? null,
    openExceptionCount,
  });

  if (!decision.payable) {
    console.log(`Invoice ${invoiceId}: not paying — ${decision.reason}`);
    return {
      invoiceId,
      status: context.payment?.status ?? null,
      skippedReason: decision.reason,
    };
  }

  const claim = await claimPaymentForProcessing({
    organizationId,
    invoiceId,
    purchaseOrder: context.purchaseOrder,
    // The BullMQ job id is stable across this job's retries, so an interrupted
    // attempt can resume its own claim without waiting out the lease.
    claimToken: String(job.id ?? invoiceId),
  });

  // Another worker owns this payment, or it settled between the gate and here.
  if (!claim.claimed) {
    return {
      invoiceId,
      status: context.payment?.status ?? null,
      skippedReason: "Payment is owned by another attempt",
    };
  }

  let providerReference: string;

  try {
    // Deliberately outside any transaction: never hold a database transaction
    // open across an external call.
    ({ providerReference } = await getPaymentProvider().charge({
      idempotencyKey: invoiceId,
      amountPaise: claim.amountPaise,
      currency: claim.currency,
      reference: context.invoiceNumber ?? context.purchaseOrder.poNumber,
    }));
  } catch (error) {
    return handleTechnicalFailure(job, { organizationId, invoiceId, error });
  }

  const completed = await applyPaymentCompletion({
    organizationId,
    invoiceId,
    providerReference,
    // Recorded on the audit row so a settled-despite-mismatch invoice is
    // greppable later, rather than looking like an ordinary clean payment.
    overriddenMatch: isOverriddenPayment(matchStatus),
  });

  if (!completed) {
    return {
      invoiceId,
      status: PaymentStatus.COMPLETED,
      skippedReason: "Payment was already settled by another attempt",
    };
  }

  return { invoiceId, status: PaymentStatus.COMPLETED };
}

/**
 * A rejected charge — a malformed amount, a provider that refuses outright —
 * will fail the same way every time, so it goes terminal immediately. Transport
 * failures get BullMQ's retries first.
 */
const PERMANENT_ERROR_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "VALIDATION_ERROR",
  "PAYMENT_BLOCKED",
]);

async function handleTechnicalFailure(
  job: Job,
  params: { organizationId: string; invoiceId: string; error: unknown },
): Promise<PaymentResult> {
  const { organizationId, invoiceId, error } = params;
  const reason = error instanceof Error ? error.message : "Payment failed";
  const maxAttempts = job.opts.attempts ?? 1;
  const isFinalAttempt = job.attemptsMade + 1 >= maxAttempts;
  const isPermanent = error instanceof AppError && PERMANENT_ERROR_CODES.has(error.code);

  if (!isFinalAttempt && !isPermanent) {
    // Rethrowing leaves the payment PROCESSING; the next attempt reclaims it.
    throw error instanceof Error ? error : new Error(reason);
  }

  console.error(
    `Invoice ${invoiceId}: payment gave up after ${job.attemptsMade + 1} attempt(s) — ${reason}`,
  );

  await applyPaymentFailure({ organizationId, invoiceId, reason });

  return { invoiceId, status: PaymentStatus.FAILED, skippedReason: reason };
}
