import type { Job } from "bullmq";
import { ExceptionType, RequisitionStatus } from "../generated/prisma/enums.js";
import { enqueuePurchaseOrder } from "../queues/purchaseOrder.queue.js";
import { findBestProduct } from "../rules/productMatching.js";
import {
  type RankedCandidate,
  rankSuppliers,
  type SourcingConstraints,
  type SupplierOffer,
} from "../rules/supplierRanking.js";
import {
  applySourcingFailure,
  applySourcingSuccess,
  findCandidateOffers,
  generateRationale,
  loadCatalogProducts,
  loadRequisitionForSourcing,
  loadSourcingDecision,
  type RequisitionForSourcing,
  type SupplierOfferRow,
} from "../services/sourcing.service.js";
import { supplierDiscoveryJobSchema } from "../types/types.js";
import { AppError } from "../utils/AppError.js";
import { parseJobData } from "./parseJobData.js";

export interface SupplierDiscoveryResult {
  requisitionId: string;
  status: RequisitionStatus;
  /** Null when no supplier was selected, or when the run was skipped. */
  selectedSupplierId: string | null;
  reason: string | null;
  /** True when the job re-ran against an already-sourced requisition. */
  skipped: boolean;
}

/** Statuses at or past selection — a re-run must not re-source them. */
const ALREADY_SOURCED: RequisitionStatus[] = ["SUPPLIER_SELECTED", "PO_CREATED"];

function toSupplierOffer(row: SupplierOfferRow): SupplierOffer {
  return {
    supplierId: row.supplier.id,
    supplierName: row.supplier.name,
    supplierProductId: row.id,
    unitPricePaise: row.unitPricePaise,
    currency: row.currency,
    stockQuantity: row.stockQuantity,
    deliveryDays: row.deliveryDays,
    minOrderQuantity: row.minOrderQuantity,
    isActive: row.supplier.isActive,
    rating: row.supplier.rating,
    reliabilityScore: row.supplier.reliabilityScore,
  };
}

function summarizeRejections(candidates: RankedCandidate[]): string {
  if (candidates.length === 0) {
    return "No supplier in the catalog offers this product.";
  }
  return `No supplier met every requirement: ${candidates
    .map((candidate) => `${candidate.supplierName} — ${candidate.ineligibleReason}`)
    .join("; ")}`;
}

/**
 * Discovers, scores and selects a supplier for an extracted requirement.
 *
 * Ranking is entirely deterministic (src/rules/supplierRanking.ts). Gemini is
 * called once, after the winner is already fixed, purely to narrate the
 * decision — and its failure is never fatal.
 *
 * Business failures (no matching product, no eligible supplier) are terminal
 * states, not errors: they return normally so BullMQ does not retry a decision
 * that cannot change.
 */
export async function processSupplierDiscoveryJob(job: Job): Promise<SupplierDiscoveryResult> {
  const { requisitionId, organizationId } = parseJobData(
    supplierDiscoveryJobSchema,
    job.data,
    "supplier-discovery",
  );

  // Loaded outside the guard below: if the requisition cannot be read there is
  // nothing to record a failure against, so that error must surface as-is.
  const requisition = await loadRequisitionForSourcing({ organizationId, requisitionId });

  try {
    return await sourceRequisition(requisition);
  } catch (error) {
    // Losing a concurrent race is not a fault — the winner already sourced it.
    if (error instanceof AppError && error.code === "CONFLICT") {
      return handleAlreadySourced({
        organizationId,
        requisitionId,
        status: RequisitionStatus.SUPPLIER_SELECTED,
      });
    }

    const reason = error instanceof Error ? error.message : "Supplier discovery failed";
    return handleTechnicalFailure(job, { organizationId, requisitionId, reason, error });
  }
}

/**
 * Re-entry point for a requisition that is already sourced.
 *
 * The purchase-order job is enqueued after its transaction commits, so a Redis
 * failure in that window leaves a committed decision with no job behind it.
 * Re-enqueuing here means the retry heals that gap instead of returning early
 * and stranding the requisition in SUPPLIER_SELECTED forever.
 */
async function handleAlreadySourced(params: {
  organizationId: string;
  requisitionId: string;
  status: RequisitionStatus;
}): Promise<SupplierDiscoveryResult> {
  const { organizationId, requisitionId, status } = params;
  const decision = await loadSourcingDecision({ organizationId, requisitionId });

  // PO_CREATED means the purchase-order worker already ran; only a decision
  // still waiting on its job needs one.
  if (status === RequisitionStatus.SUPPLIER_SELECTED && decision) {
    await enqueuePurchaseOrder({ requisitionId, organizationId });
  }

  return {
    requisitionId,
    status,
    selectedSupplierId: decision?.selectedSupplierId ?? null,
    reason: null,
    skipped: true,
  };
}

