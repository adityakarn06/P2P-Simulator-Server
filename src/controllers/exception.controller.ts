import type { Request, Response } from "express";
import { AUTO_SETTLEMENT_KEY } from "../config/constants.js";
import { enqueuePayment } from "../queues/payment.queue.js";
import {
  getExceptionById,
  listExceptions,
  resolveExceptionById,
} from "../services/exception.service.js";
import { AppError } from "../utils/AppError.js";
import { sendSuccess } from "../utils/response.js";
import {
  exceptionIdParamSchema,
  listExceptionsQuerySchema,
  resolveExceptionSchema,
} from "../zod/exception.schema.js";

function requireTenant(req: Request): { organizationId: string; userId: string } {
  if (!req.auth) {
    throw AppError.unauthorized();
  }
  return { organizationId: req.auth.organizationId, userId: req.auth.userId };
}

export async function getExceptions(req: Request, res: Response): Promise<void> {
  const { organizationId } = requireTenant(req);
  const query = listExceptionsQuerySchema.parse(req.query);

  sendSuccess(res, await listExceptions({ organizationId, ...query }));
}

export async function getException(req: Request, res: Response): Promise<void> {
  const { organizationId } = requireTenant(req);
  const { id } = exceptionIdParamSchema.parse(req.params);

  sendSuccess(res, { exception: await getExceptionById({ organizationId, exceptionId: id }) });
}

/**
 * Records a human decision on an exception, and — when that was the last thing
 * standing between an invoice and its payment — queues the payment.
 *
 * The queueing happens after the transaction commits, never inside it. The
 * payment worker re-checks the whole gate anyway, so a lost enqueue delays
 * settlement rather than corrupting it.
 */
export async function postExceptionResolution(req: Request, res: Response): Promise<void> {
  const { organizationId, userId } = requireTenant(req);
  const { id } = exceptionIdParamSchema.parse(req.params);
  const { decision, reason, approvedAmountPaise } = resolveExceptionSchema.parse(req.body);

  const result = await resolveExceptionById({
    organizationId,
    exceptionId: id,
    decision,
    reason,
    approvedAmountPaise,
    actorId: userId,
  });

  if (result.releasedForPayment && result.invoiceId) {
    // A partial approval settles its own tranche, keyed on the exception that
    // authorized it, so it neither collides with the automatic settlement nor
    // with a later approval on a different exception. A full approval takes the
    // automatic key, which is the one matching already parked as BLOCKED.
    const partial = result.approvedAmountPaise !== null;

    await enqueuePayment({
      invoiceId: result.invoiceId,
      organizationId,
      settlementKey: partial ? `exc-${id}` : AUTO_SETTLEMENT_KEY,
      ...(partial
        ? {
            amountPaise: result.approvedAmountPaise ?? undefined,
            authorization: { exceptionId: id, userId, reason },
          }
        : {}),
    });
  }

  sendSuccess(res, {
    exception: result.exception,
    releasedForPayment: result.releasedForPayment,
    approvedAmountPaise: result.approvedAmountPaise,
  });
}
