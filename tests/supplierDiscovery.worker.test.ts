import type { Job } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Prisma, Redis and Gemini are all mocked; the sourcing service's real logic
// runs against the fake client so the transaction contents are asserted too.
const db = {
  requisition: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  product: { findMany: vi.fn() },
  supplierProduct: { findMany: vi.fn() },
  sourcingDecision: { findFirst: vi.fn(), upsert: vi.fn() },
  supplierCandidate: { deleteMany: vi.fn(), createMany: vi.fn() },
  exception: { upsert: vi.fn(), findUnique: vi.fn() },
  auditLog: { create: vi.fn() },
  aIProcessingLog: { create: vi.fn() },
};

const generateStructured = vi.fn();
const enqueuePurchaseOrder = vi.fn().mockResolvedValue("job-1");

vi.mock("../src/config/prisma.js", () => ({
  prisma: {
    ...db,
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  },
  disconnectPrisma: vi.fn(),
}));

vi.mock("../src/ai/index.js", () => ({
  AI_MODEL: "gemini-test",
  getAIProvider: () => ({ generateStructured, analyzeDocument: vi.fn() }),
}));

vi.mock("../src/queues/purchaseOrder.queue.js", () => ({
  enqueuePurchaseOrder: (...args: unknown[]) => enqueuePurchaseOrder(...args),
  purchaseOrderQueue: {},
  PURCHASE_ORDER_JOBS: { CREATE_PURCHASE_ORDER: "create-purchase-order" },
}));

const { processSupplierDiscoveryJob } = await import("../src/workers/supplierDiscovery.worker.js");

const ORG = "dev-org";
const REQ = "req-1";

const CATALOG = [
  {
    id: "prod-wireless-keyboard",
    sku: "PRPH-KB-001",
    name: "Wireless Keyboard",
    category: "PERIPHERALS",
  },
  {
    id: "prod-wireless-mouse",
    sku: "PRPH-MS-001",
    name: "Wireless Mouse",
    category: "PERIPHERALS",
  },
  { id: "prod-projector", sku: "CMPT-PJ-001", name: "HD Projector", category: "COMPUTING" },
];

function supplier(id: string, name: string, rating: number, reliabilityScore: number) {
  return { id, name, isActive: true, rating, reliabilityScore };
}

// The seeded keyboard scenario: TechSource is the only eligible supplier.
const KEYBOARD_OFFERS = [
  {
    id: "sp-keyboard-techsource",
    unitPricePaise: 182_000,
    currency: "INR",
    stockQuantity: 500,
    deliveryDays: 5,
    minOrderQuantity: 1,
    supplier: supplier("sup-techsource", "TechSource Distributors", 4.6, 0.95),
  },
  {
    id: "sp-keyboard-global",
    unitPricePaise: 195_000,
    currency: "INR",
    stockQuantity: 300,
    deliveryDays: 8, // misses the 7-day deadline
    minOrderQuantity: 1,
    supplier: supplier("sup-global-office", "Global Office Supplies", 4.2, 0.88),
  },
  {
    id: "sp-keyboard-budget",
    unitPricePaise: 170_000, // cheapest, but only 40 in stock
    currency: "INR",
    stockQuantity: 40,
    deliveryDays: 4,
    minOrderQuantity: 1,
    supplier: supplier("sup-budget-bulk", "BudgetBulk Traders", 3.6, 0.72),
  },
];

function requirement(overrides: Record<string, unknown> = {}) {
  return {
    id: "rq-1",
    requisitionId: REQ,
    productName: "wireless keyboards",
    category: null,
    quantity: 100,
    maxUnitPricePaise: 200_000,
    deliveryDeadlineDays: 7,
    currency: "INR",
    ...overrides,
  };
}

function job(overrides: { attemptsMade?: number; attempts?: number } = {}): Job {
  return {
    data: { requisitionId: REQ, organizationId: ORG },
    opts: { attempts: overrides.attempts ?? 3 },
    attemptsMade: overrides.attemptsMade ?? 0,
  } as unknown as Job;
}

