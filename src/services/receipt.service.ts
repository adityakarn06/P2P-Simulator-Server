import { prisma } from "../config/prisma.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { ActorType, GoodsReceiptStatus } from "../generated/prisma/enums.js";
import { PurchaseOrderStatus, ShipmentStatus } from "../generated/prisma/enums.js";
import {
  buildReceiptLines,
  type ReceiptLine,
  type ReceiptQuantities,
  receiptStatus,
} from "../rules/receiptRules.js";
import {
  computeReliabilityScore,
  type DeliveryObservation,
  deliveryDeltas,
  nextAverageLeadTime,
} from "../rules/supplierPerformance.js";
import { AppError } from "../utils/AppError.js";
import { GOODS_RECEIPT_ENTITY, recordAudit, SUPPLIER_ENTITY } from "./audit.service.js";
import {
  type PurchaseOrderView,
  purchaseOrderViewSelect,
  type ShipmentView,
  shipmentViewSelect,
} from "./purchaseOrder.service.js";

/** Purchase-order statuses a delivery may be received against. */
const RECEIVABLE_PO_STATUSES: PurchaseOrderStatus[] = [
  PurchaseOrderStatus.APPROVED,
  // Nothing writes SHIPPED today — approval leaves the purchase order APPROVED
  // with its shipment IN_TRANSIT. Accepted here so a future shipping step needs
  // no change to the receipt flow.
  PurchaseOrderStatus.SHIPPED,
];

// ---------------------------------------------------------------------------
// Read shapes
// ---------------------------------------------------------------------------

export const goodsReceiptViewSelect = {
  id: true,
  purchaseOrderId: true,
  shipmentId: true,
  status: true,
  receivedAt: true,
  receivedBy: true,
  notes: true,
  createdAt: true,
  items: {
    // Every nested-created row shares one createdAt, so the timestamp alone
    // leaves the order to the database; id breaks the tie deterministically.
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      purchaseOrderItemId: true,
      productId: true,
      orderedQuantity: true,
      receivedQuantity: true,
      damagedQuantity: true,
      acceptedQuantity: true,
    },
  },
} satisfies Prisma.GoodsReceiptSelect;

export type GoodsReceiptView = Prisma.GoodsReceiptGetPayload<{
  select: typeof goodsReceiptViewSelect;
}>;

export interface ShipmentWithReceipt {
  shipment: ShipmentView;
  goodsReceipt: GoodsReceiptView | null;
}

