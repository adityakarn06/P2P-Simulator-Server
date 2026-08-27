import { describe, expect, it } from "vitest";
import { MatchCheckType } from "../src/generated/prisma/enums.js";
import {
  EXCEPTION_TYPE_BY_CHECK,
  type MatchCheckResult,
  type MatchGoodsReceipt,
  type MatchInvoice,
  type MatchPurchaseOrder,
  type MatchPurchaseOrderLine,
  type PriorInvoice,
  type ThreeWayMatchResult,
  threeWayMatch,
} from "../src/rules/threeWayMatch.js";

// The canonical demo transaction: 100 wireless keyboards at ₹1,820.00 each.
// 100 × 182_000 = 18_200_000 subtotal, 18% tax = 3_276_000, total = 21_476_000.
const KEYBOARD_UNIT_PAISE = 182_000;
const KEYBOARD_SUBTOTAL_PAISE = 18_200_000;
const KEYBOARD_TAX_PAISE = 3_276_000;
const KEYBOARD_TOTAL_PAISE = 21_476_000;

const PO_NUMBER = "PO-20260824-ABC123";
const SUPPLIER = "TechSource Distributors";
const INVOICE_NUMBER = "INV-2026-0001";

const KEYBOARD_LINE: MatchPurchaseOrderLine = {
  productId: "prod-kb",
  sku: "PRPH-KB-001",
  productName: "Wireless Keyboard",
  category: "Peripherals",
  description: "Wireless Keyboard",
  quantity: 100,
  unitPricePaise: KEYBOARD_UNIT_PAISE,
  lineTotalPaise: KEYBOARD_SUBTOTAL_PAISE,
};

// 50 mice at ₹450.00 = 2_250_000.
const MOUSE_LINE: MatchPurchaseOrderLine = {
  productId: "prod-mouse",
  sku: "PRPH-MS-001",
  productName: "Wireless Mouse",
  category: "Peripherals",
  description: "Wireless Mouse",
  quantity: 50,
  unitPricePaise: 45_000,
  lineTotalPaise: 2_250_000,
};

function po(overrides: Partial<MatchPurchaseOrder> = {}): MatchPurchaseOrder {
  return {
    poNumber: PO_NUMBER,
    supplierName: SUPPLIER,
    currency: "INR",
    subtotalPaise: KEYBOARD_SUBTOTAL_PAISE,
    taxPaise: KEYBOARD_TAX_PAISE,
    totalPaise: KEYBOARD_TOTAL_PAISE,
    items: [KEYBOARD_LINE],
    ...overrides,
  };
}

function receipt(overrides: Partial<MatchGoodsReceipt> = {}): MatchGoodsReceipt {
  return {
    items: [
      { productId: "prod-kb", orderedQuantity: 100, receivedQuantity: 100, acceptedQuantity: 100 },
    ],
    ...overrides,
  };
}

function invoice(overrides: Partial<MatchInvoice> = {}): MatchInvoice {
  return {
    id: "inv-1",
    invoiceNumber: INVOICE_NUMBER,
    supplierNameRaw: SUPPLIER,
    poNumberRaw: PO_NUMBER,
    currency: "INR",
    subtotalPaise: KEYBOARD_SUBTOTAL_PAISE,
    taxPaise: KEYBOARD_TAX_PAISE,
    totalPaise: KEYBOARD_TOTAL_PAISE,
    items: [
      {
        lineNumber: 1,
        description: "Wireless Keyboard",
        quantity: 100,
        unitPricePaise: KEYBOARD_UNIT_PAISE,
        lineTotalPaise: KEYBOARD_SUBTOTAL_PAISE,
      },
    ],
    ...overrides,
  };
}

function run(params: {
  purchaseOrder?: MatchPurchaseOrder;
  goodsReceipt?: MatchGoodsReceipt | null;
  invoice?: MatchInvoice;
  priorInvoices?: PriorInvoice[];
}): ThreeWayMatchResult {
  return threeWayMatch({
    purchaseOrder: params.purchaseOrder ?? po(),
    goodsReceipt: params.goodsReceipt === undefined ? receipt() : params.goodsReceipt,
    invoice: params.invoice ?? invoice(),
    priorInvoices: params.priorInvoices ?? [],
  });
}

