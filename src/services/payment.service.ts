import { PAYMENT_CLAIM_LEASE_MS } from "../config/constants.js";
import { prisma } from "../config/prisma.js";
import type { Prisma } from "../generated/prisma/client.js";
import {
  ExceptionType,
  InvoiceStatus,
  type PaymentKind,
  PaymentStatus,
  Severity,
} from "../generated/prisma/enums.js";
import { PAYMENT_PROVIDER_NAME } from "../payments/index.js";
import {
  describeSettlement,
  evaluateSettlement,
  type SettlementLedger,
} from "../rules/settlementRules.js";
import { AppError } from "../utils/AppError.js";
import { isUniqueViolation } from "../utils/prismaErrors.js";
import { INVOICE_ENTITY, recordAudit } from "./audit.service.js";
import { recordException } from "./exception.service.js";

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/**
 * The facts the payment gate needs — invoice status, match verdict, the
 * tranches already recorded against this invoice — plus the purchase order that
 * says what was actually committed.
 */
const paymentContextSelect = {
  id: true,
  organizationId: true,
  status: true,
  invoiceNumber: true,
  totalPaise: true,
  threeWayMatch: { select: { status: true } },
  payments: {
    select: { id: true, settlementKey: true, status: true, amountPaise: true, currency: true },
  },
  purchaseOrder: { select: { id: true, poNumber: true, totalPaise: true, currency: true } },
} satisfies Prisma.InvoiceSelect;

export type PaymentContext = Prisma.InvoiceGetPayload<{ select: typeof paymentContextSelect }>;

export async function loadPaymentContext(params: {
  organizationId: string;
  invoiceId: string;
}): Promise<PaymentContext> {
  const invoice = await prisma.invoice.findFirst({
    where: { id: params.invoiceId, organizationId: params.organizationId },
    select: paymentContextSelect,
  });

  if (!invoice) {
    throw AppError.notFound("Invoice not found");
  }

  return invoice;
}

/**
 * Reads what has already been settled, for this invoice and for the whole
 * purchase order it belongs to.
 *
 * PROCESSING counts as settled, not just COMPLETED: a worker is inside the
 * provider call for that tranche right now, and lending its money to a
 * concurrent tranche is exactly the double payment the cap exists to stop.
 *
 * Derived on every read rather than kept in a column on PurchaseOrder. A
 * denormalized total drifts the first time a Payment row is written or voided
 * by anything other than the one code path that maintains it, and a wrong
 * settled-total silently authorizes an overpayment.
 */
export async function loadSettlementLedger(params: {
  organizationId: string;
  invoiceId: string;
  invoiceTotalPaise: number | null;
  purchaseOrderId: string;
  purchaseOrderTotalPaise: number;
}): Promise<SettlementLedger> {
  const settled = { in: [PaymentStatus.PROCESSING, PaymentStatus.COMPLETED] };

  const [invoiceSettled, purchaseOrderSettled] = await Promise.all([
    prisma.payment.aggregate({
      _sum: { amountPaise: true },
      where: {
        organizationId: params.organizationId,
        invoiceId: params.invoiceId,
        status: settled,
      },
    }),
    prisma.payment.aggregate({
      _sum: { amountPaise: true },
      where: {
        organizationId: params.organizationId,
        purchaseOrderId: params.purchaseOrderId,
        status: settled,
      },
    }),
  ]);

  return {
    invoiceTotalPaise: params.invoiceTotalPaise,
    invoiceSettledPaise: invoiceSettled._sum.amountPaise ?? 0,
    purchaseOrderTotalPaise: params.purchaseOrderTotalPaise,
    purchaseOrderSettledPaise: purchaseOrderSettled._sum.amountPaise ?? 0,
  };
}

/**
 * True when a *different* invoice against the same purchase order holds or has
 * completed a payment.
 *
 * Only used to decide whether a refusal deserves a DUPLICATE_INVOICE exception,
 * never to decide payability — the cumulative cap does that. The distinction
 * matters: an order can be spent by this invoice's own tranches, which is an
 * ordinary settled invoice and not a duplicate document. Raising a CRITICAL
 * exception on it would be a false alarm against the very invoice that was
 * correctly paid.
 */
