import { prisma } from "../config/prisma.js";
import type { Prisma } from "../generated/prisma/client.js";
import { InvoiceSource, PurchaseOrderStatus } from "../generated/prisma/enums.js";
import {
  type AnomalySignal,
  detectInvoiceAnomalies,
  detectPurchaseOrderAnomalies,
} from "../rules/anomalyDetection.js";

/**
 * Loads the history the anomaly rules need, asks them what they see, and files
 * the answers.
 *
 * Every call site is observability, never control flow: these functions are
 * invoked *after* the decision they observe has been persisted, they return
 * void, and they swallow their own errors the way recordAIProcessing does. A
 * signal must never be able to fail a job or change a financial outcome — the
 * deterministic rules in threeWayMatch.ts and paymentRules.ts stay the only
 * gates.
 */

/**
 * Upsert, not create. A re-delivered BullMQ job re-derives the same signal from
 * the same history, and AnomalySignal is unique on
 * [organizationId, signalType, entityType, entityId], so a retry refreshes the
 * row rather than filling the feed with duplicates.
 */
async function persist(organizationId: string, signals: AnomalySignal[]): Promise<void> {
  for (const signal of signals) {
    const data = {
      organizationId,
      signalType: signal.signalType,
      severity: signal.severity,
      entityType: signal.entityType,
      entityId: signal.entityId,
      score: signal.score,
      observed: signal.observed,
      baseline: signal.baseline,
      explanation: signal.explanation,
      metadata: signal.metadata satisfies Prisma.InputJsonValue,
    };

    await prisma.anomalySignal.upsert({
      where: {
        organizationId_signalType_entityType_entityId: {
          organizationId,
          signalType: signal.signalType,
          entityType: signal.entityType,
          entityId: signal.entityId,
        },
      },
      create: data,
      update: data,
    });
  }
}

/**
 * Purchase orders this supplier has previously been given, and the unit prices
 * they charged. Excludes the order being evaluated, and excludes REJECTED
 * orders — a price nobody agreed to is not evidence of what the supplier
 * normally charges.
 */
async function loadSupplierPriceHistory(params: {
  organizationId: string;
  supplierId: string;
  purchaseOrderId: string;
  productIds: string[];
}): Promise<Map<string, number[]>> {
  const rows = await prisma.purchaseOrderItem.findMany({
    where: {
      productId: { in: params.productIds },
      purchaseOrder: {
        organizationId: params.organizationId,
        supplierId: params.supplierId,
        id: { not: params.purchaseOrderId },
        status: { not: PurchaseOrderStatus.REJECTED },
      },
    },
    select: { productId: true, unitPricePaise: true },
  });

  const byProduct = new Map<string, number[]>();
  for (const row of rows) {
    const prices = byProduct.get(row.productId) ?? [];
    prices.push(row.unitPricePaise);
    byProduct.set(row.productId, prices);
  }

  return byProduct;
}

export interface PurchaseOrderAnomalyContext {
  organizationId: string;
  purchaseOrderId: string;
}

/**
 * Evaluates a freshly created purchase order.
 *
 * Called from the purchase-order worker once the order is committed, so a
 * failure here leaves a perfectly good purchase order with no signals attached
 * rather than no purchase order at all.
 */
