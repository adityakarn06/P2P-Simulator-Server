import { describe, expect, it } from "vitest";
import { renderGoodsReceiptPdf } from "../src/pdf/documents/goodsReceipt.pdf.js";
import { renderInvoicePdf } from "../src/pdf/documents/invoice.pdf.js";
import { renderPurchaseOrderPdf } from "../src/pdf/documents/purchaseOrder.pdf.js";

function isPdf(buffer: Buffer): boolean {
  return buffer.subarray(0, 5).toString("ascii") === "%PDF-";
}

describe("renderPurchaseOrderPdf", () => {
  it("renders a valid, non-trivial PDF", async () => {
    const buffer = await renderPurchaseOrderPdf({
      organizationName: "Acme Procurement",
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
      supplier: { name: "TechSource Distributors", email: "sales@techsource.example", phone: null },
      items: [
        {
          description: "Wireless Keyboard (PRPH-KB-001)",
          quantity: 100,
          unitPricePaise: 182_000,
          lineTotalPaise: 18_200_000,
        },
      ],
    });

    expect(isPdf(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(500);
  });

  it("does not throw when the item list spans multiple pages", async () => {
    const items = Array.from({ length: 80 }, (_, index) => ({
      description: `Item ${index + 1}`,
      quantity: 1,
      unitPricePaise: 100,
      lineTotalPaise: 100,
    }));

    const buffer = await renderPurchaseOrderPdf({
      organizationName: "Acme Procurement",
      poNumber: "PO-20260825-ABC123",
      status: "APPROVED",
      currency: "INR",
      taxRateBps: 1800,
      subtotalPaise: 8000,
      taxPaise: 1440,
      totalPaise: 9440,
      expectedDeliveryDate: null,
      approvedAt: null,
      approvedBy: null,
      createdAt: new Date("2026-08-24T00:00:00.000Z"),
      supplier: { name: "TechSource Distributors", email: null, phone: null },
      items,
    });

    expect(isPdf(buffer)).toBe(true);
  });
});

describe("renderGoodsReceiptPdf", () => {
  it("renders a valid PDF", async () => {
    const buffer = await renderGoodsReceiptPdf({
      organizationName: "Acme Procurement",
      goodsReceiptId: "gr-1",
      poNumber: "PO-20260825-ABC123",
      trackingNumber: "TRK-ABC123",
      status: "PARTIAL",
      receivedAt: new Date("2026-08-24T00:00:00.000Z"),
      receivedBy: "dev-user",
      notes: null,
      items: [
        {
          description: "Wireless Keyboard (PRPH-KB-001)",
          orderedQuantity: 100,
          receivedQuantity: 98,
          damagedQuantity: 2,
          acceptedQuantity: 96,
        },
      ],
    });

    expect(isPdf(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(500);
  });
});

describe("renderInvoicePdf", () => {
  it("renders a valid PDF", async () => {
    const buffer = await renderInvoicePdf({
      invoiceNumber: "INV-20260825-ABC123",
      invoiceDate: new Date("2026-08-25T00:00:00.000Z"),
      poNumber: "PO-20260825-ABC123",
      currency: "INR",
      subtotalPaise: 18_200_000,
      taxPaise: 3_276_000,
      totalPaise: 21_476_000,
      supplier: { name: "TechSource Distributors", email: null, phone: null },
      billTo: { organizationName: "Acme Procurement" },
      items: [
        {
          description: "Wireless Keyboard (PRPH-KB-001)",
          quantity: 100,
          unitPricePaise: 182_000,
          lineTotalPaise: 18_200_000,
        },
      ],
    });

    expect(isPdf(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(500);
  });
});
