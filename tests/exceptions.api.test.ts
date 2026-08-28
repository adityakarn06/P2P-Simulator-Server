import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/db";
// attachTenant reads this per request — it is the actor recorded on the audit row.
process.env.DEV_USER_ID ??= "dev-user";

const db = {
  organization: { findUnique: vi.fn() },
  exception: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn(),
  },
  invoice: { updateMany: vi.fn(), findFirst: vi.fn() },
  payment: { updateMany: vi.fn(), aggregate: vi.fn() },
  matchCheck: { findMany: vi.fn() },
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

const enqueuePayment = vi.fn();

vi.mock("../src/queues/payment.queue.js", () => ({
  paymentQueue: {},
  PAYMENT_JOBS: { PROCESS_PAYMENT: "process-payment" },
  enqueuePayment: (...args: unknown[]) => enqueuePayment(...args),
}));

const { createApp } = await import("../src/app.js");
const request = (await import("supertest")).default;

const ORG = "dev-org";
const EXCEPTION = "exc-1";
const INVOICE = "inv-1";

function buildException(overrides: Record<string, unknown> = {}) {
  return {
    id: EXCEPTION,
    organizationId: ORG,
    type: "QUANTITY_MISMATCH",
    status: "OPEN",
    severity: "CRITICAL",
    entityType: "Invoice",
    entityId: INVOICE,
    title: "Three-way match failed: quantity mismatch",
    description: "RECEIVED_QUANTITY: expected 100, got 98",
    metadata: null,
    resolution: null,
    resolutionReason: null,
    resolvedAt: null,
    resolvedBy: null,
    createdAt: new Date("2026-08-24T00:00:00.000Z"),
    updatedAt: new Date("2026-08-24T00:00:00.000Z"),
    ...overrides,
  };
}

function auditActions(): string[] {
  return db.auditLog.create.mock.calls.map(
    (call) => (call[0] as { data: { action: string } }).data.action,
  );
}

const app = createApp();
const list = (query = "") =>
  request(app).get(`/api/v1/exceptions${query}`).set("x-organization-id", ORG);
const detail = (id: string) =>
  request(app).get(`/api/v1/exceptions/${id}`).set("x-organization-id", ORG);
const resolve = (id: string, body: object) =>
  request(app).post(`/api/v1/exceptions/${id}/resolve`).set("x-organization-id", ORG).send(body);

let lastUpdateStatus = "RESOLVED";

beforeEach(() => {
  vi.clearAllMocks();
  transaction.mockImplementation((fn) => fn(db));
  db.organization.findUnique.mockResolvedValue({ id: ORG });
  db.exception.findFirst.mockResolvedValue(buildException());
  db.exception.findMany.mockResolvedValue([]);
  db.exception.updateMany.mockImplementation((args: { data: { status: string } }) => {
    lastUpdateStatus = args.data.status;
    return Promise.resolve({ count: 1 });
  });
  db.exception.findUniqueOrThrow.mockImplementation(() =>
    Promise.resolve(buildException({ status: lastUpdateStatus })),
  );
  db.exception.count.mockResolvedValue(0);
  db.invoice.updateMany.mockResolvedValue({ count: 1 });
  db.payment.updateMany.mockResolvedValue({ count: 1 });
  db.payment.aggregate.mockResolvedValue({ _sum: { amountPaise: null } });
  db.matchCheck.findMany.mockResolvedValue([]);
  db.invoice.findFirst.mockResolvedValue(buildInvoiceForSettlement());
});

/**
 * The purchase order behind the exception: 100 keyboards ordered at ₹1,820,
 * 98 delivered with 2 damaged, so 96 were accepted.
 */
