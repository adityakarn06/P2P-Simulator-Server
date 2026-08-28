import { prisma } from "../config/prisma.js";
import type { Prisma } from "../generated/prisma/client.js";
import { RequisitionStatus } from "../generated/prisma/enums.js";
import {
  buildClarificationMessage,
  COMPLETE_MESSAGE,
  findMissingFields,
  isComplete,
  mergeDraft,
  normalizeConflicts,
  toRequirementInput,
} from "../rules/requirementRules.js";
import { AppError } from "../utils/AppError.js";
import {
  type DraftRequirements,
  EMPTY_DRAFT,
  type ExtractionResult,
  parseDraft,
} from "../zod/requisition.schema.js";
import { REQUISITION_ENTITY as ENTITY_TYPE, recordAudit } from "./audit.service.js";
import { purchaseOrderViewSelect } from "./purchaseOrder.service.js";

/**
 * Drafts contain nulls for not-yet-known fields, which Prisma's InputJsonValue
 * type rejects even though they serialise fine. Narrow once, here, rather than
 * casting at every call site.
 */
function toJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

/** Statuses past the conversational phase — further chat messages are rejected. */
/**
 * Statuses the conversation can no longer be reopened from. Exported so the
 * requisition worker can return early on a re-delivered job rather than calling
 * Gemini again and rewinding a requisition that already has a purchase order.
 */
export const CLOSED_STATUSES: RequisitionStatus[] = [
  RequisitionStatus.REQUIREMENTS_EXTRACTED,
  RequisitionStatus.SUPPLIER_SELECTED,
  RequisitionStatus.PO_CREATED,
  RequisitionStatus.FAILED,
];

const messageSelect = {
  id: true,
  role: true,
  content: true,
  createdAt: true,
} satisfies Prisma.RequisitionMessageSelect;

const requisitionSelect = {
  id: true,
  organizationId: true,
  rawInput: true,
  status: true,
  failureReason: true,
  clarificationMessage: true,
  missingFields: true,
  conflicts: true,
  draftRequirements: true,
  turnCount: true,
  createdAt: true,
  updatedAt: true,
  requirement: true,
  messages: { select: messageSelect, orderBy: { createdAt: "asc" } },
} satisfies Prisma.RequisitionSelect;

/**
 * The read path additionally returns the sourcing outcome. Kept separate from
 * requisitionSelect so the extraction worker, which only needs the
 * conversation, does not pay for these joins on every job.
 */
const requisitionDetailSelect = {
  ...requisitionSelect,
  sourcingDecision: {
    select: {
      selectedSupplierId: true,
      selectedSupplierProductId: true,
      totalScore: true,
      candidatesEvaluated: true,
      rationale: true,
      createdAt: true,
    },
  },
  supplierCandidates: {
    orderBy: { rank: "asc" },
    select: {
      supplierId: true,
      rank: true,
      eligible: true,
      ineligibleReason: true,
      unitPricePaise: true,
      deliveryDays: true,
      availableStock: true,
      priceScore: true,
      deliveryScore: true,
      reliabilityScore: true,
      ratingScore: true,
      stockScore: true,
      totalScore: true,
      supplier: { select: { id: true, name: true } },
    },
  },
  purchaseOrder: { select: purchaseOrderViewSelect },
} satisfies Prisma.RequisitionSelect;

type RequisitionDetailRow = Prisma.RequisitionGetPayload<{
  select: typeof requisitionDetailSelect;
}>;

/**
 * Flattens the sourcing rows into the shape a client renders directly.
 *
 * SourcingDecision.selectedSupplierId is a plain column with no relation, so
 * the supplier's name is resolved from the ranked candidates rather than making
 * the client join the two lists itself.
 */
function toSourcingView(requisition: RequisitionDetailRow) {
  const supplierCandidates = requisition.supplierCandidates.map((candidate) => ({
    supplierId: candidate.supplierId,
    supplierName: candidate.supplier.name,
    rank: candidate.rank,
    eligible: candidate.eligible,
    ineligibleReason: candidate.ineligibleReason,
    unitPricePaise: candidate.unitPricePaise,
    deliveryDays: candidate.deliveryDays,
    availableStock: candidate.availableStock,
    scores: {
      price: candidate.priceScore,
      delivery: candidate.deliveryScore,
      reliability: candidate.reliabilityScore,
      rating: candidate.ratingScore,
      stock: candidate.stockScore,
      total: candidate.totalScore,
    },
  }));

  const decision = requisition.sourcingDecision;
  const winner = supplierCandidates.find(
    (candidate) => candidate.supplierId === decision?.selectedSupplierId,
  );

  const sourcing = decision
    ? {
        selectedSupplier: {
          id: decision.selectedSupplierId,
          name: winner?.supplierName ?? null,
        },
        selectedSupplierProductId: decision.selectedSupplierProductId,
        totalScore: decision.totalScore,
        candidatesEvaluated: decision.candidatesEvaluated,
        rationale: decision.rationale,
        decidedAt: decision.createdAt,
      }
    : null;

  return { sourcing, supplierCandidates };
}

