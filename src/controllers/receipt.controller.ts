import type { Request, Response } from "express";
import { renderGoodsReceiptPdf } from "../pdf/documents/goodsReceipt.pdf.js";
import {
  listGoodsReceipts,
  loadGoodsReceiptForPdf,
  recordGoodsReceipt,
} from "../services/receipt.service.js";
import { AppError } from "../utils/AppError.js";
import { sendPdf } from "../utils/fileResponse.js";
import { sendSuccess } from "../utils/response.js";
import {
  goodsReceiptIdParamSchema,
  listGoodsReceiptsQuerySchema,
  simulateReceiptSchema,
} from "../zod/receipt.schema.js";

function requireTenant(req: Request): { organizationId: string; userId: string } {
  if (!req.auth) {
    throw AppError.unauthorized();
  }
  return { organizationId: req.auth.organizationId, userId: req.auth.userId };
}

export async function getGoodsReceipts(req: Request, res: Response): Promise<void> {
  const { organizationId } = requireTenant(req);
  const query = listGoodsReceiptsQuerySchema.parse(req.query);

  sendSuccess(res, await listGoodsReceipts({ organizationId, ...query }));
}

/**
 * Simulated IoT delivery. The actor is the caller rather than SYSTEM — a human
 * pressed the button — and a replay answers 200 with the receipt already on file.
 */
export async function postSimulatedReceipt(req: Request, res: Response): Promise<void> {
  const { organizationId, userId } = requireTenant(req);
  const body = simulateReceiptSchema.parse(req.body);

  const { created, ...result } = await recordGoodsReceipt({
    organizationId,
    actorType: "USER",
    actorId: userId,
    ...body,
  });

  sendSuccess(res, result, created ? 201 : 200);
}

/** Renders the goods receipt as a PDF and streams it straight to the browser — nothing is stored. */
export async function getGoodsReceiptPdf(req: Request, res: Response): Promise<void> {
  const { organizationId } = requireTenant(req);
  const { id } = goodsReceiptIdParamSchema.parse(req.params);

  const goodsReceipt = await loadGoodsReceiptForPdf({ organizationId, goodsReceiptId: id });

  const pdf = await renderGoodsReceiptPdf({
    organizationName: goodsReceipt.organization.name,
    goodsReceiptId: goodsReceipt.id,
    poNumber: goodsReceipt.shipment.purchaseOrder.poNumber,
    trackingNumber: goodsReceipt.shipment.trackingNumber,
    status: goodsReceipt.status,
    receivedAt: goodsReceipt.receivedAt,
    receivedBy: goodsReceipt.receivedBy,
    notes: goodsReceipt.notes,
    items: goodsReceipt.items.map((item) => ({
      description: item.purchaseOrderItem.description,
      orderedQuantity: item.orderedQuantity,
      receivedQuantity: item.receivedQuantity,
      damagedQuantity: item.damagedQuantity,
      acceptedQuantity: item.acceptedQuantity,
    })),
  });

  sendPdf(res, pdf, `receipt-${goodsReceipt.id}.pdf`);
}