export async function hasSettledSiblingInvoice(params: {
  organizationId: string;
  invoiceId: string;
  purchaseOrderId: string;
}): Promise<boolean> {
  const count = await prisma.payment.count({
    where: {
      organizationId: params.organizationId,
      purchaseOrderId: params.purchaseOrderId,
      invoiceId: { not: params.invoiceId },
      status: { in: [PaymentStatus.PROCESSING, PaymentStatus.COMPLETED] },
    },
  });

  return count > 0;
}

/**
 * Records that this invoice was refused because its purchase order is already
 * settled by another document. Without a row here the refusal is invisible —
 * the job returns normally and nothing tells a human that a second invoice
 * arrived for an order that has already been paid.
 */
export async function recordDuplicatePurchaseOrderPayment(params: {
  organizationId: string;
  invoiceId: string;
  purchaseOrderId: string;
  poNumber: string;
  reason: string;
}): Promise<void> {
  const { organizationId, invoiceId, purchaseOrderId, poNumber, reason } = params;

  await prisma.$transaction(async (tx) => {
    await recordException(tx, {
      organizationId,
      type: ExceptionType.DUPLICATE_INVOICE,
      severity: Severity.CRITICAL,
      entityType: INVOICE_ENTITY,
      entityId: invoiceId,
      title: "Purchase order already paid on another invoice",
      description: reason,
      metadata: { purchaseOrderId, poNumber },
    });

    // BLOCKED, not FAILED: this is a business refusal awaiting a human, not a
    // provider error. Only a row that has not settled may be moved.
    await tx.payment.updateMany({
      where: {
        invoiceId,
        organizationId,
        status: { in: [PaymentStatus.PENDING, PaymentStatus.FAILED] },
      },
      data: { status: PaymentStatus.BLOCKED, blockedReason: reason },
    });
  });
}

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

/**
 * Takes exclusive ownership of one settlement tranche before any money moves.
 *
 * Two steps, because there are two ways a row can already exist. The create is
 * the race winner on a first run: Payment is unique on (invoiceId,
 * settlementKey), so exactly one concurrent job can succeed and the loser falls
 * through to the guarded update, which only claims a row that is not already
 * COMPLETED. Between them, exactly one Payment row and one COMPLETED settlement
 * per tranche are guaranteed.
 *
 * The unique pair used to be `invoiceId` alone. Scoping it to the tranche is
 * what allows an invoice to be settled more than once — a partial payment now,
 * the balance later — without weakening the guard: two attempts at the *same*
 * tranche still collide exactly as before.
 *
 * What is NOT guaranteed is that only one worker reaches the provider. The
 * resume branch below re-claims a PROCESSING row so an interrupted attempt can
 * finish, and it cannot tell "my own crashed attempt" from "another worker is
 * inside charge() right now" — so two concurrent jobs for one tranche can both
 * call the provider. Harmless against SimulatedPaymentProvider, which is pure;
 * a real gateway would need this to become a lease (claim only when processedAt
 * is older than a timeout) plus a provider that honours idempotencyKey.
 *
 * The amount is decided by the caller's payment gate, not by this function, and
 * is re-checked against the ledger inside the transaction below: between the
 * gate's read and this write, a concurrent tranche may have spent the purchase
 * order's remaining balance. Deterministic code decides what is owed; the
 * Gemini-transcribed invoice total only ever caps it (CLAUDE.md rule 12).
 */
export interface SettlementAuthorization {
  exceptionId: string;
  userId: string;
  reason: string;
}