function buildInvoiceForSettlement(overrides: Record<string, unknown> = {}) {
  return {
    totalPaise: 21_476_000,
    purchaseOrder: {
      id: "po-1",
      poNumber: "PO-20260824-ABC123",
      currency: "INR",
      totalPaise: 21_476_000,
      taxRateBps: 1800,
      items: [{ id: "poi-1", unitPricePaise: 182_000 }],
      shipment: {
        goodsReceipt: { items: [{ purchaseOrderItemId: "poi-1", acceptedQuantity: 96 }] },
      },
    },
    ...overrides,
  };
}

describe("GET /api/v1/exceptions", () => {
  it("lists exceptions for the caller's organization", async () => {
    db.exception.findMany.mockResolvedValue([buildException()]);

    const res = await list();

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.exceptions).toHaveLength(1);
    expect(res.body.data.exceptions[0].id).toBe(EXCEPTION);
    expect(res.body.data.nextCursor).toBeNull();
    expect(db.exception.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { organizationId: ORG },
    });
  });

  it("applies status, type and entityId filters", async () => {
    await list(`?status=OPEN&type=QUANTITY_MISMATCH&entityId=${INVOICE}`);

    expect(db.exception.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { organizationId: ORG, status: "OPEN", type: "QUANTITY_MISMATCH", entityId: INVOICE },
    });
  });

  it("omits filters that were not supplied", async () => {
    await list();

    const call = db.exception.findMany.mock.calls[0];
    if (!call) {
      throw new Error("Expected findMany to have been called");
    }
    const { where } = call[0] as { where: Record<string, unknown> };
    expect(where).not.toHaveProperty("status");
    expect(where).not.toHaveProperty("type");
    expect(where).not.toHaveProperty("entityId");
  });

  it("defaults limit to 20 and requests one extra row for pagination", async () => {
    await list();

    expect(db.exception.findMany.mock.calls[0]?.[0]).toMatchObject({ take: 21 });
  });

  it("returns a nextCursor when a page is full and forwards a supplied cursor", async () => {
    const page = Array.from({ length: 6 }, (_, i) => buildException({ id: `exc-${i}` }));
    db.exception.findMany.mockResolvedValue(page);

    const res = await list("?limit=5&cursor=exc-prev");

    expect(res.body.data.exceptions).toHaveLength(5);
    expect(res.body.data.nextCursor).toBe("exc-4");
    expect(db.exception.findMany.mock.calls[0]?.[0]).toMatchObject({
      take: 6,
      cursor: { id: "exc-prev" },
      skip: 1,
    });
  });

  it("is scoped to the header organization, not any client-supplied one", async () => {
    await request(app)
      .get("/api/v1/exceptions")
      .set("x-organization-id", ORG)
      .query({ organizationId: "some-other-org" });

    expect(db.exception.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { organizationId: ORG },
    });
  });

  it("rejects an unknown status", async () => {
    const res = await list("?status=NOPE");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects an unknown type", async () => {
    const res = await list("?type=NOPE");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a limit of zero", async () => {
    const res = await list("?limit=0");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a limit over 100", async () => {
    const res = await list("?limit=101");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("GET /api/v1/exceptions/:id", () => {
  it("returns the exception scoped to the caller's organization", async () => {
    const res = await detail(EXCEPTION);

    expect(res.status).toBe(200);
    expect(res.body.data.exception.id).toBe(EXCEPTION);
    expect(db.exception.findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { id: EXCEPTION, organizationId: ORG },
    });
  });

  it("returns 404 when the exception does not exist or belongs to another organization", async () => {
    db.exception.findFirst.mockResolvedValue(null);

    const res = await detail("exc-other-org");

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  // Without these two, the operator can see that the match failed but not why,
  // and has no figure to approve — which is the whole partial-payment decision.
  it("returns the checks that actually failed", async () => {
    db.matchCheck.findMany.mockResolvedValue([
      {
        checkType: "RECEIVED_QUANTITY",
        expected: "100",
        actual: "96",
        variance: -0.04,
        severity: "CRITICAL",
      },
    ]);

    const res = await detail(EXCEPTION);

    expect(res.body.data.exception.failedChecks).toHaveLength(1);
    expect(res.body.data.exception.failedChecks[0].checkType).toBe("RECEIVED_QUANTITY");
    expect(db.matchCheck.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { passed: false, threeWayMatch: { invoiceId: INVOICE } },
    });
  });

  it("suggests paying for the 96 units that were accepted, at the order's own price", async () => {
    const res = await detail(EXCEPTION);

    // 96 x 182_000 = 17_472_000, +18% tax = 20_616_960.
    expect(res.body.data.exception.settlement).toMatchObject({
      poNumber: "PO-20260824-ABC123",
      invoiceTotalPaise: 21_476_000,
      invoiceOutstandingPaise: 21_476_000,
      purchaseOrderOutstandingPaise: 21_476_000,
      suggestedAmountPaise: 20_616_960,
    });
  });

  it("suggests nothing when the goods never arrived", async () => {
    db.invoice.findFirst.mockResolvedValue(
      buildInvoiceForSettlement({
        purchaseOrder: {
          ...buildInvoiceForSettlement().purchaseOrder,
          shipment: null,
        },
      }),
    );

    const res = await detail(EXCEPTION);

    expect(res.body.data.exception.settlement.suggestedAmountPaise).toBeNull();
  });

  it("never suggests more than the purchase order has left", async () => {
    db.payment.aggregate.mockResolvedValue({ _sum: { amountPaise: 21_000_000 } });

    const res = await detail(EXCEPTION);

    expect(res.body.data.exception.settlement.suggestedAmountPaise).toBe(476_000);
  });

  it.each([["the invoice is already fully settled", { _sum: { amountPaise: 21_476_000 } }]])(
    "suggests nothing when %s",
    async (_case, aggregate) => {
      // evaluateSettlement would refuse it outright, and an operator who approves
      // an unpayable figure sees the payment silently not happen.
      db.payment.aggregate.mockResolvedValue(aggregate);

      const res = await detail(EXCEPTION);

      expect(res.body.data.exception.settlement.suggestedAmountPaise).toBeNull();
    },
  );

  it("suggests nothing when the invoice total was never extracted", async () => {
    db.invoice.findFirst.mockResolvedValue(buildInvoiceForSettlement({ totalPaise: null }));

    const res = await detail(EXCEPTION);

    expect(res.body.data.exception.settlement.suggestedAmountPaise).toBeNull();
  });

  it("carries no settlement for an exception that is not about an invoice", async () => {
    db.exception.findFirst.mockResolvedValue(
      buildException({ entityType: "PurchaseOrder", entityId: "po-1" }),
    );

    const res = await detail(EXCEPTION);

    expect(res.body.data.exception.settlement).toBeNull();
    expect(res.body.data.exception.failedChecks).toEqual([]);
    expect(db.matchCheck.findMany).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/exceptions/:id/resolve — partial approval", () => {
  it("queues a tranche for the approved amount, keyed on the exception", async () => {
    const res = await resolve(EXCEPTION, {
      decision: "PARTIAL_APPROVE",
      approvedAmountPaise: 20_616_960,
      reason: "Supplier confirmed the 4-unit shortfall; pay for what arrived.",
    });

    expect(res.status).toBe(200);
    expect(res.body.data.approvedAmountPaise).toBe(20_616_960);

    expect(enqueuePayment).toHaveBeenCalledWith({
      invoiceId: INVOICE,
      organizationId: ORG,
      settlementKey: `exc-${EXCEPTION}`,
      amountPaise: 20_616_960,
      authorization: {
        exceptionId: EXCEPTION,
        userId: "dev-user",
        reason: "Supplier confirmed the 4-unit shortfall; pay for what arrived.",
      },
    });
  });

  it("closes the exception as RESOLVED, exactly like a full approval", async () => {
    await resolve(EXCEPTION, {
      decision: "PARTIAL_APPROVE",
      approvedAmountPaise: 20_616_960,
      reason: "Supplier confirmed the 4-unit shortfall.",
    });

    expect(lastUpdateStatus).toBe("RESOLVED");
  });

  it("records the approved amount on the audit row", async () => {
    await resolve(EXCEPTION, {
      decision: "PARTIAL_APPROVE",
      approvedAmountPaise: 20_616_960,
      reason: "Supplier confirmed the 4-unit shortfall.",
    });

    const resolution = db.auditLog.create.mock.calls
      .map((call) => (call[0] as { data: { action: string; metadata: unknown } }).data)
      .find((data) => data.action === "EXCEPTION_RESOLVED");

    expect(resolution?.metadata).toMatchObject({
      decision: "PARTIAL_APPROVE",
      approvedAmountPaise: 20_616_960,
    });
  });

  // The "auto" row matching parked carries the whole purchase order total and
  // nothing will ever enqueue a job for it. Releasing it would leave a PENDING
  // payment for the full amount that no worker processes.
  it("leaves the automatic full-value payment BLOCKED", async () => {
    await resolve(EXCEPTION, {
      decision: "PARTIAL_APPROVE",
      approvedAmountPaise: 20_616_960,
      reason: "Supplier confirmed the 4-unit shortfall.",
    });

    const unblocked = db.payment.updateMany.mock.calls.filter(
      (call) => (call[0] as { data: { status: string } }).data.status === "PENDING",
    );
    expect(unblocked).toHaveLength(0);
  });

  it("still unblocks it on a full approval", async () => {
    await resolve(EXCEPTION, {
      decision: "APPROVE",
      reason: "Discrepancy accepted; pay the invoice as billed.",
    });

    const unblocked = db.payment.updateMany.mock.calls.filter(
      (call) => (call[0] as { data: { status: string } }).data.status === "PENDING",
    );
    expect(unblocked).toHaveLength(1);
  });

  it("refuses a partial approval with no amount", async () => {
    const res = await resolve(EXCEPTION, {
      decision: "PARTIAL_APPROVE",
      reason: "Pay for what arrived, please.",
    });

    expect(res.status).toBe(400);
    expect(enqueuePayment).not.toHaveBeenCalled();
  });

  it("refuses an amount on a full approval rather than ignoring it", async () => {
    // Silently dropping a number someone typed into a payment request is how
    // the wrong sum gets paid.
    const res = await resolve(EXCEPTION, {
      decision: "APPROVE",
      approvedAmountPaise: 20_616_960,
      reason: "Approving the whole invoice as billed.",
    });

    expect(res.status).toBe(400);
    expect(enqueuePayment).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5])("refuses %s as an approved amount", async (approvedAmountPaise) => {
    const res = await resolve(EXCEPTION, {
      decision: "PARTIAL_APPROVE",
      approvedAmountPaise,
      reason: "Pay for what arrived, please.",
    });

    expect(res.status).toBe(400);
  });
});

describe("POST /api/v1/exceptions/:id/resolve — approve", () => {
  it("releases the invoice, unblocks payment and enqueues it once", async () => {
    const res = await resolve(EXCEPTION, {
      decision: "APPROVE",
      reason: "Supplier confirmed the remaining quantity will not ship.",
    });

    expect(res.status).toBe(200);
    expect(res.body.data.exception.status).toBe("RESOLVED");
    expect(res.body.data.releasedForPayment).toBe(true);

    expect(db.invoice.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: INVOICE, organizationId: ORG, status: "EXCEPTION" },
      data: { status: "APPROVED" },
    });
    expect(db.payment.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { invoiceId: INVOICE, organizationId: ORG, status: "BLOCKED" },
      data: { status: "PENDING", blockedReason: null },
    });
    expect(auditActions()).toEqual(["EXCEPTION_RESOLVED", "PAYMENT_APPROVED"]);

    expect(enqueuePayment).toHaveBeenCalledTimes(1);
    expect(enqueuePayment).toHaveBeenCalledWith({
      invoiceId: INVOICE,
      organizationId: ORG,
      settlementKey: "auto",
    });
  });

  it("records the actor from the dev tenant and the given reason", async () => {
    await resolve(EXCEPTION, {
      decision: "APPROVE",
      reason: "Supplier confirmed the remaining quantity will not ship.",
    });

    expect(db.exception.updateMany.mock.calls[0]?.[0]).toMatchObject({
      data: {
        status: "RESOLVED",
        resolution: "APPROVE",
        resolutionReason: "Supplier confirmed the remaining quantity will not ship.",
        resolvedBy: "dev-user",
      },
    });
  });

  it("does not enqueue payment while another exception on the invoice is still open", async () => {
    db.exception.count.mockResolvedValue(1);

    const res = await resolve(EXCEPTION, {
      decision: "APPROVE",
      reason: "Supplier confirmed the remaining quantity will not ship.",
    });

    expect(res.body.data.releasedForPayment).toBe(false);
    expect(db.invoice.updateMany).not.toHaveBeenCalled();
    expect(enqueuePayment).not.toHaveBeenCalled();
  });

  it("does not enqueue payment when the invoice already left EXCEPTION", async () => {
    db.invoice.updateMany.mockResolvedValue({ count: 0 });

    const res = await resolve(EXCEPTION, {
      decision: "APPROVE",
      reason: "Supplier confirmed the remaining quantity will not ship.",
    });

    expect(res.body.data.releasedForPayment).toBe(false);
    expect(db.payment.updateMany).not.toHaveBeenCalled();
    expect(enqueuePayment).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/exceptions/:id/resolve — reject", () => {
  it("closes the exception, leaves the payment blocked and enqueues nothing", async () => {
    const res = await resolve(EXCEPTION, {
      decision: "REJECT",
      reason: "Supplier could not confirm the shortage.",
    });

    expect(res.status).toBe(200);
    expect(res.body.data.exception.status).toBe("REJECTED");
    expect(res.body.data.releasedForPayment).toBe(false);
    expect(db.invoice.updateMany).not.toHaveBeenCalled();
    expect(db.payment.updateMany).not.toHaveBeenCalled();
    expect(enqueuePayment).not.toHaveBeenCalled();
    expect(auditActions()).toEqual(["EXCEPTION_RESOLVED"]);
  });
});

describe("POST /api/v1/exceptions/:id/resolve — idempotency and validation", () => {
  it("refuses to re-decide an already-resolved exception without any duplicate side effects", async () => {
    db.exception.updateMany.mockResolvedValue({ count: 0 });
    db.exception.findFirst.mockResolvedValue(buildException({ status: "RESOLVED" }));

    const res = await resolve(EXCEPTION, {
      decision: "APPROVE",
      reason: "Trying to approve it again.",
    });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INVALID_STATE");
    expect(db.invoice.updateMany).not.toHaveBeenCalled();
    expect(db.payment.updateMany).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
    expect(enqueuePayment).not.toHaveBeenCalled();
  });

  it("returns 404 for another organization's exception", async () => {
    db.exception.findFirst.mockResolvedValue(null);

    const res = await resolve("exc-other-org", {
      decision: "APPROVE",
      reason: "Trying to approve someone else's exception.",
    });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("requires a reason", async () => {
    const res = await resolve(EXCEPTION, { decision: "APPROVE" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(db.exception.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a reason shorter than 10 characters", async () => {
    const res = await resolve(EXCEPTION, { decision: "APPROVE", reason: "too short" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a whitespace-only reason", async () => {
    const res = await resolve(EXCEPTION, { decision: "APPROVE", reason: "            " });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects an invalid decision", async () => {
    const res = await resolve(EXCEPTION, {
      decision: "MAYBE",
      reason: "This is a long enough reason.",
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});
