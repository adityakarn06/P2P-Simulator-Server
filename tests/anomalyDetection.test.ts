import { describe, expect, it } from "vitest";
import { ANOMALY_THRESHOLDS } from "../src/config/constants.js";
import {
  describe as describeDistribution,
  detectInvoiceAnomalies,
  detectPurchaseOrderAnomalies,
  type InvoiceAnomalyInput,
  type PurchaseOrderAnomalyInput,
} from "../src/rules/anomalyDetection.js";

/**
 * A purchase order that trips nothing: an established supplier, a normal
 * quantity, a price in line with history, and a delivery record that matches
 * the quote. Each test moves exactly one thing.
 */
function purchaseOrder(
  overrides: Partial<PurchaseOrderAnomalyInput> = {},
): PurchaseOrderAnomalyInput {
  return {
    purchaseOrderId: "po-1",
    supplierId: "sup-1",
    supplierName: "TechSource Distributors",
    currency: "INR",
    totalPaise: 21_476_000,
    priorOrderCount: 8,
    productName: "Wireless Keyboard",
    quantity: 100,
    priorQuantities: [95, 100, 105, 100],
    lines: [
      {
        productId: "prod-kb",
        productName: "Wireless Keyboard",
        unitPricePaise: 182_000,
        priorUnitPricesPaise: [180_000, 182_000, 184_000, 182_000],
      },
    ],
    quotedDeliveryDays: 7,
    measuredLeadTimeDays: 7,
    deliveriesObserved: 8,
    reliabilityScore: 0.9,
    baselineReliability: 0.9,
    ...overrides,
  };
}

function types(signals: { signalType: string }[]): string[] {
  return signals.map((signal) => signal.signalType);
}

describe("describe", () => {
  it("returns a zeroed distribution for no samples", () => {
    expect(describeDistribution([])).toEqual({ count: 0, mean: 0, stdDev: 0 });
  });

  it("computes the population mean and standard deviation", () => {
    expect(describeDistribution([2, 4, 4, 4, 5, 5, 7, 9])).toEqual({
      count: 8,
      mean: 5,
      stdDev: 2,
    });
  });

  it("reports zero spread for identical samples", () => {
    expect(describeDistribution([100, 100, 100]).stdDev).toBe(0);
  });
});

