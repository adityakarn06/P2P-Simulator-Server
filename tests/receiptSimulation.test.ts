import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/db";
// attachTenant reads this per request — it is the actor recorded on the audit row.
process.env.DEV_USER_ID ??= "dev-user";

const db = {
  organization: { findUnique: vi.fn() },
  shipment: { findFirst: vi.fn(), findUniqueOrThrow: vi.fn(), updateMany: vi.fn() },
  goodsReceipt: { create: vi.fn() },
  purchaseOrder: { updateMany: vi.fn(), findUniqueOrThrow: vi.fn() },
  supplier: { update: vi.fn() },
  auditLog: { create: vi.fn() },
};

const transaction = vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(db));

vi.mock("../src/config/prisma.js", () => ({
  prisma: {
    ...db,
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => transaction(fn),
  },
  disconnectPrisma: vi.fn(),
}));

vi.mock("../src/config/redis.js", () => ({
  redis: { ping: vi.fn() },
  createRedisConnection: vi.fn(),
}));

const { createApp } = await import("../src/app.js");
const request = (await import("supertest")).default;

const ORG = "dev-org";
const PO = "po-1";
const SHIPMENT = "ship-1";
const PO_ITEM = "poi-1";
const SUPPLIER = "sup-techsource";

function purchaseOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: PO,
    poNumber: "PO-20260824-ABC123",
    status: "RECEIVED",
    requisitionId: "req-abc123",
    supplierId: "sup-techsource",
    subtotalPaise: 18_200_000,
    taxPaise: 3_276_000,
    totalPaise: 21_476_000,
    taxRateBps: 1800,
    currency: "INR",
    expectedDeliveryDate: new Date("2026-08-29T00:00:00.000Z"),
    approvedAt: new Date("2026-08-24T00:00:00.000Z"),
    approvedBy: "dev-user",
    rejectedAt: null,
    rejectionReason: null,
    createdAt: new Date("2026-08-24T00:00:00.000Z"),
    updatedAt: new Date("2026-08-24T00:00:00.000Z"),
    supplier: { id: "sup-techsource", name: "TechSource Distributors" },
    items: [],
    ...overrides,
  };
}

/** The row findShipment loads: the shipment view plus its receipt and purchase-order context. */
function shipmentWithContext(overrides: Record<string, unknown> = {}) {
  return {
    id: SHIPMENT,
    purchaseOrderId: PO,
    trackingNumber: "TRK-PO-1",
    carrier: null,
    status: "IN_TRANSIT",
    shippedAt: new Date("2026-08-24T00:00:00.000Z"),
    deliveredAt: null,
    expectedDeliveryDate: new Date("2026-08-29T00:00:00.000Z"),
    createdAt: new Date("2026-08-24T00:00:00.000Z"),
    goodsReceipt: null,
    purchaseOrder: {
      id: PO,
      status: "APPROVED",
      supplierId: SUPPLIER,
      approvedAt: new Date("2026-08-24T00:00:00.000Z"),
      createdAt: new Date("2026-08-24T00:00:00.000Z"),
      items: [{ id: PO_ITEM, productId: "prod-kb", quantity: 100 }],
    },
    ...overrides,
  };
}

function goodsReceipt(overrides: Record<string, unknown> = {}) {
  return {
    id: "gr-1",
    purchaseOrderId: PO,
    shipmentId: SHIPMENT,
    status: "PARTIAL",
    receivedAt: new Date("2026-08-26T00:00:00.000Z"),
    receivedBy: "dev-user",
    notes: null,
    createdAt: new Date("2026-08-26T00:00:00.000Z"),
    items: [
      {
        id: "ri-1",
        purchaseOrderItemId: PO_ITEM,
        productId: "prod-kb",
        orderedQuantity: 100,
        receivedQuantity: 98,
        damagedQuantity: 2,
        acceptedQuantity: 96,
      },
    ],
    ...overrides,
  };
}

interface AuditRow {
  action: string;
  actorType: string;
  actorId: string | null;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown>;
}

function auditRows(): AuditRow[] {
  return db.auditLog.create.mock.calls.map((call) => (call[0] as { data: AuditRow }).data);
}

function auditActions(): string[] {
  return auditRows().map((row) => row.action);
}

/** The data passed to goodsReceipt.create, including its nested items. */
function receiptCreateData(): Record<string, unknown> {
  const [call] = db.goodsReceipt.create.mock.calls as [[{ data: Record<string, unknown> }]];
  return call[0].data;
}

const app = createApp();
const simulate = (body: object) =>
  request(app).post("/api/v1/receipts/simulate").set("x-organization-id", ORG).send(body);
