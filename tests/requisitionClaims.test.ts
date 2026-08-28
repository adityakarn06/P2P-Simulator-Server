import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/db";

const db = {
  requisition: { updateMany: vi.fn(), findFirst: vi.fn() },
  requirement: { upsert: vi.fn() },
  requisitionMessage: { create: vi.fn() },
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

const { applyExtractionResult, applyFallbackClarification } = await import(
  "../src/services/requisition.service.js"
);

const ORG = "dev-org";
const REQ = "req-1";

/** Matches extractedRequirementsSchema in src/zod/requisition.schema.ts. */
const COMPLETE_DRAFT = {
  productName: "wireless keyboard",
  quantity: 100,
  maxUnitPricePaise: 200000,
  currency: "INR",
  deliveryDays: 7,
  location: "Bengaluru",
  specifications: {},
};

const EMPTY_DRAFT = {
  productName: null,
  quantity: null,
  maxUnitPricePaise: null,
  currency: null,
  deliveryDays: null,
  location: null,
  specifications: {},
};

function extraction(extracted: typeof COMPLETE_DRAFT | typeof EMPTY_DRAFT) {
  return {
    intent: "PROCUREMENT",
    extracted,
    missingRequiredFields: [],
    conflicts: [],
    userMessage: "Got it.",
  } as Parameters<typeof applyExtractionResult>[0]["result"];
}

function applyComplete() {
  return applyExtractionResult({
    organizationId: ORG,
    requisitionId: REQ,
    previousDraft: COMPLETE_DRAFT as never,
    result: extraction(COMPLETE_DRAFT),
  });
}

function applyIncomplete() {
  return applyExtractionResult({
    organizationId: ORG,
    requisitionId: REQ,
    previousDraft: EMPTY_DRAFT as never,
    result: extraction(EMPTY_DRAFT),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  db.requisition.updateMany.mockResolvedValue({ count: 1 });
  db.requirement.upsert.mockResolvedValue({});
  db.requisitionMessage.create.mockResolvedValue({});
  db.auditLog.create.mockResolvedValue({});
});

/**
 * The worker's writes are guarded on PROCESSING so a stalled job redelivered
 * after the requisition has been sourced cannot rewind it. Losing that claim is
 * a normal race, not an error: throwing would escape processRequisitionJob
 * uncaught, burn the remaining BullMQ attempts on more Gemini calls, and reach
 * the caller of POST /requisitions as a 500.
 */
describe("requisition writes — losing the PROCESSING claim", () => {
  beforeEach(() => {
    db.requisition.updateMany.mockResolvedValue({ count: 0 });
    db.requisition.findFirst.mockResolvedValue({
      status: "PO_CREATED",
      clarificationMessage: "Got it.",
      missingFields: [],
      conflicts: [],
    });
  });

  it("reports the real status instead of throwing, on the complete path", async () => {
    await expect(applyComplete()).resolves.toMatchObject({ status: "PO_CREATED" });
  });

  it("reports the real status instead of throwing, on the clarification path", async () => {
    await expect(applyIncomplete()).resolves.toMatchObject({ status: "PO_CREATED" });
  });

  it("reports the real status instead of throwing, on the fallback path", async () => {
    // This one runs inside the worker's terminal failure handler, so a throw
    // would turn a handled degradation into an unhandled job failure.
    await expect(
      applyFallbackClarification({
        organizationId: ORG,
        requisitionId: REQ,
        draft: EMPTY_DRAFT as never,
        reason: "Gemini request failed (timeout)",
      }),
    ).resolves.toMatchObject({ status: "PO_CREATED" });
  });

  it("writes nothing at all when the claim is lost", async () => {
    await applyComplete();
    await applyIncomplete();

    expect(db.requirement.upsert).not.toHaveBeenCalled();
    expect(db.requisitionMessage.create).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("scopes every claim by organization and by the status it may write out of", async () => {
    await applyComplete();

    expect(db.requisition.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: REQ, organizationId: ORG, status: "PROCESSING" },
    });
  });
});

describe("requisition writes — holding the claim", () => {
  it("still persists the requirement and audits on the complete path", async () => {
    const result = await applyComplete();

    expect(result.status).toBe("REQUIREMENTS_EXTRACTED");
    expect(db.requirement.upsert).toHaveBeenCalledTimes(1);
    expect(db.requisitionMessage.create).toHaveBeenCalledTimes(1);
  });

  it("claims before writing the requirement, so a lost race rolls nothing back", async () => {
    await applyComplete();

    const claimOrder = db.requisition.updateMany.mock.invocationCallOrder[0] ?? 0;
    const upsertOrder = db.requirement.upsert.mock.invocationCallOrder[0] ?? 0;
    expect(claimOrder).toBeLessThan(upsertOrder);
  });
});
