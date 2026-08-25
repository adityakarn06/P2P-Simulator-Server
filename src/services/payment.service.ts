import { prisma } from "../config/prisma.js";
import type { Prisma } from "../generated/prisma/client.js";
import {
  ExceptionType,
  InvoiceStatus,
  PaymentStatus,
  Severity,
} from "../generated/prisma/enums.js";
import { PAYMENT_PROVIDER_NAME } from "../payments/index.js";
import { AppError } from "../utils/AppError.js";
import { isUniqueViolation } from "../utils/prismaErrors.js";
import { INVOICE_ENTITY, recordAudit } from "./audit.service.js";
import { recordException } from "./exception.service.js";

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/**
 * The three facts the payment gate needs — invoice status, match verdict,
 * existing payment — plus the purchase order that says what is actually owed.
 */
const paymentContextSelect = {
  id: true,
  organizationId: true,
  status: true,
  invoiceNumber: true,
  threeWayMatch: { select: { status: true } },
  payment: { select: { id: true, status: true, amountPaise: true, currency: true } },
  purchaseOrder: { select: { id: true, poNumber: true, totalPaise: true, currency: true } },
} satisfies Prisma.InvoiceSelect;

export type PaymentContext = Prisma.InvoiceGetPayload<{ select: typeof paymentContextSelect }>;

export async function loadPaymentContext(params: {
  organizationId: string;
  invoiceId: string;
}): Promise<PaymentContext> {
  const invoice = await prisma.invoice.findFirst({
    where: { id: params.invoiceId, organizationId: params.organizationId },
    select: paymentContextSelect,
  });

  if (!invoice) {
    throw AppError.notFound("Invoice not found");
  }

  return invoice;
}

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

/**
 * Takes exclusive ownership of the payment before any money moves.
 *
 * Two steps, because there are two ways a row can already exist. The create is
 * the race winner on a first run: Payment.invoiceId @unique means exactly one
 * concurrent job can succeed and the loser falls through to the guarded update,
 * which only claims a row that is not already COMPLETED. Between them, two
 * workers can never both reach the provider for one invoice.
 *
 * The amount is the purchase order's total — the buyer's own deterministically
 * calculated commitment. The invoice total is transcribed by Gemini and never
 * decides what gets paid (CLAUDE.md rule 12); matching has already proved the
 * two agree within tolerance.
 */
export async function claimPaymentForProcessing(params: {
  organizationId: string;
  invoiceId: string;
  purchaseOrder: { id: string; totalPaise: number; currency: string };
}): Promise<{ claimed: boolean; amountPaise: number; currency: string }> {
  const { organizationId, invoiceId, purchaseOrder } = params;
  const amount = { amountPaise: purchaseOrder.totalPaise, currency: purchaseOrder.currency };
  const processedAt = new Date();

  try {
    await prisma.payment.create({
      data: {
        organizationId,
        invoiceId,
        purchaseOrderId: purchaseOrder.id,
        ...amount,
        status: PaymentStatus.PROCESSING,
        provider: PAYMENT_PROVIDER_NAME,
        processedAt,
      },
    });

    await recordPaymentApproved({ organizationId, invoiceId, ...amount });

    return { claimed: true, ...amount };
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
  }

  // A row already existed. Claim it only from a state that has not settled —
  // PROCESSING is this job's own interrupted attempt, BLOCKED has been cleared
  // by a human (the payment gate already verified that), FAILED is retryable.
  const { count } = await prisma.payment.updateMany({
    where: {
      invoiceId,
      organizationId,
      status: {
        in: [
          PaymentStatus.PENDING,
          PaymentStatus.PROCESSING,
          PaymentStatus.BLOCKED,
          PaymentStatus.FAILED,
        ],
      },
    },
    data: {
      status: PaymentStatus.PROCESSING,
      ...amount,
      provider: PAYMENT_PROVIDER_NAME,
      purchaseOrderId: purchaseOrder.id,
      processedAt,
      blockedReason: null,
      failureReason: null,
    },
  });

  if (count === 0) {
    return { claimed: false, ...amount };
  }

  await recordPaymentApproved({ organizationId, invoiceId, ...amount });

  return { claimed: true, ...amount };
}

