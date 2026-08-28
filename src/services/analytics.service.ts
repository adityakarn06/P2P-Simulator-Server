import { prisma } from "../config/prisma.js";
import type { Prisma } from "../generated/prisma/client.js";
import {
  ExceptionStatus,
  InvoiceSource,
  InvoiceStatus,
  MatchStatus,
  PaymentKind,
  PaymentStatus,
  PurchaseOrderStatus,
  RequisitionStatus,
} from "../generated/prisma/enums.js";
import { type SupplierScorecard, toScorecard } from "../rules/supplierPerformance.js";
import { formatMoney } from "../rules/supplierRanking.js";
import type {
  AnalyticsRange,
  ListAnomaliesQuery,
  SupplierScorecardQuery,
} from "../zod/analytics.schema.js";

/**
 * Read-only aggregation over what the workflow has already recorded.
 *
 * Nothing here writes, enqueues, or decides — PostgreSQL is the source of
 * truth and this file only asks it questions. Every query is scoped by
 * organizationId; `SupplierProduct` and `PurchaseOrderItem` carry no
 * organizationId of their own, so those are scoped through their relations,
 * the way findCandidateOffers already does in src/services/sourcing.service.ts.
 *
 * Money stays in integer paise on the way out. A `Display` string is provided
 * alongside each figure for convenience, but it is formatted from the integer
 * and is never the value a client should compute with.
 */

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Prisma date filter for the requested window, or undefined when unbounded. */
function createdWithin(range: AnalyticsRange): Prisma.DateTimeFilter | undefined {
  if (!range.from && !range.to) {
    return undefined;
  }
  return {
    ...(range.from ? { gte: range.from } : {}),
    ...(range.to ? { lte: range.to } : {}),
  };
}

function whereInRange(organizationId: string, range: AnalyticsRange) {
  const createdAt = createdWithin(range);
  return { organizationId, ...(createdAt ? { createdAt } : {}) };
}

/**
 * A rate over a denominator that may be zero.
 *
 * Null, not zero, when there is nothing to divide: "no invoices yet" and "no
 * invoice ever went through untouched" are opposite facts and must not render
 * as the same 0%.
 */
function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : round4(numerator / denominator);
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

interface Money {
  paise: number;
  display: string;
}

function money(paise: number, currency: string): Money {
  return { paise, display: formatMoney(paise, currency) };
}

/** Counts keyed by status, with every enum member present so a client can render a fixed axis. */
function countsByStatus<T extends string>(
  members: readonly T[],
  rows: { status: T; _count: { _all: number } }[],
): Record<T, number> {
  const counts = Object.fromEntries(members.map((member) => [member, 0])) as Record<T, number>;
  for (const row of rows) {
    counts[row.status] = row._count._all;
  }
  return counts;
}

/**
 * Median rather than only a mean, because procurement durations are skewed:
 * one requisition left open over a weekend drags an average that a buyer then
 * cannot recognise as their own process.
 */
interface DurationStats {
  count: number;
  meanHours: number | null;
  medianHours: number | null;
  p90Hours: number | null;
}

function describeDurations(millis: number[]): DurationStats {
  if (millis.length === 0) {
    return { count: 0, meanHours: null, medianHours: null, p90Hours: null };
  }

  const hours = millis.map((value) => value / 3_600_000).sort((a, b) => a - b);
  const mean = hours.reduce((total, value) => total + value, 0) / hours.length;

  return {
    count: hours.length,
    meanHours: round2(mean),
    medianHours: round2(quantile(hours, 0.5)),
    p90Hours: round2(quantile(hours, 0.9)),
  };
}

/** Nearest-rank on an already-sorted array. Exact enough for a dashboard, and never interpolates past the ends. */
function quantile(sorted: number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] as number;
}

