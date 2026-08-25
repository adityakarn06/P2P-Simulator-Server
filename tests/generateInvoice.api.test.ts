import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/db";
process.env.DEV_USER_ID ??= "dev-user";

const db = {
  organization: { findUnique: vi.fn() },
  purchaseOrder: { findFirst: vi.fn() },
  invoice: { findFirst: vi.fn(), create: vi.fn() },
  auditLog: { create: vi.fn() },
};

const transaction = vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(db));

vi.mock("../src/config/prisma.js", () => ({
  prisma: {
    ...db,
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => transaction(fn),
  },
  disconnectPrisma: vi.fn(),
}));

vi.mock("../src/config/redis.js", () => ({
  redis: { ping: vi.fn() },
  createRedisConnection: vi.fn(),
}));

const upload = vi.fn();
const remove = vi.fn();

vi.mock("../src/storage/index.js", () => ({
  getStorageProvider: () => ({
    upload,
    download: vi.fn(),
    delete: remove,
    getUrl: vi.fn(),
  }),
}));

const { createApp } = await import("../src/app.js");
const request = (await import("supertest")).default;

const ORG = "dev-org";
const PO = "po-1";

function purchaseOrderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PO,
    poNumber: "PO-20260825-ABC123",
    status: "RECEIVED",
    currency: "INR",
    taxRateBps: 1800,
    supplierId: "sup-techsource",
    organization: { name: "Dev Org" },
    supplier: { name: "TechSource Distributors", email: "sales@techsource.example", phone: null },
    items: [
      {
        id: "poi-1",
        productId: "prod-kb",
        description: "Wireless Keyboard (PRPH-KB-001)",
        quantity: 100,
        unitPricePaise: 182_000,
      },
    ],
    ...overrides,
  };
}

function invoiceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "inv-generated-1",
    purchaseOrderId: PO,
    supplierId: "sup-techsource",
    status: "EXTRACTED",
    source: "GENERATED",
    fileUrl: "https://res.cloudinary.com/signed",
    fileMimeType: "application/pdf",
    fileSizeBytes: 2048,
    invoiceNumber: "INV-20260825-ABC123",
    invoiceDate: new Date("2026-08-25T00:00:00.000Z"),
    supplierNameRaw: "TechSource Distributors",
    poNumberRaw: "PO-20260825-ABC123",
    subtotalPaise: 18_200_000,
    taxPaise: 3_276_000,
    totalPaise: 21_476_000,
    currency: "INR",
    extractedAt: new Date("2026-08-25T00:00:00.000Z"),
    extractionAttempts: 0,
    failureReason: null,
    createdAt: new Date("2026-08-25T00:00:00.000Z"),
    updatedAt: new Date("2026-08-25T00:00:00.000Z"),
    items: [],
    ...overrides,
  };
}

function post(app: ReturnType<typeof createApp>, body: Record<string, unknown> = {}) {
  return request(app)
    .post(`/api/v1/purchase-orders/${PO}/generate-invoice`)
    .set("x-organization-id", ORG)
    .send(body);
}

beforeEach(() => {
  vi.clearAllMocks();
  db.organization.findUnique.mockResolvedValue({ id: ORG, name: "Dev Org" });
  db.purchaseOrder.findFirst.mockResolvedValue(purchaseOrderRow());
  db.invoice.findFirst.mockResolvedValue(null);
  db.invoice.create.mockResolvedValue(invoiceRow());
  db.auditLog.create.mockResolvedValue({});
  upload.mockResolvedValue({
    storageKey: "p2p/invoices/inv-generated-1/invoice",
    url: "https://res.cloudinary.com/signed",
    bytes: 2048,
  });
});

describe("POST /api/v1/purchase-orders/:id/generate-invoice", () => {
  it("renders and stores a GENERATED invoice at EXTRACTED with the PO's totals, answering 201", async () => {
    const response = await post(createApp());

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      success: true,
      error: null,
      data: {
        invoice: {
          source: "GENERATED",
          status: "EXTRACTED",
          totalPaise: 21_476_000,
          subtotalPaise: 18_200_000,
          taxPaise: 3_276_000,
        },
      },
    });
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ mimeType: "application/pdf" }));
  });

  it("writes an INVOICE_GENERATED audit row", async () => {
    await post(createApp());

    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "INVOICE_GENERATED",
          entityType: "Invoice",
          actorType: "USER",
        }),
      }),
    );
  });

  it("is idempotent — a second call returns the existing generated invoice with 200", async () => {
    db.invoice.findFirst.mockResolvedValue(invoiceRow());

    const response = await post(createApp());

    expect(response.status).toBe(200);
    expect(response.body.data.invoice.id).toBe("inv-generated-1");
    expect(upload).not.toHaveBeenCalled();
    expect(db.invoice.create).not.toHaveBeenCalled();
  });

  it("applies a quantity override to the billed line, not the PO's own quantity", async () => {
    await post(createApp(), { items: [{ purchaseOrderItemId: "poi-1", quantity: 98 }] });

    const created = db.invoice.create.mock.calls[0]?.[0];
    expect(created.data.subtotalPaise).toBe(98 * 182_000);
    expect(created.data.items.create[0]).toMatchObject({ quantity: 98 });
  });

  it("sets generatedForPurchaseOrderId — the DB-level guard against two concurrent GENERATED invoices", async () => {
    await post(createApp());

    const created = db.invoice.create.mock.calls[0]?.[0];
    expect(created.data.generatedForPurchaseOrderId).toBe(PO);
  });

  it("refuses to invoice a purchase order that has not been approved yet", async () => {
    db.purchaseOrder.findFirst.mockResolvedValue(purchaseOrderRow({ status: "DRAFT" }));

    const response = await post(createApp());

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("INVALID_STATE");
    expect(upload).not.toHaveBeenCalled();
  });

  it("404s a purchase order belonging to another organization", async () => {
    db.purchaseOrder.findFirst.mockResolvedValue(null);

    const response = await post(createApp());

    expect(response.status).toBe(404);
    expect(upload).not.toHaveBeenCalled();
  });

  it("deletes the uploaded document when the transaction fails", async () => {
    db.invoice.create.mockRejectedValue(new Error("connection lost"));

    const response = await post(createApp());

    expect(response.status).toBe(500);
    expect(remove).toHaveBeenCalledWith("p2p/invoices/inv-generated-1/invoice");
  });

  it("recovers from a concurrent race by returning the winner's invoice instead of erroring", async () => {
    // Both requests pass the upfront existence check (findFirst resolves null
    // the first time); this one loses the generatedForPurchaseOrderId @unique
    // race on create, so it must clean up its own upload and hand back the
    // row the other request committed rather than surfacing an error.
    db.invoice.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(invoiceRow());
    db.invoice.create.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );

    const response = await post(createApp());

    expect(response.status).toBe(200);
    expect(response.body.data.invoice.id).toBe("inv-generated-1");
    expect(remove).toHaveBeenCalledWith("p2p/invoices/inv-generated-1/invoice");
  });
});