export interface RequisitionChatResult {
  requisitionId: string;
  /**
   * The requisition's real status. Widened from the three conversational
   * statuses because a re-delivered job can legitimately find the requisition
   * already SUPPLIER_SELECTED, PO_CREATED or FAILED, and reporting one of those
   * as a clarification turn would be a lie.
   */
  status: RequisitionStatus;
  message: string;
  missingFields: string[];
  conflicts: string[];
  requirements: ReturnType<typeof toRequirementInput> | null;
}

/**
 * Creates a requisition and its first user message. Status starts at PROCESSING
 * because the extraction job is enqueued immediately afterwards.
 */
export async function createRequisition(params: {
  organizationId: string;
  userId: string;
  input: string;
}): Promise<{ id: string }> {
  const { organizationId, userId, input } = params;

  return prisma.$transaction(async (tx) => {
    const requisition = await tx.requisition.create({
      data: {
        organizationId,
        rawInput: input,
        createdBy: userId,
        status: RequisitionStatus.PROCESSING,
        draftRequirements: toJson({ ...EMPTY_DRAFT }),
        turnCount: 1,
        messages: {
          create: { organizationId, role: "USER", content: input },
        },
      },
      select: { id: true },
    });

    await recordAudit(tx, {
      organizationId,
      actorType: "USER",
      actorId: userId,
      action: "REQUISITION_CREATED",
      entityType: ENTITY_TYPE,
      entityId: requisition.id,
      metadata: { input },
    });

    return requisition;
  });
}

/**
 * Appends a follow-up user message to an existing conversation. Tenant-scoped
 * lookup — a requisition belonging to another organization is a 404, never a
 * cross-tenant read.
 */
export async function appendUserMessage(params: {
  organizationId: string;
  requisitionId: string;
  input: string;
}): Promise<{ id: string }> {
  const { organizationId, requisitionId, input } = params;

  const existing = await prisma.requisition.findFirst({
    where: { id: requisitionId, organizationId },
    select: { id: true, status: true },
  });

  if (!existing) {
    throw AppError.notFound("Requisition not found");
  }

  if (CLOSED_STATUSES.includes(existing.status)) {
    throw AppError.invalidState(
      `Requisition is ${existing.status} and no longer accepts messages`,
      { status: existing.status },
    );
  }

  return prisma.$transaction(async (tx) => {
    await tx.requisitionMessage.create({
      data: { organizationId, requisitionId, role: "USER", content: input },
    });

    return tx.requisition.update({
      where: { id: requisitionId },
      data: { status: RequisitionStatus.PROCESSING, turnCount: { increment: 1 } },
      select: { id: true },
    });
  });
}

/**
 * Applies a validated Gemini extraction to the conversation state. This is the
 * deterministic decision point: the AI's own completeness verdict is discarded
 * and recomputed from the merged draft before procurement is allowed to start.
 */
