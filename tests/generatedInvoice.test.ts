import { describe, expect, it } from "vitest";
import {
  buildGeneratedInvoiceLines,
  buildGeneratedInvoiceNumber,
  computeGeneratedInvoiceTotals,
} from "../src/rules/generatedInvoice.js";
import { AppError } from "../src/utils/AppError.js";

function poLine(overrides: Partial<Parameters<typeof buildGeneratedInvoiceLines>[0][number]> = {}) {
  return {
    purchaseOrderItemId: "poi-1",
    productId: "prod-kb",
    description: "Wireless Keyboard (PRPH-KB-001)",
    quantity: 100,
    unitPricePaise: 182_000,
    ...overrides,
  };
}

describe("buildGeneratedInvoiceNumber", () => {
  it("is deterministic and derived from the PO number", () => {
    expect(buildGeneratedInvoiceNumber("PO-20260825-ABC123")).toBe("INV-20260825-ABC123");
    expect(buildGeneratedInvoiceNumber("PO-20260825-ABC123")).toBe(
      buildGeneratedInvoiceNumber("PO-20260825-ABC123"),
    );
  });
});

describe("buildGeneratedInvoiceLines", () => {
  it("defaults every line to the ordered quantity", () => {
    const lines = buildGeneratedInvoiceLines([poLine()]);

    expect(lines).toEqual([
      {
        purchaseOrderItemId: "poi-1",
        productId: "prod-kb",
        description: "Wireless Keyboard (PRPH-KB-001)",
        quantity: 100,
        unitPricePaise: 182_000,
        lineTotalPaise: 18_200_000,
      },
    ]);
  });

  it("applies an override to only the matching line", () => {
    const lines = buildGeneratedInvoiceLines(
      [poLine(), poLine({ purchaseOrderItemId: "poi-2", productId: "prod-mouse", quantity: 50 })],
      [{ purchaseOrderItemId: "poi-1", quantity: 98 }],
    );

    expect(lines[0]).toMatchObject({ quantity: 98, lineTotalPaise: 98 * 182_000 });
    expect(lines[1]).toMatchObject({ quantity: 50 });
  });

  it("rejects an override for a line that does not belong to the PO", () => {
    expect(() =>
      buildGeneratedInvoiceLines([poLine()], [{ purchaseOrderItemId: "not-a-line", quantity: 1 }]),
    ).toThrow(AppError);
  });

  it("rejects a negative or fractional override quantity", () => {
    expect(() =>
      buildGeneratedInvoiceLines([poLine()], [{ purchaseOrderItemId: "poi-1", quantity: -1 }]),
    ).toThrow(AppError);
    expect(() =>
      buildGeneratedInvoiceLines([poLine()], [{ purchaseOrderItemId: "poi-1", quantity: 1.5 }]),
    ).toThrow(AppError);
  });

  it("rejects overrides that repeat the same purchaseOrderItemId", () => {
    expect(() =>
      buildGeneratedInvoiceLines(
        [poLine()],
        [
          { purchaseOrderItemId: "poi-1", quantity: 5 },
          { purchaseOrderItemId: "poi-1", quantity: 50 },
        ],
      ),
    ).toThrow(AppError);
  });

  it("rejects a purchase order with no lines", () => {
    expect(() => buildGeneratedInvoiceLines([])).toThrow(AppError);
  });

  it("rejects an override quantity that would overflow the Int4 paise column", () => {
    // 2_147_483_647 (MAX_MONEY_PAISE) / 182_000 ≈ 11800.46, so 11801 overflows.
    expect(() =>
      buildGeneratedInvoiceLines([poLine()], [{ purchaseOrderItemId: "poi-1", quantity: 11_801 }]),
    ).toThrow(AppError);
  });
});

describe("computeGeneratedInvoiceTotals", () => {
  it("matches calculatePurchaseOrderTotals' rounding for the default (unmodified) path", () => {
    const lines = buildGeneratedInvoiceLines([poLine()]);
    const totals = computeGeneratedInvoiceTotals(lines, 1800);

    // Same figures as approvalRules.test.ts's PO totals test.
    expect(totals.subtotalPaise).toBe(18_200_000);
    expect(totals.taxPaise).toBe(3_276_000);
    expect(totals.totalPaise).toBe(21_476_000);
  });

  it("only the overridden line changes the totals", () => {
    const lines = buildGeneratedInvoiceLines(
      [poLine()],
      [{ purchaseOrderItemId: "poi-1", quantity: 98 }],
    );
    const totals = computeGeneratedInvoiceTotals(lines, 1800);

    expect(totals.subtotalPaise).toBe(98 * 182_000);
    expect(totals.totalPaise).toBeGreaterThan(0);
  });

  it("rejects a subtotal that overflows the Int4 paise column even when no single line does", () => {
    // Each line is within range on its own; only the sum overflows.
    const lines = buildGeneratedInvoiceLines([
      poLine({ purchaseOrderItemId: "poi-1", quantity: 11_000 }),
      poLine({ purchaseOrderItemId: "poi-2", quantity: 11_000 }),
    ]);

    expect(() => computeGeneratedInvoiceTotals(lines, 1800)).toThrow(AppError);
  });
});
