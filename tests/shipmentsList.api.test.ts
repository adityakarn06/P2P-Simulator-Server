import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/db";
process.env.DEV_USER_ID ??= "dev-user";

const db = {
  organization: { findUnique: vi.fn() },
  shipment: { findMany: vi.fn() },
  goodsReceipt: { findMany: vi.fn() },
};

vi.mock("../src/config/prisma.js", () => ({
  prisma: { ...db, $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(db) },
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

function shipmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SHIPMENT,
    purchaseOrderId: PO,
    trackingNumber: "TRK-PO-1",
    carrier: null,
    status: "IN_TRANSIT",
    shippedAt: new Date("2026-08-24T09:00:00.000Z"),
    deliveredAt: null,
    expectedDeliveryDate: new Date("2026-08-29T00:00:00.000Z"),
    createdAt: new Date("2026-08-24T09:00:00.000Z"),
    purchaseOrder: { poNumber: "PO-20260824-K3F9QZ0V8B2M" },
    ...overrides,
  };
}

function goodsReceiptRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "gr-1",
    purchaseOrderId: PO,
    shipmentId: SHIPMENT,
    status: "PARTIAL",
    receivedAt: new Date("2026-08-26T10:00:00.000Z"),
    receivedBy: "dev-user",
    createdAt: new Date("2026-08-26T10:00:00.000Z"),
    shipment: { purchaseOrder: { poNumber: "PO-20260824-K3F9QZ0V8B2M" } },
    ...overrides,
  };
}

const app = createApp();
const listShipments = (query = "") =>
  request(app).get(`/api/v1/shipments${query}`).set("x-organization-id", ORG);
const listReceipts = (query = "") =>
  request(app).get(`/api/v1/receipts${query}`).set("x-organization-id", ORG);

beforeEach(() => {
  vi.clearAllMocks();
  db.organization.findUnique.mockResolvedValue({ id: ORG });
  db.shipment.findMany.mockResolvedValue([]);
  db.goodsReceipt.findMany.mockResolvedValue([]);
});

describe("GET /api/v1/shipments", () => {
  it("lists shipments for the caller's organization with poNumber flattened", async () => {
    db.shipment.findMany.mockResolvedValue([shipmentRow()]);

    const res = await listShipments();

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0]).toMatchObject({
      id: SHIPMENT,
      poNumber: "PO-20260824-K3F9QZ0V8B2M",
      status: "IN_TRANSIT",
    });
    expect(res.body.data.items[0].purchaseOrder).toBeUndefined();
    expect(res.body.data.nextCursor).toBeNull();
    expect(db.shipment.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { organizationId: ORG },
    });
  });

  it("applies status and purchaseOrderId filters", async () => {
    await listShipments(`?status=IN_TRANSIT&purchaseOrderId=${PO}`);

    expect(db.shipment.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { organizationId: ORG, status: "IN_TRANSIT", purchaseOrderId: PO },
    });
  });

  it("omits filters that were not supplied", async () => {
    await listShipments();

    const call = db.shipment.findMany.mock.calls[0];
    if (!call) {
      throw new Error("Expected findMany to have been called");
    }
    const { where } = call[0] as { where: Record<string, unknown> };
    expect(where).not.toHaveProperty("status");
    expect(where).not.toHaveProperty("purchaseOrderId");
  });

  it("defaults limit to 20 and requests one extra row for pagination", async () => {
    await listShipments();

    expect(db.shipment.findMany.mock.calls[0]?.[0]).toMatchObject({ take: 21 });
  });

  it("returns a nextCursor when a page is full and forwards a supplied cursor", async () => {
    const page = Array.from({ length: 6 }, (_, i) => shipmentRow({ id: `ship-${i}` }));
    db.shipment.findMany.mockResolvedValue(page);

    const res = await listShipments("?limit=5&cursor=ship-prev");

    expect(res.body.data.items).toHaveLength(5);
    expect(res.body.data.nextCursor).toBe("ship-4");
    expect(db.shipment.findMany.mock.calls[0]?.[0]).toMatchObject({
      take: 6,
      cursor: { id: "ship-prev" },
      skip: 1,
    });
  });

  it("is scoped to the header organization, not any client-supplied one", async () => {
    await request(app)
      .get("/api/v1/shipments")
      .set("x-organization-id", ORG)
      .query({ organizationId: "some-other-org" });

    expect(db.shipment.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { organizationId: ORG },
    });
  });

  it("rejects an unknown status", async () => {
    const res = await listShipments("?status=NOPE");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("GET /api/v1/receipts", () => {
  it("lists goods receipts for the caller's organization as summary rows", async () => {
    db.goodsReceipt.findMany.mockResolvedValue([goodsReceiptRow()]);

    const res = await listReceipts();

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0]).toMatchObject({
      id: "gr-1",
      purchaseOrderId: PO,
      poNumber: "PO-20260824-K3F9QZ0V8B2M",
      shipmentId: SHIPMENT,
      status: "PARTIAL",
    });
    expect(res.body.data.items[0].shipment).toBeUndefined();
    expect(res.body.data.items[0].items).toBeUndefined();
    expect(res.body.data.nextCursor).toBeNull();
    expect(db.goodsReceipt.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { organizationId: ORG },
    });
  });

  it("applies status, purchaseOrderId and shipmentId filters", async () => {
    await listReceipts(`?status=COMPLETED&purchaseOrderId=${PO}&shipmentId=${SHIPMENT}`);

    expect(db.goodsReceipt.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: {
        organizationId: ORG,
        status: "COMPLETED",
        purchaseOrderId: PO,
        shipmentId: SHIPMENT,
      },
    });
  });

  it("omits filters that were not supplied", async () => {
    await listReceipts();

    const call = db.goodsReceipt.findMany.mock.calls[0];
    if (!call) {
      throw new Error("Expected findMany to have been called");
    }
    const { where } = call[0] as { where: Record<string, unknown> };
    expect(where).not.toHaveProperty("status");
    expect(where).not.toHaveProperty("purchaseOrderId");
    expect(where).not.toHaveProperty("shipmentId");
  });

  it("defaults limit to 20 and requests one extra row for pagination", async () => {
    await listReceipts();

    expect(db.goodsReceipt.findMany.mock.calls[0]?.[0]).toMatchObject({ take: 21 });
  });

  it("returns a nextCursor when a page is full and forwards a supplied cursor", async () => {
    const page = Array.from({ length: 6 }, (_, i) => goodsReceiptRow({ id: `gr-${i}` }));
    db.goodsReceipt.findMany.mockResolvedValue(page);

    const res = await listReceipts("?limit=5&cursor=gr-prev");

    expect(res.body.data.items).toHaveLength(5);
    expect(res.body.data.nextCursor).toBe("gr-4");
    expect(db.goodsReceipt.findMany.mock.calls[0]?.[0]).toMatchObject({
      take: 6,
      cursor: { id: "gr-prev" },
      skip: 1,
    });
  });

  it("is scoped to the header organization, not any client-supplied one", async () => {
    await request(app)
      .get("/api/v1/receipts")
      .set("x-organization-id", ORG)
      .query({ organizationId: "some-other-org" });

    expect(db.goodsReceipt.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { organizationId: ORG },
    });
  });

  it("rejects an unknown status", async () => {
    const res = await listReceipts("?status=NOPE");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});