export async function claimPaymentForProcessing(params: {
  organizationId: string;
  invoiceId: string;
  /** Which tranche of the invoice this is. "auto" for the post-match settlement. */
  settlementKey: string;
  purchaseOrder: { id: string; totalPaise: number; currency: string };
  invoiceTotalPaise: number | null;
  amountPaise: number;
  kind: PaymentKind;
  authorization: SettlementAuthorization | null;
  /** Identifies this attempt. Stable across the job's own retries. */
  claimToken: string;
}): Promise<{ claimed: boolean; amountPaise: number; currency: string; reason?: string }> {
  const {
    organizationId,
    invoiceId,
    settlementKey,
    purchaseOrder,
    amountPaise,
    kind,
    authorization,
    claimToken,
  } = params;
  const amount = { amountPaise, currency: purchaseOrder.currency };
  const processedAt = new Date();

  const authorizationFields = {
    kind,
    authorizedBy: authorization?.userId ?? null,
    authorizationReason: authorization?.reason ?? null,
    authorizingExceptionId: authorization?.exceptionId ?? null,
  };

  /**
   * Re-runs the cap inside the claim transaction, against the tranches visible
   * right now. The gate's own check ran against a snapshot taken before this
   * transaction opened; a sibling tranche committed since then would make that
   * snapshot authorize an overpayment.
   *
   * The row lock is what makes that true rather than merely likely. Postgres
   * runs these transactions at READ COMMITTED, so without it two tranches with
   * *different* settlement keys against the same order — two exceptions
   * resolved at once, or an "exc-" racing "auto" — each read a snapshot that
   * cannot see the other's uncommitted row, both pass the cap, and both commit.
   * The unique constraint is on (invoiceId, settlementKey), so it does not
   * serialize them either. Locking the purchase order does: every tranche
   * against one order queues here, and the aggregate below is then taken after
   * the previous one committed.
   */
  const assertStillWithinCap = async (tx: Prisma.TransactionClient): Promise<string | null> => {
    await tx.$queryRaw`SELECT id FROM "PurchaseOrder" WHERE id = ${purchaseOrder.id} FOR UPDATE`;

    const settled = { in: [PaymentStatus.PROCESSING, PaymentStatus.COMPLETED] };

    const [invoiceSettled, orderSettled] = await Promise.all([
      tx.payment.aggregate({
        _sum: { amountPaise: true },
        // This tranche's own row is excluded so a resume does not count itself.
        where: {
          organizationId,
          invoiceId,
          settlementKey: { not: settlementKey },
          status: settled,
        },
      }),
      tx.payment.aggregate({
        _sum: { amountPaise: true },
        where: {
          organizationId,
          purchaseOrderId: purchaseOrder.id,
          NOT: { invoiceId, settlementKey },
          status: settled,
        },
      }),
    ]);

    const decision = evaluateSettlement({
      ledger: {
        invoiceTotalPaise: params.invoiceTotalPaise,
        invoiceSettledPaise: invoiceSettled._sum.amountPaise ?? 0,
        purchaseOrderTotalPaise: purchaseOrder.totalPaise,
        purchaseOrderSettledPaise: orderSettled._sum.amountPaise ?? 0,
      },
      requestedAmountPaise: amountPaise,
    });

    return decision.settle ? null : decision.reason;
  };

  try {
    // Create and audit atomically. If the audit failed on its own the row would
    // already be PROCESSING, and the resume branch below deliberately does not
    // re-audit — so a half-committed first run would settle with no
    // PAYMENT_APPROVED row at all. Rolling both back lets the retry redo them.
    const created = await prisma.$transaction(async (tx) => {
      const overspend = await assertStillWithinCap(tx);
      if (overspend !== null) {
        return overspend;
      }

      await tx.payment.create({
        data: {
          organizationId,
          invoiceId,
          settlementKey,
          purchaseOrderId: purchaseOrder.id,
          ...amount,
          ...authorizationFields,
          status: PaymentStatus.PROCESSING,
          provider: PAYMENT_PROVIDER_NAME,
          claimedBy: claimToken,
          processedAt,
        },
      });

      await recordAudit(tx, paymentApprovedAudit({ organizationId, invoiceId, kind, ...amount }));
      return null;
    });

    if (created !== null) {
      return { claimed: false, ...amount, reason: created };
    }

    return { claimed: true, ...amount };
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
  }

  // A row already existed. Claim it only from a state that has not settled —
  // BLOCKED has been cleared by a human (the payment gate already verified
  // that), FAILED is retryable, PENDING was never started.
  //
  // PROCESSING is handled separately below rather than in this set, for two
  // reasons: re-claiming it is a *resume* rather than a fresh approval, so it
  // must not append a second PAYMENT_APPROVED audit row; and it may belong to a
  // worker that is inside the provider call right now, so it is only taken over
  // once its lease has expired.
  const claimData = {
    status: PaymentStatus.PROCESSING,
    ...amount,
    ...authorizationFields,
    provider: PAYMENT_PROVIDER_NAME,
    purchaseOrderId: purchaseOrder.id,
    claimedBy: claimToken,
    processedAt,
    blockedReason: null,
    failureReason: null,
  };

  return prisma.$transaction(async (tx) => {
    const overspend = await assertStillWithinCap(tx);
    if (overspend !== null) {
      return { claimed: false, ...amount, reason: overspend };
    }

    const approved = await tx.payment.updateMany({
      where: {
        invoiceId,
        settlementKey,
        organizationId,
        status: {
          in: [PaymentStatus.PENDING, PaymentStatus.BLOCKED, PaymentStatus.FAILED],
        },
      },
      data: claimData,
    });

    if (approved.count > 0) {
      await recordAudit(tx, paymentApprovedAudit({ organizationId, invoiceId, kind, ...amount }));
      return { claimed: true, ...amount };
    }

    // A PROCESSING row is resumable in exactly two cases: it is this attempt's
    // own claim (same job id, so this is a BullMQ retry picking up where it left
    // off — its backoff is far shorter than the lease, so it must not be made to
    // wait one out), or the claim has gone stale and its owner is presumed dead.
    // Anything else belongs to a worker that may be inside charge() right now.
    //
    // There is deliberately no third "unowned row" case. Every PROCESSING row is
    // written with both claimedBy and processedAt set, in one transaction, so a
    // row with neither cannot be produced by this code — and matching an
    // ownerless row unconditionally would hand out a claim regardless of lease.
    // A row that somehow lacks a processedAt stays put for a human instead.
    const resumed = await tx.payment.updateMany({
      where: {
        invoiceId,
        settlementKey,
        organizationId,
        status: PaymentStatus.PROCESSING,
        OR: [
          { claimedBy: claimToken },
          { processedAt: { lt: new Date(processedAt.getTime() - PAYMENT_CLAIM_LEASE_MS) } },
        ],
      },
      data: claimData,
    });

    return { claimed: resumed.count > 0, ...amount };
  });
}