/** Elapsed millis between two timestamps, or null if either is missing or the pair runs backwards. */
function elapsed(from: Date | null | undefined, to: Date | null | undefined): number | null {
  if (!from || !to) {
    return null;
  }
  const delta = to.getTime() - from.getTime();
  return delta < 0 ? null : delta;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export interface AnalyticsSummary {
  range: { from: string | null; to: string | null };
  currency: string;
  funnel: {
    requisitions: Record<string, number>;
    purchaseOrders: Record<string, number>;
    invoices: Record<string, number>;
    payments: Record<string, number>;
  };
  automation: {
    /**
     * Invoices that reached PAID without a single exception ever being raised
     * against them, over invoices that reached a terminal state.
     *
     * Invoice-side only, and named so. Purchase-order approval is deliberately
     * a human step in this build (PO_AUTO_APPROVE_ENABLED is false), so an
     * end-to-end "touchless" figure would be 0 by construction and would say
     * nothing about how well the automation works.
     */
    touchlessInvoiceRate: number | null;
    touchlessInvoices: number;
    terminalInvoices: number;
    /** Matches that passed all twelve checks on the first run, over all matches. */
    firstPassMatchRate: number | null;
    matchesRun: number;
    matchesPassed: number;
    /** Invoices that needed a human to resolve an exception before they could be paid. */
    invoicesRequiringReview: number;
  };
  cycleTimes: {
    requisitionToPurchaseOrder: DurationStats;
    purchaseOrderToApproval: DurationStats;
    approvalToDelivery: DurationStats;
    invoiceToPayment: DurationStats;
    endToEnd: DurationStats;
  };
  exceptions: {
    byType: { type: string; open: number; resolved: number; rejected: number; total: number }[];
    openTotal: number;
    meanResolutionHours: number | null;
  };
  spend: {
    committed: Money;
    paid: Money;
    blocked: Money;
    /**
     * Invoices settled for less than they asked for — the money saved by paying
     * for what actually arrived rather than what was billed.
     *
     * `count` is invoices, not payment rows, and `shortfall` is billed minus
     * everything settled against each one. An invoice partially paid and then
     * topped up to its full amount therefore contributes nothing to the
     * shortfall, which is the honest answer.
     */
    partialSettlements: { count: number; paid: Money; shortfall: Money };
    /** Committed but not yet settled: the organization's outstanding liability. */
    unsettledCommitment: Money;
    topSuppliers: { supplierId: string; supplierName: string; orders: number; total: Money }[];
  };
  ai: {
    byJobType: {
      jobType: string;
      runs: number;
      successRate: number | null;
      p50LatencyMs: number | null;
      p95LatencyMs: number | null;
    }[];
  };
}

/** Invoice statuses that mean the workflow is finished with the document, one way or another. */
const TERMINAL_INVOICE_STATUSES: InvoiceStatus[] = [
  InvoiceStatus.PAID,
  InvoiceStatus.EXCEPTION,
  InvoiceStatus.FAILED,
];

export async function getAnalyticsSummary(params: {
  organizationId: string;
  range: AnalyticsRange;
}): Promise<AnalyticsSummary> {
  const { organizationId, range } = params;
  const where = whereInRange(organizationId, range);

  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { currency: true },
  });
  const currency = organization?.currency ?? "INR";

  const [funnel, automation, cycleTimes, exceptions, spend, ai] = await Promise.all([
    loadFunnel(where),
    loadAutomation(organizationId, where),
    loadCycleTimes(organizationId, range),
    loadExceptions(where),
    loadSpend(organizationId, where, currency),
    loadAIStats(where),
  ]);

  return {
    range: {
      from: range.from?.toISOString() ?? null,
      to: range.to?.toISOString() ?? null,
    },
    currency,
    funnel,
    automation,
    cycleTimes,
    exceptions,
    spend,
    ai,
  };
}

async function loadFunnel(where: { organizationId: string; createdAt?: Prisma.DateTimeFilter }) {
  const [requisitions, purchaseOrders, invoices, payments] = await Promise.all([
    prisma.requisition.groupBy({ by: ["status"], where, _count: { _all: true } }),
    prisma.purchaseOrder.groupBy({ by: ["status"], where, _count: { _all: true } }),
    prisma.invoice.groupBy({
      by: ["status"],
      // GENERATED invoices are documents this system produced for a supplier to
      // return; counting them as invoices received would double the funnel.
      where: { ...where, source: InvoiceSource.UPLOADED },
      _count: { _all: true },
    }),
    prisma.payment.groupBy({ by: ["status"], where, _count: { _all: true } }),
  ]);

  return {
    requisitions: countsByStatus(REQUISITION_STATUSES, requisitions),
    purchaseOrders: countsByStatus(PURCHASE_ORDER_STATUSES, purchaseOrders),
    invoices: countsByStatus(INVOICE_STATUSES, invoices),
    payments: countsByStatus(PAYMENT_STATUSES, payments),
  };
}

