import type { Request, Response } from "express";
import { renderPurchaseOrderPdf } from "../pdf/documents/purchaseOrder.pdf.js";
import { generateInvoiceForPurchaseOrder } from "../services/invoice.service.js";
import {
  approvePurchaseOrder,
  getPurchaseOrder,
  listPurchaseOrders,
  loadPurchaseOrderForDocuments,
  rejectPurchaseOrder,
} from "../services/purchaseOrder.service.js";
import { AppError } from "../utils/AppError.js";
import { sendPdf } from "../utils/fileResponse.js";
import { sendSuccess } from "../utils/response.js";
import {
  generateInvoiceSchema,
  listPurchaseOrdersQuerySchema,
  purchaseOrderIdParamSchema,
  rejectPurchaseOrderSchema,
} from "../zod/purchaseOrder.schema.js";

function requireTenant(req: Request): { organizationId: string; userId: string } {
  if (!req.auth) {
    throw AppError.unauthorized();
  }
  return { organizationId: req.auth.organizationId, userId: req.auth.userId };
}

export async function getPurchaseOrderById(req: Request, res: Response): Promise<void> {
  const { organizationId } = requireTenant(req);
  const { id } = purchaseOrderIdParamSchema.parse(req.params);

  sendSuccess(res, await getPurchaseOrder({ organizationId, purchaseOrderId: id }));
}

export async function getPurchaseOrders(req: Request, res: Response): Promise<void> {
  const { organizationId } = requireTenant(req);
  const query = listPurchaseOrdersQuerySchema.parse(req.query);

  sendSuccess(res, await listPurchaseOrders({ organizationId, ...query }));
}

export async function postPurchaseOrderApproval(req: Request, res: Response): Promise<void> {
  const { organizationId, userId } = requireTenant(req);
  const { id } = purchaseOrderIdParamSchema.parse(req.params);

  sendSuccess(res, await approvePurchaseOrder({ organizationId, purchaseOrderId: id, userId }));
}

export async function postPurchaseOrderRejection(req: Request, res: Response): Promise<void> {
  const { organizationId, userId } = requireTenant(req);
  const { id } = purchaseOrderIdParamSchema.parse(req.params);
  const { reason } = rejectPurchaseOrderSchema.parse(req.body);

  sendSuccess(
    res,
    await rejectPurchaseOrder({ organizationId, purchaseOrderId: id, userId, reason }),
  );
}

/** Renders the purchase order as a PDF and streams it straight to the browser — nothing is stored. */
export async function getPurchaseOrderPdf(req: Request, res: Response): Promise<void> {
  const { organizationId } = requireTenant(req);
  const { id } = purchaseOrderIdParamSchema.parse(req.params);

  const purchaseOrder = await loadPurchaseOrderForDocuments({
    organizationId,
    purchaseOrderId: id,
  });
  const pdf = await renderPurchaseOrderPdf({
    organizationName: purchaseOrder.organization.name,
    poNumber: purchaseOrder.poNumber,
    status: purchaseOrder.status,
    currency: purchaseOrder.currency,
    taxRateBps: purchaseOrder.taxRateBps,
    subtotalPaise: purchaseOrder.subtotalPaise,
    taxPaise: purchaseOrder.taxPaise,
    totalPaise: purchaseOrder.totalPaise,
    expectedDeliveryDate: purchaseOrder.expectedDeliveryDate,
    approvedAt: purchaseOrder.approvedAt,
    approvedBy: purchaseOrder.approvedBy,
    createdAt: purchaseOrder.createdAt,
    supplier: purchaseOrder.supplier,
    items: purchaseOrder.items,
  });

  sendPdf(res, pdf, `${purchaseOrder.poNumber}.pdf`);
}

/**
 * Renders a supplier invoice from the purchase order's own data and stores it
 * as a GENERATED invoice — a convenience document for the demo operator, never
 * the one three-way matching acts on (see CLAUDE.md §9 and
 * generateInvoiceForPurchaseOrder in src/services/invoice.service.ts).
 */
export async function postGenerateInvoice(req: Request, res: Response): Promise<void> {
  const { organizationId, userId } = requireTenant(req);
  const { id } = purchaseOrderIdParamSchema.parse(req.params);
  const { items } = generateInvoiceSchema.parse(req.body);

  const { invoice, created } = await generateInvoiceForPurchaseOrder({
    organizationId,
    actorId: userId,
    purchaseOrderId: id,
    items,
  });

  sendSuccess(res, { invoice }, created ? 201 : 200);
}
