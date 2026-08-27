import type { Job } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Prisma is mocked; the purchase-order service's real logic runs against the
// fake client so the transaction contents are asserted too.
const db = {
  requisition: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  supplierProduct: { findFirst: vi.fn() },
  purchaseOrder: { create: vi.fn(), findMany: vi.fn() },
  shipment: { upsert: vi.fn() },
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

const { processPurchaseOrderJob } = await import("../src/workers/purchaseOrder.worker.js");
const { applyPurchaseOrderCreation, buildPoNumber, listPurchaseOrders } = await import(
  "../src/services/purchaseOrder.service.js"
);

const ORG = "dev-org";
const REQ = "req-abc123";

function requirement(overrides: Record<string, unknown> = {}) {
  return {
    id: "rq-1",
    requisitionId: REQ,
    productName: "wireless keyboards",
    quantity: 100,
    maxUnitPricePaise: 200_000,
    deliveryDeadlineDays: 7,
    currency: "INR",
    ...overrides,
  };
}

function requisitionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REQ,
    organizationId: ORG,
    status: "SUPPLIER_SELECTED",
    requirement: requirement(),
    sourcingDecision: {
      selectedSupplierId: "sup-techsource",
      selectedSupplierProductId: "sp-keyboard-techsource",
    },
    purchaseOrder: null,
    ...overrides,
  };
}

function offer(overrides: Record<string, unknown> = {}) {
  return {
    id: "sp-keyboard-techsource",
    unitPricePaise: 182_000,
    currency: "INR",
    stockQuantity: 500,
    deliveryDays: 5,
    minOrderQuantity: 1,
    product: {
      id: "prod-wireless-keyboard",
      name: "Wireless Keyboard",
      sku: "PRPH-KB-001",
      unit: "unit",
    },
    supplier: {
      id: "sup-techsource",
      name: "TechSource Distributors",
      isActive: true,
      rating: 4.6,
      reliabilityScore: 0.95,
    },
    ...overrides,
  };
}

function job(overrides: { attempts?: number; attemptsMade?: number } = {}): Job {
  return {
    data: { requisitionId: REQ, organizationId: ORG },
    opts: { attempts: overrides.attempts ?? 3 },
    attemptsMade: overrides.attemptsMade ?? 0,
  } as unknown as Job;
}

function auditActions(): string[] {
  return db.auditLog.create.mock.calls.map(
    (call) => (call[0] as { data: { action: string } }).data.action,
  );
}

/** The data payload of the single purchaseOrder.create call. */
function createdPO(): Record<string, unknown> {
  const call = db.purchaseOrder.create.mock.calls[0] as [{ data: Record<string, unknown> }];
  return call[0].data;
}

beforeEach(() => {
  vi.clearAllMocks();
  db.requisition.updateMany.mockResolvedValue({ count: 1 });
  db.purchaseOrder.create.mockImplementation(() =>
    Promise.resolve({ id: "po-1", poNumber: "PO-X", totalPaise: 21_476_000 }),
  );
  db.exception.upsert.mockResolvedValue({ id: "exc-1" });
  db.exception.findUnique.mockResolvedValue(null);
  db.shipment.upsert.mockResolvedValue({ id: "ship-1", trackingNumber: "TRK-PO-1" });
});

describe("processPurchaseOrderJob — happy path", () => {
  beforeEach(() => {
    db.requisition.findFirst.mockResolvedValue(requisitionRow());
    db.supplierProduct.findFirst.mockResolvedValue(offer());
  });

  it("creates a PENDING_APPROVAL purchase order with deterministic totals", async () => {
    const result = await processPurchaseOrderJob(job());

    expect(result).toMatchObject({ status: "PO_CREATED", purchaseOrderId: "po-1", skipped: false });

    const data = createdPO();
    expect(data).toMatchObject({
      organizationId: ORG,
      requisitionId: REQ,
      supplierId: "sup-techsource",
      status: "PENDING_APPROVAL",
      currency: "INR",
      subtotalPaise: 18_200_000,
      taxPaise: 3_276_000,
      totalPaise: 21_476_000,
      taxRateBps: 1800,
    });
    // Derived from the whole requisition id, so a retry regenerates the same
    // number and two ids sharing a tail cannot collide.
    expect(data.poNumber).toMatch(/^PO-\d{8}-[0-9A-Z]{12}$/);
    const now = new Date();
    expect(data.poNumber).toBe(buildPoNumber(REQ, now));
  });

  it("creates the line item in the same nested write", async () => {
    await processPurchaseOrderJob(job());

    const items = (createdPO().items as { create: Record<string, unknown>[] }).create;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      productId: "prod-wireless-keyboard",
      supplierProductId: "sp-keyboard-techsource",
      quantity: 100,
      unitPricePaise: 182_000,
      lineTotalPaise: 18_200_000,
    });
  });

  it("claims the requisition transition guarded on SUPPLIER_SELECTED", async () => {
    await processPurchaseOrderJob(job());

    expect(db.requisition.updateMany).toHaveBeenCalledWith({
      where: { id: REQ, organizationId: ORG, status: "SUPPLIER_SELECTED" },
      data: { status: "PO_CREATED", failureReason: null },
    });
  });

  it("audits the creation and opens a PO_APPROVAL_REQUIRED exception", async () => {
    await processPurchaseOrderJob(job());

    expect(auditActions()).toEqual(["PO_CREATED", "EXCEPTION_CREATED"]);
    expect(db.exception.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId_type_entityId: {
            organizationId: ORG,
            type: "PO_APPROVAL_REQUIRED",
            entityId: "po-1",
          },
        },
      }),
    );
  });

  it("enqueues nothing — approval is a human action", async () => {
    const result = await processPurchaseOrderJob(job());
    expect(result.reason).toBeNull();
  });
});