/** All audit actions written during the run, in order. */
function auditActions(): string[] {
  return db.auditLog.create.mock.calls.map(
    (call) => (call[0] as { data: { action: string } }).data.action,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  db.product.findMany.mockResolvedValue(CATALOG);
  db.supplierProduct.findMany.mockResolvedValue([]);
  db.supplierCandidate.deleteMany.mockResolvedValue({ count: 0 });
  db.supplierCandidate.createMany.mockResolvedValue({ count: 0 });
  db.sourcingDecision.upsert.mockResolvedValue({ id: "sd-1" });
  db.sourcingDecision.findFirst.mockResolvedValue(null);
  db.requisition.update.mockResolvedValue({ id: REQ });
  db.requisition.updateMany.mockResolvedValue({ count: 1 });
  db.exception.upsert.mockResolvedValue({ id: "exc-1" });
  db.exception.findUnique.mockResolvedValue(null);
  db.auditLog.create.mockResolvedValue({ id: "audit-1" });
  db.aIProcessingLog.create.mockResolvedValue({ id: "ai-1" });
  generateStructured.mockResolvedValue(
    JSON.stringify({ rationale: "TechSource Distributors met every requirement." }),
  );
});

describe("processSupplierDiscoveryJob — happy path", () => {
  beforeEach(() => {
    db.requisition.findFirst.mockResolvedValue({
      id: REQ,
      organizationId: ORG,
      status: "REQUIREMENTS_EXTRACTED",
      requirement: requirement(),
    });
    db.supplierProduct.findMany.mockResolvedValue(KEYBOARD_OFFERS);
  });

  it("selects the only eligible supplier and enqueues the purchase order", async () => {
    const result = await processSupplierDiscoveryJob(job());

    expect(result).toMatchObject({
      requisitionId: REQ,
      status: "SUPPLIER_SELECTED",
      selectedSupplierId: "sup-techsource",
      skipped: false,
    });

    // The transition is claimed with a status guard so a concurrent run loses.
    expect(db.requisition.updateMany).toHaveBeenCalledWith({
      where: { id: REQ, organizationId: ORG, status: "REQUIREMENTS_EXTRACTED" },
      data: { status: "SUPPLIER_SELECTED", failureReason: null },
    });
    expect(enqueuePurchaseOrder).toHaveBeenCalledExactlyOnceWith({
      requisitionId: REQ,
      organizationId: ORG,
    });
    expect(db.exception.upsert).not.toHaveBeenCalled();
  });

  it("scopes the offer lookup to the organization through the supplier relation", async () => {
    await processSupplierDiscoveryJob(job());

    expect(db.supplierProduct.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { productId: "prod-wireless-keyboard", supplier: { organizationId: ORG } },
      }),
    );
    expect(db.requisition.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: REQ, organizationId: ORG } }),
    );
  });

  it("persists every evaluated supplier, ineligible ones with a reason", async () => {
    await processSupplierDiscoveryJob(job());

    const rows = db.supplierCandidate.createMany.mock.calls[0]?.[0] as {
      data: Array<Record<string, unknown>>;
    };
    expect(rows.data).toHaveLength(3);

    const [winner, ...rejected] = rows.data;
    expect(winner).toMatchObject({
      supplierId: "sup-techsource",
      rank: 1,
      eligible: true,
      ineligibleReason: null,
      unitPricePaise: 182_000,
    });
    expect(rejected.map((row) => row.eligible)).toEqual([false, false]);
    expect(rejected.map((row) => row.ineligibleReason)).toEqual([
      "Stock 40 is below the required 100",
      "Delivery in 8 days exceeds the 7-day deadline",
    ]);
    // Every row is tenant-stamped.
    expect(rows.data.every((row) => row.organizationId === ORG)).toBe(true);
  });

  it("records the decision and both audit events", async () => {
    await processSupplierDiscoveryJob(job());

    expect(db.sourcingDecision.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { requisitionId: REQ },
        create: expect.objectContaining({
          selectedSupplierId: "sup-techsource",
          selectedSupplierProductId: "sp-keyboard-techsource",
          candidatesEvaluated: 3,
          rationale: "TechSource Distributors met every requirement.",
        }),
      }),
    );
    expect(auditActions()).toEqual(["SUPPLIERS_DISCOVERED", "SUPPLIER_SELECTED"]);
  });

  it("stores the deterministic rationale when Gemini fails, and still succeeds", async () => {
    generateStructured.mockRejectedValue(new Error("Gemini unavailable"));

    const result = await processSupplierDiscoveryJob(job());

    expect(result.status).toBe("SUPPLIER_SELECTED");
    const call = db.sourcingDecision.upsert.mock.calls[0]?.[0] as {
      create: { rationale: string };
    };
    expect(call.create.rationale).toContain("TechSource Distributors selected with a score of");
    expect(enqueuePurchaseOrder).toHaveBeenCalledOnce();
  });

  it("ignores a model that tries to overturn the selection", async () => {
    generateStructured.mockResolvedValue(
      JSON.stringify({
        rationale: "BudgetBulk Traders are cheaper and should be chosen instead.",
      }),
    );

    const result = await processSupplierDiscoveryJob(job());

    expect(result.selectedSupplierId).toBe("sup-techsource");
    const call = db.sourcingDecision.upsert.mock.calls[0]?.[0] as {
      create: { selectedSupplierId: string; rationale: string };
    };
    expect(call.create.selectedSupplierId).toBe("sup-techsource");
    // The reply never names the winner, so the sanity gate discards it.
    expect(call.create.rationale).toContain("TechSource Distributors selected with a score of");
  });
});

