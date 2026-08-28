import type { Job } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/db";

const db = {
  invoice: { findFirst: vi.fn(), updateMany: vi.fn() },
  payment: { create: vi.fn(), updateMany: vi.fn(), count: vi.fn(), aggregate: vi.fn() },
  exception: { upsert: vi.fn(), count: vi.fn(), findUnique: vi.fn() },
  auditLog: { create: vi.fn() },
  // The claim locks the purchase order row before re-checking the cap.
  $queryRaw: vi.fn(),
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
/** The clean case: the invoice bills exactly what the order committed. */
const INVOICE_TOTAL_PAISE = PO_TOTAL_PAISE;
const AUTO = "auto";

function buildContext(
  overrides: {
    status?: string;
    matchStatus?: string | null;
    totalPaise?: number | null;
    payments?: {
      id: string;
      settlementKey: string;
      status: string;
      amountPaise: number;
      currency: string;
    }[];
  } = {},
) {
  return {
    id: INVOICE,
    organizationId: ORG,
    status: overrides.status ?? "APPROVED",
    invoiceNumber: "INV-2026-0042",
    totalPaise: overrides.totalPaise === undefined ? INVOICE_TOTAL_PAISE : overrides.totalPaise,
    threeWayMatch:
      overrides.matchStatus === null ? null : { status: overrides.matchStatus ?? "MATCHED" },
    payments: overrides.payments ?? [],
    purchaseOrder: {
      id: "po-1",
      poNumber: "PO-20260824-ABC123",
      totalPaise: PO_TOTAL_PAISE,
      currency: "INR",
    },
  };
}

/**
 * The settlement ledger the worker reads. `invoice` is what this invoice has
 * already taken, `purchaseOrder` what the whole order has — the two aggregate
 * calls the worker makes, in that order, and again inside the claim.
 */
function mockLedger(settled: { invoice?: number; purchaseOrder?: number } = {}): void {
  db.payment.aggregate.mockImplementation(
    (args: { where: { invoiceId?: string; settlementKey?: unknown } }) => {
      const base = args.where.invoiceId
        ? (settled.invoice ?? 0)
        : (settled.purchaseOrder ?? settled.invoice ?? 0);

      // Once the provider has been charged, this tranche counts as settled too.
      // That is exactly what decides whether the invoice lands on PAID or on
      // PARTIALLY_PAID, so the fake ledger has to move with it.
      const justCharged =
        charge.mock.calls.length > 0 && args.where.invoiceId && !args.where.settlementKey
          ? ((charge.mock.calls.at(-1)?.[0] as { amountPaise: number } | undefined)?.amountPaise ??
            0)
          : 0;

      return Promise.resolve({ _sum: { amountPaise: base + justCharged } });
    },
  );
}

function buildJob(attemptsMade = 0, data: Record<string, unknown> = {}): Job {
  return {
    data: { invoiceId: INVOICE, organizationId: ORG, settlementKey: AUTO, ...data },
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
  db.$queryRaw.mockResolvedValue([{ id: "po-1" }]);
  db.payment.updateMany.mockResolvedValue({ count: 1 });
  // Nothing has been settled against this invoice or its order, unless a test
  // says so.
  db.payment.count.mockResolvedValue(0);
  mockLedger();
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

    expect(result).toEqual({
      invoiceId: INVOICE,
      settlementKey: AUTO,
      status: "COMPLETED",
      amountPaise: INVOICE_TOTAL_PAISE,
    });

    expect(charge).toHaveBeenCalledTimes(1);
    expect(charge).toHaveBeenCalledWith({
      // Keyed on the tranche, so a later instalment is a distinct charge.
      idempotencyKey: `${INVOICE}:${AUTO}`,
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
      // PARTIALLY_PAID is accepted too: an invoice settled in instalments is
      // still the same debt, and the last tranche has to be able to close it.
      where: {
        id: INVOICE,
        organizationId: ORG,
        status: { in: ["APPROVED", "PARTIALLY_PAID"] },
      },
      data: { status: "PAID" },
    });

    expect(auditActions()).toEqual(["PAYMENT_APPROVED", "PAYMENT_COMPLETED"]);
  });

  it("pays a BLOCKED payment once a human has cleared the invoice", async () => {
    db.invoice.findFirst.mockResolvedValue(
      buildContext({
        payments: [
          {
            id: "pay-1",
            settlementKey: AUTO,
            status: "BLOCKED",
            amountPaise: PO_TOTAL_PAISE,
            currency: "INR",
          },
        ],
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
        payments: [
          {
            id: "pay-1",
            settlementKey: AUTO,
            status: "BLOCKED",
            amountPaise: PO_TOTAL_PAISE,
            currency: "INR",
          },
        ],
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
        payments: [
          {
            id: "pay-1",
            settlementKey: AUTO,
            status: "PENDING",
            amountPaise: PO_TOTAL_PAISE,
            currency: "INR",
          },
        ],
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
        payments: [
          {
            id: "pay-1",
            settlementKey: AUTO,
            status: "COMPLETED",
            amountPaise: PO_TOTAL_PAISE,
            currency: "INR",
          },
        ],
      }),
    );

    const result = await processPaymentJob(buildJob());

    expect(result).toEqual({
      invoiceId: INVOICE,
      settlementKey: AUTO,
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
        payments: [
          {
            id: "pay-1",
            settlementKey: AUTO,
            status: "COMPLETED",
            amountPaise: PO_TOTAL_PAISE,
            currency: "INR",
          },
        ],
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

  it("raises an exception when money moved but the invoice was not APPROVED", async () => {
    db.invoice.findFirst.mockResolvedValue(buildContext());
    // The payment settles, but the guarded invoice transition finds nothing to
    // move — the invoice left APPROVED between the gate and the settle.
    db.invoice.updateMany.mockResolvedValue({ count: 0 });

    await processPaymentJob(buildJob());

    // A console.warn is not a signal anybody sees; this has to reach the
    // exception queue, because money has actually left.
    expect(firstArg(db.exception.upsert)).toMatchObject({
      where: {
        organizationId_type_entityId: {
          organizationId: ORG,
          type: "SYSTEM_FAILURE",
          entityId: INVOICE,
        },
      },
    });
    expect(auditActions()).toContain("PAYMENT_COMPLETED");
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
      settlementKey: AUTO,
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

describe("processPaymentJob — the purchase order caps what can be paid", () => {
  beforeEach(() => {
    db.invoice.findFirst.mockResolvedValue(buildContext());
    // A different invoice against the same purchase order already took the
    // whole committed amount, so nothing is left to pay this one from.
    mockLedger({ invoice: 0, purchaseOrder: PO_TOTAL_PAISE });
  });

  it("refuses a second invoice once its purchase order is settled in full", async () => {
    const result = await processPaymentJob(buildJob());

    expect(charge).not.toHaveBeenCalled();
    expect(db.payment.create).not.toHaveBeenCalled();
    expect(result.skippedReason).toBe(
      "The purchase order is already settled in full; nothing is left to pay",
    );
  });

  it("counts only tranches that hold or have taken the money", async () => {
    await processPaymentJob(buildJob());

    const orderQuery = db.payment.aggregate.mock.calls
      .map((call) => call[0] as { where: Record<string, unknown> })
      .find((call) => call.where.purchaseOrderId !== undefined);

    expect(orderQuery?.where).toMatchObject({
      organizationId: ORG,
      purchaseOrderId: "po-1",
      status: { in: ["PROCESSING", "COMPLETED"] },
    });
  });

  it("raises a DUPLICATE_INVOICE exception so the second document is visible", async () => {
    // A different invoice took the money — that is what makes this a duplicate.
    db.payment.count.mockResolvedValue(1);

    await processPaymentJob(buildJob());

    expect(firstArg(db.exception.upsert)).toMatchObject({
      where: {
        organizationId_type_entityId: {
          organizationId: ORG,
          type: "DUPLICATE_INVOICE",
          entityId: INVOICE,
        },
      },
    });
    expect(firstArg(db.payment.count)).toMatchObject({
      where: { purchaseOrderId: "po-1", invoiceId: { not: INVOICE } },
    });
  });

  // The false alarm this guard prevents: an order spent by this invoice's own
  // tranches is an ordinary settled invoice, not a second document. Raising a
  // CRITICAL exception on it — and blocking its remaining rows — would flag the
  // very invoice that was correctly paid.
  it("stays quiet when the order was spent by this invoice's own tranches", async () => {
    db.payment.count.mockResolvedValue(0);

    await processPaymentJob(buildJob());

    expect(db.exception.upsert).not.toHaveBeenCalled();
  });

  it("does not raise the exception for an invoice that was never approved", async () => {
    db.invoice.findFirst.mockResolvedValue(buildContext({ status: "PAID" }));

    await processPaymentJob(buildJob());

    expect(db.exception.upsert).not.toHaveBeenCalled();
  });

  // The point of the cap over the old "one payment per order" rule: an order
  // that is only *partly* spent still has room for a second document.
  it("pays a second invoice down to whatever the order has left", async () => {
    mockLedger({ invoice: 0, purchaseOrder: PO_TOTAL_PAISE - 1_000_000 });

    const result = await processPaymentJob(buildJob());

    expect(result.amountPaise).toBe(1_000_000);
    expect(charge).toHaveBeenCalledWith(expect.objectContaining({ amountPaise: 1_000_000 }));
  });
});

describe("processPaymentJob — partial settlement", () => {
  it("settles only the amount a human approved and leaves the invoice PARTIALLY_PAID", async () => {
    db.invoice.findFirst.mockResolvedValue(buildContext({ matchStatus: "MISMATCHED" }));

    const job = buildJob(0, {
      settlementKey: "exc-1",
      amountPaise: 20_616_960,
      authorization: { exceptionId: "exc-1", userId: "dev-user", reason: "96 of 100 accepted" },
    });

    const result = await processPaymentJob(job);

    expect(result).toEqual({
      invoiceId: INVOICE,
      settlementKey: "exc-1",
      status: "COMPLETED",
      amountPaise: 20_616_960,
    });

    expect(charge).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `${INVOICE}:exc-1`,
        amountPaise: 20_616_960,
      }),
    );

    const claim = firstArg(db.payment.create) as {
      data: {
        settlementKey: string;
        kind: string;
        amountPaise: number;
        authorizedBy: string;
        authorizationReason: string;
        authorizingExceptionId: string;
      };
    };
    expect(claim.data).toMatchObject({
      settlementKey: "exc-1",
      kind: "PARTIAL",
      amountPaise: 20_616_960,
      authorizedBy: "dev-user",
      authorizationReason: "96 of 100 accepted",
      authorizingExceptionId: "exc-1",
    });

    // Short of the invoice total, so the debt is not discharged.
    const statuses = db.invoice.updateMany.mock.calls.map(
      (call) => (call[0] as { data: { status: string } }).data.status,
    );
    expect(statuses).toContain("PARTIALLY_PAID");
  });

  it("settles the balance of a PARTIALLY_PAID invoice and marks it PAID", async () => {
    db.invoice.findFirst.mockResolvedValue(buildContext({ status: "PARTIALLY_PAID" }));
    mockLedger({ invoice: 20_616_960, purchaseOrder: 20_616_960 });

    const result = await processPaymentJob(buildJob(0, { settlementKey: "exc-2" }));

    expect(result.amountPaise).toBe(INVOICE_TOTAL_PAISE - 20_616_960);

    const statuses = db.invoice.updateMany.mock.calls.map(
      (call) => (call[0] as { data: { status: string } }).data.status,
    );
    expect(statuses).toContain("PAID");
  });

  it("refuses an approved amount larger than the invoice still owes", async () => {
    db.invoice.findFirst.mockResolvedValue(buildContext());

    const result = await processPaymentJob(
      buildJob(0, { settlementKey: "exc-3", amountPaise: PO_TOTAL_PAISE + 1 }),
    );

    expect(charge).not.toHaveBeenCalled();
    expect(result.skippedReason).toContain("exceeds the invoice's outstanding balance");
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
