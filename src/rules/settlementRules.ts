import { PaymentKind } from "../generated/prisma/enums.js";
import { assertWithinRange, roundTaxPaise } from "./approvalRules.js";

/**
 * The arithmetic behind partial settlement.
 *
 * Pure — no Prisma, no I/O, no AI (CLAUDE.md rule 7). The payment worker reads
 * the ledger out of the database, asks this module what may be settled, and
 * obeys the answer, so every rupee that moves is decided in one testable place.
 *
 * Two invariants hold everywhere below:
 *
 *   1. An invoice is never settled for more than its own total.
 *   2. A purchase order is never settled for more than the buyer's committed
 *      total, no matter how many invoices are raised against it.
 *
 * The second is what stops a supplier splitting one order into two invoices and
 * being paid twice — the old code enforced it by refusing the second invoice
 * outright, which also made legitimate progressive billing impossible.
 */

export interface SettlementLedger {
  /** Null until OCR has extracted a total; an invoice without one is not payable. */
  invoiceTotalPaise: number | null;
  /** Sum of this invoice's PROCESSING and COMPLETED tranches. */
  invoiceSettledPaise: number;
  purchaseOrderTotalPaise: number;
  /** Sum across every invoice on the purchase order, this one included. */
  purchaseOrderSettledPaise: number;
}

export interface SettlementView {
  invoiceTotalPaise: number | null;
  invoiceSettledPaise: number;
  invoiceOutstandingPaise: number;
  purchaseOrderTotalPaise: number;
  purchaseOrderSettledPaise: number;
  purchaseOrderOutstandingPaise: number;
  /**
   * True when nothing more will ever be paid against this invoice — which is
   * what decides whether it lands on PAID or PARTIALLY_PAID.
   *
   * Two ways to get there, and the second is not obvious. The invoice's own
   * total being settled is the ordinary one. The other is the *purchase order*
   * being settled in full: the order is the buyer's entire commitment, so once
   * it is spent there is no budget left to pay this invoice from, ever. An
   * invoice that billed slightly above the order — three-way matching tolerates
   * 1% on the total — is settled for the order's figure and is then finished,
   * not left permanently short by the rounding.
   */
  fullySettled: boolean;
}

export type SettlementDecision =
  | { settle: true; amountPaise: number; kind: PaymentKind }
  | { settle: false; reason: string };

/** Never negative: a ledger that has somehow overshot reports nothing left, not a credit. */
function outstanding(totalPaise: number, settledPaise: number): number {
  return Math.max(0, totalPaise - settledPaise);
}

/**
 * The shape the API hands to a human deciding what to pay. Derived, never
 * stored — a denormalized "amount settled" column drifts the moment a tranche
 * is written outside the one code path that maintains it.
 */
export function describeSettlement(ledger: SettlementLedger): SettlementView {
  const invoiceOutstandingPaise =
    ledger.invoiceTotalPaise === null
      ? 0
      : outstanding(ledger.invoiceTotalPaise, ledger.invoiceSettledPaise);

  const purchaseOrderOutstandingPaise = outstanding(
    ledger.purchaseOrderTotalPaise,
    ledger.purchaseOrderSettledPaise,
  );

  return {
    invoiceTotalPaise: ledger.invoiceTotalPaise,
    invoiceSettledPaise: ledger.invoiceSettledPaise,
    invoiceOutstandingPaise,
    purchaseOrderTotalPaise: ledger.purchaseOrderTotalPaise,
    purchaseOrderSettledPaise: ledger.purchaseOrderSettledPaise,
    purchaseOrderOutstandingPaise,
    fullySettled:
      (ledger.invoiceTotalPaise !== null && invoiceOutstandingPaise === 0) ||
      purchaseOrderOutstandingPaise === 0,
  };
}

/**
 * Decides how much of `ledger` may be settled now.
 *
 * `requestedAmountPaise` is null for the automatic settlement that follows a
 * clean match — it takes whatever is outstanding. It is a number only when a
 * human resolving an exception named an amount, which is the partial-payment
 * path: "the supplier billed for 100 but 96 arrived, pay for 96".
 *
 * A refusal is a business outcome, not an error. The caller returns normally;
 * retrying would produce the same answer forever.
 */
