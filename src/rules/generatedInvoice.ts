import { AppError } from "../utils/AppError.js";
import { assertWithinRange, MAX_MONEY_PAISE, roundTaxPaise } from "./approvalRules.js";

/**
 * Deterministic money math for a system-generated (PDFKit) invoice, mirroring
 * calculatePurchaseOrderTotals in src/rules/approvalRules.ts. Pure functions,
 * no I/O — CLAUDE.md: "Never let an LLM calculate totals," and nothing here is
 * an LLM either. Every amount is an integer number of paise.
 *
 * Shares assertWithinRange and roundTaxPaise with approvalRules.ts so a
 * generated invoice's totals can never drift from the PO they're built from
 * (they're matched against each other in three-way matching).
 */

export interface PurchaseOrderLineForInvoice {
  purchaseOrderItemId: string;
  productId: string;
  description: string;
  quantity: number;
  unitPricePaise: number;
}

export interface GeneratedInvoiceLine {
  purchaseOrderItemId: string;
  productId: string;
  description: string;
  quantity: number;
  unitPricePaise: number;
  lineTotalPaise: number;
}

export interface GeneratedInvoiceLineOverride {
  purchaseOrderItemId: string;
  quantity: number;
}

/** Deterministic invoice number derived from the PO number, so a repeat generation reproduces it. */
export function buildGeneratedInvoiceNumber(poNumber: string): string {
  return `INV-${poNumber.replace(/^PO-/, "")}`;
}

/**
 * Builds invoice lines from the purchase order's items.
 *
 * Defaults every line's quantity to what was ordered. An optional override
 * (keyed by purchaseOrderItemId) lets the caller bill a different quantity —
 * e.g. only what was actually received, or a deliberately wrong amount to
 * demo the QUANTITY_MISMATCH path. Unit prices always come from the PO; the
 * AI never touches this, and neither does the caller.
 */
export function buildGeneratedInvoiceLines(
  poLines: PurchaseOrderLineForInvoice[],
  overrides?: GeneratedInvoiceLineOverride[],
): GeneratedInvoiceLine[] {
  if (poLines.length === 0) {
    throw AppError.validation("Purchase order has no line items to invoice");
  }

  const overrideById = new Map((overrides ?? []).map((o) => [o.purchaseOrderItemId, o]));
  const poLineIds = new Set(poLines.map((line) => line.purchaseOrderItemId));

  if (overrides && overrides.length !== overrideById.size) {
    throw AppError.validation(
      "Invoice line overrides must not repeat the same purchase order line item",
    );
  }

  for (const override of overrides ?? []) {
    if (!poLineIds.has(override.purchaseOrderItemId)) {
      throw AppError.validation("Line item does not belong to this purchase order", {
        purchaseOrderItemId: override.purchaseOrderItemId,
      });
    }
    if (
      !Number.isInteger(override.quantity) ||
      // At least 1, never 0: a zero-quantity line bills nothing and produces a
      // lineTotalPaise of 0 — the exact ₹0 shape approvalRules.ts rejects on a
      // purchase-order line, because compareRelative in threeWayMatch.ts treats
      // an expected 0 as "equality wins" and would pass the check on no money.
      override.quantity < 1 ||
      override.quantity > MAX_MONEY_PAISE
    ) {
      throw AppError.validation("Invoice line quantity must be a positive integer", {
        purchaseOrderItemId: override.purchaseOrderItemId,
        quantity: override.quantity,
        maxQuantity: MAX_MONEY_PAISE,
      });
    }
  }

  return poLines.map((line) => {
    const quantity = overrideById.get(line.purchaseOrderItemId)?.quantity ?? line.quantity;
    const lineTotalPaise = quantity * line.unitPricePaise;
    assertWithinRange(lineTotalPaise, "Generated invoice line total", {
      purchaseOrderItemId: line.purchaseOrderItemId,
    });

    return {
      purchaseOrderItemId: line.purchaseOrderItemId,
      productId: line.productId,
      description: line.description,
      quantity,
      unitPricePaise: line.unitPricePaise,
      lineTotalPaise,
    };
  });
}

export interface GeneratedInvoiceTotals {
  subtotalPaise: number;
  taxPaise: number;
  totalPaise: number;
}

export function computeGeneratedInvoiceTotals(
  lines: GeneratedInvoiceLine[],
  taxRateBps: number,
): GeneratedInvoiceTotals {
  const subtotalPaise = lines.reduce((sum, line) => sum + line.lineTotalPaise, 0);
  assertWithinRange(subtotalPaise, "Generated invoice subtotal");

  const taxPaise = roundTaxPaise(subtotalPaise, taxRateBps);
  assertWithinRange(subtotalPaise + taxPaise, "Generated invoice total");

  return { subtotalPaise, taxPaise, totalPaise: subtotalPaise + taxPaise };
}
