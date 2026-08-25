import type { Job } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/db";

const db = {
  invoice: { findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  threeWayMatch: { upsert: vi.fn() },
  matchCheck: { deleteMany: vi.fn(), createMany: vi.fn() },
  payment: { upsert: vi.fn() },
  exception: { upsert: vi.fn(), findUnique: vi.fn() },
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

const enqueuePayment = vi.fn();

vi.mock("../src/queues/payment.queue.js", () => ({
  paymentQueue: {},
  PAYMENT_JOBS: { PROCESS_PAYMENT: "process-payment" },
  enqueuePayment: (...args: unknown[]) => enqueuePayment(...args),
}));

vi.mock("../src/queues/matching.queue.js", () => ({
  matchingQueue: {},
  MATCHING_JOBS: { RUN_THREE_WAY_MATCH: "run-three-way-match" },
  enqueueMatching: vi.fn(),
}));

const { processMatchingJob } = await import("../src/workers/matching.worker.js");

const ORG = "dev-org";
const INVOICE = "inv-1";
const PRODUCT = "prod-keyboard";

/**
 * A clean transaction: PO for 100 keyboards at ₹1,820, all 100 received and
 * accepted, invoiced identically. Individual tests bend one dimension.
 */
function buildContext(
  overrides: {
    invoice?: Record<string, unknown>;
    receivedQuantity?: number;
    acceptedQuantity?: number;
    invoiceQuantity?: number;
    invoiceUnitPricePaise?: number;
    threeWayMatch?: { id: string; status: string } | null;
    payment?: { id: string; status: string } | null;
    status?: string;
  } = {},
) {
  const invoiceQuantity = overrides.invoiceQuantity ?? 100;
  const invoiceUnitPrice = overrides.invoiceUnitPricePaise ?? 182_000;
  const received = overrides.receivedQuantity ?? 100;
  const accepted = overrides.acceptedQuantity ?? received;
  const lineTotal = invoiceQuantity * invoiceUnitPrice;
  const tax = Math.round(lineTotal * 0.18);

  return {
    id: INVOICE,
    organizationId: ORG,
    status: overrides.status ?? "EXTRACTED",
    invoiceNumber: "INV-2026-0042",
    supplierNameRaw: "TechSource Distributors",
    poNumberRaw: "PO-20260824-ABC123",
    currency: "INR",
    subtotalPaise: lineTotal,
    taxPaise: tax,
    totalPaise: lineTotal + tax,
    items: [
      {
        lineNumber: 1,
        description: "Wireless Keyboard",
        quantity: invoiceQuantity,
        unitPricePaise: invoiceUnitPrice,
        lineTotalPaise: lineTotal,
      },
    ],
    threeWayMatch: overrides.threeWayMatch ?? null,
    payment: overrides.payment ?? null,
    purchaseOrder: {
      id: "po-1",
      poNumber: "PO-20260824-ABC123",
      currency: "INR",
      subtotalPaise: 18_200_000,
      taxPaise: 3_276_000,
      totalPaise: 21_476_000,
      supplier: { name: "TechSource Distributors" },
      items: [
        {
          productId: PRODUCT,
          description: "Wireless Keyboard",
          quantity: 100,
          unitPricePaise: 182_000,
          lineTotalPaise: 18_200_000,
          product: { sku: "KB-WL-001", name: "Wireless Keyboard", category: "Peripherals" },
        },
      ],
      shipment: {
        goodsReceipt: {
          id: "gr-1",
          items: [
            {
              productId: PRODUCT,
              orderedQuantity: 100,
              receivedQuantity: received,
              acceptedQuantity: accepted,
            },
          ],
        },
      },
    },
    ...overrides.invoice,
  };
}

function buildJob(attemptsMade = 0): Job {
  return {
    data: { invoiceId: INVOICE, organizationId: ORG },
    attemptsMade,
    opts: { attempts: 3 },
  } as unknown as Job;
}

/** First argument of a mock's first call, failing loudly if it was never called. */
function firstArg(mock: { mock: { calls: unknown[][] } }): unknown {
  const call = mock.mock.calls[0];

  if (!call) {
    throw new Error("Expected the mock to have been called");
  }

  return call[0];
}

/** The status the invoice was moved to inside applyMatchResult. */
function invoiceStatusWrittenBy(call: unknown[] | undefined): string | undefined {
  return (call?.[0] as { data?: { status?: string } } | undefined)?.data?.status;
}

function exceptionTypes(): string[] {
  return db.exception.upsert.mock.calls.map(
    (call) =>
      (call[0] as { where: { organizationId_type_entityId: { type: string } } }).where
        .organizationId_type_entityId.type,
  );
}

function auditActions(): string[] {
  return db.auditLog.create.mock.calls.map(
    (call) => (call[0] as { data: { action: string } }).data.action,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  db.invoice.findMany.mockResolvedValue([]);
  db.invoice.updateMany.mockResolvedValue({ count: 1 });
  db.threeWayMatch.upsert.mockResolvedValue({ id: "match-1" });
  db.matchCheck.deleteMany.mockResolvedValue({ count: 0 });
  db.matchCheck.createMany.mockResolvedValue({ count: 12 });
  db.payment.upsert.mockResolvedValue({ id: "pay-1" });
  db.exception.upsert.mockResolvedValue({ id: "exc-1" });
  db.exception.findUnique.mockResolvedValue(null);
  db.auditLog.create.mockResolvedValue({});
});

describe("processMatchingJob — matched", () => {
  it("approves the invoice, records all twelve checks and queues payment", async () => {
    db.invoice.findFirst.mockResolvedValue(buildContext());

    const result = await processMatchingJob(buildJob());

    expect(result).toEqual({ invoiceId: INVOICE, status: "MATCHED" });

    const match = firstArg(db.threeWayMatch.upsert) as {
      where: { invoiceId: string };
      create: {
        status: string;
        passedChecks: number;
        failedChecks: number;
        goodsReceiptId: string;
      };
    };
    expect(match.where).toEqual({ invoiceId: INVOICE });
    expect(match.create.status).toBe("MATCHED");
    expect(match.create.passedChecks).toBe(12);
    expect(match.create.failedChecks).toBe(0);
    expect(match.create.goodsReceiptId).toBe("gr-1");

    const checks = (firstArg(db.matchCheck.createMany) as { data: unknown[] }).data;
    expect(checks).toHaveLength(12);

    // The claim writes MATCHING, then applyMatchResult writes APPROVED.
    expect(invoiceStatusWrittenBy(db.invoice.updateMany.mock.calls.at(-1))).toBe("APPROVED");

    expect(enqueuePayment).toHaveBeenCalledTimes(1);
    expect(enqueuePayment).toHaveBeenCalledWith({ invoiceId: INVOICE, organizationId: ORG });

    expect(db.exception.upsert).not.toHaveBeenCalled();
    expect(db.payment.upsert).not.toHaveBeenCalled();
    expect(auditActions()).toEqual(["MATCH_STARTED", "MATCH_COMPLETED"]);
  });
});

describe("processMatchingJob — mismatched", () => {
  // CLAUDE.md's canonical scenario: PO 100, receipt 98, invoice 100.
  it("blocks payment and raises a quantity exception on a short receipt", async () => {
    db.invoice.findFirst.mockResolvedValue(
      buildContext({ receivedQuantity: 98, acceptedQuantity: 98 }),
    );

    const result = await processMatchingJob(buildJob());

    expect(result.status).toBe("MISMATCHED");
    expect(invoiceStatusWrittenBy(db.invoice.updateMany.mock.calls.at(-1))).toBe("EXCEPTION");

    const payment = firstArg(db.payment.upsert) as {
      where: { invoiceId: string };
      create: { status: string; amountPaise: number; currency: string; blockedReason: string };
    };
    expect(payment.where).toEqual({ invoiceId: INVOICE });
    expect(payment.create.status).toBe("BLOCKED");
    // The purchase order's own total, never the AI-transcribed invoice figure.
    expect(payment.create.amountPaise).toBe(21_476_000);
    expect(payment.create.currency).toBe("INR");
    expect(payment.create.blockedReason).toContain("RECEIVED_QUANTITY");

    expect(exceptionTypes()).toContain("QUANTITY_MISMATCH");

    // The whole point: no money job is queued for a failed match.
    expect(enqueuePayment).not.toHaveBeenCalled();
  });

  // PO ₹1,820/unit vs invoice ₹2,100/unit — well outside the 2% tolerance.
  it("raises a price exception when the invoice bills a higher unit price", async () => {
    db.invoice.findFirst.mockResolvedValue(buildContext({ invoiceUnitPricePaise: 210_000 }));

    const result = await processMatchingJob(buildJob());

    expect(result.status).toBe("MISMATCHED");
    expect(exceptionTypes()).toContain("PRICE_MISMATCH");
    expect(firstArg(db.payment.upsert)).toMatchObject({
      create: { status: "BLOCKED" },
    });
    expect(enqueuePayment).not.toHaveBeenCalled();
  });

  it("groups several failing money checks into one exception per category", async () => {
    db.invoice.findFirst.mockResolvedValue(buildContext({ invoiceUnitPricePaise: 210_000 }));

    await processMatchingJob(buildJob());

    // UNIT_PRICE and SUBTOTAL both map to PRICE_MISMATCH; Exception is unique on
    // [organizationId, type, entityId], so they must collapse to one upsert.
    const priceExceptions = exceptionTypes().filter((type) => type === "PRICE_MISMATCH");
    expect(priceExceptions).toHaveLength(1);
  });
});

describe("processMatchingJob — idempotency", () => {
  it("skips an invoice that has already been matched", async () => {
    db.invoice.findFirst.mockResolvedValue(
      buildContext({
        status: "APPROVED",
        threeWayMatch: { id: "match-1", status: "MATCHED" },
        payment: { id: "pay-1", status: "COMPLETED" },
      }),
    );

    const result = await processMatchingJob(buildJob());

    expect(result.skippedReason).toContain("already been matched");
    expect(db.threeWayMatch.upsert).not.toHaveBeenCalled();
    expect(db.matchCheck.createMany).not.toHaveBeenCalled();
    expect(db.invoice.updateMany).not.toHaveBeenCalled();
    expect(enqueuePayment).not.toHaveBeenCalled();
  });

  it("re-queues payment when a matched invoice was approved but never got a payment job", async () => {
    db.invoice.findFirst.mockResolvedValue(
      buildContext({
        status: "APPROVED",
        threeWayMatch: { id: "match-1", status: "MATCHED" },
        payment: null,
      }),
    );

    const result = await processMatchingJob(buildJob());

    expect(result.status).toBe("MATCHED");
    expect(result.skippedReason).toBeDefined();
    expect(enqueuePayment).toHaveBeenCalledTimes(1);
    expect(db.threeWayMatch.upsert).not.toHaveBeenCalled();
  });

  it("does not re-queue payment for an already-mismatched invoice", async () => {
    db.invoice.findFirst.mockResolvedValue(
      buildContext({
        status: "EXCEPTION",
        threeWayMatch: { id: "match-1", status: "MISMATCHED" },
        payment: { id: "pay-1", status: "BLOCKED" },
      }),
    );

    await processMatchingJob(buildJob());

    expect(enqueuePayment).not.toHaveBeenCalled();
  });

  it("skips an invoice it cannot claim", async () => {
    db.invoice.findFirst.mockResolvedValue(buildContext({ status: "PAID" }));
    db.invoice.updateMany.mockResolvedValue({ count: 0 });

    const result = await processMatchingJob(buildJob());

    expect(result.skippedReason).toContain("could not be claimed");
    expect(db.threeWayMatch.upsert).not.toHaveBeenCalled();
    expect(enqueuePayment).not.toHaveBeenCalled();
  });

  it("claims only from EXTRACTED or MATCHING", async () => {
    db.invoice.findFirst.mockResolvedValue(buildContext());

    await processMatchingJob(buildJob());

    const claim = firstArg(db.invoice.updateMany) as {
      where: { id: string; organizationId: string; status: { in: string[] } };
    };
    expect(claim.where.organizationId).toBe(ORG);
    expect(claim.where.status.in).toEqual(["EXTRACTED", "MATCHING"]);
  });
});

describe("processMatchingJob — isolation and failures", () => {
  it("treats a cross-organization invoice as missing", async () => {
    db.invoice.findFirst.mockResolvedValue(null);

    const result = await processMatchingJob(buildJob());

    // NOT_FOUND is permanent — it goes terminal instead of burning retries.
    expect(result.skippedReason).toBe("Invoice not found");
    expect(db.threeWayMatch.upsert).not.toHaveBeenCalled();
    expect(exceptionTypes()).toEqual(["SYSTEM_FAILURE"]);
  });

  it("scopes the invoice lookup by organization", async () => {
    db.invoice.findFirst.mockResolvedValue(buildContext());

    await processMatchingJob(buildJob());

    expect(firstArg(db.invoice.findFirst)).toMatchObject({
      where: { id: INVOICE, organizationId: ORG },
    });
  });

  it("retries a transient database failure instead of going terminal", async () => {
    db.invoice.findFirst.mockRejectedValue(new Error("connection reset"));

    await expect(processMatchingJob(buildJob(0))).rejects.toThrow("connection reset");
    expect(db.exception.upsert).not.toHaveBeenCalled();
  });

  it("raises a system failure once the retries are spent", async () => {
    db.invoice.findFirst.mockRejectedValue(new Error("connection reset"));

    const result = await processMatchingJob(buildJob(2));

    expect(result.skippedReason).toBe("connection reset");
    expect(exceptionTypes()).toEqual(["SYSTEM_FAILURE"]);
    expect(auditActions()).toContain("WORKFLOW_FAILED");
  });

  it("only looks for prior invoices sharing this invoice number", async () => {
    db.invoice.findFirst.mockResolvedValue(buildContext());

    await processMatchingJob(buildJob());

    expect(firstArg(db.invoice.findMany)).toMatchObject({
      where: { organizationId: ORG, id: { not: INVOICE }, normalizedInvoiceNumber: "inv20260042" },
    });
  });

  it("excludes GENERATED invoices from the duplicate-number search", async () => {
    // A GENERATED invoice (the PDFKit convenience document) shares its number
    // with the uploaded document the operator re-uploads by design — the demo
    // flow, not a duplicate. Only prior UPLOADED invoices can trip
    // DUPLICATE_INVOICE, so the query itself must filter on source.
    db.invoice.findFirst.mockResolvedValue(buildContext());

    await processMatchingJob(buildJob());

    expect(firstArg(db.invoice.findMany)).toMatchObject({
      where: { source: "UPLOADED" },
    });
  });

  it("flags a duplicate invoice number", async () => {
    db.invoice.findFirst.mockResolvedValue(buildContext());
    db.invoice.findMany.mockResolvedValue([{ id: "inv-0", invoiceNumber: "INV-2026-0042" }]);

    const result = await processMatchingJob(buildJob());

    expect(result.status).toBe("MISMATCHED");
    expect(exceptionTypes()).toContain("DUPLICATE_INVOICE");
    expect(enqueuePayment).not.toHaveBeenCalled();
  });

  it("never matches a GENERATED invoice, even if a stray job is delivered for one", async () => {
    db.invoice.findFirst.mockResolvedValue({ ...buildContext(), source: "GENERATED" });

    const result = await processMatchingJob(buildJob());

    expect(result.skippedReason).toBe("Generated invoices are not matched");
    expect(db.invoice.findMany).not.toHaveBeenCalled();
    expect(exceptionTypes()).toEqual([]);
  });
});