function paymentApprovedAudit(params: {
  organizationId: string;
  invoiceId: string;
  amountPaise: number;
  currency: string;
  kind: PaymentKind;
}) {
  return {
    organizationId: params.organizationId,
    actorType: "SYSTEM" as const,
    action: "PAYMENT_APPROVED" as const,
    entityType: INVOICE_ENTITY,
    entityId: params.invoiceId,
    metadata: { amountPaise: params.amountPaise, currency: params.currency, kind: params.kind },
  };
}

// ---------------------------------------------------------------------------
// Settle
// ---------------------------------------------------------------------------

/**
 * Records a successful settlement: the tranche COMPLETED, and the invoice moved
 * to whatever the ledger now says it is.
 *
 * The invoice becomes PAID only when the tranches add up to its total;
 * otherwise it becomes PARTIALLY_PAID and stays payable, so the balance can be
 * settled later without any of this being re-derived by hand.
 *
 * Both updates are guarded on the state this job left behind, so a duplicate
 * delivery that arrives after another attempt already settled finds nothing to
 * move and reports it rather than writing a second audit trail.
 */
export async function applyPaymentCompletion(params: {
  organizationId: string;
  invoiceId: string;
  settlementKey: string;
  providerReference: string;
  /** True when a human overrode a failed match to authorize this payment. */
  overriddenMatch: boolean;
}): Promise<boolean> {
  const { organizationId, invoiceId, settlementKey, providerReference, overriddenMatch } = params;

  return prisma.$transaction(async (tx) => {
    const settled = await tx.payment.updateMany({
      where: { invoiceId, settlementKey, organizationId, status: PaymentStatus.PROCESSING },
      data: {
        status: PaymentStatus.COMPLETED,
        providerReference,
        completedAt: new Date(),
        failureReason: null,
      },
    });

    if (settled.count === 0) {
      console.warn(`Invoice ${invoiceId}: payment completion ignored, payment is not PROCESSING.`);
      return false;
    }

    // Read the ledger back only now that this tranche is COMPLETED, so the sum
    // it reports is the one the invoice's new status has to agree with.
    //
    // COMPLETED only, unlike the payment gate's own read. The gate counts
    // PROCESSING as spent so a concurrent tranche cannot lend it money that is
    // already committed; here the question is different — has this money
    // actually moved? — and counting a sibling still inside the provider call
    // would mark the invoice PAID before its last rupee left, stranding that
    // sibling's own completion in the "reconcile manually" branch below.
    const settledStatus = { status: PaymentStatus.COMPLETED };

    const invoice = await tx.invoice.findFirst({
      where: { id: invoiceId, organizationId },
      select: { totalPaise: true, purchaseOrder: { select: { id: true, totalPaise: true } } },
    });

    const [paidSoFar, orderPaidSoFar] = await Promise.all([
      tx.payment.aggregate({
        _sum: { amountPaise: true },
        where: { organizationId, invoiceId, ...settledStatus },
      }),
      tx.payment.aggregate({
        _sum: { amountPaise: true },
        where: {
          organizationId,
          purchaseOrderId: invoice?.purchaseOrder.id ?? "",
          ...settledStatus,
        },
      }),
    ]);

    const view = describeSettlement({
      invoiceTotalPaise: invoice?.totalPaise ?? null,
      invoiceSettledPaise: paidSoFar._sum.amountPaise ?? 0,
      // The order matters here too: an invoice that billed marginally above the
      // order is finished once the order is spent, and must not be left
      // permanently PARTIALLY_PAID over a rounding difference.
      purchaseOrderTotalPaise: invoice?.purchaseOrder.totalPaise ?? 0,
      purchaseOrderSettledPaise: orderPaidSoFar._sum.amountPaise ?? 0,
    });

    const nextStatus = view.fullySettled ? InvoiceStatus.PAID : InvoiceStatus.PARTIALLY_PAID;

    const invoiceUpdate = await tx.invoice.updateMany({
      where: {
        id: invoiceId,
        organizationId,
        status: { in: [InvoiceStatus.APPROVED, InvoiceStatus.PARTIALLY_PAID] },
      },
      data: { status: nextStatus },
    });

    if (invoiceUpdate.count === 0) {
      const reason =
        `Payment completed (provider reference ${providerReference}) but the invoice was not in` +
        " APPROVED or PARTIALLY_PAID state, so it was not moved to" +
        ` ${nextStatus}. Money has moved; reconcile manually.`;

      console.warn(`Invoice ${invoiceId}: ${reason}`);

      // A log line is not a signal anyone will see. Money left the building
      // against an invoice the workflow does not consider payable — that is
      // exactly what the exception queue is for.
      await recordException(tx, {
        organizationId,
        type: ExceptionType.SYSTEM_FAILURE,
        severity: Severity.CRITICAL,
        entityType: INVOICE_ENTITY,
        entityId: invoiceId,
        title: "Payment settled against a non-approved invoice",
        description: reason,
        metadata: { providerReference, provider: PAYMENT_PROVIDER_NAME },
      });
    }

    await recordAudit(tx, {
      organizationId,
      actorType: "SYSTEM",
      action: "PAYMENT_COMPLETED",
      entityType: INVOICE_ENTITY,
      entityId: invoiceId,
      metadata: {
        providerReference,
        provider: PAYMENT_PROVIDER_NAME,
        overriddenMatch,
        settlementKey,
        invoiceStatus: nextStatus,
        settledPaise: view.invoiceSettledPaise,
        outstandingPaise: view.invoiceOutstandingPaise,
      },
    });

    return true;
  });
}

