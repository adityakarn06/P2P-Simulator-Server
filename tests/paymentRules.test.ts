import { describe, expect, it } from "vitest";
import {
  InvoiceStatus,
  MatchStatus,
  PaymentKind,
  PaymentStatus,
} from "../src/generated/prisma/enums.js";
import { evaluatePayment, isOverBilling, isOverriddenPayment } from "../src/rules/paymentRules.js";
import type { SettlementLedger } from "../src/rules/settlementRules.js";

/**
 * The payment gate is the only place that decides whether money moves, so every
 * refusal reason gets a case here.
 */

/** Nothing settled yet against a ₹1,000 invoice on a ₹1,000 order. */
const FRESH: SettlementLedger = {
  invoiceTotalPaise: 100_000,
  invoiceSettledPaise: 0,
  purchaseOrderTotalPaise: 100_000,
  purchaseOrderSettledPaise: 0,
};

const PAYABLE = {
  invoiceStatus: InvoiceStatus.APPROVED,
  matchStatus: MatchStatus.MATCHED,
  paymentStatus: null,
  openExceptionCount: 0,
  ledger: FRESH,
  requestedAmountPaise: null,
} as const;

/** The full settlement PAYABLE resolves to, so the assertions stay readable. */
const PAID_IN_FULL = { payable: true, amountPaise: 100_000, kind: PaymentKind.FULL };

describe("evaluatePayment", () => {
  it("pays an approved invoice with a passing match and no payment yet", () => {
    expect(evaluatePayment(PAYABLE)).toEqual(PAID_IN_FULL);
  });

  it("refuses an invoice that is already PAID", () => {
    const decision = evaluatePayment({
      ...PAYABLE,
      invoiceStatus: InvoiceStatus.PAID,
      paymentStatus: PaymentStatus.COMPLETED,
    });

    expect(decision).toEqual({ payable: false, reason: "Invoice is already paid" });
  });

  it("refuses an invoice sitting in EXCEPTION", () => {
    const decision = evaluatePayment({
      invoiceStatus: InvoiceStatus.EXCEPTION,
      matchStatus: MatchStatus.MISMATCHED,
      paymentStatus: PaymentStatus.BLOCKED,
      openExceptionCount: 1,
      ledger: FRESH,
      requestedAmountPaise: null,
    });

    expect(decision.payable).toBe(false);
  });

  it.each([
    InvoiceStatus.UPLOADED,
    InvoiceStatus.EXTRACTED,
    InvoiceStatus.MATCHING,
    InvoiceStatus.FAILED,
  ])("refuses an invoice that is %s", (invoiceStatus) => {
    expect(evaluatePayment({ ...PAYABLE, invoiceStatus }).payable).toBe(false);
  });

  it("refuses an invoice that has never been matched", () => {
    const decision = evaluatePayment({ ...PAYABLE, matchStatus: null });

    expect(decision).toEqual({
      payable: false,
      reason: "Invoice has not been three-way matched",
    });
  });

  it("refuses a mismatched invoice while its exception is still open", () => {
    const decision = evaluatePayment({
      ...PAYABLE,
      matchStatus: MatchStatus.MISMATCHED,
      openExceptionCount: 1,
    });

    expect(decision).toEqual({
      payable: false,
      reason: "Invoice has 1 unresolved exception(s)",
    });
  });

  // The human override: the match still says MISMATCHED — that is what the
  // documents say — but a person signed off the discrepancy, which closed the
  // exception and moved the invoice to APPROVED.
  it("pays a mismatched invoice once a human has closed every exception", () => {
    const decision = evaluatePayment({
      ...PAYABLE,
      matchStatus: MatchStatus.MISMATCHED,
      paymentStatus: PaymentStatus.BLOCKED,
    });

    expect(decision).toEqual(PAID_IN_FULL);
  });

  it("refuses while any exception on the invoice remains open", () => {
    const decision = evaluatePayment({ ...PAYABLE, openExceptionCount: 2 });

    expect(decision).toEqual({
      payable: false,
      reason: "Invoice has 2 unresolved exception(s)",
    });
  });

  it("refuses a payment that has already completed", () => {
    const decision = evaluatePayment({ ...PAYABLE, paymentStatus: PaymentStatus.COMPLETED });

    expect(decision).toEqual({ payable: false, reason: "Payment has already completed" });
  });

  // The one nuanced rule: a BLOCKED row records that something once went wrong.
  // Approved + matched is the state a human can only have produced by resolving
  // the exception, so it is payable again.
  it("pays a BLOCKED payment once the invoice is approved and nothing is open", () => {
    const decision = evaluatePayment({ ...PAYABLE, paymentStatus: PaymentStatus.BLOCKED });

    expect(decision).toEqual(PAID_IN_FULL);
  });

  it("refuses a BLOCKED payment while the invoice is still in EXCEPTION", () => {
    const decision = evaluatePayment({
      invoiceStatus: InvoiceStatus.EXCEPTION,
      matchStatus: MatchStatus.MATCHED,
      paymentStatus: PaymentStatus.BLOCKED,
      openExceptionCount: 1,
      ledger: FRESH,
      requestedAmountPaise: null,
    });

    expect(decision).toEqual({ payable: false, reason: "Invoice is EXCEPTION, not APPROVED" });
  });

  it.each([PaymentStatus.PENDING, PaymentStatus.PROCESSING, PaymentStatus.FAILED])(
    "pays a %s payment — an interrupted or retryable attempt",
    (paymentStatus) => {
      expect(evaluatePayment({ ...PAYABLE, paymentStatus })).toEqual(PAID_IN_FULL);
    },
  );
});

