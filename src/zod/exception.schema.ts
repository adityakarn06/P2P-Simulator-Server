import { z } from "zod";
import { ExceptionStatus, ExceptionType } from "../generated/prisma/enums.js";

export const exceptionIdParamSchema = z.object({
  id: z.string().min(1),
});

export const listExceptionsQuerySchema = z.object({
  status: z.enum(ExceptionStatus).optional(),
  type: z.enum(ExceptionType).optional(),
  entityId: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
  cursor: z.string().min(1).optional(),
});
export type ListExceptionsQuery = z.infer<typeof listExceptionsQuerySchema>;

/**
 * A resolution is a financial judgement, so the reason is mandatory and has to
 * say something — CLAUDE.md §12: "Every resolution needs a reason and AuditLog."
 *
 * PARTIAL_APPROVE is the short-delivery answer: the paperwork genuinely
 * disagrees, the operator can see exactly which checks failed, and rather than
 * paying the whole invoice or nothing at all they authorize a specific amount —
 * typically the accepted units at the purchase order's price, which
 * `GET /exceptions/:id` offers as `settlement.suggestedAmountPaise`.
 *
 * The amount is only ever a ceiling request. The payment worker re-checks it
 * against the invoice's outstanding balance and the purchase order's remaining
 * commitment before any money moves, so a mistyped figure is refused rather
 * than paid.
 */
export const resolveExceptionSchema = z
  .object({
    decision: z.enum(["APPROVE", "PARTIAL_APPROVE", "REJECT"]),
    reason: z.string().trim().min(10, "Explain the decision in at least 10 characters").max(1000),
    approvedAmountPaise: z.number().int().positive().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.decision === "PARTIAL_APPROVE" && value.approvedAmountPaise === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["approvedAmountPaise"],
        message: "A partial approval must state the amount approved, in paise",
      });
    }

    // Rejected outright, or approved in full — either way an amount would be
    // ignored, and silently ignoring a number someone typed into a payment
    // request is how the wrong sum gets paid.
    if (value.decision !== "PARTIAL_APPROVE" && value.approvedAmountPaise !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["approvedAmountPaise"],
        message: "An amount may only be given with decision PARTIAL_APPROVE",
      });
    }
  });
export type ResolveExceptionInput = z.infer<typeof resolveExceptionSchema>;
