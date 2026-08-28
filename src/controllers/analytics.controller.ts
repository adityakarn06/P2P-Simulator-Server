import type { Request, Response } from "express";
import {
  getAnalyticsSummary,
  getSupplierScorecards,
  listAnomalySignals,
} from "../services/analytics.service.js";
import { AppError } from "../utils/AppError.js";
import { sendSuccess } from "../utils/response.js";
import {
  analyticsRangeSchema,
  listAnomaliesQuerySchema,
  supplierScorecardQuerySchema,
} from "../zod/analytics.schema.js";

function requireTenant(req: Request): { organizationId: string } {
  if (!req.auth) {
    throw AppError.unauthorized();
  }
  return { organizationId: req.auth.organizationId };
}

export async function getSummary(req: Request, res: Response): Promise<void> {
  const { organizationId } = requireTenant(req);
  const range = analyticsRangeSchema.parse(req.query);

  sendSuccess(res, await getAnalyticsSummary({ organizationId, range }));
}

export async function getSuppliers(req: Request, res: Response): Promise<void> {
  const { organizationId } = requireTenant(req);
  const query = supplierScorecardQuerySchema.parse(req.query);

  sendSuccess(res, await getSupplierScorecards({ organizationId, query }));
}

export async function getAnomalies(req: Request, res: Response): Promise<void> {
  const { organizationId } = requireTenant(req);
  const query = listAnomaliesQuerySchema.parse(req.query);

  sendSuccess(res, await listAnomalySignals({ organizationId, query }));
}