describe("processPurchaseOrderJob — idempotency and state guards", () => {
  it("skips a requisition that already has a purchase order", async () => {
    db.requisition.findFirst.mockResolvedValue(
      requisitionRow({
        status: "PO_CREATED",
        purchaseOrder: { id: "po-existing", status: "PENDING_APPROVAL" },
      }),
    );

    const result = await processPurchaseOrderJob(job());

    expect(result).toMatchObject({ skipped: true, purchaseOrderId: "po-existing" });
    expect(db.purchaseOrder.create).not.toHaveBeenCalled();
  });

  it("skips a requisition that is not ready for a purchase order", async () => {
    db.requisition.findFirst.mockResolvedValue(
      requisitionRow({ status: "REQUIREMENTS_EXTRACTED" }),
    );

    const result = await processPurchaseOrderJob(job());

    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("REQUIREMENTS_EXTRACTED");
    expect(db.purchaseOrder.create).not.toHaveBeenCalled();
  });

  it("reports the winner's outcome when it loses the concurrency race", async () => {
    db.requisition.findFirst
      .mockResolvedValueOnce(requisitionRow())
      // Re-read after the refused claim: the winner already created the PO.
      .mockResolvedValueOnce({ status: "PO_CREATED", purchaseOrder: { id: "po-winner" } });
    db.supplierProduct.findFirst.mockResolvedValue(offer());
    db.requisition.updateMany.mockResolvedValue({ count: 0 });

    const result = await processPurchaseOrderJob(job());

    expect(result).toMatchObject({
      skipped: true,
      status: "PO_CREATED",
      purchaseOrderId: "po-winner",
    });
    expect(db.exception.upsert).not.toHaveBeenCalled();
  });

  it("does not mark a requisition FAILED once it has moved past SUPPLIER_SELECTED", async () => {
    // A redriven job re-reads stock the winning job already consumed, so
    // eligibility now fails — but the winner's purchase order still stands.
    db.requisition.findFirst
      .mockResolvedValueOnce(requisitionRow())
      .mockResolvedValueOnce({ status: "PO_CREATED", purchaseOrder: { id: "po-winner" } });
    db.supplierProduct.findFirst.mockResolvedValue(offer({ stockQuantity: 0 }));
    db.requisition.updateMany.mockResolvedValue({ count: 0 });

    const result = await processPurchaseOrderJob(job());

    expect(result).toMatchObject({ skipped: true, status: "PO_CREATED" });
    expect(db.exception.upsert).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("processPurchaseOrderJob — stale sourcing data", () => {
  beforeEach(() => {
    db.requisition.findFirst.mockResolvedValue(requisitionRow());
  });

  it("fails when the supplier product no longer exists", async () => {
    db.supplierProduct.findFirst.mockResolvedValue(null);

    const result = await processPurchaseOrderJob(job());

    expect(result).toMatchObject({ status: "FAILED", purchaseOrderId: null });
    expect(db.purchaseOrder.create).not.toHaveBeenCalled();
    expect(db.exception.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId_type_entityId: expect.objectContaining({ type: "NO_SUPPLIER_FOUND" }),
        }),
      }),
    );
    expect(auditActions()).toEqual(["EXCEPTION_CREATED", "WORKFLOW_FAILED"]);
  });

  it("fails when the price has risen above the requirement ceiling", async () => {
    db.supplierProduct.findFirst.mockResolvedValue(offer({ unitPricePaise: 250_000 }));

    const result = await processPurchaseOrderJob(job());

    expect(result.status).toBe("FAILED");
    expect(result.reason).toContain("TechSource Distributors");
    expect(db.purchaseOrder.create).not.toHaveBeenCalled();
  });

  it("fails when stock has dropped below the ordered quantity", async () => {
    db.supplierProduct.findFirst.mockResolvedValue(offer({ stockQuantity: 10 }));

    const result = await processPurchaseOrderJob(job());

    expect(result.status).toBe("FAILED");
    expect(db.purchaseOrder.create).not.toHaveBeenCalled();
  });
});

