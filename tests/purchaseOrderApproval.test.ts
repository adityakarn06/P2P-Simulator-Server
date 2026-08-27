import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/db";
// attachTenant reads this per request — it is the actor recorded on the audit row.
process.env.DEV_USER_ID ??= "dev-user";

const db = {
  organization: { findUnique: vi.fn() },
  purchaseOrder: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    updateMany: vi.fn(),
  },
  shipment: { findUnique: vi.fn(), upsert: vi.fn() },
  requisition: { update: vi.fn() },
  exception: { updateMany: vi.fn() },
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

function purchaseOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: PO,
    poNumber: "PO-20260824-ABC123",
    status: "PENDING_APPROVAL",
    requisitionId: "req-abc123",
    supplierId: "sup-techsource",
    subtotalPaise: 18_200_000,
    taxPaise: 3_276_000,
    totalPaise: 21_476_000,
    taxRateBps: 1800,
    currency: "INR",
    expectedDeliveryDate: new Date("2026-08-29T00:00:00.000Z"),
    approvedAt: null,
    approvedBy: null,
    rejectedAt: null,
    rejectionReason: null,
    createdAt: new Date("2026-08-24T00:00:00.000Z"),
    updatedAt: new Date("2026-08-24T00:00:00.000Z"),
    supplier: { id: "sup-techsource", name: "TechSource Distributors" },
    items: [],
    ...overrides,
  };
}

