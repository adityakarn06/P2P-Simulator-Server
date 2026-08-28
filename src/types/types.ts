import { z } from "zod";

// Job payloads carry IDs only (CLAUDE.md §24) — workers fetch current state
// from PostgreSQL rather than trusting queued data.
//
// Every id is min(1): a bare z.string() accepts "", which no row can ever carry.
// An empty id would pass the producer-side check in src/queues/connection.ts,
// enqueue a job that can only ever resolve to NOT_FOUND, and — for payment,
// whose job id is derived from invoiceId — produce a degenerate job id shared by
// every such payload.

export const requisitionJobSchema = z.object({
  requisitionId: z.string().min(1),
  organizationId: z.string().min(1),
});
export type RequisitionJob = z.infer<typeof requisitionJobSchema>;

export const supplierDiscoveryJobSchema = z.object({
  requisitionId: z.string().min(1),
  organizationId: z.string().min(1),
});
export type SupplierDiscoveryJob = z.infer<typeof supplierDiscoveryJobSchema>;

export const purchaseOrderJobSchema = z.object({
  requisitionId: z.string().min(1),
  organizationId: z.string().min(1),
});
export type PurchaseOrderJob = z.infer<typeof purchaseOrderJobSchema>;

export const invoiceJobSchema = z.object({
  invoiceId: z.string().min(1),
  organizationId: z.string().min(1),
});
export type InvoiceJob = z.infer<typeof invoiceJobSchema>;

export const matchingJobSchema = z.object({
  invoiceId: z.string().min(1),
  organizationId: z.string().min(1),
});
export type MatchingJob = z.infer<typeof matchingJobSchema>;

/**
 * `settlementKey` names which tranche of the invoice this job settles, so an
 * invoice can be paid in instalments. It defaults to "auto" — the automatic
 * settlement that follows a clean match — and is "exc-<exceptionId>" for an
 * amount a human authorized while resolving an exception.
 *
 * `amountPaise` is set only on that human-authorized path. Left out, the worker
 * settles whatever is outstanding, capped by the purchase order's balance.
 */
export const paymentJobSchema = z.object({
  invoiceId: z.string().min(1),
  organizationId: z.string().min(1),
  settlementKey: z.string().min(1).default("auto"),
  amountPaise: z.number().int().positive().optional(),
  authorization: z
    .object({
      exceptionId: z.string().min(1),
      userId: z.string().min(1),
      reason: z.string().min(1),
    })
    .optional(),
});
export type PaymentJob = z.infer<typeof paymentJobSchema>;
