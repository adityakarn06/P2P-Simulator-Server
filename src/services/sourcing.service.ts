import { AI_MODEL, getAIProvider } from "../ai/index.js";
import {
  buildSourcingRationalePrompt,
  RATIONALE_CANDIDATE_COUNT,
  SOURCING_PROMPT_VERSION,
  SOURCING_SYSTEM_PROMPT,
} from "../ai/prompts/sourcing.v1.js";
import { prisma } from "../config/prisma.js";
import type { Prisma } from "../generated/prisma/client.js";
import { ExceptionType, RequisitionStatus } from "../generated/prisma/enums.js";
import type { ProductLike } from "../rules/productMatching.js";
import { buildRationale, type RankedCandidate } from "../rules/supplierRanking.js";
import { AppError } from "../utils/AppError.js";
import { sourcingRationaleSchema } from "../zod/sourcing.schema.js";
import { recordAIProcessing } from "./aiLog.service.js";
import { REQUISITION_ENTITY as ENTITY_TYPE, recordAudit } from "./audit.service.js";
import { recordException } from "./exception.service.js";

const RATIONALE_JOB_TYPE = "generate-sourcing-rationale";

const requisitionSelect = {
  id: true,
  organizationId: true,
  status: true,
  requirement: true,
} satisfies Prisma.RequisitionSelect;

export type RequisitionForSourcing = Prisma.RequisitionGetPayload<{
  select: typeof requisitionSelect;
}>;

/** Tenant-scoped load. A requisition owned by another organization is a 404, never a cross-tenant read. */
export async function loadRequisitionForSourcing(params: {
  organizationId: string;
  requisitionId: string;
}): Promise<RequisitionForSourcing> {
  const requisition = await prisma.requisition.findFirst({
    where: { id: params.requisitionId, organizationId: params.organizationId },
    select: requisitionSelect,
  });

  if (!requisition) {
    throw AppError.notFound("Requisition not found");
  }

  return requisition;
}

/** The catalog is small for the MVP, so matching runs in memory over every org product. */
export function loadCatalogProducts(organizationId: string): Promise<ProductLike[]> {
  return prisma.product.findMany({
    where: { organizationId },
    select: { id: true, sku: true, name: true, category: true },
    orderBy: { sku: "asc" },
  });
}

const offerSelect = {
  id: true,
  unitPricePaise: true,
  currency: true,
  stockQuantity: true,
  deliveryDays: true,
  minOrderQuantity: true,
  supplier: {
    select: { id: true, name: true, isActive: true, rating: true, reliabilityScore: true },
  },
} satisfies Prisma.SupplierProductSelect;

export type SupplierOfferRow = Prisma.SupplierProductGetPayload<{ select: typeof offerSelect }>;

/**
 * SupplierProduct has no organizationId of its own, so tenancy is enforced
 * through the supplier relation rather than trusted from the caller.
 */
export function findCandidateOffers(params: {
  organizationId: string;
  productId: string;
}): Promise<SupplierOfferRow[]> {
  return prisma.supplierProduct.findMany({
    where: { productId: params.productId, supplier: { organizationId: params.organizationId } },
    select: offerSelect,
  });
}

export function loadSourcingDecision(params: { organizationId: string; requisitionId: string }) {
  return prisma.sourcingDecision.findFirst({
    where: { requisitionId: params.requisitionId, organizationId: params.organizationId },
  });
}

function toCandidateRow(params: {
  organizationId: string;
  requisitionId: string;
  candidate: RankedCandidate;
}): Prisma.SupplierCandidateCreateManyInput {
  const { candidate } = params;
  return {
    organizationId: params.organizationId,
    requisitionId: params.requisitionId,
    supplierId: candidate.supplierId,
    supplierProductId: candidate.supplierProductId,
    eligible: candidate.eligible,
    ineligibleReason: candidate.ineligibleReason,
    priceScore: candidate.priceScore,
    deliveryScore: candidate.deliveryScore,
    reliabilityScore: candidate.reliabilityScore,
    ratingScore: candidate.ratingScore,
    stockScore: candidate.stockScore,
    totalScore: candidate.totalScore,
    rank: candidate.rank,
    unitPricePaise: candidate.unitPricePaise,
    deliveryDays: candidate.deliveryDays,
    availableStock: candidate.availableStock,
  };
}