export async function evaluatePurchaseOrder(
  context: PurchaseOrderAnomalyContext,
): Promise<AnomalySignal[]> {
  const { organizationId, purchaseOrderId } = context;

  try {
    const purchaseOrder = await prisma.purchaseOrder.findFirst({
      where: { id: purchaseOrderId, organizationId },
      select: {
        id: true,
        currency: true,
        totalPaise: true,
        supplierId: true,
        supplier: {
          select: {
            id: true,
            name: true,
            reliabilityScore: true,
            baselineReliability: true,
            avgLeadTimeDays: true,
            totalDeliveries: true,
          },
        },
        items: {
          orderBy: { createdAt: "asc" },
          select: {
            productId: true,
            quantity: true,
            unitPricePaise: true,
            product: { select: { name: true } },
            supplierProduct: { select: { deliveryDays: true } },
          },
        },
      },
    });

    if (!purchaseOrder || purchaseOrder.items.length === 0) {
      return [];
    }

    const productIds = purchaseOrder.items.map((item) => item.productId);

    const [priorOrderCount, priceHistory, priorQuantityRows] = await Promise.all([
      prisma.purchaseOrder.count({
        where: {
          organizationId,
          supplierId: purchaseOrder.supplierId,
          id: { not: purchaseOrderId },
          status: { not: PurchaseOrderStatus.REJECTED },
        },
      }),
      loadSupplierPriceHistory({
        organizationId,
        supplierId: purchaseOrder.supplierId,
        purchaseOrderId,
        productIds,
      }),
      // Quantity history is organization-wide, not per supplier: "is this a
      // normal amount of this thing to buy" is a question about the business,
      // not about who is selling it.
      prisma.purchaseOrderItem.findMany({
        where: {
          productId: { in: productIds },
          purchaseOrder: {
            organizationId,
            id: { not: purchaseOrderId },
            status: { not: PurchaseOrderStatus.REJECTED },
          },
        },
        select: { quantity: true },
      }),
    ]);

    // The MVP builds single-line purchase orders, but the rules take a list, so
    // the first line stands in for the order's headline product and the price
    // check walks every line regardless.
    const [headline] = purchaseOrder.items as [(typeof purchaseOrder.items)[number]];

    const signals = detectPurchaseOrderAnomalies({
      purchaseOrderId: purchaseOrder.id,
      supplierId: purchaseOrder.supplierId,
      supplierName: purchaseOrder.supplier.name,
      currency: purchaseOrder.currency,
      totalPaise: purchaseOrder.totalPaise,
      priorOrderCount,
      productName: headline.product.name,
      quantity: headline.quantity,
      priorQuantities: priorQuantityRows.map((row) => row.quantity),
      lines: purchaseOrder.items.map((item) => ({
        productId: item.productId,
        productName: item.product.name,
        unitPricePaise: item.unitPricePaise,
        priorUnitPricesPaise: priceHistory.get(item.productId) ?? [],
      })),
      quotedDeliveryDays: headline.supplierProduct?.deliveryDays ?? 0,
      measuredLeadTimeDays: purchaseOrder.supplier.avgLeadTimeDays,
      deliveriesObserved: purchaseOrder.supplier.totalDeliveries,
      reliabilityScore: purchaseOrder.supplier.reliabilityScore,
      baselineReliability: purchaseOrder.supplier.baselineReliability,
    });

    await persist(organizationId, signals);
    return signals;
  } catch (error) {
    // Advisory work must never fail the job that produced the purchase order.
    console.error(`Failed to evaluate anomalies for purchase order ${purchaseOrderId}:`, error);
    return [];
  }
}

export interface InvoiceAnomalyContext {
  organizationId: string;
  invoiceId: string;
}

/**
 * Evaluates an invoice once three-way matching has recorded its verdict.
 *
 * GENERATED invoices are skipped for the same reason the invoice and matching
 * workers skip them: they are convenience documents this system produced
 * itself, so comparing them against the supplier's billing history is
 * comparing our own arithmetic to itself.
 */
export async function evaluateInvoice(context: InvoiceAnomalyContext): Promise<AnomalySignal[]> {
  const { organizationId, invoiceId } = context;

  try {
    const invoice = await prisma.invoice.findFirst({
      where: { id: invoiceId, organizationId, source: InvoiceSource.UPLOADED },
      select: {
        id: true,
        supplierId: true,
        invoiceNumber: true,
        invoiceDate: true,
        totalPaise: true,
        currency: true,
        purchaseOrder: { select: { currency: true, supplier: { select: { name: true } } } },
      },
    });

    if (!invoice || invoice.supplierId === null) {
      return [];
    }

    const priorInvoices = await prisma.invoice.findMany({
      where: {
        organizationId,
        supplierId: invoice.supplierId,
        id: { not: invoiceId },
        source: InvoiceSource.UPLOADED,
      },
      select: { id: true, invoiceNumber: true, totalPaise: true, invoiceDate: true },
    });

    const signals = detectInvoiceAnomalies({
      invoiceId: invoice.id,
      supplierName: invoice.purchaseOrder.supplier.name,
      // The purchase order's currency, not the invoice's: this is a display
      // label, and the invoice's own currency may be null or wrong — that
      // disagreement is threeWayMatch's CURRENCY check to report, not ours.
      currency: invoice.purchaseOrder.currency,
      totalPaise: invoice.totalPaise,
      invoiceNumber: invoice.invoiceNumber,
      invoiceDate: invoice.invoiceDate,
      priorInvoices,
    });

    await persist(organizationId, signals);
    return signals;
  } catch (error) {
    console.error(`Failed to evaluate anomalies for invoice ${invoiceId}:`, error);
    return [];
  }
}
