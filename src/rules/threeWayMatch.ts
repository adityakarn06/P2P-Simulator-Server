import { MATCH_TOLERANCES } from "../config/constants.js";
import { ExceptionType, MatchCheckType, MatchStatus, Severity } from "../generated/prisma/enums.js";
import { findBestProduct, type ProductLike } from "./productMatching.js";
import { formatMoney } from "./supplierRanking.js";

/**
 * Deterministic three-way matching. Pure functions, no I/O, no Prisma imports —
 * this module is the financial gate of the whole procure-to-pay flow, so it
 * must be exhaustively unit-testable and must never involve Gemini (CLAUDE.md
 * §9: "Do not use AI here.").
 *
 * The caller loads the purchase order, the goods receipt and the invoice, hands
 * them over as plain objects, and gets back one check per `MatchCheckType` plus
 * an overall MATCHED / MISMATCHED verdict. Persisting the verdict, raising
 * exceptions and blocking payment belong to the matching worker, not here.
 *
 * Every amount is an integer number of minor units (paise). No floating point
 * arithmetic touches money anywhere in this file — the only floats produced are
 * the `variance` ratios, which are reporting values and never feed a decision
 * about how much is owed.
 */

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * A purchase-order line. `sku`, `productName` and `category` come from the
 * catalog product, not the PO row: invoice lines are free text and have to be
 * resolved back to a product by name (see `resolveLines` below).
 */
export interface MatchPurchaseOrderLine {
  productId: string;
  sku: string;
  productName: string;
  category: string;
  description: string;
  quantity: number;
  unitPricePaise: number;
  lineTotalPaise: number;
}

export interface MatchPurchaseOrder {
  poNumber: string;
  supplierName: string;
  currency: string;
  subtotalPaise: number;
  taxPaise: number;
  totalPaise: number;
  items: MatchPurchaseOrderLine[];
}

export interface MatchReceiptLine {
  productId: string;
  orderedQuantity: number;
  receivedQuantity: number;
  /**
   * receivedQuantity - damagedQuantity, as computed by src/rules/receiptRules.ts.
   * This — not `receivedQuantity` — is what the invoice is allowed to bill for:
   * damaged units arrived but the buyer rejected them.
   */
  acceptedQuantity: number;
}

export interface MatchGoodsReceipt {
  items: MatchReceiptLine[];
}

export interface MatchInvoiceLine {
  lineNumber: number;
  description: string;
  quantity: number;
  /** Null when the document did not print the figure — never treated as 0. */
  unitPricePaise: number | null;
  lineTotalPaise: number | null;
}

/**
 * The extracted invoice. Every transcribed field is nullable because Gemini
 * returns null for anything the document does not print (src/zod/invoice.schema.ts),
 * and a missing field can never be treated as agreement.
 */
export interface MatchInvoice {
  id: string;
  invoiceNumber: string | null;
  supplierNameRaw: string | null;
  poNumberRaw: string | null;
  currency: string | null;
  subtotalPaise: number | null;
  taxPaise: number | null;
  totalPaise: number | null;
  items: MatchInvoiceLine[];
}

/**
 * Other invoices already recorded for this organization. The caller queries
 * them — this module does no I/O. `Invoice.invoiceNumber` carries only an index,
 * not a unique constraint, so duplicates are detected here rather than by the
 * database.
 */
export interface PriorInvoice {
  id: string;
  invoiceNumber: string | null;
}

