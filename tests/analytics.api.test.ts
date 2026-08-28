import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/db";

const db = {
  organization: { findUnique: vi.fn() },
  requisition: { groupBy: vi.fn(), findMany: vi.fn() },
  purchaseOrder: { groupBy: vi.fn(), aggregate: vi.fn() },
  purchaseOrderItem: { findMany: vi.fn() },
  invoice: { groupBy: vi.fn(), count: vi.fn(), findMany: vi.fn() },
  payment: { groupBy: vi.fn(), aggregate: vi.fn() },
  threeWayMatch: { count: vi.fn() },
  exception: { groupBy: vi.fn(), findMany: vi.fn() },
  supplier: { findMany: vi.fn() },
  aIProcessingLog: { findMany: vi.fn() },
  anomalySignal: { findMany: vi.fn() },
};

vi.mock("../src/config/prisma.js", () => ({
  prisma: { ...db },
  disconnectPrisma: vi.fn(),
}));

vi.mock("../src/config/redis.js", () => ({
  redis: { ping: vi.fn() },
  createRedisConnection: vi.fn(),
}));

const { createApp } = await import("../src/app.js");
const request = (await import("supertest")).default;

const ORG = "dev-org";
const OTHER_ORG = "other-org";

const app = createApp();
const get = (path: string, organizationId = ORG) =>
  request(app).get(`/api/v1/analytics${path}`).set("x-organization-id", organizationId);

