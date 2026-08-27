import { describe, expect, it } from "vitest";
import { DEFAULT_TAX_RATE_BPS } from "../src/config/constants.js";
import {
  calculatePurchaseOrderTotals,
  decideApprovalStatus,
  MAX_MONEY_PAISE,
} from "../src/rules/approvalRules.js";
import { AppError } from "../src/utils/AppError.js";

function line(overrides: Partial<{ quantity: number; unitPricePaise: number }> = {}) {
  return {
    productId: "prod-wireless-keyboard",
    supplierProductId: "sp-keyboard-techsource",
    description: "Wireless Keyboard (PRPH-KB-001)",
    quantity: 100,
    unitPricePaise: 182_000,
    ...overrides,
  };
}

describe("calculatePurchaseOrderTotals", () => {
  it("computes subtotal, 18% tax and total in whole paise", () => {
    const totals = calculatePurchaseOrderTotals([line()], DEFAULT_TAX_RATE_BPS);

    // 100 × ₹1,820.00 = ₹1,82,000.00
    expect(totals.subtotalPaise).toBe(18_200_000);
    expect(totals.taxPaise).toBe(3_276_000);
    expect(totals.totalPaise).toBe(21_476_000);
    expect(totals.taxRateBps).toBe(1800);
    expect(totals.items[0]?.lineTotalPaise).toBe(18_200_000);
  });

  it("sums multiple lines and taxes the subtotal once", () => {
    const totals = calculatePurchaseOrderTotals(
      [line({ quantity: 2, unitPricePaise: 333 }), line({ quantity: 3, unitPricePaise: 111 })],
      DEFAULT_TAX_RATE_BPS,
    );

    expect(totals.subtotalPaise).toBe(999);
    // 999 × 1800 / 10000 = 179.82 -> rounded once, on the subtotal.
    expect(totals.taxPaise).toBe(180);
    expect(totals.totalPaise).toBe(1179);
  });

  it("keeps every amount an integer regardless of rate", () => {
    const totals = calculatePurchaseOrderTotals([line({ quantity: 1, unitPricePaise: 1 })], 1234);

    expect(Number.isInteger(totals.taxPaise)).toBe(true);
    expect(Number.isInteger(totals.totalPaise)).toBe(true);
    expect(totals.taxPaise).toBe(0);
  });

  it("refuses a purchase order with no line items", () => {
    expect(() => calculatePurchaseOrderTotals([], DEFAULT_TAX_RATE_BPS)).toThrow(AppError);
  });

  // Every paise column is a 32-bit Prisma Int; an overflow has to be caught here
  // rather than surfacing as an opaque insert failure the worker would retry.
  it("refuses a line total beyond the 32-bit paise ceiling", () => {
    expect(() =>
      calculatePurchaseOrderTotals(
        [line({ quantity: 5_000, unitPricePaise: 500_000 })],
        DEFAULT_TAX_RATE_BPS,
      ),
    ).toThrow(AppError);
  });

  it("refuses a total that overflows only once tax is added", () => {
    // Subtotal fits; subtotal + 18% does not.
    const subtotalPaise = MAX_MONEY_PAISE - 1000;
    expect(() =>
      calculatePurchaseOrderTotals(
        [line({ quantity: 1, unitPricePaise: subtotalPaise })],
        DEFAULT_TAX_RATE_BPS,
      ),
    ).toThrow(AppError);
  });

  it("accepts a total that lands exactly on the ceiling", () => {
    const totals = calculatePurchaseOrderTotals(
      [line({ quantity: 1, unitPricePaise: 1_000_000 })],
      0,
    );
    expect(totals.totalPaise).toBe(1_000_000);
  });

  // A bad tax rate has to be caught before any line math, so it is rejected
  // even when the lines themselves are worth nothing.
  it.each([-1, 0.5, MAX_MONEY_PAISE + 1])("refuses a tax rate of %s", (taxRateBps) => {
    expect(() => calculatePurchaseOrderTotals([line()], taxRateBps)).toThrow(AppError);
    expect(() => calculatePurchaseOrderTotals([line({ unitPricePaise: 0 })], taxRateBps)).toThrow(
      AppError,
    );
  });

  // A ₹0 line is a bug upstream, and it would also poison three-way matching:
  // compareRelative treats an expected 0 as "equality wins", so a ₹0 PO line
  // would let an invoice line that printed no price at all pass UNIT_PRICE.
  it("refuses a non-positive unit price", () => {
    expect(() =>
      calculatePurchaseOrderTotals([line({ unitPricePaise: 0 })], DEFAULT_TAX_RATE_BPS),
    ).toThrow(AppError);
    expect(() =>
      calculatePurchaseOrderTotals([line({ unitPricePaise: -1 })], DEFAULT_TAX_RATE_BPS),
    ).toThrow(AppError);
  });

  it("refuses a non-positive quantity", () => {
    expect(() =>
      calculatePurchaseOrderTotals([line({ quantity: 0 })], DEFAULT_TAX_RATE_BPS),
    ).toThrow(AppError);
  });
});

describe("decideApprovalStatus", () => {
  // The MVP demo deliberately routes every purchase order through a human.
  it("holds a small purchase order for approval", () => {
    expect(decideApprovalStatus(50_000).status).toBe("PENDING_APPROVAL");
  });

  it("holds a large purchase order for approval", () => {
    expect(decideApprovalStatus(1_000_000_00).status).toBe("PENDING_APPROVAL");
  });
});