/**
 * Terminal failure path, used only once BullMQ has exhausted its retries.
 *
 * The invoice stays APPROVED — it is still a legitimate debt — so a human can
 * re-drive payment once the provider is healthy again.
 */
export async function applyPaymentFailure(params: {
  organizationId: string;
  invoiceId: string;
  settlementKey: string;
  reason: string;
}): Promise<void> {
  const { organizationId, invoiceId, settlementKey, reason } = params;

  await prisma.$transaction(async (tx) => {
    await tx.payment.updateMany({
      where: { invoiceId, settlementKey, organizationId, status: PaymentStatus.PROCESSING },
      data: { status: PaymentStatus.FAILED, failureReason: reason },
    });

    await recordException(tx, {
      organizationId,
      type: ExceptionType.PAYMENT_FAILURE,
      severity: Severity.CRITICAL,
      entityType: INVOICE_ENTITY,
      entityId: invoiceId,
      title: "Payment failed",
      description: reason,
    });

    await recordAudit(tx, {
      organizationId,
      actorType: "SYSTEM",
      action: "WORKFLOW_FAILED",
      entityType: INVOICE_ENTITY,
      entityId: invoiceId,
      metadata: { stage: "payment", reason, settlementKey },
    });
  });
}

// ---------------------------------------------------------------------------
// API: read
// ---------------------------------------------------------------------------

