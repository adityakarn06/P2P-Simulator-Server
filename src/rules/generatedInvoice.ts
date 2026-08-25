import { AppError } from "../utils/AppError.js";
import { MAX_MONEY_PAISE } from "./approvalRules.js";

/**
 * Deterministic money math for a system-generated (PDFKit) invoice, mirroring
 * calculatePurchaseOrderTotals in src/rules/approvalRules.ts. Pure functions,
 * no I/O — CLAUDE.md: "Never let an LLM calculate totals," and nothing here is
 * an LLM either. Every amount is an integer number of paise.
 */

/**
 * Every paise column on Invoice/InvoiceItem is a Prisma `Int` (32-bit Postgres
 * integer), same as PurchaseOrder/PurchaseOrderItem. Mirrors assertWithinRange
 * in src/rules/approvalRules.ts so a large quantity override fails here with a
 * clean 400 rather than as an opaque Postgres integer-overflow error during
 * tx.invoice.create.
 */
function assertWithinRange(paise: number, label: string, details?: Record<string, unknown>): void {
  if (paise > MAX_MONEY_PAISE) {
    throw AppError.validation(`Generated invoice ${label} exceeds the maximum supported amount`, {
      ...details,
      paise,
      maxPaise: MAX_MONEY_PAISE,
    });
  }
}

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

  for (const override of overrides ?? []) {
    if (!poLineIds.has(override.purchaseOrderItemId)) {
      throw AppError.validation("Line item does not belong to this purchase order", {
        purchaseOrderItemId: override.purchaseOrderItemId,
      });
    }
    if (!Number.isInteger(override.quantity) || override.quantity < 0) {
      throw AppError.validation("Invoice line quantity must be a non-negative integer", {
        purchaseOrderItemId: override.purchaseOrderItemId,
        quantity: override.quantity,
      });
    }
  }

  return poLines.map((line) => {
    const quantity = overrideById.get(line.purchaseOrderItemId)?.quantity ?? line.quantity;
    const lineTotalPaise = quantity * line.unitPricePaise;
    assertWithinRange(lineTotalPaise, "line total", {
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

/**
 * Same rounding convention as calculatePurchaseOrderTotals: tax is rounded to
 * whole paise exactly once, on the subtotal, not per line.
 */
export function computeGeneratedInvoiceTotals(
  lines: GeneratedInvoiceLine[],
  taxRateBps: number,
): GeneratedInvoiceTotals {
  const subtotalPaise = lines.reduce((sum, line) => sum + line.lineTotalPaise, 0);
  assertWithinRange(subtotalPaise, "subtotal");

  const taxPaise = Math.round((subtotalPaise * taxRateBps) / 10_000);
  assertWithinRange(subtotalPaise + taxPaise, "total");

  return { subtotalPaise, taxPaise, totalPaise: subtotalPaise + taxPaise };
}
