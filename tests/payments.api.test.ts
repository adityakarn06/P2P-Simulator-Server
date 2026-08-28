import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/db";

const db = {
  organization: { findUnique: vi.fn() },
  payment: { findMany: vi.fn(), findFirst: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn() },
};

vi.mock("../src/config/prisma.js", () => ({
  prisma: db,
  disconnectPrisma: vi.fn(),
}));

vi.mock("../src/config/redis.js", () => ({
  redis: { ping: vi.fn() },
  createRedisConnection: vi.fn(),
}));

const { createApp } = await import("../src/app.js");
const request = (await import("supertest")).default;

const app = createApp();
const ORG = "dev-org";
const ORDER_TOTAL = 21_476_000;
const ACCEPTED_96 = 20_616_960;

const list = (query = "") =>
  request(app).get(`/api/v1/payments${query}`).set("x-organization-id", ORG);
const detail = (id: string) =>
  request(app).get(`/api/v1/payments/${id}`).set("x-organization-id", ORG);

/** A partial settlement: billed for all 100 units, paid for the 96 that arrived. */
function buildPayment(overrides: Record<string, unknown> = {}) {
  return {
    id: "pay-1",
    organizationId: ORG,
    invoiceId: "inv-1",
    settlementKey: "exc-1",
    purchaseOrderId: "po-1",
    amountPaise: ACCEPTED_96,
    currency: "INR",
    status: "COMPLETED",
    kind: "PARTIAL",
    provider: "SIMULATED",
    providerReference: "SIM-ABC123",
    blockedReason: null,
    failureReason: null,
    authorizedBy: "dev-user",
    authorizationReason: "Supplier confirmed the 4-unit shortfall",
    authorizingExceptionId: "exc-1",
    processedAt: new Date("2026-08-28T10:00:00.000Z"),
    completedAt: new Date("2026-08-28T10:00:01.000Z"),
    createdAt: new Date("2026-08-28T10:00:00.000Z"),
    updatedAt: new Date("2026-08-28T10:00:01.000Z"),
    invoice: {
      invoiceNumber: "INV-2026-0042",
      status: "PARTIALLY_PAID",
      totalPaise: ORDER_TOTAL,
      supplier: { id: "sup-1", name: "Keyboard Co" },
    },
    purchaseOrder: { poNumber: "PO-20260824-ABC123", totalPaise: ORDER_TOTAL, currency: "INR" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.organization.findUnique.mockResolvedValue({ id: ORG });
  db.payment.findMany.mockResolvedValue([]);
  db.payment.findFirst.mockResolvedValue(buildPayment());
  db.payment.aggregate.mockResolvedValue({ _sum: { amountPaise: ACCEPTED_96 } });
  // Everything COMPLETED against inv-1: the single partial tranche.
  db.payment.groupBy.mockResolvedValue([
    { invoiceId: "inv-1", _sum: { amountPaise: ACCEPTED_96 } },
  ]);
});

describe("GET /api/v1/payments", () => {
  it("returns an empty page with no cursor", async () => {
    const res = await list();

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ payments: [], nextCursor: null });
  });

  it("reports what a partial settlement left unpaid", async () => {
    db.payment.findMany.mockResolvedValue([buildPayment()]);

    const res = await list();

    expect(res.status).toBe(200);
    // The number an SCM manager is actually looking for: billed minus paid.
    expect(res.body.data.payments[0]).toMatchObject({
      kind: "PARTIAL",
      amountPaise: ACCEPTED_96,
      shortfallPaise: ORDER_TOTAL - ACCEPTED_96,
      authorizationReason: "Supplier confirmed the 4-unit shortfall",
    });
  });

  it("reports no shortfall on a full settlement", async () => {
    db.payment.findMany.mockResolvedValue([
      buildPayment({ kind: "FULL", amountPaise: ORDER_TOTAL, settlementKey: "auto" }),
    ]);
    db.payment.groupBy.mockResolvedValue([
      { invoiceId: "inv-1", _sum: { amountPaise: ORDER_TOTAL } },
    ]);

    const res = await list();

    expect(res.body.data.payments[0].shortfallPaise).toBe(0);
  });

  // The bug the per-invoice grouping exists to prevent: computing the shortfall
  // per row would report 60% and 70% short on an invoice that is 70% paid.
  it("reports one shortfall per invoice, not one per tranche", async () => {
    db.payment.findMany.mockResolvedValue([
      buildPayment({ id: "pay-1", amountPaise: 8_590_400, settlementKey: "exc-1" }),
      buildPayment({ id: "pay-2", amountPaise: 6_442_800, settlementKey: "exc-2" }),
    ]);
    db.payment.groupBy.mockResolvedValue([
      { invoiceId: "inv-1", _sum: { amountPaise: 8_590_400 + 6_442_800 } },
    ]);

    const res = await list();

    const shortfalls = res.body.data.payments.map(
      (row: { shortfallPaise: number }) => row.shortfallPaise,
    );
    expect(shortfalls).toEqual([ORDER_TOTAL - 15_033_200, ORDER_TOTAL - 15_033_200]);
  });

  it("reports no shortfall once the tranches add up to the invoice total", async () => {
    db.payment.findMany.mockResolvedValue([
      buildPayment({ id: "pay-1", amountPaise: ACCEPTED_96, settlementKey: "exc-1" }),
      buildPayment({ id: "pay-2", amountPaise: ORDER_TOTAL - ACCEPTED_96, settlementKey: "auto" }),
    ]);
    db.payment.groupBy.mockResolvedValue([
      { invoiceId: "inv-1", _sum: { amountPaise: ORDER_TOTAL } },
    ]);

    const res = await list();

    expect(res.body.data.payments.map((r: { shortfallPaise: number }) => r.shortfallPaise)).toEqual(
      [0, 0],
    );
  });

  it("does not invent a shortfall when the invoice total was never extracted", async () => {
    db.payment.findMany.mockResolvedValue([
      buildPayment({ invoice: { ...buildPayment().invoice, totalPaise: null } }),
    ]);

    const res = await list();

    expect(res.body.data.payments[0].shortfallPaise).toBe(0);
  });

  it("filters to partial settlements — the SCM review view", async () => {
    await list("?kind=PARTIAL&status=COMPLETED");

    expect(db.payment.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { organizationId: ORG, kind: "PARTIAL", status: "COMPLETED" },
    });
  });

  it("filters by supplier through the invoice rather than a duplicated column", async () => {
    await list("?supplierId=sup-1");

    expect(db.payment.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { invoice: { supplierId: "sup-1" } },
    });
  });

  it("paginates with a cursor when another page exists", async () => {
    db.payment.findMany.mockResolvedValue([
      buildPayment({ id: "pay-1" }),
      buildPayment({ id: "pay-2" }),
    ]);

    const res = await list("?limit=1");

    expect(res.body.data.payments).toHaveLength(1);
    expect(res.body.data.nextCursor).toBe("pay-1");
  });

  it("scopes every query to the caller's organization", async () => {
    await list();

    expect(db.payment.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { organizationId: ORG },
    });
  });

  it("rejects an unknown kind", async () => {
    const res = await list("?kind=HALF");

    expect(res.status).toBe(400);
  });
});