describe("evaluatePayment — settlement ledger", () => {
  it("pays only what the invoice still owes after an earlier tranche", () => {
    const decision = evaluatePayment({
      ...PAYABLE,
      invoiceStatus: InvoiceStatus.PARTIALLY_PAID,
      ledger: { ...FRESH, invoiceSettledPaise: 60_000, purchaseOrderSettledPaise: 60_000 },
    });

    expect(decision).toEqual({ payable: true, amountPaise: 40_000, kind: PaymentKind.FULL });
  });

  it("caps an automatic settlement at the purchase order's remaining budget", () => {
    // A second invoice for the full amount against an order that is 70% spent:
    // the order, not the invoice, decides what is left.
    const decision = evaluatePayment({
      ...PAYABLE,
      ledger: { ...FRESH, purchaseOrderSettledPaise: 70_000 },
    });

    expect(decision).toEqual({ payable: true, amountPaise: 30_000, kind: PaymentKind.PARTIAL });
  });

  it("refuses a second invoice once the purchase order is fully settled", () => {
    const decision = evaluatePayment({
      ...PAYABLE,
      ledger: { ...FRESH, purchaseOrderSettledPaise: 100_000 },
    });

    expect(decision).toEqual({
      payable: false,
      reason: "The purchase order is already settled in full; nothing is left to pay",
    });
  });

  it("refuses an invoice whose total was never extracted", () => {
    const decision = evaluatePayment({ ...PAYABLE, ledger: { ...FRESH, invoiceTotalPaise: null } });

    expect(decision).toEqual({
      payable: false,
      reason: "Invoice has no extracted total to settle against",
    });
  });

  it("settles the amount a human approved, marked PARTIAL", () => {
    const decision = evaluatePayment({
      ...PAYABLE,
      matchStatus: MatchStatus.MISMATCHED,
      requestedAmountPaise: 96_000,
    });

    expect(decision).toEqual({ payable: true, amountPaise: 96_000, kind: PaymentKind.PARTIAL });
  });

  it("refuses an approved amount larger than the invoice", () => {
    const decision = evaluatePayment({ ...PAYABLE, requestedAmountPaise: 120_000 });

    expect(decision.payable).toBe(false);
  });
});

describe("isOverBilling", () => {
  it("is true only when the purchase order has no budget left", () => {
    expect(isOverBilling({ ...FRESH, purchaseOrderSettledPaise: 100_000 })).toBe(true);
    expect(isOverBilling({ ...FRESH, purchaseOrderSettledPaise: 99_999 })).toBe(false);
  });
});

describe("isOverriddenPayment", () => {
  it("flags a settlement that overrode a failed match", () => {
    expect(isOverriddenPayment(MatchStatus.MISMATCHED)).toBe(true);
  });

  it("does not flag an ordinary clean payment", () => {
    expect(isOverriddenPayment(MatchStatus.MATCHED)).toBe(false);
    expect(isOverriddenPayment(null)).toBe(false);
  });
});
