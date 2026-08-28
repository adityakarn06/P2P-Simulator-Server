import { describe, expect, it } from "vitest";
import { InvoiceStatus, MatchStatus, PaymentStatus } from "../src/generated/prisma/enums.js";
import { evaluatePayment, isOverriddenPayment } from "../src/rules/paymentRules.js";

/**
 * The payment gate is the only place that decides whether money moves, so every
 * refusal reason gets a case here.
 */

const PAYABLE = {
  invoiceStatus: InvoiceStatus.APPROVED,
  matchStatus: MatchStatus.MATCHED,
  paymentStatus: null,
  openExceptionCount: 0,
  purchaseOrderAlreadySettled: false,
} as const;

describe("evaluatePayment", () => {
  it("pays an approved invoice with a passing match and no payment yet", () => {
    expect(evaluatePayment(PAYABLE)).toEqual({ payable: true });
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
      purchaseOrderAlreadySettled: false,
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

    expect(decision).toEqual({ payable: true });
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

    expect(decision).toEqual({ payable: true });
  });

  it("refuses a BLOCKED payment while the invoice is still in EXCEPTION", () => {
    const decision = evaluatePayment({
      invoiceStatus: InvoiceStatus.EXCEPTION,
      matchStatus: MatchStatus.MATCHED,
      paymentStatus: PaymentStatus.BLOCKED,
      openExceptionCount: 1,
      purchaseOrderAlreadySettled: false,
    });

    expect(decision).toEqual({ payable: false, reason: "Invoice is EXCEPTION, not APPROVED" });
  });

  it.each([PaymentStatus.PENDING, PaymentStatus.PROCESSING, PaymentStatus.FAILED])(
    "pays a %s payment — an interrupted or retryable attempt",
    (paymentStatus) => {
      expect(evaluatePayment({ ...PAYABLE, paymentStatus })).toEqual({ payable: true });
    },
  );
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