describe("GET /api/v1/payments/:id", () => {
  it("returns the payment with the order's ledger and its sibling tranches", async () => {
    db.payment.findMany.mockResolvedValue([
      {
        id: "pay-2",
        invoiceId: "inv-2",
        settlementKey: "auto",
        amountPaise: 100,
        status: "PENDING",
        kind: "FULL",
      },
    ]);

    const res = await detail("pay-1");

    expect(res.status).toBe(200);
    expect(res.body.data.payment.id).toBe("pay-1");
    expect(res.body.data.ledger).toMatchObject({
      poNumber: "PO-20260824-ABC123",
      purchaseOrderTotalPaise: ORDER_TOTAL,
      purchaseOrderSettledPaise: ACCEPTED_96,
      purchaseOrderOutstandingPaise: ORDER_TOTAL - ACCEPTED_96,
    });
    expect(res.body.data.siblings).toHaveLength(1);
  });

  it("treats a payment in another organization as missing", async () => {
    db.payment.findFirst.mockResolvedValue(null);

    const res = await detail("pay-elsewhere");

    expect(res.status).toBe(404);
    expect(db.payment.findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { id: "pay-elsewhere", organizationId: ORG },
    });
  });
});

describe("payments API surface", () => {
  it.each([
    ["post", "/api/v1/payments"],
    ["patch", "/api/v1/payments/pay-1"],
    ["delete", "/api/v1/payments/pay-1"],
  ] as const)("refuses to %s — a payment is never created over HTTP", async (method, path) => {
    // Marking an invoice paid over HTTP would bypass the three-way match and
    // the settlement caps entirely, so the verbs simply do not exist.
    const res = await request(app)[method](path).set("x-organization-id", ORG);

    expect(res.status).toBe(404);
  });
});