export async function applyExtractionResult(params: {
  organizationId: string;
  requisitionId: string;
  previousDraft: DraftRequirements;
  result: ExtractionResult;
}): Promise<RequisitionChatResult> {
  const { organizationId, requisitionId, previousDraft, result } = params;

  const draft = mergeDraft(previousDraft, result.extracted);
  const conflicts = normalizeConflicts(result.conflicts);
  const missingFields = findMissingFields(draft);
  const complete = isComplete(draft, conflicts);

  if (complete) {
    const requirements = toRequirementInput(draft);

    const applied = await prisma.$transaction(async (tx) => {
      // Claimed first, before any other write in this transaction. Guarded on
      // PROCESSING — the only status the worker may write out of — so a stalled
      // job redelivered after the requisition has been sourced cannot drag it
      // back to REQUIREMENTS_EXTRACTED and re-run discovery. Nothing else runs
      // when the claim finds nothing, so there is no write to roll back.
      const claimed = await tx.requisition.updateMany({
        where: { id: requisitionId, organizationId, status: RequisitionStatus.PROCESSING },
        data: {
          status: RequisitionStatus.REQUIREMENTS_EXTRACTED,
          draftRequirements: toJson(draft),
          clarificationMessage: COMPLETE_MESSAGE,
          missingFields: [],
          conflicts: [],
        },
      });

      if (claimed.count === 0) {
        return false;
      }

      await tx.requirement.upsert({
        where: { requisitionId },
        create: {
          requisitionId,
          productName: requirements.productName,
          quantity: requirements.quantity,
          maxUnitPricePaise: requirements.maxUnitPricePaise,
          currency: requirements.currency,
          deliveryDeadlineDays: requirements.deliveryDeadlineDays,
          deliveryLocation: requirements.deliveryLocation,
          specifications: toJson(requirements.specifications),
          missingFields: [],
          rawExtraction: toJson(result),
        },
        update: {
          productName: requirements.productName,
          quantity: requirements.quantity,
          maxUnitPricePaise: requirements.maxUnitPricePaise,
          currency: requirements.currency,
          deliveryDeadlineDays: requirements.deliveryDeadlineDays,
          deliveryLocation: requirements.deliveryLocation,
          specifications: toJson(requirements.specifications),
          missingFields: [],
          rawExtraction: toJson(result),
        },
      });

      await tx.requisitionMessage.create({
        data: { organizationId, requisitionId, role: "ASSISTANT", content: COMPLETE_MESSAGE },
      });

      await recordAudit(tx, {
        organizationId,
        actorType: "AI",
        action: "REQUIREMENTS_EXTRACTED",
        entityType: ENTITY_TYPE,
        entityId: requisitionId,
        metadata: { requirements: toJson(requirements) },
      });

      return true;
    });

    if (!applied) {
      return currentStateResult({ organizationId, requisitionId });
    }

    return {
      requisitionId,
      status: "REQUIREMENTS_EXTRACTED",
      message: COMPLETE_MESSAGE,
      missingFields: [],
      conflicts: [],
      requirements,
    };
  }

  // Prefer Gemini's phrasing, but only when it is coherent with what we
  // deterministically know is still missing.
  const fallback = buildClarificationMessage(result.intent, missingFields, conflicts);
  const message = isUsableClarification(result.userMessage) ? result.userMessage : fallback;

  const applied = await prisma.$transaction(async (tx) => {
    const claimed = await tx.requisition.updateMany({
      where: { id: requisitionId, organizationId, status: RequisitionStatus.PROCESSING },
      data: {
        status: RequisitionStatus.NEEDS_CLARIFICATION,
        draftRequirements: toJson(draft),
        clarificationMessage: message,
        missingFields,
        conflicts,
      },
    });

    if (claimed.count === 0) {
      return false;
    }

    await tx.requisitionMessage.create({
      data: { organizationId, requisitionId, role: "ASSISTANT", content: message },
    });

    await recordAudit(tx, {
      organizationId,
      actorType: "AI",
      action: "REQUISITION_CLARIFICATION_REQUESTED",
      entityType: ENTITY_TYPE,
      entityId: requisitionId,
      metadata: { intent: result.intent, missingFields, conflicts },
    });

    return true;
  });

  if (!applied) {
    return currentStateResult({ organizationId, requisitionId });
  }

  return {
    requisitionId,
    status: "NEEDS_CLARIFICATION",
    message,
    missingFields,
    conflicts,
    requirements: null,
  };
}

/**
 * Records a clarification turn we produced ourselves, without a usable model
 * response (malformed JSON or a failed Gemini call on the final attempt). Keeps
 * the conversation alive instead of dead-ending it.
 */