function checkOf(result: ThreeWayMatchResult, checkType: MatchCheckType): MatchCheckResult {
  const found = result.checks.filter((check) => check.checkType === checkType);
  expect(found).toHaveLength(1);
  return found[0] as MatchCheckResult;
}

function failedTypes(result: ThreeWayMatchResult): MatchCheckType[] {
  return result.checks.filter((check) => !check.passed).map((check) => check.checkType);
}

describe("threeWayMatch — perfect match", () => {
  it("passes every check when the paperwork agrees", () => {
    const result = run({});

    expect(result.status).toBe("MATCHED");
    expect(result.totalChecks).toBe(12);
    expect(result.passedChecks).toBe(12);
    expect(result.failedChecks).toBe(0);
    expect(failedTypes(result)).toEqual([]);
  });

  it("emits every check type exactly once, in enum order", () => {
    // MatchCheck is unique on [threeWayMatchId, checkType]; a duplicate row here
    // would blow up the worker's insert.
    const result = run({});

    expect(result.checks.map((check) => check.checkType)).toEqual(Object.values(MatchCheckType));
  });

  it("tolerates punctuation and casing in the transcribed supplier and PO number", () => {
    const result = run({
      invoice: invoice({
        supplierNameRaw: "techsource distributors.",
        poNumberRaw: "po 20260824 abc123",
      }),
    });

    expect(result.status).toBe("MATCHED");
  });
});

describe("threeWayMatch — quantity mismatch", () => {
  it("blocks the demo case: ordered 100, accepted 96, invoiced 100", () => {
    const result = run({
      goodsReceipt: receipt({
        items: [
          {
            productId: "prod-kb",
            orderedQuantity: 100,
            receivedQuantity: 98,
            acceptedQuantity: 96,
          },
        ],
      }),
    });

    expect(result.status).toBe("MISMATCHED");
    expect(failedTypes(result)).toEqual([
      MatchCheckType.RECEIVED_QUANTITY,
      MatchCheckType.INVOICED_QUANTITY,
    ]);

    // 96 accepted against 100 ordered.
    expect(checkOf(result, MatchCheckType.RECEIVED_QUANTITY)).toMatchObject({
      expected: "Wireless Keyboard: 100",
      actual: "Wireless Keyboard: 96",
      variance: -4,
      severity: "CRITICAL",
    });
    // 100 invoiced against 96 accepted.
    expect(checkOf(result, MatchCheckType.INVOICED_QUANTITY)).toMatchObject({
      variance: 4,
      severity: "CRITICAL",
    });
    // The receipt still agrees with the PO about what was ordered.
    expect(checkOf(result, MatchCheckType.ORDERED_QUANTITY).passed).toBe(true);
  });

  it("maps quantity failures onto QUANTITY_MISMATCH", () => {
    expect(EXCEPTION_TYPE_BY_CHECK[MatchCheckType.RECEIVED_QUANTITY]).toBe("QUANTITY_MISMATCH");
    expect(EXCEPTION_TYPE_BY_CHECK[MatchCheckType.INVOICED_QUANTITY]).toBe("QUANTITY_MISMATCH");
  });

  it("flags a receipt booked against the wrong ordered quantity", () => {
    const result = run({
      goodsReceipt: receipt({
        items: [
          { productId: "prod-kb", orderedQuantity: 90, receivedQuantity: 90, acceptedQuantity: 90 },
        ],
      }),
    });

    expect(checkOf(result, MatchCheckType.ORDERED_QUANTITY)).toMatchObject({
      passed: false,
      variance: -10,
    });
  });
});