const getShipment = (id = SHIPMENT) =>
  request(app).get(`/api/v1/shipments/${id}`).set("x-organization-id", ORG);

beforeEach(() => {
  vi.clearAllMocks();
  transaction.mockImplementation((fn) => fn(db));
  db.organization.findUnique.mockResolvedValue({ id: ORG });
  db.shipment.findFirst.mockResolvedValue(shipmentWithContext());
  db.shipment.updateMany.mockResolvedValue({ count: 1 });
  db.shipment.findUniqueOrThrow.mockResolvedValue({
    ...shipmentWithContext({ status: "DELIVERED", deliveredAt: new Date() }),
    goodsReceipt: undefined,
    purchaseOrder: undefined,
  });
  db.goodsReceipt.create.mockResolvedValue(goodsReceipt());
  db.purchaseOrder.updateMany.mockResolvedValue({ count: 1 });
  db.purchaseOrder.findUniqueOrThrow.mockResolvedValue(purchaseOrder());
  // The first supplier.update is the atomic counter increment, and it returns
  // the row those increments landed on.
  db.supplier.update.mockResolvedValue(supplierAfterIncrement());
});

/**
 * What the counter increment returns: a supplier with one delivery on the
 * books, no history before it. `updateSupplierPerformance` derives the score
 * and the running lead time from exactly this shape.
 */
function supplierAfterIncrement(overrides: Record<string, unknown> = {}) {
  return {
    id: SUPPLIER,
    reliabilityScore: 0.9,
    baselineReliability: 0.9,
    totalDeliveries: 1,
    onTimeDeliveries: 1,
    inFullDeliveries: 1,
    orderedUnits: 100,
    acceptedUnits: 100,
    damagedUnits: 0,
    avgLeadTimeDays: null,
    ...overrides,
  };
}

/** The `data` of each supplier.update call, in order. */
function supplierUpdates(): Record<string, unknown>[] {
  return db.supplier.update.mock.calls.map(
    (call) => (call[0] as { data: Record<string, unknown> }).data,
  );
}

