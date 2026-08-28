import {
  InvoiceStatus,
  MatchStatus,
  type PaymentKind,
  PaymentStatus,
} from "../generated/prisma/enums.js";
import { evaluateSettlement, type SettlementLedger } from "./settlementRules.js";

/**
 * The deterministic gate that decides whether an invoice may be settled.
 *
 * Pure — no Prisma, no I/O, no AI (CLAUDE.md rule 7: "Deterministic TypeScript
 * controls financial and business-critical decisions"). The payment worker does
 * nothing but load state, ask this function, and obey the answer, so every
 * reason money does or does not move is visible and unit-testable in one place.
 *
 * A refusal is a *business* outcome, never an error: the caller returns
 * normally rather than throwing, because retrying it would never change it.
 */

export type PaymentDecision =
  | { payable: true; amountPaise: number; kind: PaymentKind }
  | { payable: false; reason: string };

export interface PaymentGateInput {
  invoiceStatus: InvoiceStatus;
  /** Null when the invoice has never been through three-way matching. */
  matchStatus: MatchStatus | null;
  /** Null when no Payment row exists yet for this settlement key. */
  paymentStatus: PaymentStatus | null;
  /** Exceptions still OPEN or UNDER_REVIEW against this invoice. */
  openExceptionCount: number;
  /**
   * What has already been settled against this invoice and against the purchase
   * order it belongs to.
   *
   * This replaces an earlier boolean, "has a sibling invoice already been
   * paid?", which refused a second invoice on an order outright. That was the
   * only thing stopping a supplier from splitting one order across two invoices
   * and being paid twice in full — but it also made legitimate progressive
   * billing impossible, and it meant a short delivery could only ever be paid
   * for the whole order. The cumulative cap does the same job without either
   * limitation: what protects the buyer is the order's remaining balance, not
   * the number of documents raised against it.
   */
  ledger: SettlementLedger;
  /**
   * The amount a human authorized while resolving an exception, or null for the
   * automatic settlement that follows a clean match (which takes whatever is
   * outstanding).
   */
  requestedAmountPaise: number | null;
}

/**
 * Order matters: the checks run from the most authoritative fact outwards, so
 * the reason a caller reports is the most informative one available.
 *
 * Two rules deserve explanation.
 *
 * A MISMATCHED match does not veto payment on its own. Re-running matching over
 * a genuine discrepancy would produce the same verdict forever, so a human
 * cannot clear an exception by re-matching — they clear it by *overriding* it
 * ("the supplier confirmed the short delivery, pay it"). That override is
 * recorded honestly: the ThreeWayMatch keeps saying MISMATCHED, because that is
 * what the paperwork says, and the authorization lives in the resolved
 * Exception and the invoice's own status instead.
 *
 * What actually guards the override is `openExceptionCount` combined with
 * `invoiceStatus`. Matching moves a mismatched invoice to EXCEPTION and opens at
 * least one exception; the only thing in the system that can move it back to
 * APPROVED is resolveExceptionById, which demands a written reason and writes an
 * audit row. So "APPROVED with nothing open" is not a state the workflow can
 * drift into — it is a signed decision.
 */
export function evaluatePayment(input: PaymentGateInput): PaymentDecision {
  const { invoiceStatus, matchStatus, paymentStatus, openExceptionCount } = input;

  if (invoiceStatus === InvoiceStatus.PAID) {
    return { payable: false, reason: "Invoice is already paid" };
  }

  // PARTIALLY_PAID is payable: some of this invoice has already been settled by
  // an earlier tranche and the rest is still owed. It reaches this gate the same
  // way APPROVED does — through a resolved exception or a clean match — so it
  // gets the same scrutiny, and the ledger below decides what is left to pay.
  if (invoiceStatus !== InvoiceStatus.APPROVED && invoiceStatus !== InvoiceStatus.PARTIALLY_PAID) {
    return { payable: false, reason: `Invoice is ${invoiceStatus}, not APPROVED` };
  }

  if (matchStatus === null) {
    return { payable: false, reason: "Invoice has not been three-way matched" };
  }

  // Belt and braces. An approved invoice should never still have an open
  // exception, but if the two ever disagree, the open exception wins.
  if (openExceptionCount > 0) {
    return {
      payable: false,
      reason: `Invoice has ${openExceptionCount} unresolved exception(s)`,
    };
  }

  if (paymentStatus === PaymentStatus.COMPLETED) {
    return { payable: false, reason: "Payment has already completed" };
  }

  // The arithmetic goes last, so a refusal about the invoice's own state is
  // never reported as a balance problem. This is also the only refusal that can
  // be about a document other than this one: a sibling invoice may have spent
  // the purchase order's remaining balance.
  const settlement = evaluateSettlement({
    ledger: input.ledger,
    requestedAmountPaise: input.requestedAmountPaise,
  });

  if (!settlement.settle) {
    return { payable: false, reason: settlement.reason };
  }

  // Reaching here on a MISMATCHED match means a human approved it above.
  // PENDING, PROCESSING (this job's own earlier attempt), FAILED (retryable),
  // BLOCKED (unblocked by that same approval) and null all proceed.
  return { payable: true, amountPaise: settlement.amountPaise, kind: settlement.kind };
}

/**
 * True when the purchase order has no budget left, which is what a duplicate
 * invoice against an already-settled order looks like from the payment gate.
 *
 * Distinguished from every other refusal because it is the one a human has to
 * see: two documents were raised against one order and the second cannot be
 * paid. The worker raises a DUPLICATE_INVOICE exception on it.
 */
export function isOverBilling(ledger: SettlementLedger): boolean {
  return ledger.purchaseOrderSettledPaise >= ledger.purchaseOrderTotalPaise;
}

/** True when settling this invoice overrides a failed match rather than following one. */
export function isOverriddenPayment(matchStatus: MatchStatus | null): boolean {
  return matchStatus === MatchStatus.MISMATCHED;
}