describe("threeWayMatch — price mismatch", () => {
  it("blocks an invoice priced at ₹2,100 against a ₹1,820 purchase order", () => {
    const result = run({
      invoice: invoice({
        items: [
          {
            lineNumber: 1,
            description: "Wireless Keyboard",
            quantity: 100,
            unitPricePaise: 210_000,
            lineTotalPaise: 21_000_000,
          },
        ],
        subtotalPaise: 21_000_000,
        taxPaise: 3_780_000,
        totalPaise: 24_780_000,
      }),
    });

    expect(result.status).toBe("MISMATCHED");
    // (210_000 - 182_000) / 182_000 = 0.153846…
    expect(checkOf(result, MatchCheckType.UNIT_PRICE)).toMatchObject({
      expected: "Wireless Keyboard: ₹1,820.00",
      actual: "Wireless Keyboard: ₹2,100.00",
      passed: false,
      variance: 0.1538,
    });
    expect(checkOf(result, MatchCheckType.SUBTOTAL).passed).toBe(false);
    expect(checkOf(result, MatchCheckType.TOTAL).passed).toBe(false);
    expect(EXCEPTION_TYPE_BY_CHECK[MatchCheckType.UNIT_PRICE]).toBe("PRICE_MISMATCH");
  });

  it("accepts a price move inside the 2% tolerance", () => {
    // ₹1,830 against ₹1,820 is 0.55%.
    const result = run({
      invoice: invoice({
        items: [
          {
            lineNumber: 1,
            description: "Wireless Keyboard",
            quantity: 100,
            unitPricePaise: 183_000,
            lineTotalPaise: 18_300_000,
          },
        ],
      }),
    });

    expect(checkOf(result, MatchCheckType.UNIT_PRICE)).toMatchObject({
      passed: true,
      variance: null,
    });
    expect(result.status).toBe("MATCHED");
  });

  // A price the document never printed is not a price of zero. Storing 0 would
  // make an unpriced line compare equal against a ₹0 purchase-order line and
  // pass; null fails outright, the way every other missing figure does.
  it("fails when the invoice line printed no unit price", () => {
    const result = run({
      invoice: invoice({
        items: [
          {
            lineNumber: 1,
            description: "Wireless Keyboard",
            quantity: 100,
            unitPricePaise: null,
            lineTotalPaise: null,
          },
        ],
      }),
    });

    expect(checkOf(result, MatchCheckType.UNIT_PRICE).passed).toBe(false);
    expect(result.status).toBe("MISMATCHED");
    expect(failedTypes(result)).toContain(MatchCheckType.UNIT_PRICE);
  });

  // Regression: the tolerance test must use the exact ratio, not the rounded
  // reporting variance. ₹1,856.49 against ₹1,820.00 is 2.00494...%, which is
  // outside the 2% tolerance — but round4 renders it as 0.0200, and comparing
  // *that* against the tolerance would let it through.
  it("does not let a rounded variance sneak past the tolerance", () => {
    const result = run({
      invoice: invoice({
        items: [
          {
            lineNumber: 1,
            description: "Wireless Keyboard",
            quantity: 100,
            unitPricePaise: 185_649,
            lineTotalPaise: 18_564_900,
          },
        ],
      }),
    });

    const check = checkOf(result, MatchCheckType.UNIT_PRICE);
    expect(check.passed).toBe(false);
    // Reported variance stays rounded for readability, even though the
    // comparison behind it did not round.
    expect(check.variance).toBe(0.02);
    expect(result.status).toBe("MISMATCHED");
  });

  it("is symmetric — undercharging fails too", () => {
    const result = run({
      invoice: invoice({
        items: [
          {
            lineNumber: 1,
            description: "Wireless Keyboard",
            quantity: 100,
            unitPricePaise: 150_000,
            lineTotalPaise: 15_000_000,
          },
        ],
      }),
    });

    expect(checkOf(result, MatchCheckType.UNIT_PRICE).passed).toBe(false);
    expect(result.status).toBe("MISMATCHED");
  });
});

