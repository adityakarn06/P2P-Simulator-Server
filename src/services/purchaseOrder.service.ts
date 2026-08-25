import { createHash } from "node:crypto";
import { prisma } from "../config/prisma.js";
import type { Prisma } from "../generated/prisma/client.js";
import {
  ExceptionType,
  PurchaseOrderStatus,
  RequisitionStatus,
  ShipmentStatus,
} from "../generated/prisma/enums.js";
import type { PurchaseOrderLine } from "../rules/approvalRules.js";
import { AppError } from "../utils/AppError.js";
import {
  PURCHASE_ORDER_ENTITY,
  REQUISITION_ENTITY,
  recordAudit,
  SHIPMENT_ENTITY,
} from "./audit.service.js";
import { recordException, resolveException } from "./exception.service.js";

// ---------------------------------------------------------------------------
// Read shapes
// ---------------------------------------------------------------------------

/** The PO shape every read path returns — the API, and the requisition detail. */
export const purchaseOrderViewSelect = {
  id: true,
  poNumber: true,
  status: true,
  requisitionId: true,
  supplierId: true,
  subtotalPaise: true,
  taxPaise: true,
  totalPaise: true,
  taxRateBps: true,
  currency: true,
  expectedDeliveryDate: true,
  approvedAt: true,
  approvedBy: true,
  rejectedAt: true,
  rejectionReason: true,
  createdAt: true,
  updatedAt: true,
  supplier: { select: { id: true, name: true } },
  items: {
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      productId: true,
      supplierProductId: true,
      description: true,
      quantity: true,
      unitPricePaise: true,
      lineTotalPaise: true,
    },
  },
} satisfies Prisma.PurchaseOrderSelect;

export const shipmentViewSelect = {
  id: true,
  purchaseOrderId: true,
  trackingNumber: true,
  carrier: true,
  status: true,
  shippedAt: true,
  deliveredAt: true,
  expectedDeliveryDate: true,
  createdAt: true,
} satisfies Prisma.ShipmentSelect;

export type PurchaseOrderView = Prisma.PurchaseOrderGetPayload<{
  select: typeof purchaseOrderViewSelect;
}>;
export type ShipmentView = Prisma.ShipmentGetPayload<{ select: typeof shipmentViewSelect }>;

export interface PurchaseOrderWithShipment {
  purchaseOrder: PurchaseOrderView;
  shipment: ShipmentView | null;
}

// ---------------------------------------------------------------------------
// Loads for the worker
// ---------------------------------------------------------------------------

const requisitionForPOSelect = {
  id: true,
  organizationId: true,
  status: true,
  requirement: true,
  sourcingDecision: {
    select: { selectedSupplierId: true, selectedSupplierProductId: true },
  },
  purchaseOrder: { select: { id: true, status: true } },
} satisfies Prisma.RequisitionSelect;

export type RequisitionForPO = Prisma.RequisitionGetPayload<{
  select: typeof requisitionForPOSelect;
}>;

/** Tenant-scoped load. A requisition owned by another organization is a 404, never a cross-tenant read. */
export async function loadRequisitionForPO(params: {
  organizationId: string;
  requisitionId: string;
}): Promise<RequisitionForPO> {
  const requisition = await prisma.requisition.findFirst({
    where: { id: params.requisitionId, organizationId: params.organizationId },
    select: requisitionForPOSelect,
  });

  if (!requisition) {
    throw AppError.notFound("Requisition not found");
  }

  return requisition;
}

/**
 * Current requisition outcome, for reporting what actually happened after a
 * write was refused. A guarded claim tells us only that we lost — never what
 * the winner decided — so the status is re-read rather than assumed.
 */
export async function loadRequisitionOutcome(params: {
  organizationId: string;
  requisitionId: string;
}): Promise<{ status: RequisitionStatus; purchaseOrderId: string | null }> {
  const requisition = await prisma.requisition.findFirst({
    where: { id: params.requisitionId, organizationId: params.organizationId },
    select: { status: true, purchaseOrder: { select: { id: true } } },
  });

  if (!requisition) {
    throw AppError.notFound("Requisition not found");
  }

  return {
    status: requisition.status,
    purchaseOrderId: requisition.purchaseOrder?.id ?? null,
  };
}

