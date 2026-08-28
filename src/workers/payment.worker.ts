import type { Job } from "bullmq";
import { InvoiceStatus, PaymentStatus } from "../generated/prisma/enums.js";
import { getPaymentProvider } from "../payments/index.js";
import { evaluatePayment, isOverBilling, isOverriddenPayment } from "../rules/paymentRules.js";
import { countOpenExceptions } from "../services/exception.service.js";
import {
  applyPaymentCompletion,
  applyPaymentFailure,
  claimPaymentForProcessing,
  hasSettledSiblingInvoice,
  loadPaymentContext,
  loadSettlementLedger,
  recordDuplicatePurchaseOrderPayment,
} from "../services/payment.service.js";
import { paymentJobSchema } from "../types/types.js";
import { AppError, type ErrorCode } from "../utils/AppError.js";
import { parseJobData } from "./parseJobData.js";

export interface PaymentResult {
  invoiceId: string;
  status: PaymentStatus | null;
  /** Which tranche of the invoice this job was settling. */
  settlementKey: string;
  /** What actually moved, in paise. Absent when the job did no work. */
  amountPaise?: number;
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
  const { invoiceId, organizationId, settlementKey, amountPaise, authorization } = parseJobData(
    paymentJobSchema,
    job.data,
    "payment",
  );

  const context = await loadPaymentContext({ organizationId, invoiceId });
  const matchStatus = context.threeWayMatch?.status ?? null;
  const tranche = context.payments.find((row) => row.settlementKey === settlementKey) ?? null;

  // Independent reads — run them together rather than one after the other.
  const [openExceptionCount, ledger] = await Promise.all([
    countOpenExceptions({ organizationId, entityId: invoiceId }),
    loadSettlementLedger({
      organizationId,
      invoiceId,
      invoiceTotalPaise: context.totalPaise,
      purchaseOrderId: context.purchaseOrder.id,
      purchaseOrderTotalPaise: context.purchaseOrder.totalPaise,
    }),
  ]);

  const decision = evaluatePayment({
    invoiceStatus: context.status,
    matchStatus,
    paymentStatus: tranche?.status ?? null,
    openExceptionCount,
    ledger,
    requestedAmountPaise: amountPaise ?? null,
  });

  if (!decision.payable) {
    console.log(`Invoice ${invoiceId} (${settlementKey}): not paying — ${decision.reason}`);

    // A spent purchase order is the one refusal a human has to see: a second
    // document was raised against an order whose committed budget is gone.
    // Every other reason here is already visible in the invoice's own status.
    //
    // The sibling check is what makes it a *duplicate* rather than an ordinary
    // settled order. An order can be fully spent by this invoice's own
    // tranches, and raising a CRITICAL exception on the invoice that was
    // correctly paid — then blocking its remaining rows — would be a false
    // alarm. Only another document having taken the money is news.
    if (isOverBilling(ledger) && isReleasedForPayment(context.status)) {
      const settledElsewhere = await hasSettledSiblingInvoice({
        organizationId,
        invoiceId,
        purchaseOrderId: context.purchaseOrder.id,
      });

      if (settledElsewhere) {
        await recordDuplicatePurchaseOrderPayment({
          organizationId,
          invoiceId,
          purchaseOrderId: context.purchaseOrder.id,
          poNumber: context.purchaseOrder.poNumber,
          reason: decision.reason,
        });
      }
    }

    return {
      invoiceId,
      settlementKey,
      status: tranche?.status ?? null,
      skippedReason: decision.reason,
    };
  }

  const claim = await claimPaymentForProcessing({
    organizationId,
    invoiceId,
    settlementKey,
    purchaseOrder: context.purchaseOrder,
    invoiceTotalPaise: context.totalPaise,
    amountPaise: decision.amountPaise,
    kind: decision.kind,
    authorization: authorization ?? null,
    // The BullMQ job id is stable across this job's retries, so an interrupted
    // attempt can resume its own claim without waiting out the lease.
    claimToken: String(job.id ?? `${invoiceId}-${settlementKey}`),
  });

  // Another worker owns this tranche, it settled between the gate and here, or
  // a concurrent tranche spent the order's remaining balance in between.
  if (!claim.claimed) {
    return {
      invoiceId,
      settlementKey,
      status: tranche?.status ?? null,
      skippedReason: claim.reason ?? "Payment is owned by another attempt",
    };
  }

  let providerReference: string;

  try {
    // Deliberately outside any transaction: never hold a database transaction
    // open across an external call.
    ({ providerReference } = await getPaymentProvider().charge({
      // Keyed on the tranche, not the invoice: an invoice settled in two
      // instalments makes two genuinely distinct charges, and a provider that
      // honours idempotency keys must not collapse them into one.
      idempotencyKey: `${invoiceId}:${settlementKey}`,
      amountPaise: claim.amountPaise,
      currency: claim.currency,
      reference: context.invoiceNumber ?? context.purchaseOrder.poNumber,
    }));
  } catch (error) {
    return handleTechnicalFailure(job, { organizationId, invoiceId, settlementKey, error });
  }

  const completed = await applyPaymentCompletion({
    organizationId,
    invoiceId,
    settlementKey,
    providerReference,
    // Recorded on the audit row so a settled-despite-mismatch invoice is
    // greppable later, rather than looking like an ordinary clean payment.
    overriddenMatch: isOverriddenPayment(matchStatus),
  });

  if (!completed) {
    return {
      invoiceId,
      settlementKey,
      status: PaymentStatus.COMPLETED,
      skippedReason: "Payment was already settled by another attempt",
    };
  }

  return {
    invoiceId,
    settlementKey,
    status: PaymentStatus.COMPLETED,
    amountPaise: claim.amountPaise,
  };
}

/** An invoice a human or a clean match has released — the states money can move from. */
function isReleasedForPayment(status: InvoiceStatus): boolean {
  return status === InvoiceStatus.APPROVED || status === InvoiceStatus.PARTIALLY_PAID;
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
  params: { organizationId: string; invoiceId: string; settlementKey: string; error: unknown },
): Promise<PaymentResult> {
  const { organizationId, invoiceId, settlementKey, error } = params;
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

  await applyPaymentFailure({ organizationId, invoiceId, settlementKey, reason });

  return { invoiceId, settlementKey, status: PaymentStatus.FAILED, skippedReason: reason };
}