describe("POST /api/v1/receipts/simulate", () => {
  it("records a full receipt: shipment DELIVERED, purchase order RECEIVED", async () => {
    db.goodsReceipt.create.mockResolvedValue(
      goodsReceipt({
        status: "COMPLETED",
        items: [
          {
            id: "ri-1",
            purchaseOrderItemId: PO_ITEM,
            productId: "prod-kb",
            orderedQuantity: 100,
            receivedQuantity: 100,
            damagedQuantity: 0,
            acceptedQuantity: 100,
          },
        ],
      }),
    );

    const res = await simulate({ shipmentId: SHIPMENT, receivedQuantity: 100, damagedQuantity: 0 });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.goodsReceipt.status).toBe("COMPLETED");
    expect(res.body.data.shipment.status).toBe("DELIVERED");
    expect(res.body.data.purchaseOrder.status).toBe("RECEIVED");
    expect(db.shipment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: SHIPMENT, organizationId: ORG, status: "IN_TRANSIT" },
      }),
    );
    expect(db.purchaseOrder.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: PO, organizationId: ORG, status: { in: ["APPROVED", "SHIPPED"] } },
        data: { status: "RECEIVED" },
      }),
    );
    expect(auditActions()).toEqual(["GOODS_RECEIVED", "SUPPLIER_PERFORMANCE_UPDATED"]);
  });

  it("records 98 received / 2 damaged as PARTIAL with 96 accepted", async () => {
    const res = await simulate({ shipmentId: SHIPMENT, receivedQuantity: 98, damagedQuantity: 2 });

    expect(res.status).toBe(201);
    expect(res.body.data.goodsReceipt.status).toBe("PARTIAL");
    expect(res.body.data.goodsReceipt.items[0].acceptedQuantity).toBe(96);
    expect(receiptCreateData()).toMatchObject({
      status: "PARTIAL",
      shipmentId: SHIPMENT,
      purchaseOrderId: PO,
      items: {
        create: [
          {
            purchaseOrderItemId: PO_ITEM,
            orderedQuantity: 100,
            receivedQuantity: 98,
            damagedQuantity: 2,
            acceptedQuantity: 96,
          },
        ],
      },
    });
  });

  it("audits the receipt with its totals", async () => {
    await simulate({ shipmentId: SHIPMENT, receivedQuantity: 98, damagedQuantity: 2 });

    expect(auditRows()[0]).toMatchObject({
      action: "GOODS_RECEIVED",
      actorType: "USER",
      actorId: "dev-user",
      entityType: "GoodsReceipt",
      entityId: "gr-1",
      metadata: {
        shipmentId: SHIPMENT,
        purchaseOrderId: PO,
        status: "PARTIAL",
        receivedQuantity: 98,
        damagedQuantity: 2,
        acceptedQuantity: 96,
      },
    });
  });

  it("accepts an explicit items[] payload", async () => {
    await simulate({
      shipmentId: SHIPMENT,
      items: [{ purchaseOrderItemId: PO_ITEM, receivedQuantity: 98, damagedQuantity: 2 }],
    });

    expect(receiptCreateData()).toMatchObject({
      items: { create: [expect.objectContaining({ acceptedQuantity: 96 })] },
    });
  });

  it("is idempotent: a replayed delivery returns the existing receipt and writes nothing", async () => {
    db.shipment.findFirst.mockResolvedValue(
      shipmentWithContext({ status: "DELIVERED", goodsReceipt: goodsReceipt() }),
    );

    const res = await simulate({ shipmentId: SHIPMENT, receivedQuantity: 98, damagedQuantity: 2 });

    expect(res.status).toBe(200);
    expect(res.body.data.goodsReceipt.id).toBe("gr-1");
    expect(db.goodsReceipt.create).not.toHaveBeenCalled();
    expect(db.shipment.updateMany).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
    // The whole risk of the OTIF loop: a re-delivered request must not count
    // the same delivery a second time and drag the supplier's score with it.
    expect(db.supplier.update).not.toHaveBeenCalled();
  });

  it("counts the delivery against the supplier exactly once, on time and in full", async () => {
    db.goodsReceipt.create.mockResolvedValue(
      goodsReceipt({
        status: "COMPLETED",
        items: [
          {
            id: "ri-1",
            purchaseOrderItemId: PO_ITEM,
            productId: "prod-kb",
            orderedQuantity: 100,
            receivedQuantity: 100,
            damagedQuantity: 0,
            acceptedQuantity: 100,
          },
        ],
      }),
    );

    const res = await simulate({ shipmentId: SHIPMENT, receivedQuantity: 100, damagedQuantity: 0 });

    expect(res.status).toBe(201);

    const [increment, derived] = supplierUpdates() as [
      Record<string, Record<string, number>>,
      Record<string, unknown>,
    ];

    // Counters move atomically, so a concurrent receipt for another shipment
    // of the same supplier cannot clobber them.
    expect(increment).toEqual({
      totalDeliveries: { increment: 1 },
      onTimeDeliveries: { increment: 1 },
      inFullDeliveries: { increment: 1 },
      orderedUnits: { increment: 100 },
      acceptedUnits: { increment: 100 },
      damagedUnits: { increment: 0 },
    });

    // A flawless delivery on a supplier already seeded at 0.9 cannot move the
    // score down, and the shrinkage prior keeps it from jumping to 1.0.
    expect(derived.reliabilityScore).toBeGreaterThanOrEqual(0.9);
    expect(derived.reliabilityScore).toBeLessThan(1);
    expect(derived.baselineReliability).toBe(0.9);
  });

  it("records a short, damaged delivery as neither on time nor in full", async () => {
    db.shipment.findFirst.mockResolvedValue(
      shipmentWithContext({
        // Promised the 25th, arrived on the 26th.
        expectedDeliveryDate: new Date("2026-08-25T00:00:00.000Z"),
      }),
    );
    db.supplier.update.mockResolvedValue(
      supplierAfterIncrement({
        onTimeDeliveries: 0,
        inFullDeliveries: 0,
        acceptedUnits: 96,
        damagedUnits: 2,
      }),
    );

    const res = await simulate({ shipmentId: SHIPMENT, receivedQuantity: 98, damagedQuantity: 2 });

    expect(res.status).toBe(201);

    const [increment, derived] = supplierUpdates() as [
      Record<string, Record<string, number>>,
      Record<string, unknown>,
    ];

    expect(increment.onTimeDeliveries).toEqual({ increment: 0 });
    expect(increment.inFullDeliveries).toEqual({ increment: 0 });
    expect(increment.acceptedUnits).toEqual({ increment: 96 });
    expect(increment.damagedUnits).toEqual({ increment: 2 });

    // The point of the whole loop: a bad delivery costs the supplier ranking
    // position on the next requisition.
    expect(derived.reliabilityScore).toBeLessThan(0.9);
  });

  it("refuses a replay reporting different quantities", async () => {
    db.shipment.findFirst.mockResolvedValue(
      shipmentWithContext({ status: "DELIVERED", goodsReceipt: goodsReceipt() }),
    );

    // A warehouse correcting 98 -> 100 must not be told the correction landed.
    const res = await simulate({ shipmentId: SHIPMENT, receivedQuantity: 100 });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
    expect(res.body.error.details).toMatchObject({
      recorded: { receivedQuantity: 98, damagedQuantity: 2 },
      submitted: { receivedQuantity: 100, damagedQuantity: 0 },
    });
    expect(db.goodsReceipt.create).not.toHaveBeenCalled();
  });

  it("refuses a shipment that has not left the supplier", async () => {
    db.shipment.findFirst.mockResolvedValue(shipmentWithContext({ status: "CREATED" }));

    const res = await simulate({ shipmentId: SHIPMENT, receivedQuantity: 100 });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INVALID_STATE");
    expect(db.goodsReceipt.create).not.toHaveBeenCalled();
  });

  it("reports a DELIVERED shipment with no receipt rather than repairing it", async () => {
    db.shipment.findFirst.mockResolvedValue(
      shipmentWithContext({ status: "DELIVERED", goodsReceipt: null }),
    );

    const res = await simulate({ shipmentId: SHIPMENT, receivedQuantity: 100 });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INVALID_STATE");
    expect(db.goodsReceipt.create).not.toHaveBeenCalled();
  });

  it("refuses a receipt against a purchase order that is not approved", async () => {
    db.shipment.findFirst.mockResolvedValue(
      shipmentWithContext({
        purchaseOrder: {
          id: PO,
          status: "PENDING_APPROVAL",
          items: [{ id: PO_ITEM, productId: "prod-kb", quantity: 100 }],
        },
      }),
    );

    const res = await simulate({ shipmentId: SHIPMENT, receivedQuantity: 100 });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INVALID_STATE");
  });

  it("refuses a receipt where nothing arrived", async () => {
    const res = await simulate({ shipmentId: SHIPMENT, receivedQuantity: 0 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses an items[] payload where nothing arrived", async () => {
    const res = await simulate({
      shipmentId: SHIPMENT,
      items: [{ purchaseOrderItemId: PO_ITEM, receivedQuantity: 0 }],
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("refuses more damaged units than received", async () => {
    const res = await simulate({ shipmentId: SHIPMENT, receivedQuantity: 5, damagedQuantity: 6 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses an over-receipt", async () => {
    const res = await simulate({ shipmentId: SHIPMENT, receivedQuantity: 101 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a payload carrying both forms", async () => {
    const res = await simulate({
      shipmentId: SHIPMENT,
      receivedQuantity: 100,
      items: [{ purchaseOrderItemId: PO_ITEM, receivedQuantity: 100 }],
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(db.shipment.findFirst).not.toHaveBeenCalled();
  });

  it("requires a shipmentId", async () => {
    const res = await simulate({ receivedQuantity: 100 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(db.shipment.findFirst).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown or other-tenant shipment", async () => {
    db.shipment.findFirst.mockResolvedValue(null);

    const res = await simulate({ shipmentId: SHIPMENT, receivedQuantity: 100 });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 409 when another delivery claimed the shipment first", async () => {
    db.shipment.updateMany.mockResolvedValue({ count: 0 });

    const res = await simulate({ shipmentId: SHIPMENT, receivedQuantity: 100 });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
  });

  it("rolls back and surfaces an error when the transaction fails", async () => {
    transaction.mockRejectedValue(new Error("connection terminated"));

    const res = await simulate({ shipmentId: SHIPMENT, receivedQuantity: 100 });

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });
});

describe("GET /api/v1/shipments/:id", () => {
  it("returns the shipment and its receipt", async () => {
    db.shipment.findFirst.mockResolvedValue(
      shipmentWithContext({ status: "DELIVERED", goodsReceipt: goodsReceipt() }),
    );

    const res = await getShipment();

    expect(res.status).toBe(200);
    expect(res.body.data.shipment).toMatchObject({ id: SHIPMENT, status: "DELIVERED" });
    expect(res.body.data.goodsReceipt.id).toBe("gr-1");
    // The purchase-order context is loaded for the receipt flow, not exposed here.
    expect(res.body.data.shipment.purchaseOrder).toBeUndefined();
  });

  it("returns a null receipt while the shipment is in transit", async () => {
    const res = await getShipment();

    expect(res.status).toBe(200);
    expect(res.body.data.shipment.status).toBe("IN_TRANSIT");
    expect(res.body.data.goodsReceipt).toBeNull();
  });

  it("scopes the read to the organization", async () => {
    await getShipment();

    expect(db.shipment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: SHIPMENT, organizationId: ORG } }),
    );
  });

  it("returns 404 for an unknown or other-tenant shipment", async () => {
    db.shipment.findFirst.mockResolvedValue(null);

    const res = await getShipment("ship-other");

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});