/**
 * Enough context for an operator to judge a payment without opening the invoice
 * and the purchase order alongside it — which is the whole point of the partial
 * payments view: "who did we pay less than they billed, how much less, and who
 * signed it off?"
 */
const paymentViewSelect = {
  id: true,
  organizationId: true,
  invoiceId: true,
  settlementKey: true,
  purchaseOrderId: true,
  amountPaise: true,
  currency: true,
  status: true,
  kind: true,
  provider: true,
  providerReference: true,
  blockedReason: true,
  failureReason: true,
  authorizedBy: true,
  authorizationReason: true,
  authorizingExceptionId: true,
  processedAt: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
  invoice: {
    select: {
      invoiceNumber: true,
      status: true,
      totalPaise: true,
      supplier: { select: { id: true, name: true } },
    },
  },
  purchaseOrder: { select: { poNumber: true, totalPaise: true, currency: true } },
} satisfies Prisma.PaymentSelect;

type PaymentRow = Prisma.PaymentGetPayload<{ select: typeof paymentViewSelect }>;

export interface PaymentView extends PaymentRow {
  /** Everything COMPLETED against this payment's invoice, across all tranches. */
  invoiceSettledPaise: number;
  /**
   * What the supplier billed, minus what the invoice has actually been paid in
   * total. Zero once the invoice is settled in full.
   *
   * A property of the *invoice*, not of this row, so every tranche of one
   * invoice reports the same figure. Computing it per row instead — this
   * tranche against the whole invoice total — double-counts: an invoice paid
   * 40% then 30% would report shortfalls of 60% and 70%, and an invoice
   * eventually settled in full across two partials would still show a large
   * one. This number is the headline of the partial-payments view, so it has to
   * be the real outstanding amount.
   */
  shortfallPaise: number;
}

export interface ListPaymentsParams {
  organizationId: string;
  status?: PaymentStatus;
  kind?: PaymentKind;
  invoiceId?: string;
  purchaseOrderId?: string;
  supplierId?: string;
  from?: Date;
  to?: Date;
  limit: number;
  cursor?: string;
}

function toPaymentView(row: PaymentRow, settledByInvoiceId: Map<string, number>): PaymentView {
  const invoiceSettledPaise = settledByInvoiceId.get(row.invoiceId) ?? 0;

  return {
    ...row,
    invoiceSettledPaise,
    // Null total means the amount billed is unknown; a shortfall against an
    // unknown figure would be a guess, and this one is read as money saved.
    shortfallPaise:
      row.invoice.totalPaise === null
        ? 0
        : Math.max(0, row.invoice.totalPaise - invoiceSettledPaise),
  };
}

