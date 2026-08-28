import { describe, expect, it } from "vitest";
import type { SettlementLedger } from "../src/rules/settlementRules.js";
import {
  describeSettlement,
  evaluateSettlement,
  suggestPartialSettlement,
} from "../src/rules/settlementRules.js";

/**
 * The arithmetic that decides how much money leaves the building. Two caps hold
 * everywhere: an invoice is never paid more than it billed, and a purchase
 * order is never paid more than the buyer committed — no matter how many
 * invoices are raised against it.
 *
 * Figures throughout: 100 keyboards at ₹1,820, 18% tax. Order total
 * ₹2,14,760 = 21,476,000 paise. 96 accepted units come to 20,616,960 paise.
 */

const ORDER_TOTAL = 21_476_000;
const ACCEPTED_96 = 20_616_960;

function ledger(overrides: Partial<SettlementLedger> = {}): SettlementLedger {
  return {
    invoiceTotalPaise: ORDER_TOTAL,
    invoiceSettledPaise: 0,
    purchaseOrderTotalPaise: ORDER_TOTAL,
    purchaseOrderSettledPaise: 0,
    ...overrides,
  };
}

describe("describeSettlement", () => {
  it("reports nothing settled and everything outstanding on a fresh invoice", () => {
    expect(describeSettlement(ledger())).toMatchObject({
      invoiceOutstandingPaise: ORDER_TOTAL,
      purchaseOrderOutstandingPaise: ORDER_TOTAL,
      fullySettled: false,
    });
  });

  it("is fully settled once the purchase order is spent, whatever the invoice says", () => {
    // The order is the buyer's entire commitment: once it is gone there is no
    // budget left to pay this invoice from, so nothing more will ever move.
    const view = describeSettlement(
      ledger({
        invoiceTotalPaise: ORDER_TOTAL + 100_000,
        invoiceSettledPaise: ORDER_TOTAL,
        purchaseOrderSettledPaise: ORDER_TOTAL,
      }),
    );

    expect(view.invoiceOutstandingPaise).toBe(100_000);
    expect(view.fullySettled).toBe(true);
  });

  it("is fully settled only once the tranches add up to the invoice total", () => {
    expect(describeSettlement(ledger({ invoiceSettledPaise: ORDER_TOTAL })).fullySettled).toBe(
      true,
    );
    expect(describeSettlement(ledger({ invoiceSettledPaise: ORDER_TOTAL - 1 })).fullySettled).toBe(
      false,
    );
  });

  it("never reports a negative balance as a credit", () => {
    const view = describeSettlement(ledger({ invoiceSettledPaise: ORDER_TOTAL + 500 }));

    expect(view.invoiceOutstandingPaise).toBe(0);
  });

  it("treats an invoice with no extracted total as having nothing outstanding", () => {
    // Not "everything is owed": the amount is unknown, and guessing it is how a
    // wrong sum gets paid.
    expect(describeSettlement(ledger({ invoiceTotalPaise: null })).invoiceOutstandingPaise).toBe(0);
  });
});

describe("evaluateSettlement — automatic settlement", () => {
  it("settles the whole invoice when nothing has been paid", () => {
    expect(evaluateSettlement({ ledger: ledger(), requestedAmountPaise: null })).toEqual({
      settle: true,
      amountPaise: ORDER_TOTAL,
      kind: "FULL",
    });
  });

  it("settles only the balance after an earlier tranche", () => {
    const decision = evaluateSettlement({
      ledger: ledger({ invoiceSettledPaise: ACCEPTED_96, purchaseOrderSettledPaise: ACCEPTED_96 }),
      requestedAmountPaise: null,
    });

    expect(decision).toEqual({
      settle: true,
      amountPaise: ORDER_TOTAL - ACCEPTED_96,
      kind: "FULL",
    });
  });

  // Three-way matching tolerates 1% on the total, so an invoice can pass while
  // billing slightly more than the order committed. Settling it for the order's
  // figure must finish the invoice — the earlier version left it PARTIALLY_PAID
  // forever, since nothing ever enqueues a further tranche.
  it("finishes an invoice that billed marginally above the order", () => {
    const overBilled = ledger({ invoiceTotalPaise: ORDER_TOTAL + 100_000 });

    const decision = evaluateSettlement({ ledger: overBilled, requestedAmountPaise: null });
    expect(decision).toEqual({ settle: true, amountPaise: ORDER_TOTAL, kind: "PARTIAL" });

    const after = describeSettlement({
      ...overBilled,
      invoiceSettledPaise: ORDER_TOTAL,
      purchaseOrderSettledPaise: ORDER_TOTAL,
    });
    expect(after.fullySettled).toBe(true);
  });

  // CLAUDE.md rule 12: the order total is the buyer's own deterministic figure;
  // the invoice total was transcribed off a document by Gemini.
  it("pays the order's figure, not the invoice's, when they differ within tolerance", () => {
    const underBilled = ledger({ invoiceTotalPaise: ORDER_TOTAL - 100_000 });

    expect(evaluateSettlement({ ledger: underBilled, requestedAmountPaise: null })).toEqual({
      settle: true,
      amountPaise: ORDER_TOTAL,
      kind: "FULL",
    });
  });

  it("caps at the order's remaining budget and reports the result as PARTIAL", () => {
    // A second invoice for the full amount against an order that is 90% spent.
    const decision = evaluateSettlement({
      ledger: ledger({ purchaseOrderSettledPaise: ORDER_TOTAL - 1_000_000 }),
      requestedAmountPaise: null,
    });

    expect(decision).toEqual({ settle: true, amountPaise: 1_000_000, kind: "PARTIAL" });
  });

  it("refuses once the invoice is fully settled", () => {
    const decision = evaluateSettlement({
      ledger: ledger({ invoiceSettledPaise: ORDER_TOTAL }),
      requestedAmountPaise: null,
    });

    expect(decision).toEqual({ settle: false, reason: "Invoice is already fully settled" });
  });

  it("refuses a second invoice against a fully settled order", () => {
    const decision = evaluateSettlement({
      ledger: ledger({ purchaseOrderSettledPaise: ORDER_TOTAL }),
      requestedAmountPaise: null,
    });

    expect(decision).toEqual({
      settle: false,
      reason: "The purchase order is already settled in full; nothing is left to pay",
    });
  });

  it.each([null, 0, -1])("refuses an invoice whose extracted total is %s", (invoiceTotalPaise) => {
    const decision = evaluateSettlement({
      ledger: ledger({ invoiceTotalPaise }),
      requestedAmountPaise: null,
    });

    expect(decision).toEqual({
      settle: false,
      reason: "Invoice has no extracted total to settle against",
    });
  });
});