describe("threeWayMatch — supplier mismatch", () => {
  it("fails only the supplier check when the invoice is from someone else", () => {
    const result = run({ invoice: invoice({ supplierNameRaw: "Globex Trading" }) });

    expect(result.status).toBe("MISMATCHED");
    expect(failedTypes(result)).toEqual([MatchCheckType.SUPPLIER]);
    expect(checkOf(result, MatchCheckType.SUPPLIER)).toMatchObject({
      expected: SUPPLIER,
      actual: "Globex Trading",
      variance: null,
      severity: "CRITICAL",
    });
    expect(EXCEPTION_TYPE_BY_CHECK[MatchCheckType.SUPPLIER]).toBe("SUPPLIER_MISMATCH");
  });

  it("fails when the document never printed a supplier name", () => {
    const result = run({ invoice: invoice({ supplierNameRaw: null }) });

    expect(checkOf(result, MatchCheckType.SUPPLIER)).toMatchObject({
      actual: "missing",
      passed: false,
    });
  });

  it("fails when the invoice cites a different purchase order", () => {
    const result = run({ invoice: invoice({ poNumberRaw: "PO-20260101-ZZZ999" }) });

    expect(failedTypes(result)).toEqual([MatchCheckType.PO_NUMBER]);
    // No ExceptionType describes a wrong PO reference; the worker falls back.
    expect(EXCEPTION_TYPE_BY_CHECK[MatchCheckType.PO_NUMBER]).toBeUndefined();
  });
});

describe("threeWayMatch — duplicate invoice", () => {
  it("fails when the same invoice number was already billed", () => {
    const result = run({
      priorInvoices: [{ id: "inv-old", invoiceNumber: INVOICE_NUMBER }],
    });

    expect(result.status).toBe("MISMATCHED");
    expect(failedTypes(result)).toEqual([MatchCheckType.DUPLICATE_INVOICE]);
    expect(checkOf(result, MatchCheckType.DUPLICATE_INVOICE).actual).toContain("inv-old");
    expect(EXCEPTION_TYPE_BY_CHECK[MatchCheckType.DUPLICATE_INVOICE]).toBe("DUPLICATE_INVOICE");
  });

  it("does not flag the invoice against itself on a re-run", () => {
    const result = run({ priorInvoices: [{ id: "inv-1", invoiceNumber: INVOICE_NUMBER }] });

    expect(result.status).toBe("MATCHED");
  });

  it("fails an invoice that carries no number at all", () => {
    const result = run({ invoice: invoice({ invoiceNumber: null }) });

    expect(checkOf(result, MatchCheckType.DUPLICATE_INVOICE)).toMatchObject({
      actual: "missing",
      passed: false,
    });
  });
});

describe("threeWayMatch — tax mismatch", () => {
  it("fails tax beyond the 1% tolerance while the subtotal still agrees", () => {
    // 3_400_000 against 3_276_000 is 3.79%.
    const result = run({ invoice: invoice({ taxPaise: 3_400_000 }) });

    expect(result.status).toBe("MISMATCHED");
    expect(failedTypes(result)).toEqual([MatchCheckType.TAX]);
    expect(checkOf(result, MatchCheckType.TAX)).toMatchObject({
      expected: "₹32,760.00",
      actual: "₹34,000.00",
      variance: 0.0379,
      severity: "CRITICAL",
    });
    expect(EXCEPTION_TYPE_BY_CHECK[MatchCheckType.TAX]).toBe("TAX_MISMATCH");
  });

  it("accepts a rounding difference inside the 1% tolerance", () => {
    // 3_290_000 against 3_276_000 is 0.43%.
    const result = run({ invoice: invoice({ taxPaise: 3_290_000 }) });

    expect(checkOf(result, MatchCheckType.TAX).passed).toBe(true);
    expect(result.status).toBe("MATCHED");
  });

  it("fails a total the document never printed", () => {
    const result = run({ invoice: invoice({ totalPaise: null }) });

    expect(checkOf(result, MatchCheckType.TOTAL)).toMatchObject({
      expected: "₹2,14,760.00",
      actual: "missing",
      passed: false,
    });
  });
});