/** Every aggregate empty — the shape an organization that has done nothing yet returns. */
function emptyDatabase(): void {
  db.organization.findUnique.mockResolvedValue({ id: ORG, currency: "INR" });
  db.requisition.groupBy.mockResolvedValue([]);
  db.requisition.findMany.mockResolvedValue([]);
  db.purchaseOrder.groupBy.mockResolvedValue([]);
  db.purchaseOrder.aggregate.mockResolvedValue({ _sum: { totalPaise: null } });
  db.purchaseOrderItem.findMany.mockResolvedValue([]);
  db.invoice.groupBy.mockResolvedValue([]);
  db.invoice.count.mockResolvedValue(0);
  db.invoice.findMany.mockResolvedValue([]);
  db.payment.groupBy.mockResolvedValue([]);
  db.payment.aggregate.mockResolvedValue({ _sum: { amountPaise: null } });
  db.threeWayMatch.count.mockResolvedValue(0);
  db.exception.groupBy.mockResolvedValue([]);
  db.exception.findMany.mockResolvedValue([]);
  db.supplier.findMany.mockResolvedValue([]);
  db.aIProcessingLog.findMany.mockResolvedValue([]);
  db.anomalySignal.findMany.mockResolvedValue([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  emptyDatabase();
});

describe("GET /api/v1/analytics/summary", () => {
  it("returns zeroes and nulls for an organization with no activity", async () => {
    const res = await get("/summary");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Rates over an empty denominator must be null, never NaN and never 0 —
    // "nothing has happened" is not "nothing worked".
    expect(res.body.data.automation.touchlessInvoiceRate).toBeNull();
    expect(res.body.data.automation.firstPassMatchRate).toBeNull();
    expect(res.body.data.cycleTimes.endToEnd.medianHours).toBeNull();
    expect(res.body.data.spend.committed.paise).toBe(0);
    expect(res.body.data.exceptions.byType).toEqual([]);
  });

  it("keeps every status on the axis so a chart does not change shape", async () => {
    const res = await get("/summary");

    expect(res.body.data.funnel.requisitions).toMatchObject({
      CREATED: 0,
      PROCESSING: 0,
      PO_CREATED: 0,
      FAILED: 0,
    });
    expect(res.body.data.funnel.payments).toMatchObject({ COMPLETED: 0, BLOCKED: 0 });
  });

  it("counts an invoice that was reviewed by a human as not touchless", async () => {
    db.invoice.count.mockResolvedValue(2);
    db.invoice.findMany.mockResolvedValue([{ id: "inv-clean" }, { id: "inv-reviewed" }]);
    // An exception was raised against inv-reviewed and later resolved. The two
    // callers of exception.findMany ask different questions, so the mock
    // answers by the query rather than returning one shape to both.
    db.exception.findMany.mockImplementation((args: { where: Record<string, unknown> }) =>
      Promise.resolve(
        "entityId" in args.where
          ? [{ entityId: "inv-reviewed" }]
          : [
              {
                createdAt: new Date("2026-08-26T00:00:00.000Z"),
                resolvedAt: new Date("2026-08-26T02:00:00.000Z"),
              },
            ],
      ),
    );

    const res = await get("/summary");

    expect(res.body.data.automation.touchlessInvoices).toBe(1);
    expect(res.body.data.automation.terminalInvoices).toBe(2);
    expect(res.body.data.automation.touchlessInvoiceRate).toBe(0.5);
    expect(res.body.data.automation.invoicesRequiringReview).toBe(1);
  });

  it("reports money as integer paise alongside a display string", async () => {
    db.purchaseOrder.aggregate.mockResolvedValue({ _sum: { totalPaise: 21_476_000 } });

    const res = await get("/summary");

    expect(res.body.data.spend.committed.paise).toBe(21_476_000);
    // en-IN grouping: lakhs, not thousands.
    expect(res.body.data.spend.committed.display).toBe("₹2,14,760.00");
  });

  it("derives cycle times from the entity timestamps", async () => {
    db.requisition.findMany.mockResolvedValue([
      {
        createdAt: new Date("2026-08-24T00:00:00.000Z"),
        purchaseOrder: {
          createdAt: new Date("2026-08-24T01:00:00.000Z"),
          approvedAt: new Date("2026-08-24T03:00:00.000Z"),
          shipment: { deliveredAt: new Date("2026-08-26T03:00:00.000Z") },
          invoices: [
            {
              createdAt: new Date("2026-08-26T04:00:00.000Z"),
              payment: { completedAt: new Date("2026-08-26T05:00:00.000Z") },
            },
          ],
        },
      },
    ]);

    const res = await get("/summary");

    expect(res.body.data.cycleTimes.requisitionToPurchaseOrder.medianHours).toBe(1);
    expect(res.body.data.cycleTimes.purchaseOrderToApproval.medianHours).toBe(2);
    expect(res.body.data.cycleTimes.approvalToDelivery.medianHours).toBe(48);
    expect(res.body.data.cycleTimes.invoiceToPayment.medianHours).toBe(1);
    expect(res.body.data.cycleTimes.endToEnd.medianHours).toBe(53);
  });

  it("ignores a flow that has not finished rather than counting it as instant", async () => {
    db.requisition.findMany.mockResolvedValue([
      {
        createdAt: new Date("2026-08-24T00:00:00.000Z"),
        purchaseOrder: {
          createdAt: new Date("2026-08-24T01:00:00.000Z"),
          approvedAt: null,
          shipment: null,
          invoices: [],
        },
      },
    ]);

    const res = await get("/summary");

    expect(res.body.data.cycleTimes.requisitionToPurchaseOrder.count).toBe(1);
    expect(res.body.data.cycleTimes.purchaseOrderToApproval.count).toBe(0);
    expect(res.body.data.cycleTimes.endToEnd.medianHours).toBeNull();
  });

  it("surfaces AIProcessingLog, which nothing else reads", async () => {
    db.aIProcessingLog.findMany.mockResolvedValue([
      { jobType: "extract-requirements", success: true, latencyMs: 900 },
      { jobType: "extract-requirements", success: false, latencyMs: 3000 },
    ]);

    const res = await get("/summary");

    expect(res.body.data.ai.byJobType).toEqual([
      {
        jobType: "extract-requirements",
        runs: 2,
        successRate: 0.5,
        p50LatencyMs: 900,
        p95LatencyMs: 3000,
      },
    ]);
  });

  it("scopes every query to the caller's organization", async () => {
    await get("/summary", OTHER_ORG);

    for (const call of db.requisition.groupBy.mock.calls) {
      expect((call[0] as { where: { organizationId: string } }).where.organizationId).toBe(
        OTHER_ORG,
      );
    }
    expect(db.requisition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organizationId: OTHER_ORG }) }),
    );
  });

  it("applies the requested window to the queries", async () => {
    await get("/summary?from=2026-08-01&to=2026-08-31");

    const [call] = db.requisition.groupBy.mock.calls as [[{ where: { createdAt: unknown } }]];
    expect(call[0].where.createdAt).toEqual({
      gte: new Date("2026-08-01T00:00:00.000Z"),
      lte: new Date("2026-08-31T00:00:00.000Z"),
    });
  });

  it("rejects a window that runs backwards", async () => {
    const res = await get("/summary?from=2026-08-31&to=2026-08-01");

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("GET /api/v1/analytics/suppliers", () => {
  it("returns the scorecard with the movement against the onboarding baseline", async () => {
    db.supplier.findMany.mockResolvedValue([
      {
        id: "sup-1",
        name: "TechSource Distributors",
        isActive: true,
        rating: 4.5,
        reliabilityScore: 0.75,
        baselineReliability: 0.9,
        totalDeliveries: 4,
        onTimeDeliveries: 3,
        inFullDeliveries: 2,
        orderedUnits: 400,
        acceptedUnits: 390,
        damagedUnits: 10,
        avgLeadTimeDays: 6.5,
        lastDeliveryAt: new Date("2026-08-26T00:00:00.000Z"),
      },
    ]);
    db.purchaseOrder.groupBy.mockResolvedValue([
      { supplierId: "sup-1", _sum: { totalPaise: 21_476_000 }, _count: { _all: 4 } },
    ]);

    const res = await get("/suppliers");

    expect(res.status).toBe(200);
    const [supplier] = res.body.data.suppliers;
    expect(supplier.onTimeRate).toBe(0.75);
    expect(supplier.otifRate).toBe(0.375);
    expect(supplier.damageRate).toBe(0.025);
    expect(supplier.reliabilityDelta).toBeCloseTo(-0.15, 5);
    expect(supplier.purchaseOrders).toBe(4);
    expect(supplier.spend.paise).toBe(21_476_000);
  });

  it("reports a never-delivered supplier with nulls, not zeroes", async () => {
    db.supplier.findMany.mockResolvedValue([
      {
        id: "sup-2",
        name: "Untested Supplies",
        isActive: true,
        rating: 4,
        reliabilityScore: 0.8,
        baselineReliability: 0.8,
        totalDeliveries: 0,
        onTimeDeliveries: 0,
        inFullDeliveries: 0,
        orderedUnits: 0,
        acceptedUnits: 0,
        damagedUnits: 0,
        avgLeadTimeDays: null,
        lastDeliveryAt: null,
      },
    ]);

    const res = await get("/suppliers");

    const [supplier] = res.body.data.suppliers;
    expect(supplier.onTimeRate).toBeNull();
    expect(supplier.otifRate).toBeNull();
    expect(supplier.totalDeliveries).toBe(0);
    expect(supplier.spend.paise).toBe(0);
  });

  it("scopes the supplier query to the caller's organization", async () => {
    await get("/suppliers", OTHER_ORG);

    expect(db.supplier.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: OTHER_ORG } }),
    );
  });
});

