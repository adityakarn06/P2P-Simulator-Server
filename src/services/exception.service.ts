import { prisma } from "../config/prisma.js";
import type { Prisma } from "../generated/prisma/client.js";
import {
  ExceptionStatus,
  ExceptionType,
  InvoiceStatus,
  type MatchCheckType,
  PaymentStatus,
  type Severity,
} from "../generated/prisma/enums.js";
import { describeSettlement, suggestPartialSettlement } from "../rules/settlementRules.js";
import { AppError } from "../utils/AppError.js";
import { EXCEPTION_ENTITY, INVOICE_ENTITY, recordAudit } from "./audit.service.js";

/** Prisma client or an interactive-transaction client — exceptions must be able to join a transaction. */
type PrismaLike = Pick<Prisma.TransactionClient, "exception" | "auditLog">;

export interface ExceptionInput {
  organizationId: string;
  type: ExceptionType;
  severity: Severity;
  entityType: string;
  entityId: string;
  title: string;
  description: string;
  metadata?: Prisma.InputJsonValue;
}

/**
 * Records a workflow exception idempotently.
 *
 * Upserts on the existing @@unique([organizationId, type, entityId]) so a
 * retried job cannot open the same exception twice. `status` is deliberately
 * left untouched on update: a re-drive must never reopen an exception a human
 * has already resolved.
 *
 * Writes the EXCEPTION_CREATED audit itself, once, right here — rather than at
 * every call site — so no caller can raise an exception without an audit trail
 * (CLAUDE.md: "important state transitions must be audited"). The pre-read
 * that decides create-vs-update can lose a race against a concurrent duplicate
 * delivery and log EXCEPTION_CREATED twice; that is an acceptable
 * over-observation — the Exception row itself stays single because the upsert
 * is still guarded by the unique constraint.
 */
export async function recordException(
  db: PrismaLike,
  input: ExceptionInput,
): Promise<{ id: string }> {
  const payload = {
    severity: input.severity,
    title: input.title,
    description: input.description,
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  };

  const existing = await db.exception.findUnique({
    where: {
      organizationId_type_entityId: {
        organizationId: input.organizationId,
        type: input.type,
        entityId: input.entityId,
      },
    },
    select: { id: true, status: true },
  });

  // A closed row plus a fresh occurrence means the problem came back after a
  // human signed it off. Leaving it RESOLVED strands the entity forever: the
  // invoice is moved to EXCEPTION, the payment gate refuses it for having an
  // exception, and resolveExceptionById refuses to re-decide a closed row — so
  // nothing short of a manual database edit can release it. Reopening restores
  // the only path out. A row that is still OPEN or UNDER_REVIEW is left alone,
  // so a plain re-drive never disturbs a decision in progress.
  const reopened =
    existing !== null &&
    (existing.status === ExceptionStatus.RESOLVED || existing.status === ExceptionStatus.REJECTED);

  const reopenFields = reopened
    ? {
        status: ExceptionStatus.OPEN,
        resolution: null,
        resolutionReason: null,
        resolvedAt: null,
        resolvedBy: null,
      }
    : {};

  const exception = await db.exception.upsert({
    where: {
      organizationId_type_entityId: {
        organizationId: input.organizationId,
        type: input.type,
        entityId: input.entityId,
      },
    },
    create: {
      organizationId: input.organizationId,
      type: input.type,
      entityType: input.entityType,
      entityId: input.entityId,
      ...payload,
    },
    update: { ...payload, ...reopenFields },
    select: { id: true },
  });

  if (reopened) {
    await recordAudit(db, {
      organizationId: input.organizationId,
      actorType: "SYSTEM",
      action: "EXCEPTION_CREATED",
      entityType: EXCEPTION_ENTITY,
      entityId: exception.id,
      metadata: {
        reopened: true,
        previousStatus: existing.status,
        type: input.type,
        severity: input.severity,
        entityType: input.entityType,
        entityId: input.entityId,
      },
    });
  }

  if (!existing) {
    await recordAudit(db, {
      organizationId: input.organizationId,
      actorType: "SYSTEM",
      action: "EXCEPTION_CREATED",
      entityType: EXCEPTION_ENTITY,
      entityId: exception.id,
      metadata: {
        type: input.type,
        severity: input.severity,
        entityType: input.entityType,
        entityId: input.entityId,
      },
    });
  }

  return exception;
}

