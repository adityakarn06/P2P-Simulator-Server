import { describe, expect, it } from "vitest";
import { invoiceExtractionSchema, toInvoiceDate, toPaise } from "../src/zod/invoice.schema.js";

function extraction(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

describe("invoiceExtractionSchema", () => {
  it("accepts a fully populated invoice", () => {
    expect(invoiceExtractionSchema.safeParse(extraction()).success).toBe(true);
  });

  // Every paise column this lands in is a Prisma `Int` (32-bit). Without the
  // bound, a hallucinated amount reaches the insert and surfaces as an opaque
  // int4 overflow inside the extraction transaction, which the worker can only
  // read as a technical failure and retry three times.
  it("rejects an amount that would overflow the paise column", () => {
    expect(invoiceExtractionSchema.safeParse(extraction({ total: "99999999999" })).success).toBe(
      false,
    );
    expect(
      invoiceExtractionSchema.safeParse(
        extraction({
          items: [
            {
              description: "Wireless Keyboard",
              quantity: 1,
              unitPrice: "99999999999",
              lineTotal: "99999999999",
            },
          ],
        }),
      ).success,
    ).toBe(false);
  });

  it("accepts the largest amount that still fits", () => {
    // MAX_MONEY_PAISE is 2_147_483_647 paise — ₹21,474,836.47.
    expect(invoiceExtractionSchema.safeParse(extraction({ total: "21474836.47" })).success).toBe(
      true,
    );
    expect(invoiceExtractionSchema.safeParse(extraction({ total: "21474836.48" })).success).toBe(
      false,
    );
  });

  it("accepts an entirely unreadable document as nulls with no items", () => {
    const parsed = invoiceExtractionSchema.safeParse({
      invoiceNumber: null,
      invoiceDate: null,
      supplierName: null,
      poNumber: null,
      currency: null,
      subtotal: null,
      tax: null,
      total: null,
      items: [],
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects money that is not a plain decimal string", () => {
    // The three shapes Gemini is most likely to drift into: a symbol, a
    // thousands separator, and a number instead of a string.
    for (const total of ["₹214760.00", "214,760.00", 214_760]) {
      expect(invoiceExtractionSchema.safeParse(extraction({ total })).success).toBe(false);
    }
  });

  it("rejects a negative amount rather than storing a credit note as a payable", () => {
    expect(invoiceExtractionSchema.safeParse(extraction({ total: "-500.00" })).success).toBe(false);
  });

  it("rejects a non-positive or fractional line quantity", () => {
    for (const quantity of [0, -5, 2.5]) {
      const parsed = invoiceExtractionSchema.safeParse(
        extraction({
          items: [
            {
              description: "Wireless Keyboard",
              quantity,
              unitPrice: "1820.00",
              lineTotal: "182000.00",
            },
          ],
        }),
      );
      expect(parsed.success).toBe(false);
    }
  });

  it("rejects a date that is not normalised to ISO", () => {
    expect(
      invoiceExtractionSchema.safeParse(extraction({ invoiceDate: "20 Aug 2026" })).success,
    ).toBe(false);
  });

  it("rejects a currency that is not a 3-letter code", () => {
    expect(invoiceExtractionSchema.safeParse(extraction({ currency: "rupees" })).success).toBe(
      false,
    );
  });
});

describe("toPaise", () => {
  it("converts whole rupees", () => {
    expect(toPaise("1820")).toBe(182_000);
  });

  it("converts two-decimal amounts", () => {
    expect(toPaise("1820.50")).toBe(182_050);
  });

  it("treats a single decimal digit as tenths, not hundredths", () => {
    expect(toPaise("1820.5")).toBe(182_050);
  });

  it("keeps sub-rupee amounts exact", () => {
    expect(toPaise("0.05")).toBe(5);
  });

  it("passes null through", () => {
    expect(toPaise(null)).toBeNull();
  });

  it("does not lose precision on amounts that float arithmetic rounds badly", () => {
    // Math.round(1820.15 * 100) is 182014 in IEEE 754 — the reason this
    // conversion is string-based.
    expect(toPaise("1820.15")).toBe(182_015);
    expect(toPaise("10.07")).toBe(1007);
  });
});

describe("toInvoiceDate", () => {
  it("parses an ISO date as UTC midnight", () => {
    expect(toInvoiceDate("2026-08-20")?.toISOString()).toBe("2026-08-20T00:00:00.000Z");
  });

  it("returns null for a null value", () => {
    expect(toInvoiceDate(null)).toBeNull();
  });

  it("returns null for a well-formed but impossible date", () => {
    expect(toInvoiceDate("2026-02-31")).toBeNull();
  });
});
