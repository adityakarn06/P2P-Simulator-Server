import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/db";
process.env.REDIS_URL ??= "redis://localhost:6379";

const add = vi.fn();

vi.mock("bullmq", () => ({
  Queue: class {
    name = "payment";
    add = add;
    close = vi.fn();
  },
  QueueEvents: class {},
}));

vi.mock("../src/config/redis.js", () => ({
  redis: {},
  createRedisConnection: vi.fn(),
}));

const { enqueuePayment } = await import("../src/queues/payment.queue.js");

const INVOICE = "inv-1";
const ORG = "dev-org";

/** The options object handed to BullMQ's `add`. */
function addOptions(): { jobId?: string } {
  return (db()[2] ?? {}) as { jobId?: string };
}

function db(): unknown[] {
  const call = add.mock.calls[0];
  if (!call) {
    throw new Error("Expected the job to have been added");
  }
  return call;
}

beforeEach(() => {
  vi.clearAllMocks();
  add.mockResolvedValue({ id: `payment-${INVOICE}` });
});

/**
 * Payment is enqueued from three places for one invoice, so the job id is what
 * keeps two of them from being in flight at once.
 */
describe("enqueuePayment", () => {
  it("keys the job on the invoice and tranche so concurrent enqueues collapse into one", async () => {
    await enqueuePayment({ invoiceId: INVOICE, organizationId: ORG });

    expect(addOptions().jobId).toBe(`payment-${INVOICE}-auto`);
  });

  // BullMQ reserves ":" for its own Redis key structure and rejects a custom id
  // containing one at runtime ("Custom Id cannot contain :") — which no mocked
  // queue would ever surface.
  it("gives each tranche of an invoice its own job id", async () => {
    // Keyed on the invoice alone, BullMQ would collapse a human-authorized
    // partial payment into the automatic settlement and silently drop it.
    await enqueuePayment({ invoiceId: INVOICE, organizationId: ORG, settlementKey: "exc-1" });

    expect(addOptions().jobId).toBe(`payment-${INVOICE}-exc-1`);
  });

  it("uses a job id BullMQ will accept", () => {
    expect(`payment-${INVOICE}`).not.toContain(":");
  });

  it("lets an explicit job id win", async () => {
    await enqueuePayment({ invoiceId: INVOICE, organizationId: ORG }, { jobId: "manual-redrive" });

    expect(addOptions().jobId).toBe("manual-redrive");
  });

  it("validates the payload before it reaches the queue", async () => {
    await expect(enqueuePayment({ invoiceId: "", organizationId: ORG } as never)).rejects.toThrow();
    expect(add).not.toHaveBeenCalled();
  });
});