export interface ResolveExceptionInput {
  organizationId: string;
  type: ExceptionType;
  entityId: string;
  resolution: string;
  resolutionReason: string;
  resolvedBy?: string | null;
}

/**
 * Closes an open exception once the workflow has moved past it.
 *
 * Guarded on the open statuses and returns how many rows it touched, so a
 * caller can skip the EXCEPTION_RESOLVED audit when there was nothing left to
 * resolve — a repeated approval must not append a second resolution.
 */
export async function resolveException(
  db: Pick<Prisma.TransactionClient, "exception">,
  input: ResolveExceptionInput,
): Promise<number> {
  const { count } = await db.exception.updateMany({
    where: {
      organizationId: input.organizationId,
      type: input.type,
      entityId: input.entityId,
      status: { in: [ExceptionStatus.OPEN, ExceptionStatus.UNDER_REVIEW] },
    },
    data: {
      status: ExceptionStatus.RESOLVED,
      resolution: input.resolution,
      resolutionReason: input.resolutionReason,
      resolvedAt: new Date(),
      resolvedBy: input.resolvedBy ?? null,
    },
  });

  return count;
}

// ---------------------------------------------------------------------------
// API: read
// ---------------------------------------------------------------------------

const exceptionViewSelect = {
  id: true,
  organizationId: true,
  type: true,
  status: true,
  severity: true,
  entityType: true,
  entityId: true,
  title: true,
  description: true,
  metadata: true,
  resolution: true,
  resolutionReason: true,
  resolvedAt: true,
  resolvedBy: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ExceptionSelect;

export type ExceptionView = Prisma.ExceptionGetPayload<{ select: typeof exceptionViewSelect }>;

/**
 * What an operator needs in order to decide an invoice exception: which of the
 * twelve checks actually failed, and what settling it would cost.
 *
 * Attached only to invoice exceptions — every other type is decided without
 * money moving, and loading a settlement for them would be noise.
 */
export interface ExceptionSettlementContext {
  purchaseOrderId: string;
  poNumber: string;
  currency: string;
  invoiceTotalPaise: number | null;
  invoiceSettledPaise: number;
  invoiceOutstandingPaise: number;
  purchaseOrderTotalPaise: number;
  purchaseOrderSettledPaise: number;
  purchaseOrderOutstandingPaise: number;
  /**
   * What the goods that actually arrived are worth at the purchase order's own
   * agreed prices — the natural answer to a short delivery, offered so the
   * operator does not have to do the arithmetic that authorizes a payment.
   *
   * Advisory. Whatever they approve is re-checked against both balances before
   * anything is charged. Null when nothing has been received yet, since there
   * would be nothing to pay for.
   */
  suggestedAmountPaise: number | null;
}

export interface ExceptionDetail extends ExceptionView {
  failedChecks: {
    checkType: MatchCheckType;
    expected: string | null;
    actual: string | null;
    variance: number | null;
    severity: Severity;
  }[];
  settlement: ExceptionSettlementContext | null;
}

export async function getExceptionById(params: {
  organizationId: string;
  exceptionId: string;
}): Promise<ExceptionDetail> {
  const exception = await prisma.exception.findFirst({
    where: { id: params.exceptionId, organizationId: params.organizationId },
    select: exceptionViewSelect,
  });

  if (!exception) {
    throw AppError.notFound("Exception not found");
  }

  if (exception.entityType !== INVOICE_ENTITY) {
    return { ...exception, failedChecks: [], settlement: null };
  }

  const [invoice, failedChecks] = await Promise.all([
    prisma.invoice.findFirst({
      where: { id: exception.entityId, organizationId: params.organizationId },
      select: {
        totalPaise: true,
        purchaseOrder: {
          select: {
            id: true,
            poNumber: true,
            currency: true,
            totalPaise: true,
            taxRateBps: true,
            items: { select: { id: true, unitPricePaise: true } },
            shipment: {
              select: {
                goodsReceipt: {
                  select: {
                    items: { select: { purchaseOrderItemId: true, acceptedQuantity: true } },
                  },
                },
              },
            },
          },
        },
      },
    }),
    prisma.matchCheck.findMany({
      where: { passed: false, threeWayMatch: { invoiceId: exception.entityId } },
      select: {
        checkType: true,
        expected: true,
        actual: true,
        variance: true,
        severity: true,
      },
    }),
  ]);

  if (!invoice) {
    return { ...exception, failedChecks, settlement: null };
  }

  const purchaseOrder = invoice.purchaseOrder;
  const settled = { in: [PaymentStatus.PROCESSING, PaymentStatus.COMPLETED] };

  const [invoiceSettled, orderSettled] = await Promise.all([
    prisma.payment.aggregate({
      _sum: { amountPaise: true },
      where: {
        organizationId: params.organizationId,
        invoiceId: exception.entityId,
        status: settled,
      },
    }),
    prisma.payment.aggregate({
      _sum: { amountPaise: true },
      where: {
        organizationId: params.organizationId,
        purchaseOrderId: purchaseOrder.id,
        status: settled,
      },
    }),
  ]);

  const view = describeSettlement({
    invoiceTotalPaise: invoice.totalPaise,
    invoiceSettledPaise: invoiceSettled._sum.amountPaise ?? 0,
    purchaseOrderTotalPaise: purchaseOrder.totalPaise,
    purchaseOrderSettledPaise: orderSettled._sum.amountPaise ?? 0,
  });

  const acceptedByItemId = new Map(
    (purchaseOrder.shipment?.goodsReceipt?.items ?? []).map((item) => [
      item.purchaseOrderItemId,
      item.acceptedQuantity,
    ]),
  );

  const suggestionLines = purchaseOrder.items.map((item) => ({
    unitPricePaise: item.unitPricePaise,
    acceptedQuantity: acceptedByItemId.get(item.id) ?? 0,
  }));

  // Every reason evaluateSettlement would refuse the suggestion outright.
  // Offering a figure the payment worker will always reject is worse than
  // offering none — the operator approves it, and the payment silently does
  // not happen.
  const suggestible =
    suggestionLines.some((line) => line.acceptedQuantity > 0) &&
    view.invoiceTotalPaise !== null &&
    view.invoiceOutstandingPaise > 0 &&
    view.purchaseOrderOutstandingPaise > 0;

  return {
    ...exception,
    failedChecks,
    settlement: {
      purchaseOrderId: purchaseOrder.id,
      poNumber: purchaseOrder.poNumber,
      currency: purchaseOrder.currency,
      ...view,
      suggestedAmountPaise: suggestible
        ? Math.min(
            suggestPartialSettlement({
              lines: suggestionLines,
              taxRateBps: purchaseOrder.taxRateBps,
            }),
            // Never suggest more than either balance allows.
            view.invoiceOutstandingPaise,
            view.purchaseOrderOutstandingPaise,
          )
        : null,
    },
  };
}

export async function listExceptions(params: {
  organizationId: string;
  status?: ExceptionStatus;
  type?: ExceptionType;
  entityId?: string;
  limit: number;
  cursor?: string;
}): Promise<{ exceptions: ExceptionView[]; nextCursor: string | null }> {
  const { organizationId, status, type, entityId, limit, cursor } = params;

  const exceptions = await prisma.exception.findMany({
    where: {
      organizationId,
      ...(status ? { status } : {}),
      ...(type ? { type } : {}),
      ...(entityId ? { entityId } : {}),
    },
    select: exceptionViewSelect,
    // createdAt alone is not unique — matching can open several exceptions
    // against one invoice inside a single transaction — so id breaks the tie
    // deterministically and a page boundary can never skip or repeat a row.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    // One extra row tells us whether another page exists without a second query.
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const page = exceptions.slice(0, limit);

  return {
    exceptions: page,
    nextCursor: exceptions.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
}

/** Exceptions still awaiting a human, used by the payment gate. */
export function countOpenExceptions(params: {
  organizationId: string;
  entityId: string;
}): Promise<number> {
  return prisma.exception.count({
    where: {
      organizationId: params.organizationId,
      entityId: params.entityId,
      status: { in: [ExceptionStatus.OPEN, ExceptionStatus.UNDER_REVIEW] },
    },
  });
}

// ---------------------------------------------------------------------------
// API: resolve
// ---------------------------------------------------------------------------

export type ExceptionDecision = "APPROVE" | "PARTIAL_APPROVE" | "REJECT";

/** Both approvals release the invoice; only the amount they authorize differs. */
function isApproval(decision: ExceptionDecision): boolean {
  return decision === "APPROVE" || decision === "PARTIAL_APPROVE";
}

export interface ResolveExceptionByIdInput {
  organizationId: string;
  exceptionId: string;
  decision: ExceptionDecision;
  reason: string;
  /** Set only on PARTIAL_APPROVE. A request, not an authorization — see below. */
  approvedAmountPaise?: number;
  actorId: string;
}

export interface ResolveExceptionResult {
  exception: ExceptionView;
  /** True when this resolution released an invoice for payment. */
  releasedForPayment: boolean;
  invoiceId: string | null;
  /**
   * The amount the operator approved, passed through to the payment job. Null
   * on a full approval, which settles whatever is outstanding.
   *
   * Deliberately not validated against the ledger here: this transaction is
   * about recording a decision, and the balances it would check can change
   * before the payment worker runs. The worker re-derives them and refuses an
   * amount that no longer fits, so an over-approval is caught where it matters
   * rather than at the moment someone typed it.
   */
  approvedAmountPaise: number | null;
}

/**
 * Applies a human decision to one exception.
 *
 * APPROVE is an *override*, not a re-run. A genuine discrepancy — 98 units
 * received against 100 ordered — will produce the same MISMATCHED verdict every
 * time it is re-matched, so clearing it by re-matching is impossible by
 * construction. Instead the ThreeWayMatch keeps saying MISMATCHED (that is what
 * the documents say) and this resolution records, with a written reason and an
 * audit row, that a person accepted the discrepancy anyway.
 *
 * The invoice is released only once *every* exception against it is closed, so
 * an invoice failing on both quantity and price needs both signed off.
 *
 * REJECT closes the exception without releasing anything: the invoice stays in
 * EXCEPTION and its payment stays BLOCKED.
 */
export async function resolveExceptionById(
  input: ResolveExceptionByIdInput,
): Promise<ResolveExceptionResult> {
  const { organizationId, exceptionId, decision, reason, approvedAmountPaise, actorId } = input;

  return prisma.$transaction(async (tx) => {
    const exception = await tx.exception.findFirst({
      where: { id: exceptionId, organizationId },
      select: exceptionViewSelect,
    });

    if (!exception) {
      throw AppError.notFound("Exception not found");
    }

    // OPEN -> UNDER_REVIEW -> RESOLVED/REJECTED. A closed exception is terminal:
    // re-deciding it would rewrite a signed-off financial judgement.
    if (
      exception.status !== ExceptionStatus.OPEN &&
      exception.status !== ExceptionStatus.UNDER_REVIEW
    ) {
      throw AppError.invalidState(`Exception is already ${exception.status}`, {
        exceptionId,
        status: exception.status,
      });
    }

    // PO_APPROVAL_REQUIRED is not this endpoint's to close. Resolving it here
    // would mark the exception RESOLVED while leaving the purchase order in
    // PENDING_APPROVAL with nothing open against it — invisible to the operator
    // and unreachable by the approval flow, which closes this exception itself.
    if (exception.type === ExceptionType.PO_APPROVAL_REQUIRED) {
      throw AppError.invalidState(
        "A purchase-order approval is decided on the purchase order, not here — use POST /api/v1/purchase-orders/:id/approve or /reject",
        { exceptionId, type: exception.type, entityId: exception.entityId },
      );
    }

    const conditionalUpdate = await tx.exception.updateMany({
      where: {
        id: exceptionId,
        // Scoped even though the pre-read above already proved ownership: every
        // other write in this file carries the tenant, and relying on a
        // preceding read is one refactor away from a cross-tenant write.
        organizationId,
        status: { in: [ExceptionStatus.OPEN, ExceptionStatus.UNDER_REVIEW] },
      },
      data: {
        status: isApproval(decision) ? ExceptionStatus.RESOLVED : ExceptionStatus.REJECTED,
        resolution: decision,
        resolutionReason: reason,
        resolvedAt: new Date(),
        resolvedBy: actorId,
      },
    });

    if (conditionalUpdate.count === 0) {
      // Re-fetch to surface the current status in the error (the earlier read
      // may have raced with a concurrent resolution that already committed).
      const current = await tx.exception.findFirst({
        where: { id: exceptionId, organizationId },
        select: { status: true },
      });
      const currentStatus = current?.status ?? exception.status;
      throw AppError.invalidState(`Exception is already ${currentStatus}`, {
        exceptionId,
        status: currentStatus,
      });
    }

    const resolved = await tx.exception.findUniqueOrThrow({
      where: { id: exceptionId },
      select: exceptionViewSelect,
    });

    await recordAudit(tx, {
      organizationId,
      actorType: "USER",
      actorId,
      action: "EXCEPTION_RESOLVED",
      entityType: EXCEPTION_ENTITY,
      entityId: exceptionId,
      metadata: {
        decision,
        reason,
        approvedAmountPaise: approvedAmountPaise ?? null,
        type: exception.type,
        entityType: exception.entityType,
        entityId: exception.entityId,
      },
    });

    const isInvoiceException = exception.entityType === INVOICE_ENTITY;

    if (!isApproval(decision) || !isInvoiceException) {
      return {
        exception: resolved,
        releasedForPayment: false,
        invoiceId: null,
        approvedAmountPaise: null,
      };
    }

    const invoiceId = exception.entityId;

    // Every exception on this invoice must be closed before money can move.
    const stillOpen = await tx.exception.count({
      where: {
        organizationId,
        entityId: invoiceId,
        status: { in: [ExceptionStatus.OPEN, ExceptionStatus.UNDER_REVIEW] },
      },
    });

    if (stillOpen > 0) {
      return {
        exception: resolved,
        releasedForPayment: false,
        invoiceId,
        approvedAmountPaise: null,
      };
    }

    // Guarded on EXCEPTION so this can only ever release an invoice that
    // matching actually blocked — never re-approve a paid or failed one.
    const released = await tx.invoice.updateMany({
      where: { id: invoiceId, organizationId, status: InvoiceStatus.EXCEPTION },
      data: { status: InvoiceStatus.APPROVED },
    });

    if (released.count === 0) {
      return {
        exception: resolved,
        releasedForPayment: false,
        invoiceId,
        approvedAmountPaise: null,
      };
    }

    // Unblock the payment matching parked — but only on a full approval.
    //
    // A PARTIAL_APPROVE settles its own tranche, keyed on this exception. The
    // "auto" row matching wrote carries the whole purchase order total, and
    // nothing will ever enqueue a job for it: releasing it here would leave a
    // PENDING payment for the full amount that no worker processes, showing up
    // in GET /payments as outstanding money and waiting to be claimed at that
    // stale figure by any later re-drive. It stays BLOCKED, which is what it
    // is — the full-value settlement was refused, and a smaller one was
    // authorized instead.
    //
    // PENDING, not PROCESSING: the payment worker still has to claim it, and
    // still re-checks the gate first.
    if (decision === "APPROVE") {
      await tx.payment.updateMany({
        where: { invoiceId, organizationId, status: PaymentStatus.BLOCKED },
        data: { status: PaymentStatus.PENDING, blockedReason: null },
      });
    }

    await recordAudit(tx, {
      organizationId,
      actorType: "USER",
      actorId,
      action: "PAYMENT_APPROVED",
      entityType: INVOICE_ENTITY,
      entityId: invoiceId,
      metadata: {
        via: "exception-override",
        exceptionId,
        reason,
        decision,
        approvedAmountPaise: approvedAmountPaise ?? null,
      },
    });

    return {
      exception: resolved,
      releasedForPayment: true,
      invoiceId,
      approvedAmountPaise: approvedAmountPaise ?? null,
    };
  });
}