describe("GET /api/v1/analytics/anomalies", () => {
  function signal(overrides: Record<string, unknown> = {}) {
    return {
      id: "sig-1",
      signalType: "PRICE_OUTLIER",
      severity: "WARNING",
      entityType: "PurchaseOrder",
      entityId: "po-1",
      score: 3.2,
      observed: "Wireless Keyboard: ₹3,000.00",
      baseline: "₹1,820.00 average over 4 prior order line(s)",
      explanation: "TechSource is charging well above its usual price.",
      metadata: null,
      createdAt: new Date("2026-08-24T00:00:00.000Z"),
      ...overrides,
    };
  }

  it("returns an empty feed with no cursor", async () => {
    const res = await get("/anomalies");

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ signals: [], nextCursor: null });
  });

  it("paginates with a cursor when another page exists", async () => {
    db.anomalySignal.findMany.mockResolvedValue([
      signal({ id: "sig-1" }),
      signal({ id: "sig-2" }),
      signal({ id: "sig-3" }),
    ]);

    const res = await get("/anomalies?limit=2");

    expect(res.body.data.signals).toHaveLength(2);
    expect(res.body.data.nextCursor).toBe("sig-2");
  });

  it("filters by severity and signal type", async () => {
    await get("/anomalies?severity=WARNING&signalType=PRICE_OUTLIER");

    const [call] = db.anomalySignal.findMany.mock.calls as [[{ where: Record<string, unknown> }]];
    expect(call[0].where).toMatchObject({
      organizationId: ORG,
      severity: "WARNING",
      signalType: "PRICE_OUTLIER",
    });
  });

  it("rejects an unknown severity", async () => {
    const res = await get("/anomalies?severity=CATASTROPHIC");

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});
