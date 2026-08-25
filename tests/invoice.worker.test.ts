import type { Job } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/db";

const db = {
  invoice: {
    findFirst: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    updateMany: vi.fn(),
  },
  invoiceItem: { deleteMany: vi.fn(), createMany: vi.fn() },
  purchaseOrder: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  exception: { upsert: vi.fn(), findUnique: vi.fn() },
  auditLog: { create: vi.fn() },
  aIProcessingLog: { create: vi.fn() },
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

const analyzeDocument = vi.fn();

vi.mock("../src/ai/index.js", () => ({
  AI_MODEL: "gemini-test",
  getAIProvider: () => ({ generateStructured: vi.fn(), analyzeDocument }),
}));

const download = vi.fn();

vi.mock("../src/storage/index.js", () => ({
  getStorageProvider: () => ({
    upload: vi.fn(),
    download,
    delete: vi.fn(),
    getUrl: vi.fn(),
  }),
}));

const enqueueMatching = vi.fn();

vi.mock("../src/queues/matching.queue.js", () => ({
  matchingQueue: {},
  MATCHING_JOBS: { RUN_THREE_WAY_MATCH: "run-three-way-match" },
  enqueueMatching: (...args: unknown[]) => enqueueMatching(...args),
}));

vi.mock("../src/queues/invoice.queue.js", () => ({
  invoiceQueue: {},
  INVOICE_JOBS: { PROCESS_INVOICE: "process-invoice" },
  enqueueInvoice: vi.fn(),
}));

const { processInvoiceJob } = await import("../src/workers/invoice.worker.js");
const { AppError } = await import("../src/utils/AppError.js");

const ORG = "dev-org";
const INVOICE = "inv-1";

const EXTRACTION = {
  invoiceNumber: "INV-2026-0042",
  invoiceDate: "2026-08-20",
  supplierName: "TechSource Distributors",
  poNumber: "PO-20260824-ABC123",
  currency: "INR",
  subtotal: "182000.00",
  tax: "32760.00",
  total: "214760.00",
  items: [
    {
      description: "Wireless Keyboard",
      quantity: 100,
      unitPrice: "1820.00",
      lineTotal: "182000.00",
    },
  ],
};

/** BullMQ job stub. attemptsMade is 0-based: attempt 3 of 3 is attemptsMade === 2. */
function job(overrides: { attemptsMade?: number; attempts?: number } = {}): Job {
  return {
    data: { invoiceId: INVOICE, organizationId: ORG },
    attemptsMade: overrides.attemptsMade ?? 0,
    opts: { attempts: overrides.attempts ?? 3 },
  } as unknown as Job;
}

function loadedInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE,
    organizationId: ORG,
    status: "UPLOADED",
    filePublicId: "p2p/invoices/inv-1/invoice",
    fileMimeType: "application/pdf",
    extractionAttempts: 0,
    purchaseOrderId: "po-1",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.invoice.findFirst.mockResolvedValue(loadedInvoice());
  db.invoice.updateMany.mockResolvedValue({ count: 1 });
  db.invoice.findUniqueOrThrow.mockImplementation(async () => ({
    id: INVOICE,
    status: "EXTRACTED",
    items: [],
  }));
  db.invoiceItem.deleteMany.mockResolvedValue({ count: 0 });
  db.invoiceItem.createMany.mockResolvedValue({ count: 1 });
  db.exception.upsert.mockResolvedValue({ id: "exc-1" });
  db.exception.findUnique.mockResolvedValue(null);
  db.auditLog.create.mockResolvedValue({});
  db.aIProcessingLog.create.mockResolvedValue({});
  download.mockResolvedValue(Buffer.from("%PDF-1.4\nfake"));
  analyzeDocument.mockResolvedValue(JSON.stringify(EXTRACTION));
  enqueueMatching.mockResolvedValue("job-1");
});

