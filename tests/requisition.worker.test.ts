import type { Job } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/db";

const db = {
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

const enqueueSupplierDiscovery = vi.fn();
vi.mock("../src/queues/supplier.queue.js", () => ({
  supplierDiscoveryQueue: {},
  SUPPLIER_DISCOVERY_JOBS: { DISCOVER_SUPPLIERS: "discover-suppliers" },
  enqueueSupplierDiscovery: (...args: unknown[]) => enqueueSupplierDiscovery(...args),
}));

const generateStructured = vi.fn();
vi.mock("../src/ai/index.js", () => ({
  AI_MODEL: "gemini-test",
  getAIProvider: () => ({ generateStructured, analyzeDocument: vi.fn() }),
}));

vi.mock("../src/services/aiLog.service.js", () => ({ recordAIProcessing: vi.fn() }));

const loadRequisitionForProcessing = vi.fn();
const applyFallbackClarification = vi.fn();
const applyExtractionResult = vi.fn();

vi.mock("../src/services/requisition.service.js", () => ({
  loadRequisitionForProcessing: (...a: unknown[]) => loadRequisitionForProcessing(...a),
  applyFallbackClarification: (...a: unknown[]) => applyFallbackClarification(...a),
  applyExtractionResult: (...a: unknown[]) => applyExtractionResult(...a),
}));

const { processRequisitionJob } = await import("../src/workers/requisition.worker.js");
const { AppError } = await import("../src/utils/AppError.js");

const ORG = "dev-org";
const REQ = "req-1";

function buildJob(attemptsMade = 0): Job {
  return {
    data: { requisitionId: REQ, organizationId: ORG },
    attemptsMade,
    opts: { attempts: 3 },
    id: "job-1",
  } as unknown as Job;
}

function exceptionTypes(): string[] {
  return db.exception.upsert.mock.calls.map(
    (call) => (call[0] as { create: { type: string } }).create.type,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  db.exception.upsert.mockResolvedValue({ id: "exc-1" });
  db.exception.findUnique.mockResolvedValue(null);
  db.auditLog.create.mockResolvedValue({ id: "audit-1" });
  applyFallbackClarification.mockResolvedValue({
    requisitionId: REQ,
    status: "NEEDS_CLARIFICATION",
    message: "Could you rephrase that?",
    missingFields: [],
  });
  loadRequisitionForProcessing.mockResolvedValue({
    id: REQ,
    organizationId: ORG,
    status: "PROCESSING",
    rawInput: "I need 100 wireless keyboards",
    clarificationMessage: null,
    messages: [],
  });
});

describe("processRequisitionJob — systemic AI failure", () => {
  // A revoked API key or a retired model fails identically every time. Falling
  // back to a clarification alone would tell every user in a row to reword a
  // perfectly clear request, with nothing for an operator to notice.
  it("raises a SYSTEM_FAILURE exception instead of failing silently", async () => {
    generateStructured.mockRejectedValue(
      new AppError("AI_PROCESSING_FAILED", "Gemini request failed (HTTP 401)"),
    );

    const result = await processRequisitionJob(buildJob(0));

    expect(exceptionTypes()).toEqual(["SYSTEM_FAILURE"]);
    expect(applyFallbackClarification).toHaveBeenCalled();
    expect(result.status).toBe("NEEDS_CLARIFICATION");
  });

  it("goes terminal on the first attempt rather than burning all three", async () => {
    generateStructured.mockRejectedValue(
      new AppError("AI_PROCESSING_FAILED", "Gemini request failed (HTTP 401)"),
    );

    // A permanent error must not be rethrown for BullMQ to retry.
    await expect(processRequisitionJob(buildJob(0))).resolves.toBeDefined();
  });

  it("still retries a transient outage before giving up", async () => {
    generateStructured.mockRejectedValue(
      new AppError("DEPENDENCY_UNAVAILABLE", "Gemini request failed (timeout)"),
    );

    await expect(processRequisitionJob(buildJob(0))).rejects.toThrow();
    expect(db.exception.upsert).not.toHaveBeenCalled();
  });

  it("raises the exception once the retries are spent", async () => {
    generateStructured.mockRejectedValue(
      new AppError("DEPENDENCY_UNAVAILABLE", "Gemini request failed (timeout)"),
    );

    await processRequisitionJob(buildJob(2));

    expect(exceptionTypes()).toEqual(["SYSTEM_FAILURE"]);
  });
});
