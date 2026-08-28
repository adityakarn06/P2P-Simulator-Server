import type { Request, Response } from "express";
import { RequisitionStatus } from "../generated/prisma/enums.js";
import { awaitJobResult } from "../queues/jobResult.js";
import { enqueueRequisition, requisitionQueue } from "../queues/requisition.queue.js";
import {
  appendUserMessage,
  createRequisition,
  getRequisition,
  listRequisitions,
  type RequisitionChatResult,
} from "../services/requisition.service.js";
import { AppError } from "../utils/AppError.js";
import { sendSuccess } from "../utils/response.js";
import {
  createRequisitionSchema,
  listRequisitionsQuerySchema,
  requisitionIdParamSchema,
  requisitionMessageSchema,
} from "../zod/requisition.schema.js";

/**
 * How long a chat request waits for the extraction worker before falling back
 * to 202 + polling. Gemini itself is capped at 30s inside the provider, so this
 * is the point where we stop holding the socket open.
 */
const EXTRACTION_WAIT_MS = 20_000;

const STILL_WORKING_MESSAGE =
  "Still working on your request — check back in a moment for my reply.";

function requireTenant(req: Request): { organizationId: string; userId: string } {
  if (!req.auth) {
    throw AppError.unauthorized();
  }
  return { organizationId: req.auth.organizationId, userId: req.auth.userId };
}

/**
 * Runs the extraction job and shapes the chat reply. The worker owns every
 * Gemini call; this only waits for its result.
 */
async function respondWithExtraction(
  res: Response,
  params: { requisitionId: string; organizationId: string },
): Promise<void> {
  const jobId = await enqueueRequisition(params);
  const result = await awaitJobResult<RequisitionChatResult>(
    requisitionQueue,
    jobId,
    EXTRACTION_WAIT_MS,
  );

  if (!result) {
    sendSuccess(
      res,
      {
        status: "PROCESSING",
        message: STILL_WORKING_MESSAGE,
        requisitionId: params.requisitionId,
      },
      202,
    );
    return;
  }

  // The requisition's real status, never the 202 branch's "PROCESSING" — a
  // client has to be able to tell "still thinking, poll me" (202) from
  // "requirements are in, sourcing is running" (200).
  if (result.status !== RequisitionStatus.NEEDS_CLARIFICATION) {
    sendSuccess(res, {
      status: result.status,
      message: result.message,
      requisitionId: result.requisitionId,
      requirements: result.requirements,
    });
    return;
  }

  sendSuccess(res, {
    status: RequisitionStatus.NEEDS_CLARIFICATION,
    message: result.message,
    missingFields: result.missingFields,
    conflicts: result.conflicts,
    requisitionId: result.requisitionId,
  });
}

export async function postRequisition(req: Request, res: Response): Promise<void> {
  const { organizationId, userId } = requireTenant(req);
  const { input } = createRequisitionSchema.parse(req.body);

  const requisition = await createRequisition({ organizationId, userId, input });

  await respondWithExtraction(res, { requisitionId: requisition.id, organizationId });
}

export async function postRequisitionMessage(req: Request, res: Response): Promise<void> {
  const { organizationId } = requireTenant(req);
  const { id } = requisitionIdParamSchema.parse(req.params);
  const { input } = requisitionMessageSchema.parse(req.body);

  await appendUserMessage({ organizationId, requisitionId: id, input });

  await respondWithExtraction(res, { requisitionId: id, organizationId });
}

export async function getRequisitionById(req: Request, res: Response): Promise<void> {
  const { organizationId } = requireTenant(req);
  const { id } = requisitionIdParamSchema.parse(req.params);

  sendSuccess(res, await getRequisition({ organizationId, requisitionId: id }));
}

export async function getRequisitions(req: Request, res: Response): Promise<void> {
  const { organizationId } = requireTenant(req);
  const query = listRequisitionsQuerySchema.parse(req.query);

  sendSuccess(res, await listRequisitions({ organizationId, ...query }));
}