describe("processInvoiceJob", () => {
  it("never OCRs a GENERATED invoice, even if a stray job is delivered for one", async () => {
    db.invoice.findFirst.mockResolvedValue(
      loadedInvoice({ source: "GENERATED", status: "EXTRACTED" }),
    );

    const result = await processInvoiceJob(job());

    expect(result.skippedReason).toBe("Generated invoices are not OCR'd");
    expect(analyzeDocument).not.toHaveBeenCalled();
    expect(enqueueMatching).not.toHaveBeenCalled();
  });

  it("extracts the document and moves the invoice to EXTRACTED", async () => {
    const result = await processInvoiceJob(job());

    expect(result).toMatchObject({ invoiceId: INVOICE, status: "EXTRACTED" });
    expect(download).toHaveBeenCalledWith("p2p/invoices/inv-1/invoice", "application/pdf");
    expect(analyzeDocument).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: "application/pdf", promptName: "invoice.v1" }),
    );
  });

  it("claims the invoice with a guarded UPLOADED -> PROCESSING transition", async () => {
    await processInvoiceJob(job());

    expect(db.invoice.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: INVOICE, organizationId: ORG, status: "UPLOADED" }),
        data: expect.objectContaining({ status: "PROCESSING" }),
      }),
    );
  });

  it("converts printed amounts to integer paise", async () => {
    await processInvoiceJob(job());

    const write = db.invoice.updateMany.mock.calls.find(
      (call) => call[0]?.data?.status === "EXTRACTED",
    );

    expect(write?.[0].data).toMatchObject({
      invoiceNumber: "INV-2026-0042",
      subtotalPaise: 18_200_000,
      taxPaise: 3_276_000,
      totalPaise: 21_476_000,
      currency: "INR",
    });
  });

  it("writes line items numbered from 1", async () => {
    await processInvoiceJob(job());

    expect(db.invoiceItem.createMany).toHaveBeenCalledWith({
      data: [
        {
          invoiceId: INVOICE,
          lineNumber: 1,
          description: "Wireless Keyboard",
          quantity: 100,
          unitPricePaise: 182_000,
          lineTotalPaise: 18_200_000,
        },
      ],
    });
  });

  it("replaces existing line items so a retry cannot collide on lineNumber", async () => {
    await processInvoiceJob(job());

    expect(db.invoiceItem.deleteMany).toHaveBeenCalledWith({ where: { invoiceId: INVOICE } });
  });

  it("never writes to the purchase order", async () => {
    await processInvoiceJob(job());

    // AI output must never rewrite the commitment it is about to be matched against.
    expect(db.purchaseOrder.update).not.toHaveBeenCalled();
    expect(db.purchaseOrder.updateMany).not.toHaveBeenCalled();
  });

  it("records a successful AIProcessingLog entry", async () => {
    await processInvoiceJob(job());

    expect(db.aIProcessingLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entityType: "Invoice",
          jobType: "process-invoice",
          promptVersion: "invoice.v1",
          model: "gemini-test",
          success: true,
        }),
      }),
    );
  });

  it("writes an INVOICE_EXTRACTED audit row attributed to the AI actor", async () => {
    await processInvoiceJob(job());

    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "INVOICE_EXTRACTED", actorType: "AI" }),
      }),
    );
  });

  it("enqueues matching once the extraction has committed", async () => {
    await processInvoiceJob(job());

    expect(enqueueMatching).toHaveBeenCalledWith({ invoiceId: INVOICE, organizationId: ORG });
  });

  // -----------------------------------------------------------------------
  // Idempotency
  // -----------------------------------------------------------------------

  it("does not call Gemini again for an already-extracted invoice", async () => {
    db.invoice.findFirst.mockResolvedValue(loadedInvoice({ status: "EXTRACTED" }));

    const result = await processInvoiceJob(job());

    expect(analyzeDocument).not.toHaveBeenCalled();
    expect(result.skippedReason).toBeTruthy();
    // Still EXTRACTED means matching never started — re-enqueue to heal the gap.
    expect(enqueueMatching).toHaveBeenCalledWith({ invoiceId: INVOICE, organizationId: ORG });
  });

  it("leaves an invoice that is already matching alone", async () => {
    db.invoice.findFirst.mockResolvedValue(loadedInvoice({ status: "MATCHING" }));

    await processInvoiceJob(job());

    expect(analyzeDocument).not.toHaveBeenCalled();
    expect(enqueueMatching).not.toHaveBeenCalled();
  });

  it("does not re-drive an invoice that already failed terminally", async () => {
    // A FAILED invoice carries an open exception awaiting a human.
    db.invoice.findFirst.mockResolvedValue(loadedInvoice({ status: "FAILED" }));

    const result = await processInvoiceJob(job());

    expect(result.status).toBe("FAILED");
    expect(analyzeDocument).not.toHaveBeenCalled();
  });

  it("continues when the claim finds the invoice already PROCESSING from its own retry", async () => {
    db.invoice.findFirst.mockResolvedValue(loadedInvoice({ status: "PROCESSING" }));
    db.invoice.updateMany.mockResolvedValueOnce({ count: 0 });

    const result = await processInvoiceJob(job({ attemptsMade: 1 }));

    expect(analyzeDocument).toHaveBeenCalled();
    expect(result.status).toBe("EXTRACTED");
  });

  // -----------------------------------------------------------------------
  // Failure handling
  // -----------------------------------------------------------------------

  it("rethrows malformed JSON on a non-final attempt so BullMQ retries", async () => {
    analyzeDocument.mockResolvedValue("not json at all");

    await expect(processInvoiceJob(job({ attemptsMade: 0 }))).rejects.toThrow();
    expect(db.exception.upsert).not.toHaveBeenCalled();
  });

  it("rethrows a Gemini outage on a non-final attempt", async () => {
    analyzeDocument.mockRejectedValue(new Error("Gemini timed out"));

    await expect(processInvoiceJob(job({ attemptsMade: 0 }))).rejects.toThrow("Gemini timed out");
  });

  it("rethrows a Cloudinary outage on a non-final attempt", async () => {
    download.mockRejectedValue(
      AppError.dependencyUnavailable("Failed to download document from Cloudinary"),
    );

    await expect(processInvoiceJob(job({ attemptsMade: 0 }))).rejects.toThrow();
  });

  it("fails the invoice and opens an exception on the final attempt", async () => {
    analyzeDocument.mockResolvedValue("not json at all");
    db.invoice.findUniqueOrThrow.mockResolvedValue({ id: INVOICE, status: "FAILED", items: [] });

    const result = await processInvoiceJob(job({ attemptsMade: 2, attempts: 3 }));

    expect(result.status).toBe("FAILED");
    expect(db.exception.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ type: "INVOICE_EXTRACTION_FAILED" }),
      }),
    );
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "WORKFLOW_FAILED" }) }),
    );
    expect(enqueueMatching).not.toHaveBeenCalled();
  });

  it("fails immediately when the document is not retrievable, instead of burning retries", async () => {
    // CloudinaryStorage.download throws NOT_FOUND for a 4xx: the object is gone,
    // so every retry gets the same answer.
    download.mockRejectedValue(AppError.notFound("Invoice document is not retrievable"));
    db.invoice.findUniqueOrThrow.mockResolvedValue({ id: INVOICE, status: "FAILED", items: [] });

    const result = await processInvoiceJob(job({ attemptsMade: 0, attempts: 3 }));

    expect(result.status).toBe("FAILED");
    expect(db.exception.upsert).toHaveBeenCalled();
  });

  it("fails immediately on a validation error instead of burning retries", async () => {
    // A corrupt document fails identically on every attempt.
    download.mockRejectedValue(AppError.validation("File is empty"));
    db.invoice.findUniqueOrThrow.mockResolvedValue({ id: INVOICE, status: "FAILED", items: [] });

    const result = await processInvoiceJob(job({ attemptsMade: 0, attempts: 3 }));

    expect(result.status).toBe("FAILED");
    expect(db.exception.upsert).toHaveBeenCalled();
  });

  it("still retries a Cloudinary outage, which is not permanent", async () => {
    download.mockRejectedValue(
      AppError.dependencyUnavailable("Failed to download document from Cloudinary"),
    );

    await expect(processInvoiceJob(job({ attemptsMade: 0, attempts: 3 }))).rejects.toThrow();
    expect(db.exception.upsert).not.toHaveBeenCalled();
  });

  it("does not raise an exception when a late failure loses to a successful attempt", async () => {
    analyzeDocument.mockResolvedValue("not json at all");
    // The claim moved the invoice to PROCESSING; the terminal write then finds
    // nothing to update because another attempt already extracted it.
    db.invoice.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValue({ count: 0 });
    db.invoice.findUniqueOrThrow.mockResolvedValue({ id: INVOICE, status: "EXTRACTED", items: [] });

    const result = await processInvoiceJob(job({ attemptsMade: 2, attempts: 3 }));

    expect(result.status).toBe("EXTRACTED");
    expect(db.exception.upsert).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "WORKFLOW_FAILED" }) }),
    );
  });

  it("rejects a response whose money fields are not plain decimals", async () => {
    analyzeDocument.mockResolvedValue(JSON.stringify({ ...EXTRACTION, total: "₹214,760.00" }));

    await expect(processInvoiceJob(job({ attemptsMade: 0 }))).rejects.toThrow();
    expect(db.invoiceItem.createMany).not.toHaveBeenCalled();
  });

  it("records a failed AIProcessingLog entry with the reason", async () => {
    analyzeDocument.mockRejectedValue(new Error("Gemini timed out"));

    await expect(processInvoiceJob(job({ attemptsMade: 0 }))).rejects.toThrow();
    expect(db.aIProcessingLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ success: false, error: "Gemini timed out" }),
      }),
    );
  });
});