function shipment(overrides: Record<string, unknown> = {}) {
  return {
    id: "ship-1",
    purchaseOrderId: PO,
    trackingNumber: "TRK-PO-1",
    carrier: null,
    status: "IN_TRANSIT",
    shippedAt: new Date("2026-08-24T00:00:00.000Z"),
    deliveredAt: null,
    expectedDeliveryDate: new Date("2026-08-29T00:00:00.000Z"),
    createdAt: new Date("2026-08-24T00:00:00.000Z"),
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

const app = createApp();
const approve = () =>
  request(app).post(`/api/v1/purchase-orders/${PO}/approve`).set("x-organization-id", ORG);
const reject = (body: object) =>
  request(app)
    .post(`/api/v1/purchase-orders/${PO}/reject`)
    .set("x-organization-id", ORG)
    .send(body);

beforeEach(() => {
  vi.clearAllMocks();
  transaction.mockImplementation((fn) => fn(db));
  db.organization.findUnique.mockResolvedValue({ id: ORG });
  db.purchaseOrder.updateMany.mockResolvedValue({ count: 1 });
  db.shipment.upsert.mockResolvedValue(shipment());
  db.shipment.findUnique.mockResolvedValue(null);
  db.exception.updateMany.mockResolvedValue({ count: 1 });
});

describe("POST /api/v1/purchase-orders/:id/approve", () => {
  it("approves a PENDING_APPROVAL purchase order and puts its shipment in transit", async () => {
    db.purchaseOrder.findFirst.mockResolvedValue(purchaseOrder());
    db.purchaseOrder.findUniqueOrThrow.mockResolvedValue(
      purchaseOrder({ status: "APPROVED", approvedAt: new Date(), approvedBy: "dev-user" }),
    );

    const res = await approve();

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.purchaseOrder.status).toBe("APPROVED");
    expect(res.body.data.shipment.status).toBe("IN_TRANSIT");
    expect(db.purchaseOrder.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: PO, organizationId: ORG, status: "PENDING_APPROVAL" },
      }),
    );
    expect(auditActions()).toEqual(["PO_APPROVED", "SHIPMENT_CREATED", "EXCEPTION_RESOLVED"]);
  });

  it("reuses an existing shipment rather than overwriting it", async () => {
    db.purchaseOrder.findFirst.mockResolvedValue(purchaseOrder());
    db.purchaseOrder.findUniqueOrThrow.mockResolvedValue(purchaseOrder({ status: "APPROVED" }));

    await approve();

    // An empty update keeps a DELIVERED shipment exactly where it is.
    expect(db.shipment.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: {} }));
  });

  it("is idempotent: a second approval returns the existing shipment and writes no audit", async () => {
    db.purchaseOrder.findFirst.mockResolvedValue(purchaseOrder({ status: "APPROVED" }));
    db.shipment.findUnique.mockResolvedValue(shipment());

    const res = await approve();

    expect(res.status).toBe(200);
    expect(res.body.data.purchaseOrder.status).toBe("APPROVED");
    expect(res.body.data.shipment.id).toBe("ship-1");
    expect(db.shipment.upsert).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("does not re-resolve an approval exception that is already closed", async () => {
    db.purchaseOrder.findFirst.mockResolvedValue(purchaseOrder());
    db.purchaseOrder.findUniqueOrThrow.mockResolvedValue(purchaseOrder({ status: "APPROVED" }));
    db.exception.updateMany.mockResolvedValue({ count: 0 });

    await approve();

    expect(auditActions()).toEqual(["PO_APPROVED", "SHIPMENT_CREATED"]);
  });

  it("refuses to approve a rejected purchase order", async () => {
    db.purchaseOrder.findFirst.mockResolvedValue(purchaseOrder({ status: "REJECTED" }));

    const res = await approve();

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INVALID_STATE");
    expect(db.purchaseOrder.updateMany).not.toHaveBeenCalled();
  });

  it("refuses to approve a draft purchase order", async () => {
    db.purchaseOrder.findFirst.mockResolvedValue(purchaseOrder({ status: "DRAFT" }));

    const res = await approve();

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INVALID_STATE");
  });

  it("returns 404 for an unknown or other-tenant purchase order", async () => {
    db.purchaseOrder.findFirst.mockResolvedValue(null);

    const res = await approve();

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("rolls back and surfaces an error when the transaction fails", async () => {
    db.purchaseOrder.findFirst.mockResolvedValue(purchaseOrder());
    transaction.mockRejectedValue(new Error("connection terminated"));

    const res = await approve();

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });
});

describe("POST /api/v1/purchase-orders/:id/reject", () => {
  it("rejects a PENDING_APPROVAL purchase order and fails the requisition", async () => {
    db.purchaseOrder.findFirst.mockResolvedValue(purchaseOrder());
    db.purchaseOrder.findUniqueOrThrow.mockResolvedValue(
      purchaseOrder({
        status: "REJECTED",
        rejectedAt: new Date(),
        rejectionReason: "Price is too high",
      }),
    );

    const res = await reject({ reason: "Price is too high" });

    expect(res.status).toBe(200);
    expect(res.body.data.purchaseOrder.status).toBe("REJECTED");
    expect(res.body.data.shipment).toBeNull();
    expect(db.requisition.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "req-abc123" },
        data: { status: "FAILED", failureReason: "Purchase order rejected: Price is too high" },
      }),
    );
    expect(auditActions()).toEqual(["PO_REJECTED", "EXCEPTION_RESOLVED"]);
  });

  it("audits the rejection as PO_REJECTED carrying only the reason", async () => {
    db.purchaseOrder.findFirst.mockResolvedValue(purchaseOrder());
    db.purchaseOrder.findUniqueOrThrow.mockResolvedValue(purchaseOrder({ status: "REJECTED" }));

    await reject({ reason: "Price is too high" });

    const [audit] = auditRows();

    expect(audit).toMatchObject({
      action: "PO_REJECTED",
      actorType: "USER",
      actorId: "dev-user",
      entityType: "PurchaseOrder",
      entityId: PO,
      metadata: { reason: "Price is too high" },
    });
    // The rejection reason is the whole payload — nothing else is recorded.
    expect(Object.keys(audit?.metadata ?? {})).toEqual(["reason"]);
  });

  it("closes the PO_APPROVAL_REQUIRED exception", async () => {
    db.purchaseOrder.findFirst.mockResolvedValue(purchaseOrder());
    db.purchaseOrder.findUniqueOrThrow.mockResolvedValue(purchaseOrder({ status: "REJECTED" }));

    await reject({ reason: "Price is too high" });

    expect(db.exception.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: ORG,
          type: "PO_APPROVAL_REQUIRED",
          entityId: PO,
          status: { in: ["OPEN", "UNDER_REVIEW"] },
        }),
      }),
    );
  });

  it("never creates a shipment", async () => {
    db.purchaseOrder.findFirst.mockResolvedValue(purchaseOrder());
    db.purchaseOrder.findUniqueOrThrow.mockResolvedValue(purchaseOrder({ status: "REJECTED" }));

    await reject({ reason: "Price is too high" });

    expect(db.shipment.upsert).not.toHaveBeenCalled();
  });

  it("is idempotent for an already-rejected purchase order", async () => {
    db.purchaseOrder.findFirst.mockResolvedValue(purchaseOrder({ status: "REJECTED" }));

    const res = await reject({ reason: "Price is too high" });

    expect(res.status).toBe(200);
    expect(res.body.data.purchaseOrder.status).toBe("REJECTED");
    expect(db.purchaseOrder.updateMany).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("refuses to reject an approved purchase order", async () => {
    db.purchaseOrder.findFirst.mockResolvedValue(purchaseOrder({ status: "APPROVED" }));

    const res = await reject({ reason: "Changed my mind" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INVALID_STATE");
  });

  it("requires a reason", async () => {
    db.purchaseOrder.findFirst.mockResolvedValue(purchaseOrder());

    const res = await reject({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(db.purchaseOrder.updateMany).not.toHaveBeenCalled();
  });
});