describe("detectPurchaseOrderAnomalies", () => {
  it("stays silent on an ordinary order", () => {
    expect(detectPurchaseOrderAnomalies(purchaseOrder())).toEqual([]);
  });

  describe("PRICE_OUTLIER", () => {
    it("fires on a price far above the supplier's own history", () => {
      const [signal] = detectPurchaseOrderAnomalies(
        purchaseOrder({
          lines: [
            {
              productId: "prod-kb",
              productName: "Wireless Keyboard",
              unitPricePaise: 300_000,
              priorUnitPricesPaise: [180_000, 182_000, 184_000, 182_000],
            },
          ],
        }),
      );

      expect(signal?.signalType).toBe("PRICE_OUTLIER");
      expect(signal?.severity).toBe("WARNING");
      // Filed against the order, where it can still be challenged for free.
      expect(signal?.entityType).toBe("PurchaseOrder");
      expect(signal?.explanation).toContain("above");
    });

    it("fires on a suspiciously low price too", () => {
      const [signal] = detectPurchaseOrderAnomalies(
        purchaseOrder({
          lines: [
            {
              productId: "prod-kb",
              productName: "Wireless Keyboard",
              unitPricePaise: 10_000,
              priorUnitPricesPaise: [180_000, 182_000, 184_000, 182_000],
            },
          ],
        }),
      );

      expect(signal?.signalType).toBe("PRICE_OUTLIER");
      expect(signal?.explanation).toContain("below");
    });

    it("does not fire below the minimum history", () => {
      // Two priors make every third observation look like an outlier.
      const signals = detectPurchaseOrderAnomalies(
        purchaseOrder({
          lines: [
            {
              productId: "prod-kb",
              productName: "Wireless Keyboard",
              unitPricePaise: 900_000,
              priorUnitPricesPaise: [180_000, 182_000],
            },
          ],
        }),
      );

      expect(types(signals)).not.toContain("PRICE_OUTLIER");
    });

    it("does not fire with no history at all", () => {
      const signals = detectPurchaseOrderAnomalies(
        purchaseOrder({
          lines: [
            {
              productId: "prod-kb",
              productName: "Wireless Keyboard",
              unitPricePaise: 900_000,
              priorUnitPricesPaise: [],
            },
          ],
        }),
      );

      expect(types(signals)).not.toContain("PRICE_OUTLIER");
    });

    it("falls back to relative deviation when every prior price is identical", () => {
      // A flat history gives σ = 0, and a z-score would be infinite. A catalog
      // price that has never moved is the normal case, not an anomaly engine bug.
      const signals = detectPurchaseOrderAnomalies(
        purchaseOrder({
          lines: [
            {
              productId: "prod-kb",
              productName: "Wireless Keyboard",
              unitPricePaise: 182_100,
              priorUnitPricesPaise: [182_000, 182_000, 182_000],
            },
          ],
        }),
      );

      // A 0.05% move on a flat history is not worth reporting.
      expect(types(signals)).not.toContain("PRICE_OUTLIER");

      const [signal] = detectPurchaseOrderAnomalies(
        purchaseOrder({
          lines: [
            {
              productId: "prod-kb",
              productName: "Wireless Keyboard",
              unitPricePaise: 250_000,
              priorUnitPricesPaise: [182_000, 182_000, 182_000],
            },
          ],
        }),
      );

      expect(signal?.signalType).toBe("PRICE_OUTLIER");
      expect(Number.isFinite(signal?.score ?? Number.NaN)).toBe(true);
    });

    it("reports one signal naming the worst line, not one per line", () => {
      const signals = detectPurchaseOrderAnomalies(
        purchaseOrder({
          lines: [
            {
              productId: "prod-kb",
              productName: "Wireless Keyboard",
              unitPricePaise: 260_000,
              priorUnitPricesPaise: [180_000, 182_000, 184_000, 182_000],
            },
            {
              productId: "prod-ms",
              productName: "Wireless Mouse",
              unitPricePaise: 900_000,
              priorUnitPricesPaise: [50_000, 52_000, 54_000, 52_000],
            },
          ],
        }),
      );

      const priceSignals = signals.filter((signal) => signal.signalType === "PRICE_OUTLIER");
      expect(priceSignals).toHaveLength(1);
      expect(priceSignals[0]?.observed).toContain("Wireless Mouse");
      expect(priceSignals[0]?.observed).toContain("+1 more line(s)");
    });
  });

  describe("NEW_SUPPLIER_HIGH_VALUE", () => {
    it("fires on a large first order", () => {
      const signals = detectPurchaseOrderAnomalies(
        purchaseOrder({
          priorOrderCount: 0,
          totalPaise: ANOMALY_THRESHOLDS.NEW_SUPPLIER_VALUE_PAISE + 1,
        }),
      );

      expect(types(signals)).toContain("NEW_SUPPLIER_HIGH_VALUE");
    });

    it("does not fire on a small first order", () => {
      const signals = detectPurchaseOrderAnomalies(
        purchaseOrder({ priorOrderCount: 0, totalPaise: 100_000 }),
      );

      expect(types(signals)).not.toContain("NEW_SUPPLIER_HIGH_VALUE");
    });

    it("does not fire on a large order from an established supplier", () => {
      const signals = detectPurchaseOrderAnomalies(
        purchaseOrder({
          priorOrderCount: 1,
          totalPaise: ANOMALY_THRESHOLDS.NEW_SUPPLIER_VALUE_PAISE * 10,
        }),
      );

      expect(types(signals)).not.toContain("NEW_SUPPLIER_HIGH_VALUE");
    });
  });

  describe("PREDICTED_LATE_DELIVERY", () => {
    it("fires when measured lead time overruns the quote", () => {
      const signals = detectPurchaseOrderAnomalies(
        purchaseOrder({ quotedDeliveryDays: 7, measuredLeadTimeDays: 11 }),
      );

      const [signal] = signals.filter(
        (candidate) => candidate.signalType === "PREDICTED_LATE_DELIVERY",
      );
      expect(signal).toBeDefined();
      expect(signal?.explanation).toContain("likely to arrive late");
    });

    it("does not fire on an overrun inside the allowed ratio", () => {
      const signals = detectPurchaseOrderAnomalies(
        purchaseOrder({ quotedDeliveryDays: 7, measuredLeadTimeDays: 7.5 }),
      );

      expect(types(signals)).not.toContain("PREDICTED_LATE_DELIVERY");
    });

    it("does not fire on a supplier that beats its quote", () => {
      const signals = detectPurchaseOrderAnomalies(
        purchaseOrder({ quotedDeliveryDays: 7, measuredLeadTimeDays: 3 }),
      );

      expect(types(signals)).not.toContain("PREDICTED_LATE_DELIVERY");
    });

    it("does not fire before there is enough delivery history", () => {
      const signals = detectPurchaseOrderAnomalies(
        purchaseOrder({ measuredLeadTimeDays: 30, deliveriesObserved: 1 }),
      );

      expect(types(signals)).not.toContain("PREDICTED_LATE_DELIVERY");
    });

    it("does not fire before the supplier's first delivery", () => {
      const signals = detectPurchaseOrderAnomalies(
        purchaseOrder({ measuredLeadTimeDays: null, deliveriesObserved: 0 }),
      );

      expect(types(signals)).not.toContain("PREDICTED_LATE_DELIVERY");
    });
  });

  describe("SUPPLIER_DEGRADATION", () => {
    it("fires when reliability has fallen against the onboarding baseline", () => {
      const signals = detectPurchaseOrderAnomalies(
        purchaseOrder({ reliabilityScore: 0.6, baselineReliability: 0.9 }),
      );

      const [signal] = signals.filter(
        (candidate) => candidate.signalType === "SUPPLIER_DEGRADATION",
      );
      // Filed against the supplier: the order is fine, the relationship changed.
      expect(signal?.entityType).toBe("Supplier");
      expect(signal?.entityId).toBe("sup-1");
    });

    it("does not fire on a small dip", () => {
      const signals = detectPurchaseOrderAnomalies(
        purchaseOrder({ reliabilityScore: 0.85, baselineReliability: 0.9 }),
      );

      expect(types(signals)).not.toContain("SUPPLIER_DEGRADATION");
    });

    it("does not fire when the supplier has improved", () => {
      const signals = detectPurchaseOrderAnomalies(
        purchaseOrder({ reliabilityScore: 0.99, baselineReliability: 0.7 }),
      );

      expect(types(signals)).not.toContain("SUPPLIER_DEGRADATION");
    });

    it("does not fire without a baseline to measure against", () => {
      const signals = detectPurchaseOrderAnomalies(
        purchaseOrder({ reliabilityScore: 0.1, baselineReliability: null }),
      );

      expect(types(signals)).not.toContain("SUPPLIER_DEGRADATION");
    });
  });

  describe("QUANTITY_OUTLIER", () => {
    it("fires on an order far outside the organization's own history", () => {
      const signals = detectPurchaseOrderAnomalies(
        purchaseOrder({ quantity: 10_000, priorQuantities: [95, 100, 105, 100] }),
      );

      expect(types(signals)).toContain("QUANTITY_OUTLIER");
    });

    it("does not fire below the minimum history", () => {
      const signals = detectPurchaseOrderAnomalies(
        purchaseOrder({ quantity: 10_000, priorQuantities: [100, 100] }),
      );

      expect(types(signals)).not.toContain("QUANTITY_OUTLIER");
    });
  });
});