const selectedOfferSelect = {
  id: true,
  unitPricePaise: true,
  currency: true,
  stockQuantity: true,
  deliveryDays: true,
  minOrderQuantity: true,
  product: { select: { id: true, name: true, sku: true, unit: true } },
  supplier: {
    select: { id: true, name: true, isActive: true, rating: true, reliabilityScore: true },
  },
} satisfies Prisma.SupplierProductSelect;

export type SelectedOffer = Prisma.SupplierProductGetPayload<{
  select: typeof selectedOfferSelect;
}>;

/**
 * Re-reads the chosen offer at PO time.
 *
 * SourcingDecision stores the supplier and supplier-product as plain columns
 * with no relations, so this is an explicit query rather than an include. It is
 * scoped through the supplier relation because SupplierProduct carries no
 * organizationId of its own. Returns null when either row has since been
 * deleted, or the supplier belongs to a different tenant.
 */
export function loadSelectedOffer(params: {
  organizationId: string;
  supplierId: string;
  supplierProductId: string;
}): Promise<SelectedOffer | null> {
  return prisma.supplierProduct.findFirst({
    where: {
      id: params.supplierProductId,
      supplierId: params.supplierId,
      supplier: { organizationId: params.organizationId },
    },
    select: selectedOfferSelect,
  });
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

function yyyymmdd(date: Date): string {
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}

/**
 * Deterministic fixed-width suffix over the *whole* id.
 *
 * SHA-256 rather than a short non-cryptographic hash: the suffix is the only
 * thing distinguishing two purchase orders issued on the same day within one
 * organization, and a collision there is unrecoverable — the number is a pure
 * function of the id, so every retry regenerates the same colliding value and
 * @@unique([organizationId, poNumber]) rejects the insert forever. At the
 * widths used below the digest space is large enough (>2^60) that a collision
 * is not a practical concern, while a retry still reproduces the value exactly.
 *
 * Base36 keeps the output alphanumeric and human-readable on a printed PO.
 */
function idSuffix(id: string, length: number): string {
  const digest = createHash("sha256").update(id, "utf8").digest("hex");
  return BigInt(`0x${digest}`).toString(36).toUpperCase().padStart(length, "0").slice(0, length);
}

/**
 * Derived from the requisition id, which is already unique, so a retried job
 * regenerates the identical number instead of racing
 * @@unique([organizationId, poNumber]) with a fresh random suffix.
 */
export function buildPoNumber(requisitionId: string, now: Date): string {
  return `PO-${yyyymmdd(now)}-${idSuffix(requisitionId, 12)}`;
}

/** Same reasoning as buildPoNumber, against @@unique([organizationId, trackingNumber]). */
export function buildTrackingNumber(purchaseOrderId: string): string {
  return `TRK-${idSuffix(purchaseOrderId, 16)}`;
}

export function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Worker writes
// ---------------------------------------------------------------------------

export interface CreatePurchaseOrderInput {
  organizationId: string;
  requisitionId: string;
  supplierId: string;
  poNumber: string;
  status: typeof PurchaseOrderStatus.PENDING_APPROVAL | typeof PurchaseOrderStatus.APPROVED;
  approvalReason: string;
  currency: string;
  subtotalPaise: number;
  taxPaise: number;
  totalPaise: number;
  taxRateBps: number;
  expectedDeliveryDate: Date;
  items: PurchaseOrderLine[];
}

/**
 * Creates the shipment for an approved purchase order, or returns the existing
 * one untouched.
 *
 * The empty `update` is deliberate: Shipment.purchaseOrderId is unique, so a
 * second approval reuses the row rather than dragging an already-DELIVERED
 * shipment back to IN_TRANSIT.
 */
function createShipment(
  tx: Pick<Prisma.TransactionClient, "shipment">,
  params: { organizationId: string; purchaseOrderId: string; expectedDeliveryDate: Date | null },
): Promise<ShipmentView> {
  return tx.shipment.upsert({
    where: { purchaseOrderId: params.purchaseOrderId },
    create: {
      organizationId: params.organizationId,
      purchaseOrderId: params.purchaseOrderId,
      trackingNumber: buildTrackingNumber(params.purchaseOrderId),
      status: ShipmentStatus.IN_TRANSIT,
      shippedAt: new Date(),
      expectedDeliveryDate: params.expectedDeliveryDate,
    },
    update: {},
    select: shipmentViewSelect,
  });
}

/**
 * Persists a generated purchase order atomically: the requisition transition,
 * the PO, its items, the approval exception and every audit row commit together
 * or not at all.
 */
export async function applyPurchaseOrderCreation(
  input: CreatePurchaseOrderInput,
): Promise<PurchaseOrderView> {
  const { organizationId, requisitionId } = input;

  return prisma.$transaction(async (tx) => {
    // Claim the transition first. Two concurrent purchase-order jobs can both
    // pass the worker's status check before either commits; guarding the update
    // on the expected status means the loser writes nothing at all instead of
    // creating a second purchase order for the same requisition.
    const claimed = await tx.requisition.updateMany({
      where: { id: requisitionId, status: RequisitionStatus.SUPPLIER_SELECTED },
      data: { status: RequisitionStatus.PO_CREATED, failureReason: null },
    });

    if (claimed.count === 0) {
      throw AppError.conflict("Purchase order was created concurrently", { requisitionId });
    }

    const purchaseOrder = await tx.purchaseOrder.create({
      data: {
        organizationId,
        requisitionId,
        supplierId: input.supplierId,
        poNumber: input.poNumber,
        status: input.status,
        currency: input.currency,
        subtotalPaise: input.subtotalPaise,
        taxPaise: input.taxPaise,
        totalPaise: input.totalPaise,
        taxRateBps: input.taxRateBps,
        expectedDeliveryDate: input.expectedDeliveryDate,
        ...(input.status === PurchaseOrderStatus.APPROVED
          ? { approvedAt: new Date(), approvedBy: null }
          : {}),
        // Nested create: a rollback can never leave an item-less purchase order.
        items: {
          create: input.items.map((item) => ({
            productId: item.productId,
            supplierProductId: item.supplierProductId,
            description: item.description,
            quantity: item.quantity,
            unitPricePaise: item.unitPricePaise,
            lineTotalPaise: item.lineTotalPaise,
          })),
        },
      },
      select: purchaseOrderViewSelect,
    });

    await recordAudit(tx, {
      organizationId,
      actorType: "SYSTEM",
      action: "PO_CREATED",
      entityType: PURCHASE_ORDER_ENTITY,
      entityId: purchaseOrder.id,
      metadata: {
        requisitionId,
        supplierId: input.supplierId,
        poNumber: input.poNumber,
        status: input.status,
        subtotalPaise: input.subtotalPaise,
        taxPaise: input.taxPaise,
        totalPaise: input.totalPaise,
      },
    });

    if (input.status === PurchaseOrderStatus.APPROVED) {
      // Auto-approval skips the human endpoint, so the shipment and the
      // approval audits have to be written here — otherwise an auto-approved PO
      // would sit APPROVED forever with nothing for the receipt flow to act on.
      const shipment = await createShipment(tx, {
        organizationId,
        purchaseOrderId: purchaseOrder.id,
        expectedDeliveryDate: purchaseOrder.expectedDeliveryDate,
      });

      await recordAudit(tx, {
        organizationId,
        actorType: "SYSTEM",
        action: "PO_APPROVED",
        entityType: PURCHASE_ORDER_ENTITY,
        entityId: purchaseOrder.id,
        metadata: { poNumber: input.poNumber, reason: input.approvalReason, auto: true },
      });

      await recordAudit(tx, {
        organizationId,
        actorType: "SYSTEM",
        action: "SHIPMENT_CREATED",
        entityType: SHIPMENT_ENTITY,
        entityId: shipment.id,
        metadata: { purchaseOrderId: purchaseOrder.id, trackingNumber: shipment.trackingNumber },
      });
    }

    if (input.status === PurchaseOrderStatus.PENDING_APPROVAL) {
      // Upserted on [organizationId, type, entityId], so a redriven job cannot
      // open the same approval request twice.
      await recordException(tx, {
        organizationId,
        type: ExceptionType.PO_APPROVAL_REQUIRED,
        severity: "WARNING",
        entityType: PURCHASE_ORDER_ENTITY,
        entityId: purchaseOrder.id,
        title: `Purchase order ${input.poNumber} needs approval`,
        description: input.approvalReason,
        metadata: { requisitionId, totalPaise: input.totalPaise },
      });
    }

    return purchaseOrder;
  });
}

/**
 * Terminal failure path for PO generation, mirroring applySourcingFailure: the
 * requisition stops at FAILED with a readable reason and an exception a human
 * can pick up, rather than sitting in SUPPLIER_SELECTED with nothing driving it.
 *
 * Returns false when the requisition has already moved on. A redriven job can
 * re-read a SupplierProduct whose stock the winning job just consumed and
 * conclude the supplier no longer qualifies; without the guard it would mark a
 * requisition FAILED that already carries a valid purchase order.
 */
export async function applyPurchaseOrderFailure(params: {
  organizationId: string;
  requisitionId: string;
  reason: string;
  exceptionType: typeof ExceptionType.NO_SUPPLIER_FOUND | typeof ExceptionType.SYSTEM_FAILURE;
  metadata?: Prisma.InputJsonValue;
}): Promise<boolean> {
  const { organizationId, requisitionId, reason, exceptionType, metadata } = params;

  return prisma.$transaction(async (tx) => {
    const claimed = await tx.requisition.updateMany({
      where: {
        id: requisitionId,
        organizationId,
        status: RequisitionStatus.SUPPLIER_SELECTED,
      },
      data: { status: RequisitionStatus.FAILED, failureReason: reason },
    });

    if (claimed.count === 0) {
      return false;
    }

    await recordException(tx, {
      organizationId,
      type: exceptionType,
      severity: "CRITICAL",
      entityType: REQUISITION_ENTITY,
      entityId: requisitionId,
      title:
        exceptionType === ExceptionType.NO_SUPPLIER_FOUND
          ? "Selected supplier can no longer fulfil the requirement"
          : "Purchase order generation failed",
      description: reason,
      ...(metadata !== undefined ? { metadata } : {}),
    });

    await recordAudit(tx, {
      organizationId,
      actorType: "SYSTEM",
      action: "WORKFLOW_FAILED",
      entityType: REQUISITION_ENTITY,
      entityId: requisitionId,
      metadata: { stage: "purchase-order", reason },
    });

    return true;
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function findPurchaseOrder(params: {
  organizationId: string;
  purchaseOrderId: string;
}): Promise<PurchaseOrderView> {
  const purchaseOrder = await prisma.purchaseOrder.findFirst({
    where: { id: params.purchaseOrderId, organizationId: params.organizationId },
    select: purchaseOrderViewSelect,
  });

  if (!purchaseOrder) {
    // A purchase order owned by another organization is a 404, not a 403 —
    // a 403 would confirm that the id exists.
    throw AppError.notFound("Purchase order not found");
  }

  return purchaseOrder;
}

function findShipment(purchaseOrderId: string): Promise<ShipmentView | null> {
  return prisma.shipment.findUnique({
    where: { purchaseOrderId },
    select: shipmentViewSelect,
  });
}

export async function getPurchaseOrder(params: {
  organizationId: string;
  purchaseOrderId: string;
}): Promise<PurchaseOrderWithShipment> {
  const purchaseOrder = await findPurchaseOrder(params);
  return { purchaseOrder, shipment: await findShipment(purchaseOrder.id) };
}

export async function listPurchaseOrders(params: {
  organizationId: string;
  status?: PurchaseOrderStatus;
  limit: number;
  cursor?: string;
}) {
  const { organizationId, status, limit, cursor } = params;

  const items = await prisma.purchaseOrder.findMany({
    where: { organizationId, ...(status ? { status } : {}) },
    select: purchaseOrderViewSelect,
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

// ---------------------------------------------------------------------------
// Documents (PDF rendering and generated-invoice creation)
// ---------------------------------------------------------------------------

/**
 * Shared by the PO PDF renderer (src/pdf/documents/purchaseOrder.pdf.ts) and
 * generateInvoiceForPurchaseOrder (src/services/invoice.service.ts) — both
 * need the same supplier contact block and item lines, so one select and one
 * loader serve both rather than drifting apart as two near-identical copies.
 */
const purchaseOrderForDocumentsSelect = {
  id: true,
  poNumber: true,
  status: true,
  currency: true,
  taxRateBps: true,
  supplierId: true,
  subtotalPaise: true,
  taxPaise: true,
  totalPaise: true,
  expectedDeliveryDate: true,
  approvedAt: true,
  approvedBy: true,
  createdAt: true,
  organization: { select: { name: true } },
  supplier: { select: { name: true, email: true, phone: true } },
  items: {
    // createdAt alone does not order nested-created rows deterministically —
    // they can share one timestamp — so id breaks the tie, same as
    // goodsReceiptViewSelect in src/services/receipt.service.ts.
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      productId: true,
      description: true,
      quantity: true,
      unitPricePaise: true,
      lineTotalPaise: true,
    },
  },
} satisfies Prisma.PurchaseOrderSelect;

export type PurchaseOrderForDocuments = Prisma.PurchaseOrderGetPayload<{
  select: typeof purchaseOrderForDocumentsSelect;
}>;

/** Tenant-scoped read of everything the PO PDF renderer and generated-invoice creation need. */
export async function loadPurchaseOrderForDocuments(params: {
  organizationId: string;
  purchaseOrderId: string;
}): Promise<PurchaseOrderForDocuments> {
  const purchaseOrder = await prisma.purchaseOrder.findFirst({
    where: { id: params.purchaseOrderId, organizationId: params.organizationId },
    select: purchaseOrderForDocumentsSelect,
  });

  if (!purchaseOrder) {
    throw AppError.notFound("Purchase order not found");
  }

  return purchaseOrder;
}

// ---------------------------------------------------------------------------
// Approval / rejection
// ---------------------------------------------------------------------------

/** Statuses past APPROVED — the receipt flow owns them, approval cannot revisit them. */
const POST_APPROVAL_STATUSES: PurchaseOrderStatus[] = [
  PurchaseOrderStatus.SHIPPED,
  PurchaseOrderStatus.RECEIVED,
  PurchaseOrderStatus.COMPLETED,
];

/**
 * Closes the PO_APPROVAL_REQUIRED exception opened at creation, once a human
 * has decided. The audit is written only when a row actually moved, so a
 * repeated approval does not append a second resolution.
 */
async function closeApprovalException(
  tx: Pick<Prisma.TransactionClient, "exception" | "auditLog">,
  params: {
    organizationId: string;
    purchaseOrderId: string;
    resolution: string;
    resolutionReason: string;
    resolvedBy: string;
  },
): Promise<void> {
  const resolved = await resolveException(tx, {
    organizationId: params.organizationId,
    type: ExceptionType.PO_APPROVAL_REQUIRED,
    entityId: params.purchaseOrderId,
    resolution: params.resolution,
    resolutionReason: params.resolutionReason,
    resolvedBy: params.resolvedBy,
  });

  if (resolved === 0) {
    return;
  }

  await recordAudit(tx, {
    organizationId: params.organizationId,
    actorType: "USER",
    actorId: params.resolvedBy,
    action: "EXCEPTION_RESOLVED",
    entityType: PURCHASE_ORDER_ENTITY,
    entityId: params.purchaseOrderId,
    metadata: { type: ExceptionType.PO_APPROVAL_REQUIRED, resolution: params.resolution },
  });
}

/**
 * Approves a purchase order and puts its shipment in transit.
 *
 * Idempotent by design: an already-APPROVED purchase order returns its existing
 * shipment unchanged and writes no second audit row, so a double-clicking client
 * cannot create two shipments. REJECTED is a conflict, never a silent re-open.
 */
export async function approvePurchaseOrder(params: {
  organizationId: string;
  purchaseOrderId: string;
  userId: string;
}): Promise<PurchaseOrderWithShipment> {
  const { organizationId, purchaseOrderId, userId } = params;
  const existing = await findPurchaseOrder({ organizationId, purchaseOrderId });

  if (existing.status === PurchaseOrderStatus.APPROVED) {
    return { purchaseOrder: existing, shipment: await findShipment(existing.id) };
  }

  assertApprovable(existing.status);

  return prisma.$transaction(async (tx) => {
    // Guarded so two concurrent approvals cannot both transition it.
    const claimed = await tx.purchaseOrder.updateMany({
      where: { id: purchaseOrderId, status: PurchaseOrderStatus.PENDING_APPROVAL },
      data: {
        status: PurchaseOrderStatus.APPROVED,
        approvedAt: new Date(),
        approvedBy: userId,
        rejectedAt: null,
        rejectionReason: null,
      },
    });

    if (claimed.count === 0) {
      throw AppError.conflict("Purchase order was updated concurrently", { purchaseOrderId });
    }

    const purchaseOrder = await tx.purchaseOrder.findUniqueOrThrow({
      where: { id: purchaseOrderId },
      select: purchaseOrderViewSelect,
    });

    const shipment = await createShipment(tx, {
      organizationId,
      purchaseOrderId,
      expectedDeliveryDate: purchaseOrder.expectedDeliveryDate,
    });

    await recordAudit(tx, {
      organizationId,
      actorType: "USER",
      actorId: userId,
      action: "PO_APPROVED",
      entityType: PURCHASE_ORDER_ENTITY,
      entityId: purchaseOrderId,
      metadata: { poNumber: purchaseOrder.poNumber, totalPaise: purchaseOrder.totalPaise },
    });

    await recordAudit(tx, {
      organizationId,
      actorType: "SYSTEM",
      action: "SHIPMENT_CREATED",
      entityType: SHIPMENT_ENTITY,
      entityId: shipment.id,
      metadata: { purchaseOrderId, trackingNumber: shipment.trackingNumber },
    });

    await closeApprovalException(tx, {
      organizationId,
      purchaseOrderId,
      resolution: "APPROVED",
      resolutionReason: "Purchase order approved",
      resolvedBy: userId,
    });

    return { purchaseOrder, shipment };
  });
}

function assertApprovable(status: PurchaseOrderStatus): void {
  if (status === PurchaseOrderStatus.REJECTED) {
    throw AppError.invalidState("A rejected purchase order cannot be approved", { status });
  }
  if (status === PurchaseOrderStatus.DRAFT) {
    throw AppError.invalidState("A draft purchase order is not ready for approval", { status });
  }
  if (POST_APPROVAL_STATUSES.includes(status)) {
    throw AppError.invalidState(`A ${status} purchase order can no longer be approved`, { status });
  }
}

/**
 * Rejects a purchase order. Creates no shipment and enqueues nothing — the
 * workflow stops here, and the requisition is marked FAILED so the frontend
 * does not have to infer the outcome from the purchase order alone.
 */
export async function rejectPurchaseOrder(params: {
  organizationId: string;
  purchaseOrderId: string;
  userId: string;
  reason: string;
}): Promise<PurchaseOrderWithShipment> {
  const { organizationId, purchaseOrderId, userId, reason } = params;
  const existing = await findPurchaseOrder({ organizationId, purchaseOrderId });

  if (existing.status === PurchaseOrderStatus.REJECTED) {
    return { purchaseOrder: existing, shipment: null };
  }

  assertRejectable(existing.status);

  return prisma.$transaction(async (tx) => {
    const claimed = await tx.purchaseOrder.updateMany({
      where: { id: purchaseOrderId, status: PurchaseOrderStatus.PENDING_APPROVAL },
      data: {
        status: PurchaseOrderStatus.REJECTED,
        rejectedAt: new Date(),
        rejectionReason: reason,
      },
    });

    if (claimed.count === 0) {
      throw AppError.conflict("Purchase order was updated concurrently", { purchaseOrderId });
    }

    const purchaseOrder = await tx.purchaseOrder.findUniqueOrThrow({
      where: { id: purchaseOrderId },
      select: purchaseOrderViewSelect,
    });

    await tx.requisition.update({
      where: { id: purchaseOrder.requisitionId },
      data: {
        status: RequisitionStatus.FAILED,
        failureReason: `Purchase order rejected: ${reason}`,
      },
    });

    await recordAudit(tx, {
      organizationId,
      actorType: "USER",
      actorId: userId,
      action: "PO_REJECTED",
      entityType: PURCHASE_ORDER_ENTITY,
      entityId: purchaseOrderId,
      metadata: { reason },
    });

    await closeApprovalException(tx, {
      organizationId,
      purchaseOrderId,
      resolution: "REJECTED",
      resolutionReason: reason,
      resolvedBy: userId,
    });

    return { purchaseOrder, shipment: null };
  });
}

function assertRejectable(status: PurchaseOrderStatus): void {
  if (status === PurchaseOrderStatus.APPROVED) {
    throw AppError.invalidState("An approved purchase order cannot be rejected", { status });
  }
  if (status === PurchaseOrderStatus.DRAFT) {
    throw AppError.invalidState("A draft purchase order is not ready for approval", { status });
  }
  if (POST_APPROVAL_STATUSES.includes(status)) {
    throw AppError.invalidState(`A ${status} purchase order can no longer be rejected`, { status });
  }
}