export function evaluateSettlement(params: {
  ledger: SettlementLedger;
  requestedAmountPaise: number | null;
}): SettlementDecision {
  const { ledger, requestedAmountPaise } = params;
  const view = describeSettlement(ledger);

  if (ledger.invoiceTotalPaise === null || ledger.invoiceTotalPaise <= 0) {
    return { settle: false, reason: "Invoice has no extracted total to settle against" };
  }

  if (view.invoiceOutstandingPaise === 0) {
    return { settle: false, reason: "Invoice is already fully settled" };
  }

  // The purchase order is the buyer's commitment, and it is spent. Whatever
  // this invoice claims, there is no budget left on the order to pay it from —
  // which is what a second invoice for an already-settled order looks like.
  if (view.purchaseOrderOutstandingPaise === 0) {
    return {
      settle: false,
      reason: "The purchase order is already settled in full; nothing is left to pay",
    };
  }

  if (requestedAmountPaise === null) {
    // The purchase order's remaining balance, not the invoice's. The order
    // total is the buyer's own deterministically calculated commitment; the
    // invoice total was transcribed off a document by Gemini and must never be
    // what decides how much money moves (CLAUDE.md rule 12). Matching has
    // already proved the two agree within tolerance, and the invoice still caps
    // every *human-approved* amount below.
    const amountPaise = view.purchaseOrderOutstandingPaise;

    return {
      settle: true,
      amountPaise,
      // FULL means "this cleared what the supplier billed". Paying the order's
      // figure when the invoice asked for slightly more is a PARTIAL
      // settlement, and the difference shows up as the shortfall — which is
      // accurate, and different from the invoice being left unfinished.
      kind: amountPaise >= view.invoiceOutstandingPaise ? PaymentKind.FULL : PaymentKind.PARTIAL,
    };
  }

  if (!Number.isInteger(requestedAmountPaise) || requestedAmountPaise <= 0) {
    return { settle: false, reason: "Approved amount must be a whole, positive number of paise" };
  }

  if (requestedAmountPaise > view.invoiceOutstandingPaise) {
    return {
      settle: false,
      reason:
        `Approved amount (${requestedAmountPaise} paise) exceeds the invoice's outstanding` +
        ` balance (${view.invoiceOutstandingPaise} paise)`,
    };
  }

  if (requestedAmountPaise > view.purchaseOrderOutstandingPaise) {
    return {
      settle: false,
      reason:
        `Approved amount (${requestedAmountPaise} paise) exceeds the purchase order's` +
        ` outstanding balance (${view.purchaseOrderOutstandingPaise} paise)`,
    };
  }

  return {
    settle: true,
    amountPaise: requestedAmountPaise,
    kind:
      requestedAmountPaise === view.invoiceOutstandingPaise
        ? PaymentKind.FULL
        : PaymentKind.PARTIAL,
  };
}

export interface SettlementSuggestionLine {
  /** What the purchase order committed to pay per unit. Never the invoiced price. */
  unitPricePaise: number;
  /** Units that actually arrived undamaged. */
  acceptedQuantity: number;
}

/**
 * "Pay for what actually arrived": accepted units at the *purchase order's*
 * agreed unit price, plus tax at the order's rate.
 *
 * Priced off the PO rather than the invoice deliberately. The invoice is the
 * document under suspicion — if the supplier also inflated the unit price, this
 * suggestion must not inherit that. It is advisory: a human still names the
 * amount they approve, and evaluateSettlement re-checks it against both caps.
 */
export function suggestPartialSettlement(params: {
  lines: SettlementSuggestionLine[];
  taxRateBps: number;
}): number {
  const subtotalPaise = params.lines.reduce(
    (sum, line) => sum + line.unitPricePaise * line.acceptedQuantity,
    0,
  );

  assertWithinRange(subtotalPaise, "Suggested settlement subtotal");

  const totalPaise = subtotalPaise + roundTaxPaise(subtotalPaise, params.taxRateBps);
  assertWithinRange(totalPaise, "Suggested settlement total");

  return totalPaise;
}