function invoice(overrides: Partial<InvoiceAnomalyInput> = {}): InvoiceAnomalyInput {
  return {
    invoiceId: "inv-1",
    supplierName: "TechSource Distributors",
    currency: "INR",
    totalPaise: 21_476_000,
    invoiceNumber: "INV-2026-001",
    invoiceDate: new Date("2026-08-20T00:00:00.000Z"),
    priorInvoices: [],
    ...overrides,
  };
}

describe("detectInvoiceAnomalies", () => {
  it("stays silent when the supplier has never billed this amount before", () => {
    expect(
      detectInvoiceAnomalies(
        invoice({
          priorInvoices: [
            {
              id: "inv-0",
              invoiceNumber: "INV-2026-000",
              totalPaise: 999_000,
              invoiceDate: new Date("2026-08-19T00:00:00.000Z"),
            },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("fires when the same amount was billed under a different number", () => {
    // The exact-number DUPLICATE_INVOICE check in threeWayMatch cannot see this.
    const [signal] = detectInvoiceAnomalies(
      invoice({
        priorInvoices: [
          {
            id: "inv-0",
            invoiceNumber: "INV-2026-000",
            totalPaise: 21_476_000,
            invoiceDate: new Date("2026-08-19T00:00:00.000Z"),
          },
        ],
      }),
    );

    expect(signal?.signalType).toBe("NEAR_DUPLICATE_INVOICE");
    expect(signal?.severity).toBe("WARNING");
    expect(signal?.metadata.matchedInvoiceIds).toEqual(["inv-0"]);
  });

  it("does not fire outside the window", () => {
    expect(
      detectInvoiceAnomalies(
        invoice({
          priorInvoices: [
            {
              id: "inv-0",
              invoiceNumber: "INV-2026-000",
              totalPaise: 21_476_000,
              invoiceDate: new Date("2026-01-01T00:00:00.000Z"),
            },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("does not flag the same invoice number as its own near-duplicate", () => {
    // That case is the exact-match DUPLICATE_INVOICE check's job, and it blocks payment.
    expect(
      detectInvoiceAnomalies(
        invoice({
          priorInvoices: [
            {
              id: "inv-0",
              invoiceNumber: "INV-2026-001",
              totalPaise: 21_476_000,
              invoiceDate: new Date("2026-08-19T00:00:00.000Z"),
            },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("does not fire when the document printed no total", () => {
    expect(
      detectInvoiceAnomalies(
        invoice({
          totalPaise: null,
          priorInvoices: [
            {
              id: "inv-0",
              invoiceNumber: "INV-2026-000",
              totalPaise: null,
              invoiceDate: new Date("2026-08-19T00:00:00.000Z"),
            },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("does not fire when the document printed no date", () => {
    expect(detectInvoiceAnomalies(invoice({ invoiceDate: null }))).toEqual([]);
  });
});