async function loadAutomation(
  organizationId: string,
  where: { organizationId: string; createdAt?: Prisma.DateTimeFilter },
): Promise<AnalyticsSummary["automation"]> {
  const invoiceWhere = { ...where, source: InvoiceSource.UPLOADED };

  const [terminalInvoices, paidInvoiceIds, matchesRun, matchesPassed] = await Promise.all([
    prisma.invoice.count({
      where: { ...invoiceWhere, status: { in: TERMINAL_INVOICE_STATUSES } },
    }),
    prisma.invoice.findMany({
      where: { ...invoiceWhere, status: InvoiceStatus.PAID },
      select: { id: true },
    }),
    prisma.threeWayMatch.count({ where }),
    prisma.threeWayMatch.count({ where: { ...where, status: MatchStatus.MATCHED } }),
  ]);

  // "Touchless" means no human ever had to intervene — so an exception that was
  // raised and then resolved still disqualifies the invoice. Counting only
  // *currently open* exceptions would mark every successfully reviewed invoice
  // as touchless and inflate the headline number, which is the one figure on
  // this dashboard nobody should be able to accuse of flattery.
  const touchedInvoiceIds = await prisma.exception.findMany({
    where: {
      organizationId,
      entityType: "Invoice",
      entityId: { in: paidInvoiceIds.map((invoice) => invoice.id) },
    },
    select: { entityId: true },
    distinct: ["entityId"],
  });

  const touched = new Set(touchedInvoiceIds.map((row) => row.entityId));
  const touchlessInvoices = paidInvoiceIds.filter((invoice) => !touched.has(invoice.id)).length;

  return {
    touchlessInvoiceRate: rate(touchlessInvoices, terminalInvoices),
    touchlessInvoices,
    terminalInvoices,
    firstPassMatchRate: rate(matchesPassed, matchesRun),
    matchesRun,
    matchesPassed,
    invoicesRequiringReview: touched.size,
  };
}

/**
 * Stage durations, measured from the entities themselves rather than from the
 * audit log: every timestamp needed already exists as a column, and a column is
 * not subject to an audit row being written a beat late.
 */
async function loadCycleTimes(
  organizationId: string,
  range: AnalyticsRange,
): Promise<AnalyticsSummary["cycleTimes"]> {
  const createdAt = createdWithin(range);

  const requisitions = await prisma.requisition.findMany({
    where: { organizationId, ...(createdAt ? { createdAt } : {}) },
    select: {
      createdAt: true,
      purchaseOrder: {
        select: {
          createdAt: true,
          approvedAt: true,
          shipment: { select: { deliveredAt: true } },
          invoices: {
            where: { source: InvoiceSource.UPLOADED },
            orderBy: { createdAt: "asc" },
            take: 1,
            select: {
              createdAt: true,
              // An invoice settled in tranches is "paid" when the last one
              // lands, so the cycle time measures the whole settlement rather
              // than a partial payment that left a balance outstanding.
              payments: {
                where: { status: PaymentStatus.COMPLETED },
                orderBy: { completedAt: "desc" },
                take: 1,
                select: { completedAt: true },
              },
            },
          },
        },
      },
    },
  });

  const buckets = {
    requisitionToPurchaseOrder: [] as number[],
    purchaseOrderToApproval: [] as number[],
    approvalToDelivery: [] as number[],
    invoiceToPayment: [] as number[],
    endToEnd: [] as number[],
  };

  for (const requisition of requisitions) {
    const purchaseOrder = requisition.purchaseOrder;
    if (!purchaseOrder) {
      continue;
    }

    const invoice = purchaseOrder.invoices.at(0) ?? null;
    const paidAt = invoice?.payments.at(0)?.completedAt ?? null;

    push(buckets.requisitionToPurchaseOrder, requisition.createdAt, purchaseOrder.createdAt);
    push(buckets.purchaseOrderToApproval, purchaseOrder.createdAt, purchaseOrder.approvedAt);
    push(
      buckets.approvalToDelivery,
      purchaseOrder.approvedAt,
      purchaseOrder.shipment?.deliveredAt ?? null,
    );
    push(buckets.invoiceToPayment, invoice?.createdAt ?? null, paidAt);
    push(buckets.endToEnd, requisition.createdAt, paidAt);
  }

  return {
    requisitionToPurchaseOrder: describeDurations(buckets.requisitionToPurchaseOrder),
    purchaseOrderToApproval: describeDurations(buckets.purchaseOrderToApproval),
    approvalToDelivery: describeDurations(buckets.approvalToDelivery),
    invoiceToPayment: describeDurations(buckets.invoiceToPayment),
    endToEnd: describeDurations(buckets.endToEnd),
  };
}