describe("threeWayMatch — partial receipt", () => {
  const partial = receipt({
    items: [
      { productId: "prod-kb", orderedQuantity: 100, receivedQuantity: 98, acceptedQuantity: 96 },
    ],
  });

  it("still blocks when the supplier bills only for the 96 units accepted", () => {
    // 96 × 182_000 = 17_472_000, 18% tax = 3_144_960, total = 20_616_960.
    const result = run({
      goodsReceipt: partial,
      invoice: invoice({
        items: [
          {
            lineNumber: 1,
            description: "Wireless Keyboard",
            quantity: 96,
            unitPricePaise: KEYBOARD_UNIT_PAISE,
            lineTotalPaise: 17_472_000,
          },
        ],
        subtotalPaise: 17_472_000,
        taxPaise: 3_144_960,
        totalPaise: 20_616_960,
      }),
    });

    // The invoice agrees with the receipt, but the short delivery itself needs a
    // human decision before anything is paid.
    expect(checkOf(result, MatchCheckType.INVOICED_QUANTITY).passed).toBe(true);
    expect(checkOf(result, MatchCheckType.RECEIVED_QUANTITY).passed).toBe(false);
    expect(checkOf(result, MatchCheckType.UNIT_PRICE).passed).toBe(true);
    // 4% short of the ordered subtotal, outside the 2% price tolerance.
    expect(checkOf(result, MatchCheckType.SUBTOTAL)).toMatchObject({
      passed: false,
      variance: -0.04,
    });
    expect(result.status).toBe("MISMATCHED");
  });

  it("fails RECEIVED_QUANTITY when the invoice arrived before the goods", () => {
    const result = run({ goodsReceipt: null });

    expect(checkOf(result, MatchCheckType.RECEIVED_QUANTITY)).toMatchObject({
      expected: "100",
      actual: "none",
      passed: false,
      severity: "CRITICAL",
    });
    // The missing receipt is reported once, not twice.
    expect(checkOf(result, MatchCheckType.ORDERED_QUANTITY).passed).toBe(true);
    // Over-billing is still caught, against the ordered quantity.
    expect(checkOf(result, MatchCheckType.INVOICED_QUANTITY).passed).toBe(true);
    expect(result.status).toBe("MISMATCHED");
  });

  it("catches over-billing with no receipt to compare against", () => {
    const result = run({
      goodsReceipt: null,
      invoice: invoice({
        items: [
          {
            lineNumber: 1,
            description: "Wireless Keyboard",
            quantity: 120,
            unitPricePaise: KEYBOARD_UNIT_PAISE,
            lineTotalPaise: 21_840_000,
          },
        ],
      }),
    });

    expect(checkOf(result, MatchCheckType.INVOICED_QUANTITY)).toMatchObject({
      passed: false,
      variance: 20,
    });
  });
});