describe("processSupplierDiscoveryJob — no eligible supplier", () => {
  beforeEach(() => {
    db.requisition.findFirst.mockResolvedValue({
      id: REQ,
      organizationId: ORG,
      status: "REQUIREMENTS_EXTRACTED",
      requirement: requirement({ productName: "HD projectors", quantity: 10 }),
    });
    db.supplierProduct.findMany.mockResolvedValue([
      {
        id: "sp-projector-techsource",
        unitPricePaise: 4_500_000, // over budget
        currency: "INR",
        stockQuantity: 3,
        deliveryDays: 10,
        minOrderQuantity: 1,
        supplier: supplier("sup-techsource", "TechSource Distributors", 4.6, 0.95),
      },
      {
        id: "sp-projector-global",
        unitPricePaise: 3_900_000,
        currency: "INR",
        stockQuantity: 0, // out of stock
        deliveryDays: 12,
        minOrderQuantity: 1,
        supplier: supplier("sup-global-office", "Global Office Supplies", 4.2, 0.88),
      },
    ]);
  });

  it("fails the requisition and opens a NO_SUPPLIER_FOUND exception without throwing", async () => {
    const result = await processSupplierDiscoveryJob(job());

    expect(result).toMatchObject({ status: "FAILED", selectedSupplierId: null, skipped: false });
    expect(result.reason).toContain("No supplier met every requirement");
    expect(result.reason).toContain("Stock 3 is below the required 10");

    expect(db.requisition.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "FAILED", failureReason: result.reason }),
      }),
    );
    expect(db.exception.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId_type_entityId: {
            organizationId: ORG,
            type: "NO_SUPPLIER_FOUND",
            entityId: REQ,
          },
        },
        create: expect.objectContaining({ severity: "CRITICAL", entityType: "Requisition" }),
      }),
    );
    expect(auditActions()).toEqual(["EXCEPTION_CREATED", "WORKFLOW_FAILED"]);
  });

  it("does not enqueue a purchase order or call Gemini", async () => {
    await processSupplierDiscoveryJob(job());

    expect(enqueuePurchaseOrder).not.toHaveBeenCalled();
    expect(generateStructured).not.toHaveBeenCalled();
  });

  it("still persists the rejected candidates so the reasons are auditable", async () => {
    await processSupplierDiscoveryJob(job());

    const rows = db.supplierCandidate.createMany.mock.calls[0]?.[0] as {
      data: Array<Record<string, unknown>>;
    };
    expect(rows.data).toHaveLength(2);
    expect(rows.data.every((row) => row.eligible === false && row.totalScore === 0)).toBe(true);
  });
});

