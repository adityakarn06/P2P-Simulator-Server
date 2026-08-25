import { prisma } from "../config/prisma.js";
import type { Prisma } from "../generated/prisma/client.js";
import {
  ExceptionType,
  InvoiceSource,
  InvoiceStatus,
  type MatchCheckType,
  MatchStatus,
  PaymentStatus,
  Severity,
} from "../generated/prisma/enums.js";
import {
  EXCEPTION_TYPE_BY_CHECK,
  type MatchCheckResult,
  type ThreeWayMatchInput,
  type ThreeWayMatchResult,
} from "../rules/threeWayMatch.js";
import { AppError } from "../utils/AppError.js";
import { INVOICE_ENTITY, recordAudit } from "./audit.service.js";
import { recordException } from "./exception.service.js";

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/**
 * Everything threeWayMatch() needs, in one tenant-scoped read.
 *
 * The purchase order is reached through the invoice rather than through
 * ThreeWayMatch or GoodsReceipt: those two carry `purchaseOrderId` as a bare
 * scalar with no relation field, so they cannot be traversed to the PO.
 *
 * `sku`, `name` and `category` come off the catalog Product because invoice
 * lines are free text and have to be resolved back to a product by name.
 */
const matchingContextSelect = {
  id: true,
  organizationId: true,
  status: true,
  source: true,
  invoiceNumber: true,
  supplierNameRaw: true,
  poNumberRaw: true,
  currency: true,
  subtotalPaise: true,
  taxPaise: true,
  totalPaise: true,
  items: {
    select: {
      lineNumber: true,
      description: true,
      quantity: true,
      unitPricePaise: true,
      lineTotalPaise: true,
    },
    orderBy: { lineNumber: "asc" },
  },
  threeWayMatch: { select: { id: true, status: true } },
  payment: { select: { id: true, status: true } },
  purchaseOrder: {
    select: {
      id: true,
      poNumber: true,
      currency: true,
      subtotalPaise: true,
      taxPaise: true,
      totalPaise: true,
      supplier: { select: { name: true } },
      items: {
        select: {
          productId: true,
          description: true,
          quantity: true,
          unitPricePaise: true,
          lineTotalPaise: true,
          product: { select: { sku: true, name: true, category: true } },
        },
      },
      shipment: {
        select: {
          goodsReceipt: {
            select: {
              id: true,
              items: {
                select: {
                  productId: true,
                  orderedQuantity: true,
                  receivedQuantity: true,
                  acceptedQuantity: true,
                },
              },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.InvoiceSelect;

export type MatchingContext = Prisma.InvoiceGetPayload<{ select: typeof matchingContextSelect }>;

export async function loadMatchingContext(params: {
  organizationId: string;
  invoiceId: string;
}): Promise<MatchingContext> {
  const invoice = await prisma.invoice.findFirst({
    where: { id: params.invoiceId, organizationId: params.organizationId },
    select: matchingContextSelect,
  });

  // Scoping the lookup by organizationId means a cross-tenant id is
  // indistinguishable from a missing one, which is the point.
  if (!invoice) {
    throw AppError.notFound("Invoice not found");
  }

  return invoice;
}

/**
 * Canonical normalization for invoice numbers: lower-case, strip everything
 * that is not a letter or digit. Mirrors normalize() in src/rules/threeWayMatch.ts
 * and must stay in sync with it; exported so writers (e.g. invoice.service.ts)
 * can produce the same value when persisting the field.
 */
export function normalizeInvoiceNumber(value: string): string | null {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return normalized === "" ? null : normalized;
}

/**
 * Invoices this organization has already recorded under the same number.
 *
 * Queries the persisted `normalizedInvoiceNumber` column so the index on
 * @@index([organizationId, normalizedInvoiceNumber]) is used and format
 * variants (e.g. "INV-001" vs "inv001") are unified in the DB rather than
 * in application memory. Falls back to an empty result when the invoice
 * number is absent (an unnumbered document is caught separately by
 * checkDuplicateInvoice).
 */
export function loadPriorInvoices(params: {
  organizationId: string;
  invoiceId: string;
  invoiceNumber: string | null;
}): Promise<{ id: string; invoiceNumber: string | null }[]> {
  if (params.invoiceNumber === null) {
    return Promise.resolve([]);
  }

  const normalized = normalizeInvoiceNumber(params.invoiceNumber);

  if (normalized === null) {
    return Promise.resolve([]);
  }

  return prisma.invoice.findMany({
    where: {
      organizationId: params.organizationId,
      id: { not: params.invoiceId },
      normalizedInvoiceNumber: normalized,
      // A GENERATED invoice (the PDFKit convenience document) is expected to
      // share its number with the uploaded document the operator re-uploads —
      // that is the intended demo flow, not a duplicate. Only prior UPLOADED
      // invoices can trigger DUPLICATE_INVOICE.
      source: InvoiceSource.UPLOADED,
    },
    select: { id: true, invoiceNumber: true },
  });
}

/** Maps the loaded rows onto the rule module's plain-object contract. */
export function toMatchInput(
  context: MatchingContext,
  priorInvoices: { id: string; invoiceNumber: string | null }[],
): ThreeWayMatchInput {
  const po = context.purchaseOrder;
  const goodsReceipt = po.shipment?.goodsReceipt ?? null;

  return {
    purchaseOrder: {
      poNumber: po.poNumber,
      supplierName: po.supplier.name,
      currency: po.currency,
      subtotalPaise: po.subtotalPaise,
      taxPaise: po.taxPaise,
      totalPaise: po.totalPaise,
      items: po.items.map((item) => ({
        productId: item.productId,
        sku: item.product.sku,
        productName: item.product.name,
        category: item.product.category,
        description: item.description,
        quantity: item.quantity,
        unitPricePaise: item.unitPricePaise,
        lineTotalPaise: item.lineTotalPaise,
      })),
    },
    // Null when the goods have not arrived yet; the rule module treats a
    // missing receipt as a failed RECEIVED_QUANTITY check, not as agreement.
    goodsReceipt: goodsReceipt
      ? {
          items: goodsReceipt.items.map((item) => ({
            productId: item.productId,
            orderedQuantity: item.orderedQuantity,
            receivedQuantity: item.receivedQuantity,
            acceptedQuantity: item.acceptedQuantity,
          })),
        }
      : null,
    invoice: {
      id: context.id,
      invoiceNumber: context.invoiceNumber,
      supplierNameRaw: context.supplierNameRaw,
      poNumberRaw: context.poNumberRaw,
      currency: context.currency,
      subtotalPaise: context.subtotalPaise,
      taxPaise: context.taxPaise,
      totalPaise: context.totalPaise,
      items: context.items,
    },
    priorInvoices,
  };
}

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

/**
 * Claims the invoice for matching: EXTRACTED -> MATCHING.
 *
 * This guarded update is the primary idempotency gate. An invoice that has
 * already reached APPROVED, EXCEPTION or PAID cannot be claimed, so a
 * re-delivered BullMQ job does no work. MATCHING is accepted so a job can
 * resume its own interrupted attempt.
 */
export async function claimInvoiceForMatching(params: {
  organizationId: string;
  invoiceId: string;
}): Promise<boolean> {
  const { count } = await prisma.invoice.updateMany({
    where: {
      id: params.invoiceId,
      organizationId: params.organizationId,
      status: { in: [InvoiceStatus.EXTRACTED, InvoiceStatus.MATCHING] },
    },
    data: { status: InvoiceStatus.MATCHING },
  });

  return count > 0;
}

export function recordMatchStarted(params: {
  organizationId: string;
  invoiceId: string;
}): Promise<void> {
  return recordAudit(prisma, {
    organizationId: params.organizationId,
    actorType: "SYSTEM",
    action: "MATCH_STARTED",
    entityType: INVOICE_ENTITY,
    entityId: params.invoiceId,
  });
}

// ---------------------------------------------------------------------------
// Persist
// ---------------------------------------------------------------------------

export interface ApplyMatchResultParams {
  organizationId: string;
  invoiceId: string;
  purchaseOrder: { id: string; totalPaise: number; currency: string };
  goodsReceiptId: string | null;
  result: ThreeWayMatchResult;
}

/**
 * Persists the verdict, and everything that follows from it, atomically.
 *
 * A MATCHED invoice becomes APPROVED and the caller queues payment. A
 * MISMATCHED one becomes EXCEPTION, gets a BLOCKED payment row, and raises one
 * exception per distinct failure category — payment is never queued. Nothing
 * here consults an LLM: the verdict arrives already decided by
 * src/rules/threeWayMatch.ts.
 */
export async function applyMatchResult(params: ApplyMatchResultParams): Promise<MatchStatus> {
  const { organizationId, invoiceId, purchaseOrder, goodsReceiptId, result } = params;
  const matched = result.status === MatchStatus.MATCHED;
  const matchedAt = new Date();

  await prisma.$transaction(async (tx) => {
    const summary = {
      status: result.status,
      totalChecks: result.totalChecks,
      passedChecks: result.passedChecks,
      failedChecks: result.failedChecks,
      matchedAt,
    };

    // Upsert rather than create: a deliberate re-match (an invoice pushed back
    // to EXTRACTED after a human resolved an exception) must replace the old
    // verdict, not collide with ThreeWayMatch.invoiceId @unique.
    const match = await tx.threeWayMatch.upsert({
      where: { invoiceId },
      create: {
        organizationId,
        invoiceId,
        purchaseOrderId: purchaseOrder.id,
        goodsReceiptId,
        ...summary,
      },
      update: { goodsReceiptId, ...summary },
      select: { id: true },
    });

    // MatchCheck is @@unique([threeWayMatchId, checkType]); replacing the set
    // keeps a re-match idempotent instead of colliding row by row.
    await tx.matchCheck.deleteMany({ where: { threeWayMatchId: match.id } });
    await tx.matchCheck.createMany({
      data: result.checks.map((check) => ({
        threeWayMatchId: match.id,
        checkType: check.checkType,
        expected: check.expected,
        actual: check.actual,
        passed: check.passed,
        variance: check.variance,
        severity: check.severity,
      })),
    });

    const moved = await tx.invoice.updateMany({
      where: { id: invoiceId, organizationId, status: InvoiceStatus.MATCHING },
      data: { status: matched ? InvoiceStatus.APPROVED : InvoiceStatus.EXCEPTION },
    });

    if (moved.count === 0) {
      throw AppError.conflict("Invoice is no longer being matched", { invoiceId });
    }

    if (!matched) {
      const blockedReason = describeFailures(result.checks);

      // Payment.invoiceId @unique makes this upsert the idempotent way to
      // record the block. amountPaise comes from the purchase order — the
      // buyer's own deterministic figure — never from the AI-read invoice.
      await tx.payment.upsert({
        where: { invoiceId },
        create: {
          organizationId,
          invoiceId,
          purchaseOrderId: purchaseOrder.id,
          amountPaise: purchaseOrder.totalPaise,
          currency: purchaseOrder.currency,
          status: PaymentStatus.BLOCKED,
          blockedReason,
        },
        update: { status: PaymentStatus.BLOCKED, blockedReason, purchaseOrderId: purchaseOrder.id },
      });

      for (const [type, checks] of groupFailuresByExceptionType(result.checks)) {
        await recordException(tx, {
          organizationId,
          type,
          severity: worstSeverity(checks),
          entityType: INVOICE_ENTITY,
          entityId: invoiceId,
          title: `Three-way match failed: ${type.replace(/_/g, " ").toLowerCase()}`,
          description: describeFailures(checks),
          metadata: {
            checks: checks.map((check) => ({
              checkType: check.checkType,
              expected: check.expected,
              actual: check.actual,
              variance: check.variance,
            })),
          },
        });
      }
    }

    await recordAudit(tx, {
      organizationId,
      actorType: "SYSTEM",
      action: "MATCH_COMPLETED",
      entityType: INVOICE_ENTITY,
      entityId: invoiceId,
      metadata: {
        status: result.status,
        totalChecks: result.totalChecks,
        passedChecks: result.passedChecks,
        failedChecks: result.failedChecks,
      },
    });
  });

  return result.status;
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/**
 * Buckets the failed checks by the exception a human would act on.
 *
 * EXCEPTION_TYPE_BY_CHECK deliberately omits PO_NUMBER and PRODUCT — no
 * ExceptionType describes them, and filing them as a quantity or price mismatch
 * would send the reviewer looking in the wrong place. SYSTEM_FAILURE is the
 * honest fallback.
 *
 * Grouping matters because Exception is @@unique([organizationId, type,
 * entityId]): three failing money checks are one PRICE_MISMATCH row carrying
 * all three, not three upserts fighting over the same row.
 */
function groupFailuresByExceptionType(
  checks: MatchCheckResult[],
): Map<ExceptionType, MatchCheckResult[]> {
  const grouped = new Map<ExceptionType, MatchCheckResult[]>();

  for (const check of checks) {
    if (check.passed) {
      continue;
    }

    const type = exceptionTypeFor(check.checkType);
    const bucket = grouped.get(type);

    if (bucket) {
      bucket.push(check);
    } else {
      grouped.set(type, [check]);
    }
  }

  return grouped;
}

function exceptionTypeFor(checkType: MatchCheckType): ExceptionType {
  return EXCEPTION_TYPE_BY_CHECK[checkType] ?? ExceptionType.SYSTEM_FAILURE;
}

const SEVERITY_RANK: Record<Severity, number> = {
  [Severity.INFO]: 0,
  [Severity.WARNING]: 1,
  [Severity.CRITICAL]: 2,
};

function worstSeverity(checks: MatchCheckResult[]): Severity {
  return checks.reduce<Severity>(
    (worst, check) =>
      SEVERITY_RANK[check.severity] > SEVERITY_RANK[worst] ? check.severity : worst,
    Severity.INFO,
  );
}

/** One line per failed check: what was expected, what the invoice said. */
function describeFailures(checks: MatchCheckResult[]): string {
  const failed = checks.filter((check) => !check.passed);

  if (failed.length === 0) {
    return "No failed checks";
  }

  return failed
    .map((check) => `${check.checkType}: expected ${check.expected}, got ${check.actual}`)
    .join("; ");
}

// ---------------------------------------------------------------------------
// Terminal technical failure
// ---------------------------------------------------------------------------

/**
 * Used only once BullMQ has exhausted its retries on a *technical* failure —
 * never for a mismatch, which is a legitimate verdict with its own exceptions.
 *
 * The invoice is left where it is rather than forced to FAILED: matching can be
 * re-driven safely once the underlying problem is fixed, and the open exception
 * is what tells a human to do so.
 */
export async function recordMatchingSystemFailure(params: {
  organizationId: string;
  invoiceId: string;
  reason: string;
}): Promise<void> {
  const { organizationId, invoiceId, reason } = params;

  await prisma.$transaction(async (tx) => {
    await recordException(tx, {
      organizationId,
      type: ExceptionType.SYSTEM_FAILURE,
      severity: Severity.CRITICAL,
      entityType: INVOICE_ENTITY,
      entityId: invoiceId,
      title: "Three-way matching failed",
      description: reason,
    });

    await recordAudit(tx, {
      organizationId,
      actorType: "SYSTEM",
      action: "WORKFLOW_FAILED",
      entityType: INVOICE_ENTITY,
      entityId: invoiceId,
      metadata: { stage: "matching", reason },
    });
  });
}