describe("threeWayMatch — multiple invoice items", () => {
  // 18_200_000 + 2_250_000 = 20_450_000 subtotal, 18% tax = 3_681_000, total = 24_131_000.
  const twoLinePo = po({
    items: [KEYBOARD_LINE, MOUSE_LINE],
    subtotalPaise: 20_450_000,
    taxPaise: 3_681_000,
    totalPaise: 24_131_000,
  });

  const twoLineReceipt = receipt({
    items: [
      { productId: "prod-kb", orderedQuantity: 100, receivedQuantity: 100, acceptedQuantity: 100 },
      { productId: "prod-mouse", orderedQuantity: 50, receivedQuantity: 50, acceptedQuantity: 50 },
    ],
  });

  function twoLineInvoice(overrides: Partial<MatchInvoice> = {}): MatchInvoice {
    return invoice({
      items: [
        {
          lineNumber: 1,
          description: "Wireless Keyboard",
          quantity: 100,
          unitPricePaise: KEYBOARD_UNIT_PAISE,
          lineTotalPaise: KEYBOARD_SUBTOTAL_PAISE,
        },
        {
          lineNumber: 2,
          description: "Wireless Mouse",
          quantity: 50,
          unitPricePaise: 45_000,
          lineTotalPaise: 2_250_000,
        },
      ],
      subtotalPaise: 20_450_000,
      taxPaise: 3_681_000,
      totalPaise: 24_131_000,
      ...overrides,
    });
  }

  it("resolves each invoice line back to its purchase-order line by description", () => {
    const result = run({
      purchaseOrder: twoLinePo,
      goodsReceipt: twoLineReceipt,
      invoice: twoLineInvoice(),
    });

    expect(result.status).toBe("MATCHED");
    expect(checkOf(result, MatchCheckType.INVOICED_QUANTITY)).toMatchObject({
      expected: "150",
      actual: "150",
      passed: true,
    });
  });

  it("collapses per-line price failures into one check naming the worst offender", () => {
    const result = run({
      purchaseOrder: twoLinePo,
      goodsReceipt: twoLineReceipt,
      invoice: twoLineInvoice({
        items: [
          {
            lineNumber: 1,
            description: "Wireless Keyboard",
            quantity: 100,
            unitPricePaise: 210_000, // +15.38%
            lineTotalPaise: 21_000_000,
          },
          {
            lineNumber: 2,
            description: "Wireless Mouse",
            quantity: 50,
            unitPricePaise: 50_000, // +11.11%
            lineTotalPaise: 2_500_000,
          },
        ],
      }),
    });

    const unitPrice = checkOf(result, MatchCheckType.UNIT_PRICE);
    expect(unitPrice).toMatchObject({
      expected: "Wireless Keyboard: ₹1,820.00",
      actual: "Wireless Keyboard: ₹2,100.00 (+1 more lines)",
      passed: false,
      variance: 0.1538,
    });
  });

  it("sums an ordered line the supplier split across two printed rows", () => {
    const result = run({
      purchaseOrder: twoLinePo,
      goodsReceipt: twoLineReceipt,
      invoice: twoLineInvoice({
        items: [
          {
            lineNumber: 1,
            description: "Wireless Keyboard",
            quantity: 60,
            unitPricePaise: KEYBOARD_UNIT_PAISE,
            lineTotalPaise: 10_920_000,
          },
          {
            lineNumber: 2,
            description: "Wireless Keyboard",
            quantity: 40,
            unitPricePaise: KEYBOARD_UNIT_PAISE,
            lineTotalPaise: 7_280_000,
          },
          {
            lineNumber: 3,
            description: "Wireless Mouse",
            quantity: 50,
            unitPricePaise: 45_000,
            lineTotalPaise: 2_250_000,
          },
        ],
      }),
    });

    expect(result.status).toBe("MATCHED");
  });

  it("fails PRODUCT when an ordered product is never invoiced", () => {
    const result = run({
      purchaseOrder: twoLinePo,
      goodsReceipt: twoLineReceipt,
      invoice: twoLineInvoice({
        items: [
          {
            lineNumber: 1,
            description: "Wireless Keyboard",
            quantity: 100,
            unitPricePaise: KEYBOARD_UNIT_PAISE,
            lineTotalPaise: KEYBOARD_SUBTOTAL_PAISE,
          },
        ],
      }),
    });

    expect(checkOf(result, MatchCheckType.PRODUCT)).toMatchObject({
      passed: false,
      actual: "Wireless Mouse not invoiced",
      severity: "CRITICAL",
    });
    expect(result.status).toBe("MISMATCHED");
  });

  it("fails PRODUCT when the invoice bills for something the PO never ordered", () => {
    const result = run({
      purchaseOrder: twoLinePo,
      goodsReceipt: twoLineReceipt,
      invoice: twoLineInvoice({
        items: [
          {
            lineNumber: 1,
            description: "Wireless Keyboard",
            quantity: 100,
            unitPricePaise: KEYBOARD_UNIT_PAISE,
            lineTotalPaise: KEYBOARD_SUBTOTAL_PAISE,
          },
          {
            lineNumber: 2,
            description: "Wireless Mouse",
            quantity: 50,
            unitPricePaise: 45_000,
            lineTotalPaise: 2_250_000,
          },
          {
            lineNumber: 3,
            description: "Expedited Freight Surcharge",
            quantity: 1,
            unitPricePaise: 500_000,
            lineTotalPaise: 500_000,
          },
        ],
      }),
    });

    expect(checkOf(result, MatchCheckType.PRODUCT).actual).toContain(
      'line 3 "Expedited Freight Surcharge" not on the purchase order',
    );
    expect(result.status).toBe("MISMATCHED");
  });
});

describe("threeWayMatch — currency", () => {
  it("fails a currency the purchase order was not placed in", () => {
    const result = run({ invoice: invoice({ currency: "USD" }) });

    expect(failedTypes(result)).toEqual([MatchCheckType.CURRENCY]);
    expect(checkOf(result, MatchCheckType.CURRENCY)).toMatchObject({
      expected: "INR",
      actual: "USD",
      variance: null,
    });
  });

  it("ignores casing", () => {
    const result = run({ invoice: invoice({ currency: "inr" }) });

    expect(checkOf(result, MatchCheckType.CURRENCY).passed).toBe(true);
  });
});
