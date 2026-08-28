import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/db";

const db = {
  exception: { findUnique: vi.fn(), upsert: vi.fn() },
  auditLog: { create: vi.fn() },
};

vi.mock("../src/config/prisma.js", () => ({
  prisma: { ...db, $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(db) },
  disconnectPrisma: vi.fn(),
}));

vi.mock("../src/config/redis.js", () => ({
  redis: { ping: vi.fn() },
  createRedisConnection: vi.fn(),
}));

const { recordException } = await import("../src/services/exception.service.js");

const ORG = "dev-org";
const INVOICE = "inv-1";

function input() {
  return {
    organizationId: ORG,
    type: "QUANTITY_MISMATCH",
    severity: "CRITICAL",
    entityType: "Invoice",
    entityId: INVOICE,
    title: "Three-way match failed: quantity mismatch",
    description: "INVOICED_QUANTITY: expected 96, got 100",
  } as Parameters<typeof recordException>[1];
}

/** The `update` half of the single upsert call. */
function updateData(): Record<string, unknown> {
  const call = db.exception.upsert.mock.calls[0]?.[0] as { update: Record<string, unknown> };
  return call.update;
}

function auditMetadata(): Record<string, unknown>[] {
  return db.exception.upsert.mock.calls.length === 0
    ? []
    : db.auditLog.create.mock.calls.map(
        (call) => (call[0] as { data: { metadata: Record<string, unknown> } }).data.metadata,
      );
}

beforeEach(() => {
  vi.clearAllMocks();
  db.exception.upsert.mockResolvedValue({ id: "exc-1" });
  db.auditLog.create.mockResolvedValue({});
});

/**
 * The upsert is keyed on @@unique([organizationId, type, entityId]), so one
 * failure type against one entity has exactly one row for all time. What that
 * row's status does on a repeat call is the whole subject here.
 */
describe("recordException", () => {
  it("creates the row and audits it the first time", async () => {
    db.exception.findUnique.mockResolvedValue(null);

    await recordException(db as never, input());

    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
    // Nothing to reopen — the create branch carries no status override.
    expect(updateData()).not.toHaveProperty("status");
  });

  it.each(["OPEN", "UNDER_REVIEW"])(
    "leaves a %s exception's status alone on a re-drive",
    async (status) => {
      db.exception.findUnique.mockResolvedValue({ id: "exc-1", status });

      await recordException(db as never, input());

      expect(updateData()).not.toHaveProperty("status");
      expect(db.auditLog.create).not.toHaveBeenCalled();
    },
  );

  it.each(["RESOLVED", "REJECTED"])(
    "reopens a %s exception when the same failure happens again",
    async (status) => {
      db.exception.findUnique.mockResolvedValue({ id: "exc-1", status });

      await recordException(db as never, input());

      // Without this the invoice is stranded: matching moves it to EXCEPTION,
      // the payment gate refuses it for having one, and resolveExceptionById
      // refuses to re-decide a closed row.
      expect(updateData()).toMatchObject({
        status: "OPEN",
        resolution: null,
        resolutionReason: null,
        resolvedAt: null,
        resolvedBy: null,
      });
    },
  );

  it("audits the reopen, recording what the exception was before", async () => {
    db.exception.findUnique.mockResolvedValue({ id: "exc-1", status: "RESOLVED" });

    await recordException(db as never, input());

    expect(auditMetadata()).toEqual([
      expect.objectContaining({ reopened: true, previousStatus: "RESOLVED" }),
    ]);
  });
});