describe("evaluateSettlement — a human-approved amount", () => {
  it("settles exactly what was approved, marked PARTIAL", () => {
    expect(evaluateSettlement({ ledger: ledger(), requestedAmountPaise: ACCEPTED_96 })).toEqual({
      settle: true,
      amountPaise: ACCEPTED_96,
      kind: "PARTIAL",
    });
  });

  it("calls an approval that happens to clear the invoice a FULL settlement", () => {
    const decision = evaluateSettlement({
      ledger: ledger(),
      requestedAmountPaise: ORDER_TOTAL,
    });

    expect(decision).toEqual({ settle: true, amountPaise: ORDER_TOTAL, kind: "FULL" });
  });

  it("refuses more than the invoice still owes", () => {
    const decision = evaluateSettlement({
      ledger: ledger({ invoiceSettledPaise: ACCEPTED_96 }),
      requestedAmountPaise: ORDER_TOTAL,
    });

    expect(decision.settle).toBe(false);
    expect(decision).toMatchObject({ reason: expect.stringContaining("invoice's outstanding") });
  });

  it("refuses more than the purchase order has left, even if the invoice allows it", () => {
    const decision = evaluateSettlement({
      ledger: ledger({ purchaseOrderSettledPaise: ORDER_TOTAL - 1_000 }),
      requestedAmountPaise: 5_000,
    });

    expect(decision).toMatchObject({
      settle: false,
      reason: expect.stringContaining("purchase order's"),
    });
  });

  it.each([0, -1, 1.5, Number.NaN])("refuses %s as an approved amount", (requestedAmountPaise) => {
    const decision = evaluateSettlement({ ledger: ledger(), requestedAmountPaise });

    expect(decision).toEqual({
      settle: false,
      reason: "Approved amount must be a whole, positive number of paise",
    });
  });

  it("allows the last rupee of an order to be settled exactly", () => {
    const decision = evaluateSettlement({
      ledger: ledger({ purchaseOrderSettledPaise: ORDER_TOTAL - 100 }),
      requestedAmountPaise: 100,
    });

    expect(decision).toEqual({ settle: true, amountPaise: 100, kind: "PARTIAL" });
  });
});

describe("suggestPartialSettlement", () => {
  it("prices the accepted units at the purchase order's own rate, with tax", () => {
    // 96 x 182_000 = 17_472_000, +18% = 3_144_960, total 20_616_960.
    expect(
      suggestPartialSettlement({
        lines: [{ unitPricePaise: 182_000, acceptedQuantity: 96 }],
        taxRateBps: 1800,
      }),
    ).toBe(ACCEPTED_96);
  });

  it("returns the full order total when everything arrived intact", () => {
    expect(
      suggestPartialSettlement({
        lines: [{ unitPricePaise: 182_000, acceptedQuantity: 100 }],
        taxRateBps: 1800,
      }),
    ).toBe(ORDER_TOTAL);
  });

  it("suggests nothing when nothing was accepted", () => {
    expect(
      suggestPartialSettlement({
        lines: [{ unitPricePaise: 182_000, acceptedQuantity: 0 }],
        taxRateBps: 1800,
      }),
    ).toBe(0);
  });

  it("sums across lines and rounds the tax exactly once, on the subtotal", () => {
    // Rounding per line would give 1 + 1 = 2 paise of tax; rounding the
    // subtotal gives 3. The purchase order's own totals are computed the same
    // way, so this has to match or the invoice will never balance.
    expect(
      suggestPartialSettlement({
        lines: [
          { unitPricePaise: 7, acceptedQuantity: 1 },
          { unitPricePaise: 8, acceptedQuantity: 1 },
        ],
        taxRateBps: 1800,
      }),
    ).toBe(15 + 3);
  });

  it("refuses a subtotal past what an integer paise column can hold", () => {
    expect(() =>
      suggestPartialSettlement({
        lines: [{ unitPricePaise: 2_000_000_000, acceptedQuantity: 100 }],
        taxRateBps: 1800,
      }),
    ).toThrow(/maximum supported amount/);
  });
});