describe("processPurchaseOrderJob — technical failure", () => {
  beforeEach(() => {
    // SUPPLIER_SELECTED with no sourcing decision is an invariant breach.
    db.requisition.findFirst.mockResolvedValue(requisitionRow({ sourcingDecision: null }));
  });

  it("rethrows while retries remain", async () => {
    await expect(processPurchaseOrderJob(job({ attemptsMade: 0 }))).rejects.toThrow(
      /no requirement or sourcing decision/,
    );
    // applyPurchaseOrderFailure writes through updateMany — the terminal path
    // must not run while retries remain.
    expect(db.requisition.updateMany).not.toHaveBeenCalled();
  });

  it("records a SYSTEM_FAILURE exception on the final attempt", async () => {
    const result = await processPurchaseOrderJob(job({ attempts: 3, attemptsMade: 2 }));

    expect(result.status).toBe("FAILED");
    expect(db.requisition.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "SUPPLIER_SELECTED" }),
        data: expect.objectContaining({ status: "FAILED" }),
      }),
    );
    expect(db.exception.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId_type_entityId: expect.objectContaining({ type: "SYSTEM_FAILURE" }),
        }),
      }),
    );
  });
});

describe("applyPurchaseOrderCreation — auto-approved purchase orders", () => {
  const input = {
    organizationId: ORG,
    requisitionId: REQ,
    supplierId: "sup-techsource",
    poNumber: "PO-20260824-ABC123",
    status: "APPROVED" as const,
    approvalReason: "Below the auto-approval threshold",
    currency: "INR",
    subtotalPaise: 18_200_000,
    taxPaise: 3_276_000,
    totalPaise: 21_476_000,
    taxRateBps: 1800,
    expectedDeliveryDate: new Date("2026-08-29T00:00:00.000Z"),
    items: [
      {
        productId: "prod-wireless-keyboard",
        supplierProductId: "sp-keyboard-techsource",
        description: "Wireless Keyboard (PRPH-KB-001)",
        quantity: 100,
        unitPricePaise: 182_000,
        lineTotalPaise: 18_200_000,
      },
    ],
  };

  beforeEach(() => {
    db.purchaseOrder.create.mockResolvedValue({
      id: "po-1",
      poNumber: input.poNumber,
      totalPaise: input.totalPaise,
      expectedDeliveryDate: input.expectedDeliveryDate,
    });
  });

  // Without this the PO would sit APPROVED forever with nothing for the
  // receipt flow to act on — approvePurchaseOrder early-returns for an
  // already-approved PO and so can never create the shipment later.
  it("creates the shipment in the same transaction", async () => {
    await applyPurchaseOrderCreation(input);

    expect(db.shipment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { purchaseOrderId: "po-1" },
        update: {},
        create: expect.objectContaining({ status: "IN_TRANSIT" }),
      }),
    );
    expect(auditActions()).toEqual(["PO_CREATED", "PO_APPROVED", "SHIPMENT_CREATED"]);
  });

  it("stamps the approval and opens no approval exception", async () => {
    await applyPurchaseOrderCreation(input);

    expect(createdPO().approvedAt).toBeInstanceOf(Date);
    expect(db.exception.upsert).not.toHaveBeenCalled();
  });

  it("still holds a PENDING_APPROVAL purchase order for a human", async () => {
    await applyPurchaseOrderCreation({ ...input, status: "PENDING_APPROVAL" });

    expect(db.shipment.upsert).not.toHaveBeenCalled();
    expect(auditActions()).toEqual(["PO_CREATED", "EXCEPTION_CREATED"]);
  });
});

describe("listPurchaseOrders", () => {
  it("breaks createdAt ties by id so pages cannot repeat or skip rows", async () => {
    db.purchaseOrder.findMany.mockResolvedValue([]);

    await listPurchaseOrders({ organizationId: ORG, limit: 20 });

    expect(db.purchaseOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ createdAt: "desc" }, { id: "desc" }] }),
    );
  });
});