function recordPaymentApproved(params: {
  organizationId: string;
  invoiceId: string;
  amountPaise: number;
  currency: string;
}): Promise<void> {
  return recordAudit(prisma, {
    organizationId: params.organizationId,
    actorType: "SYSTEM",
    action: "PAYMENT_APPROVED",
    entityType: INVOICE_ENTITY,
    entityId: params.invoiceId,
    metadata: { amountPaise: params.amountPaise, currency: params.currency },
  });
}

// ---------------------------------------------------------------------------
// Settle
// ---------------------------------------------------------------------------

/**
 * Records a successful settlement: Payment COMPLETED, Invoice PAID.
 *
 * Both updates are guarded on the state this job left behind, so a duplicate
 * delivery that arrives after another attempt already settled finds nothing to
 * move and reports it rather than writing a second audit trail.
 */
export async function applyPaymentCompletion(params: {
  organizationId: string;
  invoiceId: string;
  providerReference: string;
  /** True when a human overrode a failed match to authorize this payment. */
  overriddenMatch: boolean;
}): Promise<boolean> {
  const { organizationId, invoiceId, providerReference, overriddenMatch } = params;

  return prisma.$transaction(async (tx) => {
    const settled = await tx.payment.updateMany({
      where: { invoiceId, organizationId, status: PaymentStatus.PROCESSING },
      data: {
        status: PaymentStatus.COMPLETED,
        providerReference,
        completedAt: new Date(),
        failureReason: null,
      },
    });

    if (settled.count === 0) {
      console.warn(`Invoice ${invoiceId}: payment completion ignored, payment is not PROCESSING.`);
      return false;
    }

    const invoiceUpdate = await tx.invoice.updateMany({
      where: { id: invoiceId, organizationId, status: InvoiceStatus.APPROVED },
      data: { status: InvoiceStatus.PAID },
    });

    if (invoiceUpdate.count === 0) {
      console.warn(
        `Invoice ${invoiceId}: payment completed (ref: ${providerReference}) but invoice was not` +
          ` in APPROVED state — no status transition applied. Manual reconciliation may be needed.`,
      );
    }

    await recordAudit(tx, {
      organizationId,
      actorType: "SYSTEM",
      action: "PAYMENT_COMPLETED",
      entityType: INVOICE_ENTITY,
      entityId: invoiceId,
      metadata: { providerReference, provider: PAYMENT_PROVIDER_NAME, overriddenMatch },
    });

    return true;
  });
}

/**
 * Terminal failure path, used only once BullMQ has exhausted its retries.
 *
 * The invoice stays APPROVED — it is still a legitimate debt — so a human can
 * re-drive payment once the provider is healthy again.
 */
export async function applyPaymentFailure(params: {
  organizationId: string;
  invoiceId: string;
  reason: string;
}): Promise<void> {
  const { organizationId, invoiceId, reason } = params;

  await prisma.$transaction(async (tx) => {
    await tx.payment.updateMany({
      where: { invoiceId, organizationId, status: PaymentStatus.PROCESSING },
      data: { status: PaymentStatus.FAILED, failureReason: reason },
    });

    await recordException(tx, {
      organizationId,
      type: ExceptionType.PAYMENT_FAILURE,
      severity: Severity.CRITICAL,
      entityType: INVOICE_ENTITY,
      entityId: invoiceId,
      title: "Payment failed",
      description: reason,
    });

    await recordAudit(tx, {
      organizationId,
      actorType: "SYSTEM",
      action: "WORKFLOW_FAILED",
      entityType: INVOICE_ENTITY,
      entityId: invoiceId,
      metadata: { stage: "payment", reason },
    });
  });
}