export interface GoodsReceiptResult extends ShipmentWithReceipt {
  goodsReceipt: GoodsReceiptView;
  purchaseOrder: PurchaseOrderView;
  /** False when an identical receipt already existed — the caller answers 200 rather than 201. */
  created: boolean;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const shipmentWithContextSelect = {
  ...shipmentViewSelect,
  goodsReceipt: { select: goodsReceiptViewSelect },
  purchaseOrder: {
    select: {
      id: true,
      status: true,
      supplierId: true,
      // Start of the lead-time clock: the supplier could not ship before the
      // buyer approved. Falls back to the PO's creation in updateSupplierPerformance.
      approvedAt: true,
      createdAt: true,
      items: {
        orderBy: { createdAt: "asc" },
        select: { id: true, productId: true, quantity: true },
      },
    },
  },
} satisfies Prisma.ShipmentSelect;

type ShipmentWithContext = Prisma.ShipmentGetPayload<{ select: typeof shipmentWithContextSelect }>;

async function findShipment(params: {
  organizationId: string;
  shipmentId: string;
}): Promise<ShipmentWithContext> {
  const shipment = await prisma.shipment.findFirst({
    where: { id: params.shipmentId, organizationId: params.organizationId },
    select: shipmentWithContextSelect,
  });

  if (!shipment) {
    // A shipment owned by another organization is a 404, not a 403 — a 403
    // would confirm that the id exists.
    throw AppError.notFound("Shipment not found");
  }

  return shipment;
}

/** Splits the loaded row into the public shipment view and its context. */
function toShipmentView(shipment: ShipmentWithContext): ShipmentView {
  const { goodsReceipt: _receipt, purchaseOrder: _po, ...view } = shipment;
  return view;
}

export async function getShipment(params: {
  organizationId: string;
  shipmentId: string;
}): Promise<ShipmentWithReceipt> {
  const shipment = await findShipment(params);
  return { shipment: toShipmentView(shipment), goodsReceipt: shipment.goodsReceipt };
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

// GoodsReceipt has no `purchaseOrder` relation of its own, only the scalar
// purchaseOrderId — but every shipment carries exactly one purchase order, so
// poNumber is reached through the shipment instead.
const shipmentListSelect = {
  ...shipmentViewSelect,
  purchaseOrder: { select: { poNumber: true } },
} satisfies Prisma.ShipmentSelect;

type ShipmentListRow = Prisma.ShipmentGetPayload<{ select: typeof shipmentListSelect }>;

export interface ShipmentListItem extends ShipmentView {
  poNumber: string;
}

function toShipmentListItem(row: ShipmentListRow): ShipmentListItem {
  const { purchaseOrder, ...view } = row;
  return { ...view, poNumber: purchaseOrder.poNumber };
}

export async function listShipments(params: {
  organizationId: string;
  status?: ShipmentStatus;
  purchaseOrderId?: string;
  limit: number;
  cursor?: string;
}) {
  const { organizationId, status, purchaseOrderId, limit, cursor } = params;

  const rows = await prisma.shipment.findMany({
    where: {
      organizationId,
      ...(status ? { status } : {}),
      ...(purchaseOrderId ? { purchaseOrderId } : {}),
    },
    select: shipmentListSelect,
    // createdAt alone is not unique, so a page boundary landing inside a tie
    // could repeat or skip rows; id breaks the tie deterministically.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    items: page.map(toShipmentListItem),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}

const goodsReceiptListSelect = {
  id: true,
  purchaseOrderId: true,
  shipmentId: true,
  status: true,
  receivedAt: true,
  receivedBy: true,
  createdAt: true,
  shipment: { select: { purchaseOrder: { select: { poNumber: true } } } },
} satisfies Prisma.GoodsReceiptSelect;

type GoodsReceiptListRow = Prisma.GoodsReceiptGetPayload<{ select: typeof goodsReceiptListSelect }>;

export interface GoodsReceiptListItem {
  id: string;
  purchaseOrderId: string;
  poNumber: string;
  shipmentId: string;
  status: GoodsReceiptStatus;
  receivedAt: Date;
  receivedBy: string | null;
  createdAt: Date;
}

function toGoodsReceiptListItem(row: GoodsReceiptListRow): GoodsReceiptListItem {
  const { shipment, ...rest } = row;
  return { ...rest, poNumber: shipment.purchaseOrder.poNumber };
}

export async function listGoodsReceipts(params: {
  organizationId: string;
  status?: GoodsReceiptStatus;
  purchaseOrderId?: string;
  shipmentId?: string;
  limit: number;
  cursor?: string;
}) {
  const { organizationId, status, purchaseOrderId, shipmentId, limit, cursor } = params;

  const rows = await prisma.goodsReceipt.findMany({
    where: {
      organizationId,
      ...(status ? { status } : {}),
      ...(purchaseOrderId ? { purchaseOrderId } : {}),
      ...(shipmentId ? { shipmentId } : {}),
    },
    select: goodsReceiptListSelect,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    items: page.map(toGoodsReceiptListItem),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

const goodsReceiptForPdfSelect = {
  id: true,
  status: true,
  receivedAt: true,
  receivedBy: true,
  notes: true,
  organization: { select: { name: true } },
  shipment: {
    select: { trackingNumber: true, purchaseOrder: { select: { poNumber: true } } },
  },
  items: {
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      orderedQuantity: true,
      receivedQuantity: true,
      damagedQuantity: true,
      acceptedQuantity: true,
      // goodsReceiptViewSelect deliberately omits unit prices; the PDF needs a
      // human-readable description, which only the purchase order line has.
      purchaseOrderItem: { select: { description: true } },
    },
  },
} satisfies Prisma.GoodsReceiptSelect;

export type GoodsReceiptForPdf = Prisma.GoodsReceiptGetPayload<{
  select: typeof goodsReceiptForPdfSelect;
}>;

/** Tenant-scoped read of everything the receipt PDF renderer needs — see src/pdf/documents/goodsReceipt.pdf.ts. */
export async function loadGoodsReceiptForPdf(params: {
  organizationId: string;
  goodsReceiptId: string;
}): Promise<GoodsReceiptForPdf> {
  const goodsReceipt = await prisma.goodsReceipt.findFirst({
    where: { id: params.goodsReceiptId, organizationId: params.organizationId },
    select: goodsReceiptForPdfSelect,
  });

  if (!goodsReceipt) {
    throw AppError.notFound("Goods receipt not found");
  }

  return goodsReceipt;
}

// ---------------------------------------------------------------------------
// Goods receipt
// ---------------------------------------------------------------------------

export interface RecordGoodsReceiptInput extends ReceiptQuantities {
  organizationId: string;
  shipmentId: string;
  /** USER from the simulate endpoint; SYSTEM when a future IoT integration reports a delivery. */
  actorType: ActorType;
  actorId?: string | null;
  receivedBy?: string;
  notes?: string;
}

/**
 * Records the goods receipt for a shipment: shipment → DELIVERED, purchase
 * order → RECEIVED, one GoodsReceipt with a line per ordered item.
 *
 * Transport-agnostic on purpose — the HTTP controller is the only thing that
 * knows about `req`, so an IoT webhook or a worker can call this directly.
 *
 * Idempotent: GoodsReceipt.shipmentId is unique, so a replayed delivery returns
 * the receipt already on file and writes no second audit row. A replay reporting
 * *different* quantities is a conflict, not a silent no-op — see
 * assertReplayMatches.
 */
export async function recordGoodsReceipt(
  input: RecordGoodsReceiptInput,
): Promise<GoodsReceiptResult> {
  const { organizationId, shipmentId } = input;
  const shipment = await findShipment({ organizationId, shipmentId });

  // Runs before anything else: a malformed payload must never open a
  // transaction, and a replay has to be compared against what was stored.
  const lines = buildReceiptLines(shipment.purchaseOrder.items, input);

  if (shipment.goodsReceipt) {
    assertReplayMatches(shipment.goodsReceipt, lines);
    return {
      created: false,
      shipment: toShipmentView(shipment),
      goodsReceipt: shipment.goodsReceipt,
      purchaseOrder: await loadPurchaseOrderView(prisma, shipment.purchaseOrder.id),
    };
  }

  assertReceivable(shipment);

  const status = receiptStatus(lines);
  const receivedAt = new Date();

  return prisma.$transaction(async (tx) => {
    // Guarded so two concurrent deliveries cannot both claim the shipment.
    const claimed = await tx.shipment.updateMany({
      where: { id: shipmentId, organizationId, status: ShipmentStatus.IN_TRANSIT },
      data: { status: ShipmentStatus.DELIVERED, deliveredAt: receivedAt },
    });

    if (claimed.count === 0) {
      throw AppError.conflict("Shipment was updated concurrently", { shipmentId });
    }

    const goodsReceipt = await tx.goodsReceipt.create({
      data: {
        organizationId,
        purchaseOrderId: shipment.purchaseOrder.id,
        shipmentId,
        status,
        receivedAt,
        receivedBy: input.receivedBy ?? input.actorId ?? null,
        notes: input.notes ?? null,
        // Nested create: a rollback can never leave an item-less receipt.
        items: { create: lines },
      },
      select: goodsReceiptViewSelect,
    });

    // Unguarded on count: a purchase order already RECEIVED is fine, and the
    // shipment claim above is what makes this run at most once.
    await tx.purchaseOrder.updateMany({
      where: {
        id: shipment.purchaseOrder.id,
        organizationId,
        status: { in: RECEIVABLE_PO_STATUSES },
      },
      data: { status: PurchaseOrderStatus.RECEIVED },
    });

    await recordAudit(tx, {
      organizationId,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      action: "GOODS_RECEIVED",
      entityType: GOODS_RECEIPT_ENTITY,
      entityId: goodsReceipt.id,
      metadata: {
        shipmentId,
        purchaseOrderId: shipment.purchaseOrder.id,
        status,
        ...totals(lines),
      },
    });

    // Runs inside the same transaction as the receipt, and only on this
    // branch — the replay above returns before reaching here, so a
    // re-delivered request can never count the same delivery twice.
    await updateSupplierPerformance(tx, {
      organizationId,
      supplierId: shipment.purchaseOrder.supplierId,
      observation: {
        expectedDeliveryDate: shipment.expectedDeliveryDate,
        deliveredAt: receivedAt,
        orderedAt: shipment.purchaseOrder.approvedAt ?? shipment.purchaseOrder.createdAt,
        lines,
      },
    });

    const updatedShipment = await tx.shipment.findUniqueOrThrow({
      where: { id: shipmentId },
      select: shipmentViewSelect,
    });

    return {
      created: true,
      shipment: updatedShipment,
      goodsReceipt,
      purchaseOrder: await loadPurchaseOrderView(tx, shipment.purchaseOrder.id),
    };
  });
}

/**
 * Folds a delivery into the supplier's OTIF record and recomputes the
 * reliability score that ranks it on the next requisition
 * (src/rules/supplierRanking.ts reads exactly this column).
 *
 * Two writes rather than one on purpose. The counters move through Prisma's
 * atomic `increment`, because two shipments from the same supplier can be
 * received concurrently and a read-modify-write would lose one of them. The
 * derived score is then computed from the row those increments returned, so it
 * always reflects counters that actually landed.
 *
 * Deterministic throughout: src/rules/supplierPerformance.ts owns every
 * decision, this function only moves rows.
 */
async function updateSupplierPerformance(
  tx: Pick<Prisma.TransactionClient, "supplier" | "auditLog">,
  params: {
    organizationId: string;
    supplierId: string;
    observation: DeliveryObservation;
  },
): Promise<void> {
  const { organizationId, supplierId, observation } = params;
  const deltas = deliveryDeltas(observation);

  const counted = await tx.supplier.update({
    where: { id: supplierId },
    data: {
      totalDeliveries: { increment: deltas.totalDeliveries },
      onTimeDeliveries: { increment: deltas.onTimeDeliveries },
      inFullDeliveries: { increment: deltas.inFullDeliveries },
      orderedUnits: { increment: deltas.orderedUnits },
      acceptedUnits: { increment: deltas.acceptedUnits },
      damagedUnits: { increment: deltas.damagedUnits },
    },
    select: {
      id: true,
      reliabilityScore: true,
      baselineReliability: true,
      totalDeliveries: true,
      onTimeDeliveries: true,
      inFullDeliveries: true,
      orderedUnits: true,
      acceptedUnits: true,
      damagedUnits: true,
      avgLeadTimeDays: true,
    },
  });

  // First delivery for a supplier onboarded before this column existed: its
  // current score *is* the seeded baseline, so capture it now rather than
  // shrinking toward a score that has already started moving.
  const baseline = counted.baselineReliability ?? counted.reliabilityScore;

  const reliabilityScore = computeReliabilityScore(counted, baseline);

  await tx.supplier.update({
    where: { id: supplierId },
    data: {
      reliabilityScore,
      baselineReliability: baseline,
      lastDeliveryAt: observation.deliveredAt,
      avgLeadTimeDays: nextAverageLeadTime(
        counted.avgLeadTimeDays,
        // The increment already landed, so the stored count includes this
        // delivery; the running mean needs the count from before it.
        counted.totalDeliveries - deltas.totalDeliveries,
        observation,
      ),
    },
  });

  // The score moving is what changes future sourcing, so it is auditable in its
  // own right rather than buried in the receipt's metadata.
  await recordAudit(tx, {
    organizationId,
    actorType: "SYSTEM",
    action: "SUPPLIER_PERFORMANCE_UPDATED",
    entityType: SUPPLIER_ENTITY,
    entityId: supplierId,
    metadata: {
      previousReliabilityScore: counted.reliabilityScore,
      reliabilityScore,
      baselineReliability: baseline,
      onTime: deltas.onTimeDeliveries === 1,
      inFull: deltas.inFullDeliveries === 1,
      totalDeliveries: counted.totalDeliveries,
      orderedUnits: deltas.orderedUnits,
      acceptedUnits: deltas.acceptedUnits,
      damagedUnits: deltas.damagedUnits,
    },
  });
}

function totals(
  lines: { receivedQuantity: number; damagedQuantity: number; acceptedQuantity: number }[],
) {
  return {
    receivedQuantity: lines.reduce((sum, line) => sum + line.receivedQuantity, 0),
    damagedQuantity: lines.reduce((sum, line) => sum + line.damagedQuantity, 0),
    acceptedQuantity: lines.reduce((sum, line) => sum + line.acceptedQuantity, 0),
  };
}

function loadPurchaseOrderView(
  db: Pick<Prisma.TransactionClient, "purchaseOrder">,
  purchaseOrderId: string,
): Promise<PurchaseOrderView> {
  return db.purchaseOrder.findUniqueOrThrow({
    where: { id: purchaseOrderId },
    select: purchaseOrderViewSelect,
  });
}

/**
 * Guards the idempotent path against a replay that is not actually a replay.
 *
 * Returning 200 with the stored receipt for a payload reporting different
 * quantities would tell a warehouse correcting 98 → 100 that the correction was
 * recorded, while matching went on using the stale accepted quantity. A receipt
 * is immutable, so the divergent call is refused instead.
 */
function assertReplayMatches(stored: GoodsReceiptView, lines: ReceiptLine[]): void {
  const storedByItem = new Map(stored.items.map((item) => [item.purchaseOrderItemId, item]));

  for (const line of lines) {
    const item = storedByItem.get(line.purchaseOrderItemId);

    if (
      !item ||
      item.receivedQuantity !== line.receivedQuantity ||
      item.damagedQuantity !== line.damagedQuantity
    ) {
      throw AppError.conflict(
        "This shipment already has a goods receipt recording different quantities",
        {
          goodsReceiptId: stored.id,
          purchaseOrderItemId: line.purchaseOrderItemId,
          recorded: item
            ? { receivedQuantity: item.receivedQuantity, damagedQuantity: item.damagedQuantity }
            : null,
          submitted: {
            receivedQuantity: line.receivedQuantity,
            damagedQuantity: line.damagedQuantity,
          },
        },
      );
    }
  }
}

function assertReceivable(shipment: ShipmentWithContext): void {
  if (shipment.status === ShipmentStatus.CREATED) {
    throw AppError.invalidState("Shipment has not left the supplier yet", {
      status: shipment.status,
    });
  }

  if (shipment.status === ShipmentStatus.DELIVERED) {
    // The shipment update and the receipt commit together, so this cannot
    // happen through the API. Report the inconsistency instead of back-filling
    // a receipt for goods nobody recorded.
    throw AppError.invalidState("Shipment is already delivered but carries no goods receipt", {
      status: shipment.status,
    });
  }

  if (!RECEIVABLE_PO_STATUSES.includes(shipment.purchaseOrder.status)) {
    throw AppError.invalidState(
      `A ${shipment.purchaseOrder.status} purchase order cannot receive goods`,
      { purchaseOrderStatus: shipment.purchaseOrder.status },
    );
  }
}