/** Only complete, forward-running pairs contribute — a half-finished flow is not a fast one. */
function push(bucket: number[], from: Date | null, to: Date | null): void {
  const duration = elapsed(from, to);
  if (duration !== null) {
    bucket.push(duration);
  }
}

async function loadExceptions(where: {
  organizationId: string;
  createdAt?: Prisma.DateTimeFilter;
}): Promise<AnalyticsSummary["exceptions"]> {
  const [grouped, resolved] = await Promise.all([
    prisma.exception.groupBy({ by: ["type", "status"], where, _count: { _all: true } }),
    prisma.exception.findMany({
      where: { ...where, resolvedAt: { not: null } },
      select: { createdAt: true, resolvedAt: true },
    }),
  ]);

  const byType = new Map<
    string,
    { type: string; open: number; resolved: number; rejected: number; total: number }
  >();

  for (const row of grouped) {
    const entry = byType.get(row.type) ?? {
      type: row.type,
      open: 0,
      resolved: 0,
      rejected: 0,
      total: 0,
    };
    const count = row._count._all;

    // OPEN and UNDER_REVIEW are both "still on someone's desk" — the split
    // between them is workflow detail a summary does not need.
    if (row.status === ExceptionStatus.OPEN || row.status === ExceptionStatus.UNDER_REVIEW) {
      entry.open += count;
    } else if (row.status === ExceptionStatus.RESOLVED) {
      entry.resolved += count;
    } else {
      entry.rejected += count;
    }

    entry.total += count;
    byType.set(row.type, entry);
  }

  const durations = resolved
    .map((row) => elapsed(row.createdAt, row.resolvedAt))
    .filter((value) => value !== null);

  return {
    byType: [...byType.values()].sort((a, b) => b.total - a.total || a.type.localeCompare(b.type)),
    openTotal: [...byType.values()].reduce((total, entry) => total + entry.open, 0),
    meanResolutionHours: describeDurations(durations).meanHours,
  };
}

