import type { Job } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/db";

const db = {
  invoice: { findFirst: vi.fn(), updateMany: vi.fn() },
  payment: { create: vi.fn(), updateMany: vi.fn() },
  exception: { upsert: vi.fn(), count: vi.fn(), findUnique: vi.fn() },
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

const charge = vi.fn();

vi.mock("../src/payments/index.js", () => ({
  PAYMENT_PROVIDER_NAME: "SIMULATED",
  getPaymentProvider: () => ({ name: "SIMULATED", charge }),
}));

const { processPaymentJob } = await import("../src/workers/payment.worker.js");
const { AppError } = await import("../src/utils/AppError.js");

const ORG = "dev-org";
const INVOICE = "inv-1";
const PO_TOTAL_PAISE = 21_476_000;

function buildContext(
  overrides: {
    status?: string;
    matchStatus?: string | null;
    payment?: { id: string; status: string; amountPaise: number; currency: string } | null;
  } = {},
) {
  return {
    id: INVOICE,
    organizationId: ORG,
    status: overrides.status ?? "APPROVED",
    invoiceNumber: "INV-2026-0042",
    threeWayMatch:
      overrides.matchStatus === null ? null : { status: overrides.matchStatus ?? "MATCHED" },
    payment: overrides.payment ?? null,
    purchaseOrder: {
      id: "po-1",
      poNumber: "PO-20260824-ABC123",
      totalPaise: PO_TOTAL_PAISE,
      currency: "INR",
    },
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

function auditActions(): string[] {
  return db.auditLog.create.mock.calls.map(
    (call) => (call[0] as { data: { action: string } }).data.action,
  );
}

/** The status written by the Nth payment.updateMany call. */
function paymentUpdates(): { status: string }[] {
  return db.payment.updateMany.mock.calls.map(
    (call) => (call[0] as { data: { status: string } }).data,
  );
}

function uniqueViolation(): Error {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
}

beforeEach(() => {
  vi.clearAllMocks();
  db.invoice.updateMany.mockResolvedValue({ count: 1 });
  db.payment.create.mockResolvedValue({ id: "pay-1" });
  db.payment.updateMany.mockResolvedValue({ count: 1 });
  db.exception.upsert.mockResolvedValue({ id: "exc-1" });
  db.exception.findUnique.mockResolvedValue(null);
  db.exception.count.mockResolvedValue(0);
  db.auditLog.create.mockResolvedValue({});
  charge.mockResolvedValue({ providerReference: "SIM-ABC123" });
});

describe("processPaymentJob — success", () => {
  it("charges once, completes the payment and marks the invoice PAID", async () => {
    db.invoice.findFirst.mockResolvedValue(buildContext());

    const result = await processPaymentJob(buildJob());

    expect(result).toEqual({ invoiceId: INVOICE, status: "COMPLETED" });

    expect(charge).toHaveBeenCalledTimes(1);
    expect(charge).toHaveBeenCalledWith({
      idempotencyKey: INVOICE,
      // The purchase order's total, not the AI-transcribed invoice figure.
      amountPaise: PO_TOTAL_PAISE,
      currency: "INR",
      reference: "INV-2026-0042",
    });

    const claim = firstArg(db.payment.create) as {
      data: { status: string; amountPaise: number; currency: string; provider: string };
    };
    expect(claim.data.status).toBe("PROCESSING");
    expect(claim.data.amountPaise).toBe(PO_TOTAL_PAISE);
    expect(claim.data.provider).toBe("SIMULATED");

    const settle = firstArg(db.payment.updateMany) as {
      where: { status: string };
      data: { status: string; providerReference: string };
    };
    expect(settle.where.status).toBe("PROCESSING");
    expect(settle.data).toMatchObject({ status: "COMPLETED", providerReference: "SIM-ABC123" });

    expect(firstArg(db.invoice.updateMany)).toMatchObject({
      where: { id: INVOICE, organizationId: ORG, status: "APPROVED" },
      data: { status: "PAID" },
    });

    expect(auditActions()).toEqual(["PAYMENT_APPROVED", "PAYMENT_COMPLETED"]);
  });

  it("pays a BLOCKED payment once a human has cleared the invoice", async () => {
    db.invoice.findFirst.mockResolvedValue(
      buildContext({
        payment: { id: "pay-1", status: "BLOCKED", amountPaise: PO_TOTAL_PAISE, currency: "INR" },
      }),
    );
    db.payment.create.mockRejectedValue(uniqueViolation());

    const result = await processPaymentJob(buildJob());

    expect(result.status).toBe("COMPLETED");
    expect(charge).toHaveBeenCalledTimes(1);
    // The reclaim clears the stale block before settling.
    expect(paymentUpdates()[0]).toMatchObject({ status: "PROCESSING", blockedReason: null });
  });
});

describe("processPaymentJob — refusals", () => {
  it("refuses a blocked payment on an invoice still in EXCEPTION", async () => {
    db.invoice.findFirst.mockResolvedValue(
      buildContext({
        status: "EXCEPTION",
        matchStatus: "MISMATCHED",
        payment: { id: "pay-1", status: "BLOCKED", amountPaise: PO_TOTAL_PAISE, currency: "INR" },
      }),
    );

    const result = await processPaymentJob(buildJob());

    expect(result.skippedReason).toBe("Invoice is EXCEPTION, not APPROVED");
    expect(charge).not.toHaveBeenCalled();
    expect(db.payment.create).not.toHaveBeenCalled();
    expect(db.invoice.updateMany).not.toHaveBeenCalled();
  });

  it("refuses an invoice with an exception still open", async () => {
    db.invoice.findFirst.mockResolvedValue(buildContext({ matchStatus: "MISMATCHED" }));
    db.exception.count.mockResolvedValue(1);

    const result = await processPaymentJob(buildJob());

    expect(result.skippedReason).toBe("Invoice has 1 unresolved exception(s)");
    expect(charge).not.toHaveBeenCalled();
  });

  // The override path end to end: matching left this MISMATCHED and BLOCKED, a
  // human signed it off, so the invoice is APPROVED with nothing open.
  it("settles a mismatched invoice a human has overridden, and flags the audit", async () => {
    db.invoice.findFirst.mockResolvedValue(
      buildContext({
        matchStatus: "MISMATCHED",
        payment: { id: "pay-1", status: "PENDING", amountPaise: PO_TOTAL_PAISE, currency: "INR" },
      }),
    );
    db.payment.create.mockRejectedValue(uniqueViolation());

    const result = await processPaymentJob(buildJob());

    expect(result.status).toBe("COMPLETED");
    expect(charge).toHaveBeenCalledTimes(1);

    const completedAudit = db.auditLog.create.mock.calls
      .map((call) => (call[0] as { data: { action: string; metadata?: unknown } }).data)
      .find((data) => data.action === "PAYMENT_COMPLETED");
    expect(completedAudit?.metadata).toMatchObject({ overriddenMatch: true });
  });

  it("refuses an invoice that was never matched", async () => {
    db.invoice.findFirst.mockResolvedValue(buildContext({ matchStatus: null }));

    const result = await processPaymentJob(buildJob());

    expect(result.skippedReason).toBe("Invoice has not been three-way matched");
    expect(charge).not.toHaveBeenCalled();
  });

  it("refuses to pay an invoice twice", async () => {
    db.invoice.findFirst.mockResolvedValue(
      buildContext({
        status: "PAID",
        payment: { id: "pay-1", status: "COMPLETED", amountPaise: PO_TOTAL_PAISE, currency: "INR" },
      }),
    );

    const result = await processPaymentJob(buildJob());

    expect(result).toEqual({
      invoiceId: INVOICE,
      status: "COMPLETED",
      skippedReason: "Invoice is already paid",
    });
    expect(charge).not.toHaveBeenCalled();
    expect(db.payment.create).not.toHaveBeenCalled();
    expect(db.invoice.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a completed payment even if the invoice status lags behind", async () => {
    db.invoice.findFirst.mockResolvedValue(
      buildContext({
        payment: { id: "pay-1", status: "COMPLETED", amountPaise: PO_TOTAL_PAISE, currency: "INR" },
      }),
    );

    const result = await processPaymentJob(buildJob());

    expect(result.skippedReason).toBe("Payment has already completed");
    expect(charge).not.toHaveBeenCalled();
  });

  it("refuses when another worker already owns the payment", async () => {
    db.invoice.findFirst.mockResolvedValue(buildContext());
    db.payment.create.mockRejectedValue(uniqueViolation());
    db.payment.updateMany.mockResolvedValue({ count: 0 });

    const result = await processPaymentJob(buildJob());

    expect(result.skippedReason).toBe("Payment is owned by another attempt");
    expect(charge).not.toHaveBeenCalled();
  });

  // A PROCESSING row may belong to a worker that is inside charge() right now,
  // so it is only taken over once its lease has expired — or when it is this
  // attempt's own claim, identified by the (retry-stable) BullMQ job id.
  it("only resumes a PROCESSING claim that is its own or has gone stale", async () => {
    db.invoice.findFirst.mockResolvedValue(buildContext());
    db.payment.create.mockRejectedValue(uniqueViolation());
    // The fresh-approval claim matches nothing, so the resume claim runs.
    db.payment.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValue({ count: 1 });

    await processPaymentJob({
      data: { invoiceId: INVOICE, organizationId: ORG },
      attemptsMade: 0,
      opts: { attempts: 3 },
      id: "job-42",
    } as unknown as Job);

    const resume = db.payment.updateMany.mock.calls[1]?.[0] as {
      where: { status: string; OR: Array<Record<string, unknown>> };
    };
    expect(resume.where.status).toBe("PROCESSING");
    // Its own claim, by job id.
    expect(resume.where.OR).toContainEqual({ claimedBy: "job-42" });
    // Or an abandoned one, by lease age.
    expect(
      resume.where.OR.some(
        (clause) => "processedAt" in clause && "lt" in (clause.processedAt as object),
      ),
    ).toBe(true);
  });

  it("stamps the claim owner so a retry can resume its own attempt", async () => {
    db.invoice.findFirst.mockResolvedValue(buildContext());

    await processPaymentJob({
      data: { invoiceId: INVOICE, organizationId: ORG },
      attemptsMade: 0,
      opts: { attempts: 3 },
      id: "job-7",
    } as unknown as Job);

    const created = firstArg(db.payment.create) as { data: { claimedBy: string } };
    expect(created.data.claimedBy).toBe("job-7");
  });

  it("does not mark the invoice PAID when the settle update finds nothing to move", async () => {
    db.invoice.findFirst.mockResolvedValue(buildContext());
    db.payment.updateMany.mockResolvedValue({ count: 0 });

    const result = await processPaymentJob(buildJob());

    expect(result.skippedReason).toBe("Payment was already settled by another attempt");
    expect(db.invoice.updateMany).not.toHaveBeenCalled();
    expect(auditActions()).not.toContain("PAYMENT_COMPLETED");
  });
});

describe("processPaymentJob — provider failures", () => {
  it("retries a transient provider outage", async () => {
    db.invoice.findFirst.mockResolvedValue(buildContext());
    charge.mockRejectedValue(new Error("gateway timeout"));

    await expect(processPaymentJob(buildJob(0))).rejects.toThrow("gateway timeout");
    expect(db.exception.upsert).not.toHaveBeenCalled();
  });

  it("fails the payment and raises an exception once the retries are spent", async () => {
    db.invoice.findFirst.mockResolvedValue(buildContext());
    charge.mockRejectedValue(new Error("gateway timeout"));

    const result = await processPaymentJob(buildJob(2));

    expect(result).toEqual({
      invoiceId: INVOICE,
      status: "FAILED",
      skippedReason: "gateway timeout",
    });

    expect(paymentUpdates().at(-1)).toMatchObject({
      status: "FAILED",
      failureReason: "gateway timeout",
    });

    expect(firstArg(db.exception.upsert)).toMatchObject({
      where: { organizationId_type_entityId: { type: "PAYMENT_FAILURE" } },
    });

    // The debt is still real, so the invoice stays APPROVED for a re-drive.
    expect(db.invoice.updateMany).not.toHaveBeenCalled();
    expect(auditActions()).toContain("WORKFLOW_FAILED");
  });

  it("goes terminal immediately on a rejected amount, without burning retries", async () => {
    db.invoice.findFirst.mockResolvedValue(buildContext());
    charge.mockRejectedValue(AppError.validation("Payment amount must be a positive integer"));

    const result = await processPaymentJob(buildJob(0));

    expect(result.status).toBe("FAILED");
    expect(db.exception.upsert).toHaveBeenCalledTimes(1);
  });
});

describe("processPaymentJob — isolation", () => {
  it("scopes the lookup by organization and treats a foreign invoice as missing", async () => {
    db.invoice.findFirst.mockResolvedValue(null);

    await expect(processPaymentJob(buildJob())).rejects.toThrow("Invoice not found");

    expect(firstArg(db.invoice.findFirst)).toMatchObject({
      where: { id: INVOICE, organizationId: ORG },
    });
    expect(charge).not.toHaveBeenCalled();
  });
});
