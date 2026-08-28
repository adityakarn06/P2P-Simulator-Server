import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/db";

const db = {
  exception: {
    findFirst: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn(),
  },
  invoice: { updateMany: vi.fn() },
  payment: { updateMany: vi.fn() },
  auditLog: { create: vi.fn() },
};

vi.mock("../src/config/prisma.js", () => ({
  prisma: {
    ...db,
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  },
  disconnectPrisma: vi.fn(),
}));

vi.mock("../src/config/redis.js", () => ({
  redis: { ping: vi.fn() },
  createRedisConnection: vi.fn(),
}));

const { resolveExceptionById } = await import("../src/services/exception.service.js");

const ORG = "dev-org";
const USER = "dev-user";
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
    ...overrides,
  };
}

let lastUpdateStatus = "RESOLVED";

function auditActions(): string[] {
  return db.auditLog.create.mock.calls.map(
    (call) => (call[0] as { data: { action: string } }).data.action,
  );
}

function resolve(decision: "APPROVE" | "REJECT" = "APPROVE") {
  return resolveExceptionById({
    organizationId: ORG,
    exceptionId: EXCEPTION,
    decision,
    reason: "Supplier confirmed the remaining quantity will not ship.",
    actorId: USER,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  db.exception.findFirst.mockResolvedValue(buildException());
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
  db.auditLog.create.mockResolvedValue({});
});

describe("resolveExceptionById — approve", () => {
  it("releases the invoice and unblocks its payment", async () => {
    const result = await resolve("APPROVE");

    expect(result.releasedForPayment).toBe(true);
    expect(result.invoiceId).toBe(INVOICE);
    expect(result.exception.status).toBe("RESOLVED");

    expect(db.invoice.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: INVOICE, organizationId: ORG, status: "EXCEPTION" },
      data: { status: "APPROVED" },
    });

    // PENDING, not PROCESSING — the payment worker still has to claim it and
    // re-check the gate.
    expect(db.payment.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { invoiceId: INVOICE, organizationId: ORG, status: "BLOCKED" },
      data: { status: "PENDING", blockedReason: null },
    });

    expect(auditActions()).toEqual(["EXCEPTION_RESOLVED", "PAYMENT_APPROVED"]);
  });

  it("holds the invoice while another exception is still open", async () => {
    db.exception.count.mockResolvedValue(1);

    const result = await resolve("APPROVE");

    expect(result.releasedForPayment).toBe(false);
    expect(db.invoice.updateMany).not.toHaveBeenCalled();
    expect(db.payment.updateMany).not.toHaveBeenCalled();
    expect(auditActions()).toEqual(["EXCEPTION_RESOLVED"]);
  });

  it("does not re-approve an invoice that is no longer in EXCEPTION", async () => {
    db.invoice.updateMany.mockResolvedValue({ count: 0 });

    const result = await resolve("APPROVE");

    expect(result.releasedForPayment).toBe(false);
    expect(db.payment.updateMany).not.toHaveBeenCalled();
  });

  it("resolves a non-invoice exception without touching any invoice", async () => {
    db.exception.findFirst.mockResolvedValue(
      buildException({ entityType: "Requisition", entityId: "req-1", type: "NO_SUPPLIER_FOUND" }),
    );

    const result = await resolve("APPROVE");

    expect(result.releasedForPayment).toBe(false);
    expect(db.invoice.updateMany).not.toHaveBeenCalled();
    expect(db.payment.updateMany).not.toHaveBeenCalled();
  });
});

describe("resolveExceptionById — reject", () => {
  it("closes the exception and leaves the payment blocked", async () => {
    const result = await resolve("REJECT");

    expect(result.exception.status).toBe("REJECTED");
    expect(result.releasedForPayment).toBe(false);
    expect(db.invoice.updateMany).not.toHaveBeenCalled();
    expect(db.payment.updateMany).not.toHaveBeenCalled();
    expect(auditActions()).toEqual(["EXCEPTION_RESOLVED"]);
  });
});

describe("resolveExceptionById — guards", () => {
  it("records the decision, reason and actor", async () => {
    await resolve("APPROVE");

    expect(db.exception.updateMany.mock.calls[0]?.[0]).toMatchObject({
      data: {
        status: "RESOLVED",
        resolution: "APPROVE",
        resolutionReason: "Supplier confirmed the remaining quantity will not ship.",
        resolvedBy: USER,
      },
    });
  });

  it.each(["RESOLVED", "REJECTED"])("refuses to re-decide a %s exception", async (status) => {
    db.exception.findFirst.mockResolvedValue(buildException({ status }));

    db.exception.updateMany.mockResolvedValue({ count: 0 });

    await expect(resolve("APPROVE")).rejects.toThrow(`Exception is already ${status}`);
    expect(db.invoice.updateMany).not.toHaveBeenCalled();
  });

  it("treats another organization's exception as missing", async () => {
    db.exception.findFirst.mockResolvedValue(null);

    await expect(resolve("APPROVE")).rejects.toThrow("Exception not found");

    expect(db.exception.findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { id: EXCEPTION, organizationId: ORG },
    });
  });

  it("allows an UNDER_REVIEW exception to be decided", async () => {
    db.exception.findFirst.mockResolvedValue(buildException({ status: "UNDER_REVIEW" }));

    await expect(resolve("APPROVE")).resolves.toMatchObject({ releasedForPayment: true });
  });

  it("refuses a PO_APPROVAL_REQUIRED exception, which the purchase order owns", async () => {
    db.exception.findFirst.mockResolvedValue(
      buildException({
        type: "PO_APPROVAL_REQUIRED",
        entityType: "PurchaseOrder",
        entityId: "po-1",
      }),
    );

    // Resolving it here would close the exception while leaving the purchase
    // order in PENDING_APPROVAL with nothing open against it.
    await expect(resolve("APPROVE")).rejects.toThrow(/purchase-order/i);
    expect(db.exception.updateMany).not.toHaveBeenCalled();
    expect(db.invoice.updateMany).not.toHaveBeenCalled();
  });

  it("scopes the status transition by organization, not only the preceding read", async () => {
    await resolve("APPROVE");

    expect(db.exception.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: EXCEPTION, organizationId: ORG },
    });
  });
});
