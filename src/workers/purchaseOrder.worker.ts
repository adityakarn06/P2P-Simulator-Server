import type { Job } from "bullmq";
import { DEFAULT_TAX_RATE_BPS } from "../config/constants.js";
import type { Prisma } from "../generated/prisma/client.js";
import { ExceptionType, RequisitionStatus } from "../generated/prisma/enums.js";
import { calculatePurchaseOrderTotals, decideApprovalStatus } from "../rules/approvalRules.js";
import { checkEligibility, type SourcingConstraints } from "../rules/supplierRanking.js";
import { evaluatePurchaseOrder } from "../services/anomaly.service.js";
import {
  addDays,
  applyPurchaseOrderCreation,
  applyPurchaseOrderFailure,
  buildPoNumber,
  loadRequisitionForPO,
  loadRequisitionOutcome,
  loadSelectedOffer,
  type RequisitionForPO,
  type SelectedOffer,
} from "../services/purchaseOrder.service.js";
import { purchaseOrderJobSchema } from "../types/types.js";
import { AppError } from "../utils/AppError.js";
import { parseJobData } from "./parseJobData.js";

export interface PurchaseOrderResult {
  requisitionId: string;
  status: RequisitionStatus;
  /** Null when no purchase order was created, or when the run was skipped. */
  purchaseOrderId: string | null;
  reason: string | null;
  /** True when the job re-ran against a requisition that already has a PO. */
  skipped: boolean;
}

/**
 * Generates the purchase order for a requisition whose supplier has been
 * selected.
 *
 * Every money figure is computed by src/rules/approvalRules.ts from the live
 * SupplierProduct row — never from the queued payload, never from the ranking
 * snapshot, and never by Gemini. Nothing is enqueued afterwards: approval is a
 * human action (POST /api/v1/purchase-orders/:id/approve).
 */
export async function processPurchaseOrderJob(job: Job): Promise<PurchaseOrderResult> {
  const { requisitionId, organizationId } = parseJobData(
    purchaseOrderJobSchema,
    job.data,
    "purchase-order",
  );

  // Loaded outside the guard below: if the requisition cannot be read there is
  // nothing to record a failure against, so that error must surface as-is.
  const requisition = await loadRequisitionForPO({ organizationId, requisitionId });

  try {
    return await createPurchaseOrder(requisition);
  } catch (error) {
    // Losing a guarded claim is not a fault — someone else moved the
    // requisition on. What they decided has to be re-read, not assumed: the
    // claim can also miss because an earlier run already marked it FAILED.
    if (error instanceof AppError && error.code === "CONFLICT") {
      return skippedOutcome({ organizationId, requisitionId });
    }

    // A validation error is deterministic — retrying cannot change the answer,
    // so it fails terminally instead of burning three attempts.
    if (error instanceof AppError && error.code === "VALIDATION_ERROR") {
      return terminalFailure({
        organizationId,
        requisitionId,
        reason: error.message,
        exceptionType: ExceptionType.SYSTEM_FAILURE,
      });
    }

    const reason = error instanceof Error ? error.message : "Purchase order generation failed";
    return handleTechnicalFailure(job, { organizationId, requisitionId, reason, error });
  }
}

function alreadyCreated(
  requisitionId: string,
  purchaseOrderId: string | null,
): PurchaseOrderResult {
  return {
    requisitionId,
    status: RequisitionStatus.PO_CREATED,
    purchaseOrderId,
    reason: null,
    skipped: true,
  };
}

/** Reports what the requisition actually looks like after a refused write. */
async function skippedOutcome(params: {
  organizationId: string;
  requisitionId: string;
}): Promise<PurchaseOrderResult> {
  const outcome = await loadRequisitionOutcome(params);

  return {
    requisitionId: params.requisitionId,
    status: outcome.status,
    purchaseOrderId: outcome.purchaseOrderId,
    reason: null,
    skipped: true,
  };
}

/**
 * Records a terminal PO-generation failure. When the requisition has already
 * moved past SUPPLIER_SELECTED the write is refused, and the job reports the
 * real outcome rather than claiming a failure it did not cause.
 */
async function terminalFailure(params: {
  organizationId: string;
  requisitionId: string;
  reason: string;
  exceptionType: typeof ExceptionType.NO_SUPPLIER_FOUND | typeof ExceptionType.SYSTEM_FAILURE;
  metadata?: Prisma.InputJsonValue;
}): Promise<PurchaseOrderResult> {
  const applied = await applyPurchaseOrderFailure(params);

  if (!applied) {
    return skippedOutcome(params);
  }

  return {
    requisitionId: params.requisitionId,
    status: RequisitionStatus.FAILED,
    purchaseOrderId: null,
    reason: params.reason,
    skipped: false,
  };
}

