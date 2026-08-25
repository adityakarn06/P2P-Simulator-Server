import type { Request, Response } from "express";
import { enqueueInvoice } from "../queues/invoice.queue.js";
import {
  createInvoice,
  getInvoice,
  getInvoiceFile,
  listInvoices,
} from "../services/invoice.service.js";
import { getStorageProvider } from "../storage/index.js";
import { FORMAT_BY_MIME_TYPE } from "../storage/storage.interface.js";
import { AppError } from "../utils/AppError.js";
import { sendFile } from "../utils/fileResponse.js";
import { sendSuccess } from "../utils/response.js";
import {
  createInvoiceSchema,
  invoiceIdParamSchema,
  listInvoicesQuerySchema,
} from "../zod/invoice.schema.js";

function requireTenant(req: Request): { organizationId: string; userId: string } {
  if (!req.auth) {
    throw AppError.unauthorized();
  }
  return { organizationId: req.auth.organizationId, userId: req.auth.userId };
}

/**
 * Accepts the invoice document and hands extraction to the invoice worker.
 *
 * Answers 202 without waiting: OCR is a multi-second Gemini Vision call and
 * never belongs inside a request handler (CLAUDE.md §9).
 */
export async function postInvoice(req: Request, res: Response): Promise<void> {
  const { organizationId, userId } = requireTenant(req);

  if (!req.file) {
    throw AppError.validation('An invoice document is required under the "file" field');
  }

  const { purchaseOrderId } = createInvoiceSchema.parse(req.body);

  const invoice = await createInvoice({
    organizationId,
    actorId: userId,
    purchaseOrderId,
    file: req.file,
  });

  // Enqueued after the transaction commits, never inside it.
  await enqueueInvoice({ invoiceId: invoice.id, organizationId });

  sendSuccess(res, { invoice }, 202);
}

export async function getInvoiceById(req: Request, res: Response): Promise<void> {
  const { organizationId } = requireTenant(req);
  const { id } = invoiceIdParamSchema.parse(req.params);

  sendSuccess(res, await getInvoice({ organizationId, invoiceId: id }));
}

export async function getInvoices(req: Request, res: Response): Promise<void> {
  const { organizationId } = requireTenant(req);
  const query = listInvoicesQuerySchema.parse(req.query);

  sendSuccess(res, await listInvoices({ organizationId, ...query }));
}

/**
 * Streams the invoice document's stored bytes back as a download — the same
 * route works for a GENERATED invoice (always a PDF) and an UPLOADED one
 * (PDF, PNG or JPEG), so the content type and extension follow the file's own
 * stored MIME type rather than being hardcoded to application/pdf.
 */
export async function getInvoicePdf(req: Request, res: Response): Promise<void> {
  const { organizationId } = requireTenant(req);
  const { id } = invoiceIdParamSchema.parse(req.params);

  const invoice = await getInvoiceFile({ organizationId, invoiceId: id });
  const buffer = await getStorageProvider().download(invoice.filePublicId, invoice.fileMimeType);
  const format =
    FORMAT_BY_MIME_TYPE[invoice.fileMimeType as keyof typeof FORMAT_BY_MIME_TYPE] ?? "bin";

  sendFile(res, buffer, invoice.fileMimeType, `invoice-${invoice.id}.${format}`);
}
