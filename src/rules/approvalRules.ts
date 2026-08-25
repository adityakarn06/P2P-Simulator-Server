import { APPROVAL_THRESHOLDS_PAISE, PO_AUTO_APPROVE_ENABLED } from "../config/constants.js";
import { AppError } from "../utils/AppError.js";

/**
 * Deterministic purchase-order money math and approval decisions. Pure
 * functions, no I/O, no Prisma imports — this module is the financial
 * decision-maker for purchase orders, so it must be exhaustively unit-testable
 * and must never involve Gemini (CLAUDE.md: "Never let an LLM calculate
 * totals.").
 *
 * Every amount is an integer number of minor units (paise). No floating point
 * arithmetic touches money anywhere in this file.
 */

/**
 * Every paise column on PurchaseOrder and PurchaseOrderItem is a Prisma `Int`,
 * i.e. a 32-bit Postgres integer. Anything larger has to be rejected here as a
 * validation error — left to the database it surfaces as an opaque insert
 * failure that the worker would retry three times before giving up.
 */
export const MAX_MONEY_PAISE = 2_147_483_647;

export interface PurchaseOrderLineInput {
  productId: string;
  supplierProductId: string | null;
  description: string;
  quantity: number;
  unitPricePaise: number;
}

export interface PurchaseOrderLine extends PurchaseOrderLineInput {
  lineTotalPaise: number;
}

export interface PurchaseOrderTotals {
  items: PurchaseOrderLine[];
  subtotalPaise: number;
  taxRateBps: number;
  taxPaise: number;
  totalPaise: number;
}

/**
 * Expands lines into their totals. A purchase order with no lines is a bug
 * upstream, never a zero-value PO — it is rejected here rather than persisted.
 */
export function calculatePurchaseOrderTotals(
  lines: PurchaseOrderLineInput[],
  taxRateBps: number,
): PurchaseOrderTotals {
  if (lines.length === 0) {
    throw AppError.validation("A purchase order must have at least one line item");
  }

  // Checked before any line math so a bad rate is rejected the same way whether
  // the lines are worth ₹0 or ₹1 crore. A fractional or negative rate would
  // otherwise silently produce a wrong or negative tax figure.
  if (!Number.isInteger(taxRateBps) || taxRateBps < 0 || taxRateBps > MAX_MONEY_PAISE) {
    throw AppError.validation(
      "Purchase order tax rate must be a non-negative integer number of basis points",
      { taxRateBps },
    );
  }

  const items = lines.map((line) => {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw AppError.validation("Purchase order line quantity must be a positive integer", {
        productId: line.productId,
        quantity: line.quantity,
      });
    }
    if (!Number.isInteger(line.unitPricePaise) || line.unitPricePaise < 0) {
      throw AppError.validation("Purchase order unit price must be a non-negative integer", {
        productId: line.productId,
        unitPricePaise: line.unitPricePaise,
      });
    }
    const lineTotalPaise = line.quantity * line.unitPricePaise;
    assertWithinRange(lineTotalPaise, "Purchase order line total", { productId: line.productId });
    return { ...line, lineTotalPaise };
  });

  const subtotalPaise = items.reduce((sum, item) => sum + item.lineTotalPaise, 0);
  assertWithinRange(subtotalPaise, "Purchase order subtotal");
  const taxPaise = roundTaxPaise(subtotalPaise, taxRateBps);
  assertWithinRange(subtotalPaise + taxPaise, "Purchase order total");

  return {
    items,
    subtotalPaise,
    taxRateBps,
    taxPaise,
    totalPaise: subtotalPaise + taxPaise,
  };
}

/**
 * Shared by src/rules/generatedInvoice.ts as well — every Prisma `Int` paise
 * column across POs and system-generated invoices has the same 32-bit bound.
 */
export function assertWithinRange(
  paise: number,
  label: string,
  details?: Record<string, unknown>,
): void {
  if (paise > MAX_MONEY_PAISE) {
    throw AppError.validation(`${label} exceeds the maximum supported amount`, {
      ...details,
      paise,
      maxPaise: MAX_MONEY_PAISE,
    });
  }
}

/**
 * Basis points, so the divisor is 10,000. Rounded to whole paise exactly
 * once, on the subtotal, rather than per line. Shared with
 * src/rules/generatedInvoice.ts so a generated invoice's tax always agrees
 * with the PO it was generated from — the two are matched against each other
 * in three-way matching.
 */
export function roundTaxPaise(subtotalPaise: number, taxRateBps: number): number {
  return Math.round((subtotalPaise * taxRateBps) / 10_000);
}

export interface ApprovalDecision {
  status: "PENDING_APPROVAL" | "APPROVED";
  reason: string;
}

/**
 * Decides whether a purchase order can skip human approval.
 *
 * For the MVP demo every PO waits for a human, so PO_AUTO_APPROVE_ENABLED is
 * false and this always returns PENDING_APPROVAL. The threshold branch is kept
 * live behind that flag so enabling auto-approval later is a one-constant
 * change rather than a rewrite of the worker.
 */
export function decideApprovalStatus(totalPaise: number): ApprovalDecision {
  if (!PO_AUTO_APPROVE_ENABLED) {
    return {
      status: "PENDING_APPROVAL",
      reason: "Every purchase order requires human approval",
    };
  }

  if (totalPaise < APPROVAL_THRESHOLDS_PAISE.AUTO_APPROVE_BELOW) {
    return {
      status: "APPROVED",
      reason: `Total is below the ${APPROVAL_THRESHOLDS_PAISE.AUTO_APPROVE_BELOW} paise auto-approval threshold`,
    };
  }

  return {
    status: "PENDING_APPROVAL",
    reason: `Total is at or above the ${APPROVAL_THRESHOLDS_PAISE.AUTO_APPROVE_BELOW} paise auto-approval threshold`,
  };
}
