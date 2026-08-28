import { z } from "zod";
import { PaymentKind, PaymentStatus } from "../generated/prisma/enums.js";

export const paymentIdParamSchema = z.object({
  id: z.string().min(1),
});

/**
 * `kind=PARTIAL` is the settlement-review view: every invoice the organization
 * paid less than it was billed for, with the reason and the approver attached.
 */
export const listPaymentsQuerySchema = z.object({
  status: z.enum(PaymentStatus).optional(),
  kind: z.enum(PaymentKind).optional(),
  invoiceId: z.string().min(1).optional(),
  purchaseOrderId: z.string().min(1).optional(),
  supplierId: z.string().min(1).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
  cursor: z.string().min(1).optional(),
});
export type ListPaymentsQuery = z.infer<typeof listPaymentsQuerySchema>;