async function sourceRequisition(
  requisition: RequisitionForSourcing,
): Promise<SupplierDiscoveryResult> {
  const { id: requisitionId, organizationId } = requisition;

  // Idempotency: BullMQ may run a job more than once. Once a supplier is chosen
  // the decision stands — re-running could pick a different supplier than the
  // purchase order already names.
  if (ALREADY_SOURCED.includes(requisition.status)) {
    return handleAlreadySourced({ organizationId, requisitionId, status: requisition.status });
  }

  if (requisition.status !== "REQUIREMENTS_EXTRACTED") {
    return {
      requisitionId,
      status: requisition.status,
      selectedSupplierId: null,
      reason: `Requisition is ${requisition.status}, not ready for sourcing`,
      skipped: true,
    };
  }

  const requirement = requisition.requirement;
  if (!requirement) {
    // REQUIREMENTS_EXTRACTED is written in the same transaction as the
    // Requirement row, so this is an invariant breach, not a business outcome.
    // The wrapper turns it into a retry, then a SYSTEM_FAILURE exception.
    throw new Error("Requisition is REQUIREMENTS_EXTRACTED but has no Requirement record");
  }

  const products = await loadCatalogProducts(organizationId);
  const match = findBestProduct(requirement.productName, requirement.category, products);

  if (match.status !== "MATCHED") {
    const reason =
      match.status === "AMBIGUOUS"
        ? `"${requirement.productName}" matches more than one catalog product (${match.candidates
            .map((product) => product.name)
            .join(", ")}) — the request is not specific enough to source`
        : `No catalog product matches "${requirement.productName}"`;

    await applySourcingFailure({
      organizationId,
      requisitionId,
      reason,
      candidates: [],
      exceptionType: ExceptionType.NO_SUPPLIER_FOUND,
      metadata: { productName: requirement.productName, matchStatus: match.status },
    });
    return { requisitionId, status: "FAILED", selectedSupplierId: null, reason, skipped: false };
  }

  const constraints: SourcingConstraints = {
    quantity: requirement.quantity,
    currency: requirement.currency,
    maxUnitPricePaise: requirement.maxUnitPricePaise,
    deliveryDeadlineDays: requirement.deliveryDeadlineDays,
  };

  const offers = await findCandidateOffers({ organizationId, productId: match.product.id });
  const candidates = rankSuppliers(offers.map(toSupplierOffer), constraints);
  const eligible = candidates.filter((candidate) => candidate.eligible);
  const selected = eligible[0];

  if (!selected) {
    const reason = summarizeRejections(candidates);
    await applySourcingFailure({
      organizationId,
      requisitionId,
      reason,
      candidates,
      exceptionType: ExceptionType.NO_SUPPLIER_FOUND,
      metadata: { productId: match.product.id, evaluated: candidates.length },
    });
    return { requisitionId, status: "FAILED", selectedSupplierId: null, reason, skipped: false };
  }

  // The winner is final from here on. Gemini only describes it.
  const rationale = await generateRationale({
    organizationId,
    requisitionId,
    productName: match.product.name,
    quantity: requirement.quantity,
    currency: requirement.currency,
    maxUnitPricePaise: requirement.maxUnitPricePaise,
    deliveryDeadlineDays: requirement.deliveryDeadlineDays,
    candidates,
    selected,
    evaluatedCount: candidates.length,
    eligibleCount: eligible.length,
  });

  await applySourcingSuccess({
    organizationId,
    requisitionId,
    productId: match.product.id,
    candidates,
    selected,
    rationale,
  });

  // Enqueued after the transaction commits, never inside it.
  await enqueuePurchaseOrder({ requisitionId, organizationId });

  return {
    requisitionId,
    status: "SUPPLIER_SELECTED",
    selectedSupplierId: selected.supplierId,
    reason: null,
    skipped: false,
  };
}

/**
 * Technical failures — a dropped database connection, a Redis blip, a broken
 * invariant — are retried by BullMQ. On the final attempt we record a
 * SYSTEM_FAILURE exception rather than leaving the requisition stuck in
 * REQUIREMENTS_EXTRACTED with nothing driving it forward.
 */
async function handleTechnicalFailure(
  job: Job,
  params: { organizationId: string; requisitionId: string; reason: string; error?: unknown },
): Promise<SupplierDiscoveryResult> {
  const maxAttempts = job.opts.attempts ?? 1;
  const isFinalAttempt = job.attemptsMade + 1 >= maxAttempts;

  if (!isFinalAttempt) {
    throw params.error instanceof Error ? params.error : new Error(params.reason);
  }

  console.error(
    `Requisition ${params.requisitionId}: supplier discovery giving up after ${maxAttempts} attempts — ${params.reason}`,
  );

  await applySourcingFailure({
    organizationId: params.organizationId,
    requisitionId: params.requisitionId,
    reason: params.reason,
    candidates: [],
    exceptionType: ExceptionType.SYSTEM_FAILURE,
  });

  return {
    requisitionId: params.requisitionId,
    status: "FAILED",
    selectedSupplierId: null,
    reason: params.reason,
    skipped: false,
  };
}