/** Everything COMPLETED against each of these invoices, in one grouped query. */
async function settledByInvoice(params: {
  organizationId: string;
  invoiceIds: string[];
}): Promise<Map<string, number>> {
  if (params.invoiceIds.length === 0) {
    return new Map();
  }

  const rows = await prisma.payment.groupBy({
    by: ["invoiceId"],
    where: {
      organizationId: params.organizationId,
      invoiceId: { in: params.invoiceIds },
      status: PaymentStatus.COMPLETED,
    },
    _sum: { amountPaise: true },
  });

  return new Map(rows.map((row) => [row.invoiceId, row._sum.amountPaise ?? 0]));
}

export async function listPayments(
  params: ListPaymentsParams,
): Promise<{ payments: PaymentView[]; nextCursor: string | null }> {
  const { organizationId, status, kind, invoiceId, purchaseOrderId, supplierId, from, to } = params;
  const { limit, cursor } = params;

  const payments = await prisma.payment.findMany({
    where: {
      organizationId,
      ...(status ? { status } : {}),
      ...(kind ? { kind } : {}),
      ...(invoiceId ? { invoiceId } : {}),
      ...(purchaseOrderId ? { purchaseOrderId } : {}),
      // Filtered through the invoice rather than denormalized onto Payment: the
      // supplier is a fact about the document being settled, and duplicating it
      // here is one more column to keep true.
      ...(supplierId ? { invoice: { supplierId } } : {}),
      ...(from || to
        ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
        : {}),
    },
    select: paymentViewSelect,
    // createdAt alone is not unique — two tranches of one invoice can be
    // written in the same millisecond — so id breaks the tie deterministically
    // and a page boundary can never skip or repeat a row.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    // One extra row tells us whether another page exists without a second query.
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const page = payments.slice(0, limit);

  const settled = await settledByInvoice({
    organizationId,
    invoiceIds: [...new Set(page.map((row) => row.invoiceId))],
  });

  return {
    payments: page.map((row) => toPaymentView(row, settled)),
    nextCursor: payments.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
}

/**
 * One payment, with the other tranches settling the same purchase order and the
 * order's overall ledger. A partial payment only means anything next to what
 * else has been paid against the same commitment.
 */
export async function getPaymentById(params: {
  organizationId: string;
  paymentId: string;
}): Promise<{
  payment: PaymentView;
  ledger: ReturnType<typeof describeSettlement> & { poNumber: string };
  siblings: {
    id: string;
    invoiceId: string;
    settlementKey: string;
    amountPaise: number;
    status: PaymentStatus;
    kind: PaymentKind;
  }[];
}> {
  const payment = await prisma.payment.findFirst({
    where: { id: params.paymentId, organizationId: params.organizationId },
    select: paymentViewSelect,
  });

  if (!payment) {
    throw AppError.notFound("Payment not found");
  }

  const [ledger, siblings, settled] = await Promise.all([
    loadSettlementLedger({
      organizationId: params.organizationId,
      invoiceId: payment.invoiceId,
      invoiceTotalPaise: payment.invoice.totalPaise,
      purchaseOrderId: payment.purchaseOrderId,
      purchaseOrderTotalPaise: payment.purchaseOrder.totalPaise,
    }),
    prisma.payment.findMany({
      where: {
        organizationId: params.organizationId,
        purchaseOrderId: payment.purchaseOrderId,
        id: { not: payment.id },
      },
      select: {
        id: true,
        invoiceId: true,
        settlementKey: true,
        amountPaise: true,
        status: true,
        kind: true,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    // COMPLETED only, matching the list view — the ledger below counts
    // in-flight tranches too, which is the right basis for the cap but the
    // wrong one for "how much has this invoice actually been paid".
    settledByInvoice({ organizationId: params.organizationId, invoiceIds: [payment.invoiceId] }),
  ]);

  return {
    payment: toPaymentView(payment, settled),
    ledger: { ...describeSettlement(ledger), poNumber: payment.purchaseOrder.poNumber },
    siblings,
  };
}