export interface ThreeWayMatchInput {
  purchaseOrder: MatchPurchaseOrder;
  /** Null when the invoice arrived before the goods did. */
  goodsReceipt: MatchGoodsReceipt | null;
  invoice: MatchInvoice;
  priorInvoices: PriorInvoice[];
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/**
 * One row of the `MatchCheck` table.
 *
 * `variance` is a reporting figure, not money:
 *  - money checks carry the signed relative difference (actual - expected) / expected
 *  - quantity checks carry the signed absolute difference in units
 *  - non-numeric checks carry null, as does any comparison against an expected 0
 */
export interface MatchCheckResult {
  checkType: MatchCheckType;
  expected: string;
  actual: string;
  passed: boolean;
  variance: number | null;
  severity: Severity;
}

export interface ThreeWayMatchResult {
  status: MatchStatus;
  /** All twelve check types, in enum order, each exactly once. */
  checks: MatchCheckResult[];
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
}

/**
 * Which exception a failed check should raise.
 *
 * PO_NUMBER and PRODUCT are deliberately absent: no `ExceptionType` describes
 * "this invoice cites the wrong PO" or "this invoice bills for something the PO
 * never ordered", and mislabelling them as a quantity or price mismatch would
 * send a human looking in the wrong place. The worker falls back to
 * SYSTEM_FAILURE for unmapped checks.
 */
export const EXCEPTION_TYPE_BY_CHECK: Partial<Record<MatchCheckType, ExceptionType>> = {
  [MatchCheckType.SUPPLIER]: ExceptionType.SUPPLIER_MISMATCH,
  [MatchCheckType.ORDERED_QUANTITY]: ExceptionType.QUANTITY_MISMATCH,
  [MatchCheckType.RECEIVED_QUANTITY]: ExceptionType.QUANTITY_MISMATCH,
  [MatchCheckType.INVOICED_QUANTITY]: ExceptionType.QUANTITY_MISMATCH,
  [MatchCheckType.UNIT_PRICE]: ExceptionType.PRICE_MISMATCH,
  [MatchCheckType.SUBTOTAL]: ExceptionType.PRICE_MISMATCH,
  [MatchCheckType.TAX]: ExceptionType.TAX_MISMATCH,
  [MatchCheckType.TOTAL]: ExceptionType.TOTAL_MISMATCH,
  [MatchCheckType.CURRENCY]: ExceptionType.TOTAL_MISMATCH,
  [MatchCheckType.DUPLICATE_INVOICE]: ExceptionType.DUPLICATE_INVOICE,
};

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Compares a purchase order, its goods receipt and the supplier's invoice.
 *
 * Emits every check type exactly once — `MatchCheck` is unique on
 * [threeWayMatchId, checkType], so a per-line failure is collapsed into one row
 * naming the worst offender rather than fanned out into several.
 *
 * Any failed check makes the whole match MISMATCHED. Variance is symmetric:
 * an invoice that bills for less than was accepted is as much a mismatch as one
 * that bills for more, because both mean the paperwork disagrees and a human
 * has to say what is owed.
 */
export function threeWayMatch(input: ThreeWayMatchInput): ThreeWayMatchResult {
  const { purchaseOrder, goodsReceipt, invoice, priorInvoices } = input;
  const resolution = resolveLines(purchaseOrder, invoice);

  const checks: MatchCheckResult[] = [
    checkSupplier(purchaseOrder, invoice),
    checkPoNumber(purchaseOrder, invoice),
    checkProduct(resolution),
    checkOrderedQuantity(purchaseOrder, goodsReceipt),
    checkReceivedQuantity(purchaseOrder, goodsReceipt),
    checkInvoicedQuantity(purchaseOrder, goodsReceipt, resolution),
    checkUnitPrice(purchaseOrder, resolution),
    checkSubtotal(purchaseOrder, invoice),
    checkTax(purchaseOrder, invoice),
    checkTotal(purchaseOrder, invoice),
    checkCurrency(purchaseOrder, invoice),
    checkDuplicateInvoice(invoice, priorInvoices),
  ];

  const passedChecks = checks.filter((check) => check.passed).length;

  return {
    status: passedChecks === checks.length ? MatchStatus.MATCHED : MatchStatus.MISMATCHED,
    checks,
    totalChecks: checks.length,
    passedChecks,
    failedChecks: checks.length - passedChecks,
  };
}

// ---------------------------------------------------------------------------
// Line reconciliation
// ---------------------------------------------------------------------------

interface ResolvedProduct {
  line: MatchPurchaseOrderLine;
  invoiceLines: MatchInvoiceLine[];
  invoicedQuantity: number;
}

interface LineResolution {
  /** Keyed by productId; every purchase-order line appears, invoiced or not. */
  byProduct: Map<string, ResolvedProduct>;
  /** Invoice lines whose description matched no purchase-order line, or matched ambiguously. */
  unresolved: MatchInvoiceLine[];
}

/**
 * Links each invoice line back to a purchase-order line.
 *
 * `InvoiceItem.productId` is never populated by extraction — Gemini transcribes
 * the printed description and is deliberately never shown the purchase order —
 * so the description is the only bridge. `findBestProduct` already owns that
 * lookup for requisitions; reusing it keeps one definition of "is this the same
 * product" in the codebase.
 *
 * Two invoice lines resolving to the same product are summed rather than
 * rejected: a supplier splitting one ordered line across two printed rows is
 * normal, and `PurchaseOrderItem` is unique on [purchaseOrderId, productId], so
 * there is exactly one purchase-order line to sum them into.
 */
function resolveLines(purchaseOrder: MatchPurchaseOrder, invoice: MatchInvoice): LineResolution {
  const byProduct = new Map<string, ResolvedProduct>(
    purchaseOrder.items.map((line) => [
      line.productId,
      { line, invoiceLines: [], invoicedQuantity: 0 },
    ]),
  );

  const catalog: ProductLike[] = purchaseOrder.items.map((line) => ({
    id: line.productId,
    sku: line.sku,
    name: line.productName,
    category: line.category,
  }));

  const unresolved: MatchInvoiceLine[] = [];

  for (const invoiceLine of invoice.items) {
    const match = findBestProduct(invoiceLine.description, null, catalog);
    const resolved = match.status === "MATCHED" ? byProduct.get(match.product.id) : undefined;

    if (!resolved) {
      unresolved.push(invoiceLine);
      continue;
    }

    resolved.invoiceLines.push(invoiceLine);
    resolved.invoicedQuantity += invoiceLine.quantity;
  }

  return { byProduct, unresolved };
}

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

/** One line's contribution to a line-scoped check. */
interface LineComparison {
  label: string;
  expected: number;
  actual: number;
  variance: number | null;
  withinTolerance: boolean;
}

/** Variance ratios are reporting values; four decimals is plenty and keeps them stable. */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Absolute comparison, used for quantities. `MATCH_TOLERANCES.QUANTITY` is 0
 * units, so this is equality until somebody deliberately loosens it.
 */
function compareAbsolute(expected: number, actual: number, tolerance: number): LineComparison {
  const delta = actual - expected;
  return {
    label: "",
    expected,
    actual,
    variance: delta,
    withinTolerance: Math.abs(delta) <= tolerance,
  };
}

/**
 * Relative comparison, used for money. An expected 0 has no meaningful ratio, so
 * it falls back to equality and reports no variance rather than Infinity or NaN.
 */
function compareRelative(expected: number, actual: number, tolerance: number): LineComparison {
  if (expected === 0) {
    return { label: "", expected, actual, variance: null, withinTolerance: actual === 0 };
  }

  // The tolerance test uses the exact ratio; only the *reported* variance is
  // rounded. Rounding first would silently widen every money tolerance by up to
  // half of round4's precision — a 2.0049% overcharge would report as 2.00% and
  // pass a 2% tolerance.
  const ratio = (actual - expected) / expected;
  return {
    label: "",
    expected,
    actual,
    variance: round4(ratio),
    withinTolerance: Math.abs(ratio) <= tolerance,
  };
}

/**
 * Collapses per-line comparisons into the single row the schema allows.
 *
 * When every line agrees the check reports the totals, which is what a reviewer
 * wants to see on a passing match. When lines disagree it reports the worst
 * offender by name, because "₹1,820 expected, ₹2,100 charged on Wireless
 * Keyboard" is actionable and a summed total is not.
 */
function summarizeLines(
  checkType: MatchCheckType,
  comparisons: LineComparison[],
  format: (value: number) => string,
): MatchCheckResult {
  if (comparisons.length === 0) {
    return {
      checkType,
      expected: "nothing to compare",
      actual: "nothing to compare",
      passed: true,
      variance: null,
      severity: Severity.INFO,
    };
  }

  const failures = comparisons.filter((comparison) => !comparison.withinTolerance);

  if (failures.length === 0) {
    const expected = comparisons.reduce((sum, comparison) => sum + comparison.expected, 0);
    const actual = comparisons.reduce((sum, comparison) => sum + comparison.actual, 0);
    return {
      checkType,
      expected: format(expected),
      actual: format(actual),
      passed: true,
      variance: null,
      severity: Severity.INFO,
    };
  }

  // Sorted by magnitude, then by label, so the same inputs always name the same
  // offending line.
  const [worst] = failures.sort((a, b) => {
    const byMagnitude = Math.abs(b.variance ?? 0) - Math.abs(a.variance ?? 0);
    return byMagnitude !== 0 ? byMagnitude : a.label.localeCompare(b.label);
  }) as [LineComparison];

  const suffix = failures.length > 1 ? ` (+${failures.length - 1} more lines)` : "";

  return {
    checkType,
    expected: `${worst.label}: ${format(worst.expected)}`,
    actual: `${worst.label}: ${format(worst.actual)}${suffix}`,
    passed: false,
    variance: worst.variance,
    severity: Severity.CRITICAL,
  };
}

/** Single-value comparison for the invoice-level money fields. */
function scalarMoneyCheck(params: {
  checkType: MatchCheckType;
  expectedPaise: number;
  actualPaise: number | null;
  tolerance: number;
  currency: string;
}): MatchCheckResult {
  const { checkType, expectedPaise, actualPaise, tolerance, currency } = params;
  const expected = formatMoney(expectedPaise, currency);

  if (actualPaise === null) {
    return missing(checkType, expected);
  }

  const comparison = compareRelative(expectedPaise, actualPaise, tolerance);

  return {
    checkType,
    expected,
    actual: formatMoney(actualPaise, currency),
    passed: comparison.withinTolerance,
    variance: comparison.variance,
    severity: comparison.withinTolerance ? Severity.INFO : Severity.CRITICAL,
  };
}

/**
 * The document did not print the value at all. Never a pass: an absent figure is
 * not agreement, and the invoice cannot be paid on a field nobody can read.
 */
function missing(checkType: MatchCheckType, expected: string): MatchCheckResult {
  return {
    checkType,
    expected,
    actual: "missing",
    passed: false,
    variance: null,
    severity: Severity.CRITICAL,
  };
}

/**
 * Punctuation- and case-insensitive comparison, so "PO-20260824-ABC123" matches
 * "po 20260824 abc123" and "TechSource Distributors." matches the catalog name.
 * Mirrors `normalizeSku` in src/rules/productMatching.ts.
 */
function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function checkSupplier(purchaseOrder: MatchPurchaseOrder, invoice: MatchInvoice): MatchCheckResult {
  if (invoice.supplierNameRaw === null) {
    return missing(MatchCheckType.SUPPLIER, purchaseOrder.supplierName);
  }

  const passed = normalize(invoice.supplierNameRaw) === normalize(purchaseOrder.supplierName);

  return {
    checkType: MatchCheckType.SUPPLIER,
    expected: purchaseOrder.supplierName,
    actual: invoice.supplierNameRaw,
    passed,
    variance: null,
    severity: passed ? Severity.INFO : Severity.CRITICAL,
  };
}

function checkPoNumber(purchaseOrder: MatchPurchaseOrder, invoice: MatchInvoice): MatchCheckResult {
  if (invoice.poNumberRaw === null) {
    return missing(MatchCheckType.PO_NUMBER, purchaseOrder.poNumber);
  }

  const passed = normalize(invoice.poNumberRaw) === normalize(purchaseOrder.poNumber);

  return {
    checkType: MatchCheckType.PO_NUMBER,
    expected: purchaseOrder.poNumber,
    actual: invoice.poNumberRaw,
    passed,
    variance: null,
    severity: passed ? Severity.INFO : Severity.CRITICAL,
  };
}

/**
 * Both directions matter. An invoice line nobody ordered is an overcharge; an
 * ordered product the invoice never mentions means the paperwork is incomplete
 * and the quantity checks below are comparing against a phantom zero.
 */
function checkProduct(resolution: LineResolution): MatchCheckResult {
  const ordered = [...resolution.byProduct.values()];
  const uninvoiced = ordered.filter((entry) => entry.invoiceLines.length === 0);
  const passed = resolution.unresolved.length === 0 && uninvoiced.length === 0;

  const problems = [
    ...uninvoiced.map((entry) => `${entry.line.productName} not invoiced`),
    ...resolution.unresolved.map(
      (line) => `line ${line.lineNumber} "${line.description}" not on the purchase order`,
    ),
  ];

  return {
    checkType: MatchCheckType.PRODUCT,
    expected: ordered.map((entry) => entry.line.productName).join(", ") || "no ordered products",
    actual: passed
      ? ordered.map((entry) => entry.line.productName).join(", ")
      : problems.join("; "),
    passed,
    variance: null,
    severity: passed ? Severity.INFO : Severity.CRITICAL,
  };
}

/**
 * Purchase order against the receipt's own record of what was ordered. This is a
 * consistency check on the receipt, not a delivery check — a receipt booked
 * against the wrong quantities makes every downstream comparison meaningless.
 */
function checkOrderedQuantity(
  purchaseOrder: MatchPurchaseOrder,
  goodsReceipt: MatchGoodsReceipt | null,
): MatchCheckResult {
  if (goodsReceipt === null) {
    // RECEIVED_QUANTITY already fails on the missing receipt; failing twice for
    // the same cause would raise two exceptions for one problem.
    return {
      checkType: MatchCheckType.ORDERED_QUANTITY,
      expected: String(totalOrdered(purchaseOrder)),
      actual: "no goods receipt",
      passed: true,
      variance: null,
      severity: Severity.INFO,
    };
  }

  const receiptByProduct = indexReceipt(goodsReceipt);

  const comparisons = purchaseOrder.items.map((line) => ({
    ...compareAbsolute(
      line.quantity,
      receiptByProduct.get(line.productId)?.orderedQuantity ?? 0,
      MATCH_TOLERANCES.QUANTITY,
    ),
    label: line.productName,
  }));

  return summarizeLines(MatchCheckType.ORDERED_QUANTITY, comparisons, String);
}

/** Did everything that was ordered actually arrive undamaged? */
function checkReceivedQuantity(
  purchaseOrder: MatchPurchaseOrder,
  goodsReceipt: MatchGoodsReceipt | null,
): MatchCheckResult {
  if (goodsReceipt === null) {
    return {
      checkType: MatchCheckType.RECEIVED_QUANTITY,
      expected: String(totalOrdered(purchaseOrder)),
      actual: "none",
      passed: false,
      variance: null,
      severity: Severity.CRITICAL,
    };
  }

  const receiptByProduct = indexReceipt(goodsReceipt);

  const comparisons = purchaseOrder.items.map((line) => ({
    ...compareAbsolute(
      line.quantity,
      receiptByProduct.get(line.productId)?.acceptedQuantity ?? 0,
      MATCH_TOLERANCES.QUANTITY,
    ),
    label: line.productName,
  }));

  return summarizeLines(MatchCheckType.RECEIVED_QUANTITY, comparisons, String);
}

/**
 * The rule the whole engine exists for: the invoice may only bill for units the
 * buyer actually accepted. The demo case — ordered 100, received 98, damaged 2,
 * invoiced 100 — fails here against the 96 accepted.
 *
 * With no receipt to compare against, this falls back to the ordered quantity so
 * an over-billing invoice is still caught; the missing delivery itself is
 * reported by RECEIVED_QUANTITY.
 */
function checkInvoicedQuantity(
  purchaseOrder: MatchPurchaseOrder,
  goodsReceipt: MatchGoodsReceipt | null,
  resolution: LineResolution,
): MatchCheckResult {
  const receiptByProduct = goodsReceipt === null ? null : indexReceipt(goodsReceipt);

  const comparisons = purchaseOrder.items.map((line) => {
    const accepted =
      receiptByProduct === null
        ? line.quantity
        : (receiptByProduct.get(line.productId)?.acceptedQuantity ?? 0);

    return {
      ...compareAbsolute(
        accepted,
        resolution.byProduct.get(line.productId)?.invoicedQuantity ?? 0,
        MATCH_TOLERANCES.QUANTITY,
      ),
      label: line.productName,
    };
  });

  return summarizeLines(MatchCheckType.INVOICED_QUANTITY, comparisons, String);
}

/**
 * Per-line unit price against the price the purchase order locked in.
 *
 * Compared per invoice line rather than per product: a supplier who splits a
 * line and quietly raises the price on the second half would otherwise be
 * averaged back inside tolerance.
 */
function checkUnitPrice(
  purchaseOrder: MatchPurchaseOrder,
  resolution: LineResolution,
): MatchCheckResult {
  const comparisons: LineComparison[] = [];

  for (const entry of resolution.byProduct.values()) {
    for (const invoiceLine of entry.invoiceLines) {
      if (invoiceLine.unitPricePaise === null) {
        // The line printed no price. That is not agreement at any tolerance, so
        // it fails outright rather than being compared against a stand-in zero.
        comparisons.push({
          label: entry.line.productName,
          expected: entry.line.unitPricePaise,
          actual: 0,
          variance: null,
          withinTolerance: false,
        });
        continue;
      }

      comparisons.push({
        ...compareRelative(
          entry.line.unitPricePaise,
          invoiceLine.unitPricePaise,
          MATCH_TOLERANCES.PRICE_PERCENTAGE,
        ),
        label: entry.line.productName,
      });
    }
  }

  return summarizeLines(MatchCheckType.UNIT_PRICE, comparisons, (paise) =>
    formatMoney(paise, purchaseOrder.currency),
  );
}

function checkSubtotal(purchaseOrder: MatchPurchaseOrder, invoice: MatchInvoice): MatchCheckResult {
  return scalarMoneyCheck({
    checkType: MatchCheckType.SUBTOTAL,
    expectedPaise: purchaseOrder.subtotalPaise,
    actualPaise: invoice.subtotalPaise,
    tolerance: MATCH_TOLERANCES.PRICE_PERCENTAGE,
    currency: purchaseOrder.currency,
  });
}

function checkTax(purchaseOrder: MatchPurchaseOrder, invoice: MatchInvoice): MatchCheckResult {
  return scalarMoneyCheck({
    checkType: MatchCheckType.TAX,
    expectedPaise: purchaseOrder.taxPaise,
    actualPaise: invoice.taxPaise,
    tolerance: MATCH_TOLERANCES.TAX_PERCENTAGE,
    currency: purchaseOrder.currency,
  });
}

function checkTotal(purchaseOrder: MatchPurchaseOrder, invoice: MatchInvoice): MatchCheckResult {
  return scalarMoneyCheck({
    checkType: MatchCheckType.TOTAL,
    expectedPaise: purchaseOrder.totalPaise,
    actualPaise: invoice.totalPaise,
    tolerance: MATCH_TOLERANCES.TOTAL_PERCENTAGE,
    currency: purchaseOrder.currency,
  });
}

/**
 * Currencies are compared as codes, never converted. Paying an INR purchase
 * order against a USD invoice is a business decision, not an arithmetic one.
 */
function checkCurrency(purchaseOrder: MatchPurchaseOrder, invoice: MatchInvoice): MatchCheckResult {
  if (invoice.currency === null) {
    return missing(MatchCheckType.CURRENCY, purchaseOrder.currency);
  }

  const passed = invoice.currency.toUpperCase() === purchaseOrder.currency.toUpperCase();

  return {
    checkType: MatchCheckType.CURRENCY,
    expected: purchaseOrder.currency,
    actual: invoice.currency,
    passed,
    variance: null,
    severity: passed ? Severity.INFO : Severity.CRITICAL,
  };
}

/**
 * An invoice number already seen in this organization means the supplier has
 * billed twice for the same work.
 *
 * The invoice being matched is excluded by id, so re-running a match on the same
 * invoice never flags itself. An invoice with no number at all fails: it cannot
 * be deduplicated, and an unnumbered document is not something to pay on trust.
 */
function checkDuplicateInvoice(
  invoice: MatchInvoice,
  priorInvoices: PriorInvoice[],
): MatchCheckResult {
  if (invoice.invoiceNumber === null) {
    return missing(MatchCheckType.DUPLICATE_INVOICE, "a unique invoice number");
  }

  const normalized = normalize(invoice.invoiceNumber);
  const duplicates = priorInvoices.filter(
    (prior) =>
      prior.id !== invoice.id &&
      prior.invoiceNumber !== null &&
      normalize(prior.invoiceNumber) === normalized,
  );

  return {
    checkType: MatchCheckType.DUPLICATE_INVOICE,
    expected: `${invoice.invoiceNumber} seen once`,
    actual:
      duplicates.length === 0
        ? `${invoice.invoiceNumber} seen once`
        : `${invoice.invoiceNumber} already billed on ${duplicates.map((prior) => prior.id).join(", ")}`,
    passed: duplicates.length === 0,
    variance: null,
    severity: duplicates.length === 0 ? Severity.INFO : Severity.CRITICAL,
  };
}

// ---------------------------------------------------------------------------
// Small shared lookups
// ---------------------------------------------------------------------------

function indexReceipt(goodsReceipt: MatchGoodsReceipt): Map<string, MatchReceiptLine> {
  return new Map(goodsReceipt.items.map((line) => [line.productId, line]));
}

function totalOrdered(purchaseOrder: MatchPurchaseOrder): number {
  return purchaseOrder.items.reduce((sum, line) => sum + line.quantity, 0);
}
