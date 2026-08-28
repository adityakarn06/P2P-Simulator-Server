import type { Request, Response } from "express";
import { getPaymentById, listPayments } from "../services/payment.service.js";
import { AppError } from "../utils/AppError.js";
import { sendSuccess } from "../utils/response.js";
import { listPaymentsQuerySchema, paymentIdParamSchema } from "../zod/payment.schema.js";

function requireTenant(req: Request): { organizationId: string } {
  if (!req.auth) {
    throw AppError.unauthorized();
  }
  return { organizationId: req.auth.organizationId };
}

export async function getPayments(req: Request, res: Response): Promise<void> {
  const { organizationId } = requireTenant(req);
  const query = listPaymentsQuerySchema.parse(req.query);

  sendSuccess(res, await listPayments({ organizationId, ...query }));
}

export async function getPayment(req: Request, res: Response): Promise<void> {
  const { organizationId } = requireTenant(req);
  const { id } = paymentIdParamSchema.parse(req.params);

  sendSuccess(res, await getPaymentById({ organizationId, paymentId: id }));
}