export async function applyFallbackClarification(params: {
  organizationId: string;
  requisitionId: string;
  draft: DraftRequirements;
  reason: string;
}): Promise<RequisitionChatResult> {
  const { organizationId, requisitionId, draft, reason } = params;

  const missingFields = findMissingFields(draft);
  const message = buildClarificationMessage("UNCLEAR", missingFields, []);

  const applied = await prisma.$transaction(async (tx) => {
    const claimed = await tx.requisition.updateMany({
      where: { id: requisitionId, organizationId, status: RequisitionStatus.PROCESSING },
      data: {
        status: RequisitionStatus.NEEDS_CLARIFICATION,
        clarificationMessage: message,
        missingFields,
        conflicts: [],
        failureReason: reason,
      },
    });

    // This runs inside the worker's terminal failure handler. Throwing here
    // would escape that handler and turn a handled degradation into an
    // unhandled job failure, so a lost claim reports state instead.
    if (claimed.count === 0) {
      return false;
    }

    await tx.requisitionMessage.create({
      data: { organizationId, requisitionId, role: "ASSISTANT", content: message },
    });

    await recordAudit(tx, {
      organizationId,
      actorType: "SYSTEM",
      action: "REQUISITION_CLARIFICATION_REQUESTED",
      entityType: ENTITY_TYPE,
      entityId: requisitionId,
      metadata: { reason },
    });

    // This is the terminal branch of a technical failure (Gemini outage or
    // malformed output on the final retry attempt) — every other stage logs
    // WORKFLOW_FAILED here. Recorded alongside, not instead of, the
    // REQUISITION_CLARIFICATION_REQUESTED row above: that one drives the
    // user-facing message, this one makes the failure itself auditable
    // (distinguishable from a genuine AI clarification, which shares the
    // same action but carries actorType AI, not SYSTEM).
    await recordAudit(tx, {
      organizationId,
      actorType: "SYSTEM",
      action: "WORKFLOW_FAILED",
      entityType: ENTITY_TYPE,
      entityId: requisitionId,
      metadata: { stage: "requisition", reason },
    });

    return true;
  });

  if (!applied) {
    return currentStateResult({ organizationId, requisitionId });
  }

  return {
    requisitionId,
    status: "NEEDS_CLARIFICATION",
    message,
    missingFields,
    conflicts: [],
    requirements: null,
  };
}

/** A model reply that leaked schema field names is unusable as user-facing copy. */
function isUsableClarification(message: string): boolean {
  if (message.trim().length === 0) {
    return false;
  }
  return !/\b(maxUnitPricePaise|deliveryDays|productName|missingRequiredFields|null)\b/.test(
    message,
  );
}

/**
 * The conversational reply for a requisition this job is no longer allowed to
 * write to.
 *
 * A lost claim is not an error: another turn, or another delivery of this job,
 * legitimately moved the requisition on. Throwing here would escape the worker
 * uncaught, burn BullMQ's remaining attempts on more Gemini calls, and surface
 * to the caller of POST /requisitions as a 500 — so the current state is
 * reported instead, exactly as the supplier-discovery worker does for its own
 * lost claim.
 */
async function currentStateResult(params: {
  organizationId: string;
  requisitionId: string;
}): Promise<RequisitionChatResult> {
  const current = await prisma.requisition.findFirst({
    where: { id: params.requisitionId, organizationId: params.organizationId },
    select: { status: true, clarificationMessage: true, missingFields: true, conflicts: true },
  });

  if (!current) {
    throw AppError.notFound("Requisition not found");
  }

  return {
    requisitionId: params.requisitionId,
    status: current.status,
    message: current.clarificationMessage ?? `Requisition is ${current.status}.`,
    missingFields: current.missingFields,
    conflicts: current.conflicts,
    requirements: null,
  };
}

export async function loadRequisitionForProcessing(params: {
  organizationId: string;
  requisitionId: string;
}) {
  const requisition = await prisma.requisition.findFirst({
    where: { id: params.requisitionId, organizationId: params.organizationId },
    select: requisitionSelect,
  });

  if (!requisition) {
    throw AppError.notFound("Requisition not found");
  }

  return requisition;
}

export async function getRequisition(params: { organizationId: string; requisitionId: string }) {
  const requisition = await prisma.requisition.findFirst({
    where: { id: params.requisitionId, organizationId: params.organizationId },
    select: requisitionDetailSelect,
  });

  if (!requisition) {
    throw AppError.notFound("Requisition not found");
  }

  const {
    sourcingDecision: _decision,
    supplierCandidates: _candidates,
    purchaseOrder,
    ...rest
  } = requisition;

  return {
    ...rest,
    // Inlined so the frontend can tell from this one response that a purchase
    // order exists and whether it is waiting for approval, without a second call.
    purchaseOrder,
    draftRequirements: parseDraft(requisition.draftRequirements),
    ...toSourcingView(requisition),
  };
}

export async function listRequisitions(params: {
  organizationId: string;
  status?: RequisitionStatus;
  limit: number;
  cursor?: string;
}) {
  const { organizationId, status, limit, cursor } = params;

  const items = await prisma.requisition.findMany({
    where: { organizationId, ...(status ? { status } : {}) },
    select: {
      id: true,
      rawInput: true,
      status: true,
      clarificationMessage: true,
      missingFields: true,
      conflicts: true,
      turnCount: true,
      createdAt: true,
      updatedAt: true,
    },
    // createdAt alone is not unique, so a page boundary landing inside a tie
    // could repeat or skip rows; id breaks the tie deterministically.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;

  return {
    items: page,
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}
