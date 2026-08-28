import { PAYMENT_CLAIM_LEASE_MS } from "../config/constants.js";
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

/**
 * True when a *different* invoice against the same purchase order already holds
 * or has completed a payment.
 *
 * PROCESSING counts as settled: a worker is inside the provider call for it
 * right now, and letting a sibling through would be exactly the double payment
 * this guard exists to stop.
 */
export async function hasSettledSiblingInvoice(params: {
  organizationId: string;
  invoiceId: string;
  purchaseOrderId: string;
}): Promise<boolean> {
  const count = await prisma.payment.count({
    where: {
      organizationId: params.organizationId,
      purchaseOrderId: params.purchaseOrderId,
      invoiceId: { not: params.invoiceId },
      status: { in: [PaymentStatus.PROCESSING, PaymentStatus.COMPLETED] },
    },
  });

  return count > 0;
}

/**
 * Records that this invoice was refused because its purchase order is already
 * settled by another document. Without a row here the refusal is invisible —
 * the job returns normally and nothing tells a human that a second invoice
 * arrived for an order that has already been paid.
 */
export async function recordDuplicatePurchaseOrderPayment(params: {
  organizationId: string;
  invoiceId: string;
  purchaseOrderId: string;
  poNumber: string;
  reason: string;
}): Promise<void> {
  const { organizationId, invoiceId, purchaseOrderId, poNumber, reason } = params;

  await prisma.$transaction(async (tx) => {
    await recordException(tx, {
      organizationId,
      type: ExceptionType.DUPLICATE_INVOICE,
      severity: Severity.CRITICAL,
      entityType: INVOICE_ENTITY,
      entityId: invoiceId,
      title: "Purchase order already paid on another invoice",
      description: reason,
      metadata: { purchaseOrderId, poNumber },
    });

    // BLOCKED, not FAILED: this is a business refusal awaiting a human, not a
    // provider error. Only a row that has not settled may be moved.
    await tx.payment.updateMany({
      where: {
        invoiceId,
        organizationId,
        status: { in: [PaymentStatus.PENDING, PaymentStatus.FAILED] },
      },
      data: { status: PaymentStatus.BLOCKED, blockedReason: reason },
    });
  });
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
 * which only claims a row that is not already COMPLETED. Between them, exactly
 * one Payment row and one COMPLETED settlement are guaranteed.
 *
 * What is NOT guaranteed is that only one worker reaches the provider. The
 * resume branch below re-claims a PROCESSING row so an interrupted attempt can
 * finish, and it cannot tell "my own crashed attempt" from "another worker is
 * inside charge() right now" — so two concurrent jobs for one invoice can both
 * call the provider. Harmless against SimulatedPaymentProvider, which is pure;
 * a real gateway would need this to become a lease (claim only when processedAt
 * is older than a timeout) plus a provider that honours idempotencyKey.
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
  /** Identifies this attempt. Stable across the job's own retries. */
  claimToken: string;
}): Promise<{ claimed: boolean; amountPaise: number; currency: string }> {
  const { organizationId, invoiceId, purchaseOrder, claimToken } = params;
  const amount = { amountPaise: purchaseOrder.totalPaise, currency: purchaseOrder.currency };
  const processedAt = new Date();

  try {
    // Create and audit atomically. If the audit failed on its own the row would
    // already be PROCESSING, and the resume branch below deliberately does not
    // re-audit — so a half-committed first run would settle with no
    // PAYMENT_APPROVED row at all. Rolling both back lets the retry redo them.
    await prisma.$transaction(async (tx) => {
      await tx.payment.create({
        data: {
          organizationId,
          invoiceId,
          purchaseOrderId: purchaseOrder.id,
          ...amount,
          status: PaymentStatus.PROCESSING,
          provider: PAYMENT_PROVIDER_NAME,
          claimedBy: claimToken,
          processedAt,
        },
      });

      await recordAudit(tx, paymentApprovedAudit({ organizationId, invoiceId, ...amount }));
    });

    return { claimed: true, ...amount };
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
  }

  // A row already existed. Claim it only from a state that has not settled —
  // BLOCKED has been cleared by a human (the payment gate already verified
  // that), FAILED is retryable, PENDING was never started.
  //
  // PROCESSING is handled separately below rather than in this set, for two
  // reasons: re-claiming it is a *resume* rather than a fresh approval, so it
  // must not append a second PAYMENT_APPROVED audit row; and it may belong to a
  // worker that is inside the provider call right now, so it is only taken over
  // once its lease has expired.
  const claimData = {
    status: PaymentStatus.PROCESSING,
    ...amount,
    provider: PAYMENT_PROVIDER_NAME,
    purchaseOrderId: purchaseOrder.id,
    claimedBy: claimToken,
    processedAt,
    blockedReason: null,
    failureReason: null,
  };

  return prisma.$transaction(async (tx) => {
    const approved = await tx.payment.updateMany({
      where: {
        invoiceId,
        organizationId,
        status: {
          in: [PaymentStatus.PENDING, PaymentStatus.BLOCKED, PaymentStatus.FAILED],
        },
      },
      data: claimData,
    });

    if (approved.count > 0) {
      await recordAudit(tx, paymentApprovedAudit({ organizationId, invoiceId, ...amount }));
      return { claimed: true, ...amount };
    }

    // A PROCESSING row is resumable in exactly two cases: it is this attempt's
    // own claim (same job id, so this is a BullMQ retry picking up where it left
    // off — its backoff is far shorter than the lease, so it must not be made to
    // wait one out), or the claim has gone stale and its owner is presumed dead.
    // Anything else belongs to a worker that may be inside charge() right now.
    //
    // There is deliberately no third "unowned row" case. Every PROCESSING row is
    // written with both claimedBy and processedAt set, in one transaction, so a
    // row with neither cannot be produced by this code — and matching an
    // ownerless row unconditionally would hand out a claim regardless of lease.
    // A row that somehow lacks a processedAt stays put for a human instead.
    const resumed = await tx.payment.updateMany({
      where: {
        invoiceId,
        organizationId,
        status: PaymentStatus.PROCESSING,
        OR: [
          { claimedBy: claimToken },
          { processedAt: { lt: new Date(processedAt.getTime() - PAYMENT_CLAIM_LEASE_MS) } },
        ],
      },
      data: claimData,
    });

    return { claimed: resumed.count > 0, ...amount };
  });
}

function paymentApprovedAudit(params: {
  organizationId: string;
  invoiceId: string;
  amountPaise: number;
  currency: string;
}) {
  return {
    organizationId: params.organizationId,
    actorType: "SYSTEM" as const,
    action: "PAYMENT_APPROVED" as const,
    entityType: INVOICE_ENTITY,
    entityId: params.invoiceId,
    metadata: { amountPaise: params.amountPaise, currency: params.currency },
  };
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
      const reason =
        `Payment completed (provider reference ${providerReference}) but the invoice was not in` +
        " APPROVED state, so it was not moved to PAID. Money has moved; reconcile manually.";

      console.warn(`Invoice ${invoiceId}: ${reason}`);

      // A log line is not a signal anyone will see. Money left the building
      // against an invoice the workflow does not consider payable — that is
      // exactly what the exception queue is for.
      await recordException(tx, {
        organizationId,
        type: ExceptionType.SYSTEM_FAILURE,
        severity: Severity.CRITICAL,
        entityType: INVOICE_ENTITY,
        entityId: invoiceId,
        title: "Payment settled against a non-approved invoice",
        description: reason,
        metadata: { providerReference, provider: PAYMENT_PROVIDER_NAME },
      });
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
