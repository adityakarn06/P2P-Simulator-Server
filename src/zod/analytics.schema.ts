import { z } from "zod";
import { AnomalySignalType, Severity } from "../generated/prisma/enums.js";

/**
 * Every analytics endpoint accepts the same optional window. Both bounds are
 * inclusive-from / exclusive-to at the database, and an absent bound means
 * "since the beginning" or "up to now" rather than a default window — a
 * dashboard that silently showed only the last 30 days would misreport the
 * touchless rate the demo is judged on.
 */
export const analyticsRangeSchema = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .refine((range) => !range.from || !range.to || range.from <= range.to, {
    message: "`from` must not be after `to`",
    path: ["from"],
  });
export type AnalyticsRange = z.infer<typeof analyticsRangeSchema>;

export const supplierScorecardQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(50),
});
export type SupplierScorecardQuery = z.infer<typeof supplierScorecardQuerySchema>;

export const listAnomaliesQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  severity: z.enum(Severity).optional(),
  signalType: z.enum(AnomalySignalType).optional(),
  entityType: z.string().min(1).optional(),
  entityId: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
  cursor: z.string().min(1).optional(),
});
export type ListAnomaliesQuery = z.infer<typeof listAnomaliesQuerySchema>;