describe("processSupplierDiscoveryJob — unmatchable requirements", () => {
  function withProductName(productName: string) {
    db.requisition.findFirst.mockResolvedValue({
      id: REQ,
      organizationId: ORG,
      status: "REQUIREMENTS_EXTRACTED",
      requirement: requirement({ productName }),
    });
  }

  it("fails when nothing in the catalog matches", async () => {
    withProductName("industrial forklift");

    const result = await processSupplierDiscoveryJob(job());

    expect(result.status).toBe("FAILED");
    expect(result.reason).toBe('No catalog product matches "industrial forklift"');
    expect(db.supplierProduct.findMany).not.toHaveBeenCalled();
    expect(enqueuePurchaseOrder).not.toHaveBeenCalled();
  });

  it("refuses to guess when the wording matches several products", async () => {
    withProductName("wireless");

    const result = await processSupplierDiscoveryJob(job());

    expect(result.status).toBe("FAILED");
    expect(result.reason).toContain("matches more than one catalog product");
    expect(result.reason).toContain("Wireless Keyboard");
    expect(result.reason).toContain("Wireless Mouse");
    expect(enqueuePurchaseOrder).not.toHaveBeenCalled();
  });
});

describe("processSupplierDiscoveryJob — idempotency and state guards", () => {
  it("returns the stored decision and writes nothing when already sourced", async () => {
    db.requisition.findFirst.mockResolvedValue({
      id: REQ,
      organizationId: ORG,
      status: "SUPPLIER_SELECTED",
      requirement: requirement(),
    });
    db.sourcingDecision.findFirst.mockResolvedValue({
      id: "sd-1",
      selectedSupplierId: "sup-techsource",
    });

    const result = await processSupplierDiscoveryJob(job());

    expect(result).toMatchObject({
      status: "SUPPLIER_SELECTED",
      selectedSupplierId: "sup-techsource",
      skipped: true,
    });
    expect(db.supplierCandidate.createMany).not.toHaveBeenCalled();
    expect(db.sourcingDecision.upsert).not.toHaveBeenCalled();
    expect(db.requisition.updateMany).not.toHaveBeenCalled();
    expect(generateStructured).not.toHaveBeenCalled();
  });

  it("re-enqueues the purchase order so a lost enqueue cannot strand the requisition", async () => {
    // The PO job is added after the sourcing transaction commits. If Redis
    // failed in that window the decision exists with no job behind it, and the
    // retry must heal it rather than returning early.
    db.requisition.findFirst.mockResolvedValue({
      id: REQ,
      organizationId: ORG,
      status: "SUPPLIER_SELECTED",
      requirement: requirement(),
    });
    db.sourcingDecision.findFirst.mockResolvedValue({
      id: "sd-1",
      selectedSupplierId: "sup-techsource",
    });

    await processSupplierDiscoveryJob(job());

    expect(enqueuePurchaseOrder).toHaveBeenCalledExactlyOnceWith({
      requisitionId: REQ,
      organizationId: ORG,
    });
    // Healing must not rewrite any state.
    expect(db.requisition.updateMany).not.toHaveBeenCalled();
    expect(db.sourcingDecision.upsert).not.toHaveBeenCalled();
  });

  it("loses a concurrent race without writing anything", async () => {
    db.requisition.findFirst.mockResolvedValue({
      id: REQ,
      organizationId: ORG,
      status: "REQUIREMENTS_EXTRACTED",
      requirement: requirement(),
    });
    db.supplierProduct.findMany.mockResolvedValue(KEYBOARD_OFFERS);
    // Another job already claimed the transition.
    db.requisition.updateMany.mockResolvedValue({ count: 0 });
    db.sourcingDecision.findFirst.mockResolvedValue({
      id: "sd-1",
      selectedSupplierId: "sup-techsource",
    });

    const result = await processSupplierDiscoveryJob(job());

    expect(result).toMatchObject({ status: "SUPPLIER_SELECTED", skipped: true });
    // A lost race is not a system failure.
    expect(db.exception.upsert).not.toHaveBeenCalled();
  });

  it("does not re-source a requisition whose purchase order already exists", async () => {
    db.requisition.findFirst.mockResolvedValue({
      id: REQ,
      organizationId: ORG,
      status: "PO_CREATED",
      requirement: requirement(),
    });
    db.sourcingDecision.findFirst.mockResolvedValue({
      id: "sd-1",
      selectedSupplierId: "sup-techsource",
    });

    const result = await processSupplierDiscoveryJob(job());

    expect(result.skipped).toBe(true);
    expect(db.sourcingDecision.upsert).not.toHaveBeenCalled();
    expect(enqueuePurchaseOrder).not.toHaveBeenCalled();
  });

  it("skips a requisition that is not ready for sourcing", async () => {
    for (const status of ["NEEDS_CLARIFICATION", "PROCESSING", "FAILED", "CREATED"]) {
      vi.clearAllMocks();
      db.requisition.findFirst.mockResolvedValue({
        id: REQ,
        organizationId: ORG,
        status,
        requirement: null,
      });

      const result = await processSupplierDiscoveryJob(job());

      expect(result).toMatchObject({ status, skipped: true, selectedSupplierId: null });
      expect(db.requisition.update).not.toHaveBeenCalled();
      expect(db.exception.upsert).not.toHaveBeenCalled();
      expect(enqueuePurchaseOrder).not.toHaveBeenCalled();
    }
  });

  it("replaces candidates from a previous partial run rather than duplicating them", async () => {
    db.requisition.findFirst.mockResolvedValue({
      id: REQ,
      organizationId: ORG,
      status: "REQUIREMENTS_EXTRACTED",
      requirement: requirement(),
    });
    db.supplierProduct.findMany.mockResolvedValue(KEYBOARD_OFFERS);

    await processSupplierDiscoveryJob(job());

    expect(db.supplierCandidate.deleteMany).toHaveBeenCalledWith({ where: { requisitionId: REQ } });
    const deleteOrder = db.supplierCandidate.deleteMany.mock.invocationCallOrder[0] ?? 0;
    const createOrder = db.supplierCandidate.createMany.mock.invocationCallOrder[0] ?? 0;
    expect(deleteOrder).toBeLessThan(createOrder);
  });
});

