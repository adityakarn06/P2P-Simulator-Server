import type { Request, Response } from "express";
import { listGoodsReceipts, recordGoodsReceipt } from "../services/receipt.service.js";
import { AppError } from "../utils/AppError.js";
import { sendSuccess } from "../utils/response.js";
import { listGoodsReceiptsQuerySchema, simulateReceiptSchema } from "../zod/receipt.schema.js";

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
