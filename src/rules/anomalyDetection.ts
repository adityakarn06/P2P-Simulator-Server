import { ANOMALY_THRESHOLDS } from "../config/constants.js";
import { AnomalySignalType, Severity } from "../generated/prisma/enums.js";
import { formatMoney } from "./supplierRanking.js";

/**
 * Deterministic anomaly signals over the organization's own procurement
 * history. Pure functions, no I/O, no Prisma imports, no Gemini.
 *
 * These are *advisory*. Nothing here blocks a payment, raises an Exception, or
 * changes a three-way match verdict — src/rules/threeWayMatch.ts remains the
 * only financial gate, and src/rules/paymentRules.ts the only payment one. A
 * signal says "a buyer might want to look at this"; it never says "do not pay".
 *
 * Statistical, not machine-learned: mean and standard deviation over prior
 * purchase orders and deliveries. That keeps every signal explainable in one
 * sentence, which is the point — an unexplainable warning on a procurement
 * dashboard gets ignored, and an unexplainable one that blocked money would be
 * indefensible.
 */

export interface AnomalySignal {
  signalType: AnomalySignalType;
  severity: Severity;
  entityType: string;
  entityId: string;
  /** Sortable magnitude: a z-score where there is a distribution, a ratio otherwise. */
  score: number;
  observed: string;
  baseline: string;
  explanation: string;
  /** Structured detail for the dashboard. Display and drill-down only, never re-parsed into a decision. */
  metadata: Record<string, string | number | boolean | string[]>;
}

// ---------------------------------------------------------------------------
// Distribution helpers
// ---------------------------------------------------------------------------

export interface Distribution {
  count: number;
  mean: number;
  /** Population standard deviation. Zero when every sample is identical. */
  stdDev: number;
}

