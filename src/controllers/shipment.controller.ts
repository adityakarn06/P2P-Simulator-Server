import type { Request, Response } from "express";
import { getShipment, listShipments } from "../services/receipt.service.js";
import { AppError } from "../utils/AppError.js";
import { sendSuccess } from "../utils/response.js";
import { listShipmentsQuerySchema, shipmentIdParamSchema } from "../zod/receipt.schema.js";

function requireTenant(req: Request): { organizationId: string; userId: string } {
  if (!req.auth) {
    throw AppError.unauthorized();
  }
  return { organizationId: req.auth.organizationId, userId: req.auth.userId };
}

export async function getShipmentById(req: Request, res: Response): Promise<void> {
  const { organizationId } = requireTenant(req);
  const { id } = shipmentIdParamSchema.parse(req.params);

  sendSuccess(res, await getShipment({ organizationId, shipmentId: id }));
}

export async function getShipments(req: Request, res: Response): Promise<void> {
  const { organizationId } = requireTenant(req);
  const query = listShipmentsQuerySchema.parse(req.query);

  sendSuccess(res, await listShipments({ organizationId, ...query }));
}