async function loadSpend(
  organizationId: string,
  where: { organizationId: string; createdAt?: Prisma.DateTimeFilter },
  currency: string,
): Promise<AnalyticsSummary["spend"]> {
  const [committed, paid, blocked, partial, bySupplier] = await Promise.all([
    // Everything actually ordered: a rejected purchase order committed nothing.
    prisma.purchaseOrder.aggregate({
      where: { ...where, status: { not: PurchaseOrderStatus.REJECTED } },
      _sum: { totalPaise: true },
    }),
    prisma.payment.aggregate({
      where: { ...where, status: PaymentStatus.COMPLETED },
      _sum: { amountPaise: true },
    }),
    prisma.payment.aggregate({
      where: { ...where, status: PaymentStatus.BLOCKED },
      _sum: { amountPaise: true },
    }),
    // Grouped by invoice, not by payment. The shortfall is a property of the
    // invoice — billed minus the sum of every tranche settling it — so counting
    // it per PARTIAL row would double-count an invoice paid in two instalments
    // and would still report a large "saved" figure for one eventually settled
    // in full.
    //
    // Only COMPLETED tranches count. One still in flight has saved nothing yet,
    // and one that failed never will.
    prisma.invoice.findMany({
      where: {
        organizationId,
        payments: {
          some: { ...where, status: PaymentStatus.COMPLETED, kind: PaymentKind.PARTIAL },
        },
      },
      select: {
        totalPaise: true,
        payments: {
          where: { status: PaymentStatus.COMPLETED },
          select: { amountPaise: true },
        },
      },
    }),
    prisma.purchaseOrder.groupBy({
      by: ["supplierId"],
      where: { ...where, status: { not: PurchaseOrderStatus.REJECTED } },
      _sum: { totalPaise: true },
      _count: { _all: true },
      orderBy: { _sum: { totalPaise: "desc" } },
      take: 10,
    }),
  ]);

  const suppliers = await prisma.supplier.findMany({
    where: { organizationId, id: { in: bySupplier.map((row) => row.supplierId) } },
    select: { id: true, name: true },
  });
  const namesById = new Map(suppliers.map((supplier) => [supplier.id, supplier.name]));

  const partialSettled = partial.map((invoice) => ({
    totalPaise: invoice.totalPaise,
    paidPaise: invoice.payments.reduce((total, row) => total + row.amountPaise, 0),
  }));

  const partialPaidPaise = partialSettled.reduce((total, row) => total + row.paidPaise, 0);
  const partialShortfallPaise = partialSettled.reduce(
    (total, row) =>
      total + (row.totalPaise === null ? 0 : Math.max(0, row.totalPaise - row.paidPaise)),
    0,
  );

  const committedPaise = committed._sum.totalPaise ?? 0;
  const paidPaise = paid._sum.amountPaise ?? 0;

  return {
    committed: money(committedPaise, currency),
    paid: money(paidPaise, currency),
    blocked: money(blocked._sum.amountPaise ?? 0, currency),
    partialSettlements: {
      // Invoices touched by a partial settlement, not tranches.
      count: partialSettled.length,
      paid: money(partialPaidPaise, currency),
      shortfall: money(partialShortfallPaise, currency),
    },
    unsettledCommitment: money(Math.max(0, committedPaise - paidPaise), currency),
    topSuppliers: bySupplier.map((row) => ({
      supplierId: row.supplierId,
      supplierName: namesById.get(row.supplierId) ?? "Unknown supplier",
      orders: row._count._all,
      total: money(row._sum.totalPaise ?? 0, currency),
    })),
  };
}

/**
 * Surfaces AIProcessingLog, which until now was written by three call sites and
 * read by none. Latency percentiles are what tell you whether the Gemini calls
 * are the reason the workflow feels slow.
 */
async function loadAIStats(where: {
  organizationId: string;
  createdAt?: Prisma.DateTimeFilter;
}): Promise<AnalyticsSummary["ai"]> {
  const rows = await prisma.aIProcessingLog.findMany({
    where,
    select: { jobType: true, success: true, latencyMs: true },
  });

  const byJobType = new Map<string, { successes: number; latencies: number[] }>();

  for (const row of rows) {
    const entry = byJobType.get(row.jobType) ?? { successes: 0, latencies: [] };
    entry.successes += row.success ? 1 : 0;
    entry.latencies.push(row.latencyMs);
    byJobType.set(row.jobType, entry);
  }

  return {
    byJobType: [...byJobType.entries()]
      .map(([jobType, entry]) => {
        const sorted = [...entry.latencies].sort((a, b) => a - b);
        return {
          jobType,
          runs: sorted.length,
          successRate: rate(entry.successes, sorted.length),
          p50LatencyMs: sorted.length === 0 ? null : Math.round(quantile(sorted, 0.5)),
          p95LatencyMs: sorted.length === 0 ? null : Math.round(quantile(sorted, 0.95)),
        };
      })
      .sort((a, b) => b.runs - a.runs || a.jobType.localeCompare(b.jobType)),
  };
}

// ---------------------------------------------------------------------------
// Supplier scorecard
// ---------------------------------------------------------------------------

export interface SupplierScorecardRow extends SupplierScorecard {
  supplierId: string;
  supplierName: string;
  isActive: boolean;
  rating: number;
  /** The score the supplier was onboarded with, so the movement is visible. */
  baselineReliability: number | null;
  reliabilityDelta: number | null;
  purchaseOrders: number;
  spend: Money;
  lastDeliveryAt: string | null;
}

