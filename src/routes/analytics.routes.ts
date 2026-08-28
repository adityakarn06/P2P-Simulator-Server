import { Router } from "express";
import { getAnomalies, getSummary, getSuppliers } from "../controllers/analytics.controller.js";
import { asyncHandler } from "../utils/asyncHandler.js";

/**
 * Read-only, like the audit-log router: analytics aggregates what the workflow
 * already decided and must never be able to change it. Do not add mutations
 * here.
 */
export const analyticsRouter: Router = Router();

analyticsRouter.get("/summary", asyncHandler(getSummary));
analyticsRouter.get("/suppliers", asyncHandler(getSuppliers));
analyticsRouter.get("/anomalies", asyncHandler(getAnomalies));