/** Population σ, not sample σ: these are all the priors there are, not a sample of them. */
export function describe(samples: number[]): Distribution {
  if (samples.length === 0) {
    return { count: 0, mean: 0, stdDev: 0 };
  }

  const mean = samples.reduce((total, value) => total + value, 0) / samples.length;
  const variance =
    samples.reduce((total, value) => total + (value - mean) ** 2, 0) / samples.length;

  return { count: samples.length, mean, stdDev: Math.sqrt(variance) };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * How far an observation sits from its history, and whether that is far enough
 * to report.
 *
 * Two regimes. With spread in the history, a z-score. With none — every prior
 * identical, which is exactly what a catalog price looks like until it changes
 * — σ is 0 and every z-score is infinite, so it falls back to a relative
 * deviation instead. Without that fallback the very first price change a
 * supplier ever makes would be reported as an infinitely severe anomaly.
 */
function assess(observed: number, history: Distribution): { score: number; fires: boolean } | null {
  if (history.count < ANOMALY_THRESHOLDS.MIN_HISTORY) {
    return null;
  }

  if (history.stdDev === 0) {
    if (history.mean === 0) {
      return null;
    }
    const deviation = (observed - history.mean) / history.mean;
    return {
      score: round2(deviation),
      fires: Math.abs(deviation) > ANOMALY_THRESHOLDS.FLAT_HISTORY_DEVIATION,
    };
  }

  const z = (observed - history.mean) / history.stdDev;
  return { score: round2(z), fires: Math.abs(z) > ANOMALY_THRESHOLDS.Z_SCORE };
}

function direction(observed: number, mean: number): string {
  return observed > mean ? "above" : "below";
}

// ---------------------------------------------------------------------------
// Purchase-order-time signals
// ---------------------------------------------------------------------------

export interface PurchaseOrderAnomalyLine {
  productId: string;
  productName: string;
  unitPricePaise: number;
  /** What this supplier has historically charged per unit for this product. */
  priorUnitPricesPaise: number[];
}

export interface PurchaseOrderAnomalyInput {
  purchaseOrderId: string;
  supplierName: string;
  currency: string;
  totalPaise: number;
  /** Purchase orders previously placed with this supplier, this one excluded. */
  priorOrderCount: number;
  productName: string;
  quantity: number;
  /** Quantities previously ordered of this product across the organization. */
  priorQuantities: number[];
  lines: PurchaseOrderAnomalyLine[];
  /** Delivery days the supplier quoted on the catalog entry that was bought. */
  quotedDeliveryDays: number;
  /** The supplier's measured mean lead time, or null before its first delivery. */
  measuredLeadTimeDays: number | null;
  deliveriesObserved: number;
  reliabilityScore: number;
  /** The supplier's seeded score, the yardstick degradation is measured against. */
  baselineReliability: number | null;
  supplierId: string;
}

/**
 * Signals worth raising the moment a purchase order exists — early enough that
 * a buyer sees them before the goods ship, which is the only point at which
 * acting on them is cheap.
 */
export function detectPurchaseOrderAnomalies(input: PurchaseOrderAnomalyInput): AnomalySignal[] {
  const signals: AnomalySignal[] = [];

  const price = priceOutlier(input);
  if (price) {
    signals.push(price);
  }

  const newSupplier = newSupplierHighValue(input);
  if (newSupplier) {
    signals.push(newSupplier);
  }

  const quantity = quantityOutlier(input);
  if (quantity) {
    signals.push(quantity);
  }

  const late = predictedLateDelivery(input);
  if (late) {
    signals.push(late);
  }

  const degraded = supplierDegradation(input);
  if (degraded) {
    signals.push(degraded);
  }

  return signals;
}

/**
 * A large first order with a supplier nobody has bought from before. Not
 * suspicious on its own — every supplier has a first order — but it is the
 * shape invoice fraud takes, and it is the cheapest moment to glance at.
 */
function newSupplierHighValue(input: PurchaseOrderAnomalyInput): AnomalySignal | null {
  if (input.priorOrderCount > 0 || input.totalPaise < ANOMALY_THRESHOLDS.NEW_SUPPLIER_VALUE_PAISE) {
    return null;
  }

  return {
    signalType: AnomalySignalType.NEW_SUPPLIER_HIGH_VALUE,
    severity: Severity.WARNING,
    entityType: "PurchaseOrder",
    entityId: input.purchaseOrderId,
    score: round2(input.totalPaise / ANOMALY_THRESHOLDS.NEW_SUPPLIER_VALUE_PAISE),
    observed: formatMoney(input.totalPaise, input.currency),
    baseline: `first order with ${input.supplierName}`,
    explanation:
      `${formatMoney(input.totalPaise, input.currency)} is the first purchase order ever placed ` +
      `with ${input.supplierName}, and is above the ` +
      `${formatMoney(ANOMALY_THRESHOLDS.NEW_SUPPLIER_VALUE_PAISE, input.currency)} first-order review threshold.`,
    metadata: { supplierId: input.supplierId, totalPaise: input.totalPaise },
  };
}

/** An order far larger or smaller than this organization has ever placed for the product. */
function quantityOutlier(input: PurchaseOrderAnomalyInput): AnomalySignal | null {
  const history = describe(input.priorQuantities);
  const verdict = assess(input.quantity, history);

  if (!verdict?.fires) {
    return null;
  }

  return {
    signalType: AnomalySignalType.QUANTITY_OUTLIER,
    severity: Severity.INFO,
    entityType: "PurchaseOrder",
    entityId: input.purchaseOrderId,
    score: verdict.score,
    observed: `${input.quantity} units`,
    baseline: `${round2(history.mean)} units average over ${history.count} prior order(s)`,
    explanation:
      `${input.quantity} units of ${input.productName} is well ${direction(input.quantity, history.mean)} ` +
      `the ${round2(history.mean)}-unit average across ${history.count} prior order(s).`,
    metadata: { quantity: input.quantity, mean: history.mean, stdDev: history.stdDev },
  };
}

/**
 * The predictive signal.
 *
 * The supplier quoted N days and the catalog was ranked on that quote, but
 * their own delivery history says they take longer. Raised at PO time, before
 * the delay happens, which is what makes it a prediction rather than a report.
 */
function predictedLateDelivery(input: PurchaseOrderAnomalyInput): AnomalySignal | null {
  if (
    input.measuredLeadTimeDays === null ||
    input.deliveriesObserved < ANOMALY_THRESHOLDS.MIN_HISTORY ||
    input.quotedDeliveryDays <= 0
  ) {
    return null;
  }

  const overrun =
    (input.measuredLeadTimeDays - input.quotedDeliveryDays) / input.quotedDeliveryDays;

  if (overrun <= ANOMALY_THRESHOLDS.LATE_DELIVERY_RATIO) {
    return null;
  }

  return {
    signalType: AnomalySignalType.PREDICTED_LATE_DELIVERY,
    severity: Severity.WARNING,
    entityType: "PurchaseOrder",
    entityId: input.purchaseOrderId,
    score: round2(overrun),
    observed: `${round2(input.measuredLeadTimeDays)} days measured`,
    baseline: `${input.quotedDeliveryDays} days quoted`,
    explanation:
      `${input.supplierName} quoted ${input.quotedDeliveryDays}-day delivery but has averaged ` +
      `${round2(input.measuredLeadTimeDays)} days across ${input.deliveriesObserved} deliveries. ` +
      `This order is likely to arrive late.`,
    metadata: {
      supplierId: input.supplierId,
      quotedDeliveryDays: input.quotedDeliveryDays,
      measuredLeadTimeDays: input.measuredLeadTimeDays,
    },
  };
}

/** The supplier has fallen materially below the score it was onboarded with. */
function supplierDegradation(input: PurchaseOrderAnomalyInput): AnomalySignal | null {
  if (
    input.baselineReliability === null ||
    input.deliveriesObserved < ANOMALY_THRESHOLDS.MIN_HISTORY
  ) {
    return null;
  }

  const drop = input.baselineReliability - input.reliabilityScore;

  if (drop < ANOMALY_THRESHOLDS.DEGRADATION_DROP) {
    return null;
  }

  return {
    signalType: AnomalySignalType.SUPPLIER_DEGRADATION,
    severity: Severity.INFO,
    // Filed against the supplier, not the order: the order is fine, the
    // relationship is what has changed.
    entityType: "Supplier",
    entityId: input.supplierId,
    score: round2(drop),
    observed: `reliability ${round2(input.reliabilityScore)}`,
    baseline: `reliability ${round2(input.baselineReliability)} at onboarding`,
    explanation:
      `${input.supplierName}'s measured reliability has fallen from ` +
      `${round2(input.baselineReliability)} to ${round2(input.reliabilityScore)} over ` +
      `${input.deliveriesObserved} deliveries.`,
    metadata: { supplierId: input.supplierId, drop: round2(drop) },
  };
}

// ---------------------------------------------------------------------------
// Invoice-time signals
// ---------------------------------------------------------------------------

export interface InvoiceAnomalyInput {
  invoiceId: string;
  supplierName: string;
  currency: string;
  /** Null when the document printed no total — nothing to compare. */
  totalPaise: number | null;
  invoiceNumber: string | null;
  invoiceDate: Date | null;
  /** Other invoices from the same supplier, this one excluded. */
  priorInvoices: PriorInvoiceSummary[];
}

export interface PriorInvoiceSummary {
  id: string;
  invoiceNumber: string | null;
  totalPaise: number | null;
  invoiceDate: Date | null;
}

/**
 * Signals raised after three-way matching has already reached its verdict.
 *
 * Deliberately after: a signal computed before the match could not influence it
 * anyway, and computing it afterwards makes the ordering impossible to get
 * wrong later. This catches what the twelve deterministic checks structurally
 * cannot — they compare an invoice against *its own* purchase order, and this
 * compares it against every other invoice the supplier has sent.
 */
export function detectInvoiceAnomalies(input: InvoiceAnomalyInput): AnomalySignal[] {
  const duplicate = nearDuplicateInvoice(input);
  return duplicate ? [duplicate] : [];
}

/**
 * A unit price far outside what this supplier has historically charged for the
 * same product.
 *
 * This is the gap three-way matching leaves by design: UNIT_PRICE compares the
 * invoice against its own purchase order, and a purchase order built from a
 * quietly inflated catalog price matches itself perfectly at any tolerance.
 * Only the history shows the drift.
 *
 * Evaluated at purchase-order time rather than invoice time, for two reasons.
 * It is the last moment the price can still be challenged for free — once the
 * goods are received the money is effectively committed. And `InvoiceItem`
 * carries no productId (extraction is deliberately never shown the purchase
 * order), so an invoice line can only be tied back to a product through
 * description matching, while a `PurchaseOrderItem` already knows exactly what
 * it bought.
 *
 * One signal per order, naming the worst line — the same collapsing rule
 * summarizeLines uses in threeWayMatch.ts, for the same reason.
 */
function priceOutlier(input: PurchaseOrderAnomalyInput): AnomalySignal | null {
  const candidates = input.lines
    .map((line) => {
      const history = describe(line.priorUnitPricesPaise);
      const verdict = assess(line.unitPricePaise, history);
      return verdict?.fires ? { line, history, verdict } : null;
    })
    .filter((candidate) => candidate !== null);

  if (candidates.length === 0) {
    return null;
  }

  const [worst] = candidates.sort(
    (a, b) =>
      Math.abs(b.verdict.score) - Math.abs(a.verdict.score) ||
      a.line.productName.localeCompare(b.line.productName),
  ) as [(typeof candidates)[number]];

  const price = worst.line.unitPricePaise;
  const mean = Math.round(worst.history.mean);
  const suffix = candidates.length > 1 ? ` (+${candidates.length - 1} more line(s))` : "";

  return {
    signalType: AnomalySignalType.PRICE_OUTLIER,
    severity: Severity.WARNING,
    entityType: "PurchaseOrder",
    entityId: input.purchaseOrderId,
    score: worst.verdict.score,
    observed: `${worst.line.productName}: ${formatMoney(price, input.currency)}${suffix}`,
    baseline: `${formatMoney(mean, input.currency)} average over ${worst.history.count} prior order line(s)`,
    explanation:
      `${input.supplierName} is charging ${formatMoney(price, input.currency)} per unit for ` +
      `${worst.line.productName}, well ${direction(price, worst.history.mean)} the ` +
      `${formatMoney(mean, input.currency)} they have historically charged.`,
    metadata: {
      productId: worst.line.productId,
      unitPricePaise: price,
      meanPaise: mean,
      priorCount: worst.history.count,
    },
  };
}

/**
 * The same amount billed twice under two different invoice numbers.
 *
 * threeWayMatch's DUPLICATE_INVOICE check compares invoice numbers exactly, so
 * a supplier who re-bills the same work under a fresh number passes it. This
 * catches that shape — and stays advisory, because "same supplier, same total,
 * same month" is also what a legitimate recurring order looks like. It is a
 * question for a human, not a verdict.
 */
function nearDuplicateInvoice(input: InvoiceAnomalyInput): AnomalySignal | null {
  if (input.totalPaise === null || input.invoiceDate === null) {
    return null;
  }

  const windowMs = ANOMALY_THRESHOLDS.NEAR_DUPLICATE_WINDOW_DAYS * 86_400_000;
  const invoiceTime = input.invoiceDate.getTime();

  const matches = input.priorInvoices.filter(
    (prior) =>
      prior.totalPaise === input.totalPaise &&
      prior.invoiceNumber !== input.invoiceNumber &&
      prior.invoiceDate !== null &&
      Math.abs(prior.invoiceDate.getTime() - invoiceTime) <= windowMs,
  );

  if (matches.length === 0) {
    return null;
  }

  return {
    signalType: AnomalySignalType.NEAR_DUPLICATE_INVOICE,
    severity: Severity.WARNING,
    entityType: "Invoice",
    entityId: input.invoiceId,
    score: matches.length,
    observed: `${input.invoiceNumber ?? "unnumbered"} for ${formatMoney(input.totalPaise, input.currency)}`,
    baseline: matches
      .map((prior) => `${prior.invoiceNumber ?? "unnumbered"} (${prior.id})`)
      .join(", "),
    explanation:
      `${input.supplierName} has billed ${formatMoney(input.totalPaise, input.currency)} on ` +
      `${matches.length} other invoice(s) within ${ANOMALY_THRESHOLDS.NEAR_DUPLICATE_WINDOW_DAYS} days ` +
      `under a different invoice number.`,
    metadata: { matchedInvoiceIds: matches.map((prior) => prior.id) },
  };
}