/**
 * The vendor scorecard the OTIF loop makes possible.
 *
 * `reliabilityScore` here is not decoration: it is 20% of the sourcing score in
 * src/rules/supplierRanking.ts, so this table shows exactly why the next
 * requisition will pick who it picks.
 */
export async function getSupplierScorecards(params: {
  organizationId: string;
  query: SupplierScorecardQuery;
}): Promise<{ suppliers: SupplierScorecardRow[] }> {
  const { organizationId, query } = params;

  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { currency: true },
  });
  const currency = organization?.currency ?? "INR";

  const suppliers = await prisma.supplier.findMany({
    where: { organizationId },
    select: {
      id: true,
      name: true,
      isActive: true,
      rating: true,
      reliabilityScore: true,
      baselineReliability: true,
      totalDeliveries: true,
      onTimeDeliveries: true,
      inFullDeliveries: true,
      orderedUnits: true,
      acceptedUnits: true,
      damagedUnits: true,
      avgLeadTimeDays: true,
      lastDeliveryAt: true,
    },
    orderBy: [{ reliabilityScore: "desc" }, { name: "asc" }],
    take: query.limit,
  });

  const spend = await prisma.purchaseOrder.groupBy({
    by: ["supplierId"],
    where: {
      organizationId,
      supplierId: { in: suppliers.map((supplier) => supplier.id) },
      status: { not: PurchaseOrderStatus.REJECTED },
    },
    _sum: { totalPaise: true },
    _count: { _all: true },
  });
  const spendById = new Map(spend.map((row) => [row.supplierId, row]));

  return {
    suppliers: suppliers.map((supplier) => {
      const scorecard = toScorecard(supplier);
      const orders = spendById.get(supplier.id);

      return {
        ...scorecard,
        supplierId: supplier.id,
        supplierName: supplier.name,
        isActive: supplier.isActive,
        rating: supplier.rating,
        baselineReliability: supplier.baselineReliability,
        reliabilityDelta:
          supplier.baselineReliability === null
            ? null
            : round4(supplier.reliabilityScore - supplier.baselineReliability),
        purchaseOrders: orders?._count._all ?? 0,
        spend: money(orders?._sum.totalPaise ?? 0, currency),
        lastDeliveryAt: supplier.lastDeliveryAt?.toISOString() ?? null,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Anomaly feed
// ---------------------------------------------------------------------------

const anomalySignalSelect = {
  id: true,
  signalType: true,
  severity: true,
  entityType: true,
  entityId: true,
  score: true,
  observed: true,
  baseline: true,
  explanation: true,
  metadata: true,
  createdAt: true,
} satisfies Prisma.AnomalySignalSelect;

export type AnomalySignalView = Prisma.AnomalySignalGetPayload<{
  select: typeof anomalySignalSelect;
}>;

/** Cursor-paginated, matching the shape listAuditLogs already returns. */
export async function listAnomalySignals(params: {
  organizationId: string;
  query: ListAnomaliesQuery;
}): Promise<{ signals: AnomalySignalView[]; nextCursor: string | null }> {
  const { organizationId, query } = params;
  const createdAt = createdWithin(query);

  const signals = await prisma.anomalySignal.findMany({
    where: {
      organizationId,
      ...(createdAt ? { createdAt } : {}),
      ...(query.severity ? { severity: query.severity } : {}),
      ...(query.signalType ? { signalType: query.signalType } : {}),
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
    },
    select: anomalySignalSelect,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    // One extra row tells us whether another page exists without a second query.
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });

  const page = signals.slice(0, query.limit);

  return {
    signals: page,
    nextCursor: signals.length > query.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

// ---------------------------------------------------------------------------
// Enum axes, so a chart keeps a stable shape on an empty organization
// ---------------------------------------------------------------------------

// Derived from the generated enums rather than retyped: a status added to the
// schema must appear on the dashboard automatically, not silently go missing.
const REQUISITION_STATUSES = Object.values(RequisitionStatus);
const PURCHASE_ORDER_STATUSES = Object.values(PurchaseOrderStatus);
const INVOICE_STATUSES = Object.values(InvoiceStatus);
const PAYMENT_STATUSES = Object.values(PaymentStatus);
