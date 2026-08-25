import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/db";
process.env.DEV_USER_ID ??= "dev-user";

const db = {
  organization: { findUnique: vi.fn() },
  purchaseOrder: { findFirst: vi.fn() },
  goodsReceipt: { findFirst: vi.fn() },
  invoice: { findFirst: vi.fn() },
};

vi.mock("../src/config/prisma.js", () => ({
  prisma: { ...db, $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(db) },
  disconnectPrisma: vi.fn(),
}));

vi.mock("../src/config/redis.js", () => ({
  redis: { ping: vi.fn() },
  createRedisConnection: vi.fn(),
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

const { createApp } = await import("../src/app.js");
const request = (await import("supertest")).default;

const ORG = "dev-org";
const PO = "po-1";
const RECEIPT = "gr-1";
const INVOICE = "inv-1";

function isPdf(buffer: Buffer): boolean {
  return buffer.subarray(0, 5).toString("ascii") === "%PDF-";
}

function purchaseOrderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PO,
    poNumber: "PO-20260825-ABC123",
    status: "APPROVED",
    currency: "INR",
    taxRateBps: 1800,
    subtotalPaise: 18_200_000,
    taxPaise: 3_276_000,
    totalPaise: 21_476_000,
    expectedDeliveryDate: new Date("2026-08-29T00:00:00.000Z"),
    approvedAt: new Date("2026-08-24T00:00:00.000Z"),
    approvedBy: "dev-user",
    createdAt: new Date("2026-08-24T00:00:00.000Z"),
    organization: { name: "Dev Org" },
    supplier: { name: "TechSource Distributors", email: null, phone: null },
    items: [
      {
        description: "Wireless Keyboard (PRPH-KB-001)",
        quantity: 100,
        unitPricePaise: 182_000,
        lineTotalPaise: 18_200_000,
      },
    ],
    ...overrides,
  };
}

function goodsReceiptRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RECEIPT,
    status: "PARTIAL",
    receivedAt: new Date("2026-08-24T00:00:00.000Z"),
    receivedBy: "dev-user",
    notes: null,
    organization: { name: "Dev Org" },
    shipment: {
      trackingNumber: "TRK-ABC123",
      purchaseOrder: { poNumber: "PO-20260825-ABC123" },
    },
    items: [
      {
        orderedQuantity: 100,
        receivedQuantity: 98,
        damagedQuantity: 2,
        acceptedQuantity: 96,
        purchaseOrderItem: { description: "Wireless Keyboard (PRPH-KB-001)" },
      },
    ],
    ...overrides,
  };
}

function invoiceFileRow(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE,
    filePublicId: "p2p/invoices/inv-1/invoice",
    fileMimeType: "application/pdf",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.organization.findUnique.mockResolvedValue({ id: ORG, name: "Dev Org" });
  db.purchaseOrder.findFirst.mockResolvedValue(purchaseOrderRow());
  db.goodsReceipt.findFirst.mockResolvedValue(goodsReceiptRow());
  db.invoice.findFirst.mockResolvedValue(invoiceFileRow());
  download.mockResolvedValue(Buffer.from("%PDF-1.4\nfake-pdf-content"));
});

describe("GET /api/v1/purchase-orders/:id/pdf", () => {
  it("streams a rendered PDF", async () => {
    const response = await request(createApp())
      .get(`/api/v1/purchase-orders/${PO}/pdf`)
      .set("x-organization-id", ORG);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/pdf");
    expect(isPdf(response.body)).toBe(true);
  });

  it("404s a purchase order belonging to another organization", async () => {
    db.purchaseOrder.findFirst.mockResolvedValue(null);

    const response = await request(createApp())
      .get(`/api/v1/purchase-orders/${PO}/pdf`)
      .set("x-organization-id", ORG);

    expect(response.status).toBe(404);
  });
});

describe("GET /api/v1/receipts/:id/pdf", () => {
  it("streams a rendered PDF", async () => {
    const response = await request(createApp())
      .get(`/api/v1/receipts/${RECEIPT}/pdf`)
      .set("x-organization-id", ORG);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/pdf");
    expect(isPdf(response.body)).toBe(true);
  });

  it("404s an unknown goods receipt", async () => {
    db.goodsReceipt.findFirst.mockResolvedValue(null);

    const response = await request(createApp())
      .get(`/api/v1/receipts/${RECEIPT}/pdf`)
      .set("x-organization-id", ORG);

    expect(response.status).toBe(404);
  });
});

describe("GET /api/v1/invoices/:id/pdf", () => {
  it("streams the stored document bytes with the stored content type", async () => {
    const response = await request(createApp())
      .get(`/api/v1/invoices/${INVOICE}/pdf`)
      .set("x-organization-id", ORG);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/pdf");
    expect(download).toHaveBeenCalledWith("p2p/invoices/inv-1/invoice", "application/pdf");
  });

  it("uses the invoice's own MIME type for an uploaded image, not application/pdf", async () => {
    db.invoice.findFirst.mockResolvedValue(
      invoiceFileRow({ fileMimeType: "image/png", filePublicId: "p2p/invoices/inv-1/scan" }),
    );
    download.mockResolvedValue(Buffer.from("fake-png-bytes"));

    const response = await request(createApp())
      .get(`/api/v1/invoices/${INVOICE}/pdf`)
      .set("x-organization-id", ORG);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.headers["content-disposition"]).toContain(".png");
  });

  it("404s an unknown invoice", async () => {
    db.invoice.findFirst.mockResolvedValue(null);

    const response = await request(createApp())
      .get(`/api/v1/invoices/${INVOICE}/pdf`)
      .set("x-organization-id", ORG);

    expect(response.status).toBe(404);
  });
});