async function createPurchaseOrder(requisition: RequisitionForPO): Promise<PurchaseOrderResult> {
  const { id: requisitionId, organizationId } = requisition;

  // Idempotency: BullMQ may run a job more than once. A requisition that
  // already carries a purchase order must never get a second one.
  if (requisition.purchaseOrder) {
    return alreadyCreated(requisitionId, requisition.purchaseOrder.id);
  }

  if (requisition.status !== RequisitionStatus.SUPPLIER_SELECTED) {
    return {
      requisitionId,
      status: requisition.status,
      purchaseOrderId: null,
      reason: `Requisition is ${requisition.status}, not ready for a purchase order`,
      skipped: true,
    };
  }

  const requirement = requisition.requirement;
  const decision = requisition.sourcingDecision;

  if (!requirement || !decision) {
    // SUPPLIER_SELECTED is written in the same transaction as the
    // SourcingDecision, and the Requirement predates both, so this is an
    // invariant breach rather than a business outcome. The wrapper turns it
    // into a retry, then a SYSTEM_FAILURE exception.
    throw new Error("Requisition is SUPPLIER_SELECTED but has no requirement or sourcing decision");
  }

  const offer = await loadSelectedOffer({
    organizationId,
    supplierId: decision.selectedSupplierId,
    supplierProductId: decision.selectedSupplierProductId,
  });

  if (!offer) {
    const reason =
      "The selected supplier or its product listing no longer exists — the purchase order cannot be issued";
    return terminalFailure({
      organizationId,
      requisitionId,
      reason,
      exceptionType: ExceptionType.NO_SUPPLIER_FOUND,
      metadata: {
        supplierId: decision.selectedSupplierId,
        supplierProductId: decision.selectedSupplierProductId,
      },
    });
  }

  // Price, stock and lead time are re-checked against the live listing. Sourcing
  // may have run minutes ago; issuing a purchase order on stale terms would
  // commit money to a price nobody approved.
  const constraints: SourcingConstraints = {
    quantity: requirement.quantity,
    currency: requirement.currency,
    maxUnitPricePaise: requirement.maxUnitPricePaise,
    deliveryDeadlineDays: requirement.deliveryDeadlineDays,
  };

  const ineligibleReason = checkEligibility(toSupplierOffer(offer), constraints);

  if (ineligibleReason) {
    const reason = `${offer.supplier.name} no longer meets the requirement — ${ineligibleReason}`;
    return terminalFailure({
      organizationId,
      requisitionId,
      reason,
      exceptionType: ExceptionType.NO_SUPPLIER_FOUND,
      metadata: {
        supplierId: offer.supplier.id,
        supplierProductId: offer.id,
        unitPricePaise: offer.unitPricePaise,
        stockQuantity: offer.stockQuantity,
        deliveryDays: offer.deliveryDays,
      },
    });
  }

  const totals = calculatePurchaseOrderTotals(
    [
      {
        productId: offer.product.id,
        supplierProductId: offer.id,
        description: `${offer.product.name} (${offer.product.sku})`,
        quantity: requirement.quantity,
        unitPricePaise: offer.unitPricePaise,
      },
    ],
    DEFAULT_TAX_RATE_BPS,
  );

  const approval = decideApprovalStatus(totals.totalPaise);
  const now = new Date();

  const purchaseOrder = await applyPurchaseOrderCreation({
    organizationId,
    requisitionId,
    supplierId: offer.supplier.id,
    poNumber: buildPoNumber(requisitionId, now),
    status: approval.status,
    approvalReason: approval.reason,
    currency: offer.currency,
    subtotalPaise: totals.subtotalPaise,
    taxPaise: totals.taxPaise,
    totalPaise: totals.totalPaise,
    taxRateBps: totals.taxRateBps,
    expectedDeliveryDate: addDays(now, offer.deliveryDays),
    items: totals.items,
  });

  // Advisory only, and deliberately after the order is committed: anomaly
  // signals inform a buyer, they never gate a purchase order. The service
  // swallows its own failures so this cannot fail the job.
  await evaluatePurchaseOrder({ organizationId, purchaseOrderId: purchaseOrder.id });

  return {
    requisitionId,
    status: RequisitionStatus.PO_CREATED,
    purchaseOrderId: purchaseOrder.id,
    reason: null,
    skipped: false,
  };
}

function toSupplierOffer(offer: SelectedOffer) {
  return {
    supplierId: offer.supplier.id,
    supplierName: offer.supplier.name,
    supplierProductId: offer.id,
    unitPricePaise: offer.unitPricePaise,
    currency: offer.currency,
    stockQuantity: offer.stockQuantity,
    deliveryDays: offer.deliveryDays,
    minOrderQuantity: offer.minOrderQuantity,
    isActive: offer.supplier.isActive,
    rating: offer.supplier.rating,
    reliabilityScore: offer.supplier.reliabilityScore,
  };
}

/**
 * Technical failures — a dropped database connection, a broken invariant — are
 * retried by BullMQ. On the final attempt we record a SYSTEM_FAILURE exception
 * rather than leaving the requisition stuck in SUPPLIER_SELECTED with nothing
 * driving it forward.
 */
async function handleTechnicalFailure(
  job: Job,
  params: { organizationId: string; requisitionId: string; reason: string; error?: unknown },
): Promise<PurchaseOrderResult> {
  const maxAttempts = job.opts.attempts ?? 1;
  const isFinalAttempt = job.attemptsMade + 1 >= maxAttempts;

  if (!isFinalAttempt) {
    throw params.error instanceof Error ? params.error : new Error(params.reason);
  }

  console.error(
    `Requisition ${params.requisitionId}: purchase order generation giving up after ${maxAttempts} attempts — ${params.reason}`,
  );

  return terminalFailure({
    organizationId: params.organizationId,
    requisitionId: params.requisitionId,
    reason: params.reason,
    exceptionType: ExceptionType.SYSTEM_FAILURE,
  });
}