/**
 * Persists a completed sourcing run atomically: candidates, the decision, the
 * requisition transition and both audit rows commit together or not at all.
 * The purchase-order job is enqueued by the caller, after this commits.
 */
export async function applySourcingSuccess(params: {
  organizationId: string;
  requisitionId: string;
  productId: string;
  candidates: RankedCandidate[];
  selected: RankedCandidate;
  rationale: string;
}): Promise<void> {
  const { organizationId, requisitionId, productId, candidates, selected, rationale } = params;
  const eligibleCount = candidates.filter((candidate) => candidate.eligible).length;

  await prisma.$transaction(async (tx) => {
    // Claim the transition first. Two concurrent discovery jobs can both pass
    // the worker's status check before either commits; guarding the update on
    // the expected status means the loser writes nothing at all, instead of
    // overwriting the winner's candidates, decision and purchase-order job.
    const claimed = await tx.requisition.updateMany({
      where: {
        id: requisitionId,
        organizationId,
        status: RequisitionStatus.REQUIREMENTS_EXTRACTED,
      },
      data: { status: RequisitionStatus.SUPPLIER_SELECTED, failureReason: null },
    });

    if (claimed.count === 0) {
      throw AppError.conflict("Requisition was sourced concurrently", { requisitionId });
    }

    // A previous partial run leaves rows behind; replacing them wholesale keeps
    // the job idempotent without depending on per-row upserts.
    await tx.supplierCandidate.deleteMany({ where: { requisitionId } });
    await tx.supplierCandidate.createMany({
      data: candidates.map((candidate) =>
        toCandidateRow({ organizationId, requisitionId, candidate }),
      ),
    });

    const decision = {
      organizationId,
      selectedSupplierId: selected.supplierId,
      selectedSupplierProductId: selected.supplierProductId,
      totalScore: selected.totalScore,
      candidatesEvaluated: candidates.length,
      rationale,
    };

    await tx.sourcingDecision.upsert({
      where: { requisitionId },
      create: { requisitionId, ...decision },
      update: decision,
    });

    await recordAudit(tx, {
      organizationId,
      actorType: "SYSTEM",
      action: "SUPPLIERS_DISCOVERED",
      entityType: ENTITY_TYPE,
      entityId: requisitionId,
      metadata: { productId, evaluated: candidates.length, eligible: eligibleCount },
    });

    await recordAudit(tx, {
      organizationId,
      actorType: "SYSTEM",
      action: "SUPPLIER_SELECTED",
      entityType: ENTITY_TYPE,
      entityId: requisitionId,
      metadata: {
        supplierId: selected.supplierId,
        supplierProductId: selected.supplierProductId,
        totalScore: selected.totalScore,
        unitPricePaise: selected.unitPricePaise,
        deliveryDays: selected.deliveryDays,
      },
    });
  });
}

/**
 * Terminal failure path. Ineligible candidates are still persisted so a buyer
 * can see exactly why every supplier was rejected.
 */