describe("processSupplierDiscoveryJob — technical failure", () => {
  beforeEach(() => {
    // REQUIREMENTS_EXTRACTED is written in the same transaction as the
    // Requirement row, so a missing one is an invariant breach.
    db.requisition.findFirst.mockResolvedValue({
      id: REQ,
      organizationId: ORG,
      status: "REQUIREMENTS_EXTRACTED",
      requirement: null,
    });
  });

  it("throws so BullMQ retries while attempts remain", async () => {
    await expect(processSupplierDiscoveryJob(job({ attemptsMade: 0 }))).rejects.toThrow(
      /no Requirement record/,
    );
    expect(db.exception.upsert).not.toHaveBeenCalled();
  });

  it("opens a SYSTEM_FAILURE exception on the final attempt instead of retrying forever", async () => {
    const result = await processSupplierDiscoveryJob(job({ attemptsMade: 2, attempts: 3 }));

    expect(result).toMatchObject({ status: "FAILED", skipped: false });
    expect(db.exception.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId_type_entityId: expect.objectContaining({ type: "SYSTEM_FAILURE" }),
        }),
      }),
    );
    expect(auditActions()).toEqual(["EXCEPTION_CREATED", "WORKFLOW_FAILED"]);
    expect(enqueuePurchaseOrder).not.toHaveBeenCalled();
  });

  it("routes an infrastructure failure to the same path instead of stalling", async () => {
    db.requisition.findFirst.mockResolvedValue({
      id: REQ,
      organizationId: ORG,
      status: "REQUIREMENTS_EXTRACTED",
      requirement: requirement(),
    });
    db.product.findMany.mockRejectedValue(new Error("connection terminated unexpectedly"));

    // Retries while attempts remain...
    await expect(processSupplierDiscoveryJob(job({ attemptsMade: 0 }))).rejects.toThrow(
      /connection terminated/,
    );

    // ...then records the failure rather than leaving the requisition in
    // REQUIREMENTS_EXTRACTED with nothing driving it forward.
    const result = await processSupplierDiscoveryJob(job({ attemptsMade: 2, attempts: 3 }));

    expect(result).toMatchObject({ status: "FAILED", skipped: false });
    expect(result.reason).toContain("connection terminated");
    expect(db.exception.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId_type_entityId: expect.objectContaining({ type: "SYSTEM_FAILURE" }),
        }),
      }),
    );
  });

  it("surfaces an unreadable requisition instead of masking it", async () => {
    db.requisition.findFirst.mockResolvedValue(null);

    await expect(
      processSupplierDiscoveryJob(job({ attemptsMade: 2, attempts: 3 })),
    ).rejects.toThrow(/Requisition not found/);
    // Nothing to attach a failure to, so no exception is invented.
    expect(db.exception.upsert).not.toHaveBeenCalled();
  });
});