export async function applySourcingFailure(params: {
  organizationId: string;
  requisitionId: string;
  reason: string;
  candidates: RankedCandidate[];
  exceptionType: typeof ExceptionType.NO_SUPPLIER_FOUND | typeof ExceptionType.SYSTEM_FAILURE;
  metadata?: Prisma.InputJsonValue;
}): Promise<void> {
  const { organizationId, requisitionId, reason, candidates, exceptionType, metadata } = params;

  await prisma.$transaction(async (tx) => {
    await tx.supplierCandidate.deleteMany({ where: { requisitionId } });
    if (candidates.length > 0) {
      await tx.supplierCandidate.createMany({
        data: candidates.map((candidate) =>
          toCandidateRow({ organizationId, requisitionId, candidate }),
        ),
      });
    }

    await tx.requisition.update({
      where: { id: requisitionId },
      data: { status: RequisitionStatus.FAILED, failureReason: reason },
    });

    await recordException(tx, {
      organizationId,
      type: exceptionType,
      severity: "CRITICAL",
      entityType: ENTITY_TYPE,
      entityId: requisitionId,
      title:
        exceptionType === ExceptionType.NO_SUPPLIER_FOUND
          ? "No eligible supplier found"
          : "Supplier discovery failed",
      description: reason,
      ...(metadata !== undefined ? { metadata } : {}),
    });

    await recordAudit(tx, {
      organizationId,
      actorType: "SYSTEM",
      action: "WORKFLOW_FAILED",
      entityType: ENTITY_TYPE,
      entityId: requisitionId,
      metadata: { stage: "supplier-discovery", reason },
    });
  });
}

/** A reply that leaked schema field names, or never names the winner, is unusable as buyer-facing copy. */
function isUsableRationale(text: string, selectedSupplierName: string): boolean {
  if (!text.toLowerCase().includes(selectedSupplierName.toLowerCase())) {
    return false;
  }
  // Only camelCase identifiers are matched. Ordinary business words the prompt
  // actively asks for — "eligible", "delivery days" — must not trip this, or
  // the gate would discard good copy far more often than it catches a leak.
  return !/\b(unitPricePaise|totalScore|priceScore|deliveryScore|stockScore|ratingScore|reliabilityScore|supplierProductId|supplierId|ineligibleReason|null)\b/.test(
    text,
  );
}

/**
 * Asks Gemini to explain a decision that has already been made.
 *
 * This is the only AI call in sourcing, and it is purely cosmetic: the selected
 * supplier is fixed before this runs and nothing downstream reads the returned
 * text. Every failure mode — timeout, malformed JSON, schema violation, leaked
 * field names — degrades to the deterministic rationale. It never throws, so a
 * Gemini outage can never fail or retry a sourcing job.
 */
export async function generateRationale(params: {
  organizationId: string;
  requisitionId: string;
  productName: string;
  quantity: number;
  currency: string;
  maxUnitPricePaise: number | null;
  deliveryDeadlineDays: number | null;
  candidates: RankedCandidate[];
  selected: RankedCandidate;
  evaluatedCount: number;
  eligibleCount: number;
}): Promise<string> {
  const fallback = buildRationale(
    params.selected,
    params.currency,
    params.evaluatedCount,
    params.eligibleCount,
  );

  const startedAt = Date.now();

  const log = (success: boolean, error?: string): Promise<void> =>
    recordAIProcessing({
      organizationId: params.organizationId,
      entityType: ENTITY_TYPE,
      entityId: params.requisitionId,
      jobType: RATIONALE_JOB_TYPE,
      model: AI_MODEL,
      promptVersion: SOURCING_PROMPT_VERSION,
      success,
      latencyMs: Date.now() - startedAt,
      error: error ?? null,
    });

  try {
    const raw = await getAIProvider().generateStructured({
      systemPrompt: SOURCING_SYSTEM_PROMPT,
      userPrompt: buildSourcingRationalePrompt({
        productName: params.productName,
        quantity: params.quantity,
        currency: params.currency,
        maxUnitPricePaise: params.maxUnitPricePaise,
        deliveryDeadlineDays: params.deliveryDeadlineDays,
        candidates: params.candidates.slice(0, RATIONALE_CANDIDATE_COUNT),
      }),
      promptName: SOURCING_PROMPT_VERSION,
    });

    const parsed = sourcingRationaleSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      await log(false, "Gemini response failed schema validation");
      return fallback;
    }

    if (!isUsableRationale(parsed.data.rationale, params.selected.supplierName)) {
      await log(false, "Gemini rationale failed the sanity check");
      return fallback;
    }

    await log(true);
    return parsed.data.rationale;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Gemini request failed";
    await log(false, reason);
    console.error(`Requisition ${params.requisitionId}: rationale generation failed — ${reason}`);
    return fallback;
  }
}
