import { randomUUID } from "node:crypto";
import { prisma } from "../config/prisma.js";
import type { Prisma } from "../generated/prisma/client.js";
import {
  ExceptionType,
  InvoiceSource,
  InvoiceStatus,
  PurchaseOrderStatus,
  Severity,
} from "../generated/prisma/enums.js";
import { renderInvoicePdf } from "../pdf/documents/invoice.pdf.js";
import {
  buildGeneratedInvoiceLines,
  buildGeneratedInvoiceNumber,
  computeGeneratedInvoiceTotals,
  type GeneratedInvoiceLineOverride,
} from "../rules/generatedInvoice.js";
import { getStorageProvider } from "../storage/index.js";
import { AppError } from "../utils/AppError.js";
import { isUniqueViolation } from "../utils/prismaErrors.js";
import type { InvoiceExtraction } from "../zod/invoice.schema.js";
import { toInvoiceDate, toPaise } from "../zod/invoice.schema.js";
import { INVOICE_ENTITY, recordAudit } from "./audit.service.js";
import { recordException } from "./exception.service.js";
import { normalizeInvoiceNumber } from "./matching.service.js";
import { loadPurchaseOrderForDocuments } from "./purchaseOrder.service.js";

/**
 * Purchase-order statuses an invoice may be raised against. A DRAFT,
 * PENDING_APPROVAL or REJECTED order has no commitment behind it, so accepting
 * an invoice for one would put a document into matching against nothing.
 */
const INVOICEABLE_PO_STATUSES: PurchaseOrderStatus[] = [
  PurchaseOrderStatus.APPROVED,
  PurchaseOrderStatus.SHIPPED,
  PurchaseOrderStatus.RECEIVED,
  PurchaseOrderStatus.COMPLETED,
];

/** Statuses meaning extraction has already succeeded — the worker must not re-run Gemini. */
const EXTRACTED_STATUSES: InvoiceStatus[] = [
  InvoiceStatus.EXTRACTED,
  InvoiceStatus.MATCHING,
  InvoiceStatus.APPROVED,
  InvoiceStatus.EXCEPTION,
  InvoiceStatus.PAID,
];

// ---------------------------------------------------------------------------
// Read shapes
// ---------------------------------------------------------------------------

/** The invoice shape every read path returns. `fileUrl` is a signed, expiring URL. */
export const invoiceViewSelect = {
  id: true,
  purchaseOrderId: true,
  supplierId: true,
  status: true,
  source: true,
  fileUrl: true,
  fileMimeType: true,
  fileSizeBytes: true,
  invoiceNumber: true,
  invoiceDate: true,
  supplierNameRaw: true,
  poNumberRaw: true,
  subtotalPaise: true,
  taxPaise: true,
  totalPaise: true,
  currency: true,
  extractedAt: true,
  extractionAttempts: true,
  failureReason: true,
  createdAt: true,
  updatedAt: true,
  items: {
    orderBy: { lineNumber: "asc" },
    select: {
      id: true,
      lineNumber: true,
      description: true,
      quantity: true,
      unitPricePaise: true,
      lineTotalPaise: true,
      productId: true,
    },
  },
} satisfies Prisma.InvoiceSelect;

export type InvoiceView = Prisma.InvoiceGetPayload<{ select: typeof invoiceViewSelect }>;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getInvoice(params: {
  organizationId: string;
  invoiceId: string;
}): Promise<InvoiceView> {
  const invoice = await prisma.invoice.findFirst({
    where: { id: params.invoiceId, organizationId: params.organizationId },
    select: invoiceViewSelect,
  });

  if (!invoice) {
    // An invoice owned by another organization is a 404, not a 403 — a 403
    // would confirm that the id exists.
    throw AppError.notFound("Invoice not found");
  }

  return invoice;
}

const invoiceFileSelect = {
  id: true,
  filePublicId: true,
  fileMimeType: true,
} satisfies Prisma.InvoiceSelect;

/** Tenant-scoped lookup of just what GET /invoices/:id/pdf needs to stream the stored bytes back. */
export async function getInvoiceFile(params: {
  organizationId: string;
  invoiceId: string;
}): Promise<Prisma.InvoiceGetPayload<{ select: typeof invoiceFileSelect }>> {
  const invoice = await prisma.invoice.findFirst({
    where: { id: params.invoiceId, organizationId: params.organizationId },
    select: invoiceFileSelect,
  });

  if (!invoice) {
    throw AppError.notFound("Invoice not found");
  }

  return invoice;
}

export async function listInvoices(params: {
  organizationId: string;
  status?: InvoiceStatus;
  source?: InvoiceSource;
  purchaseOrderId?: string;
  limit: number;
  cursor?: string;
}): Promise<{ items: InvoiceView[]; nextCursor: string | null }> {
  const { organizationId, status, source, purchaseOrderId, limit, cursor } = params;

  const items = await prisma.invoice.findMany({
    where: {
      organizationId,
      ...(status ? { status } : {}),
      ...(source ? { source } : {}),
      ...(purchaseOrderId ? { purchaseOrderId } : {}),
    },
    select: invoiceViewSelect,
    // createdAt alone is not unique, so a page boundary landing inside a tie
    // could repeat or skip rows; id breaks the tie deterministically.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;

  return {
    items: page,
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export interface CreateInvoiceParams {
  organizationId: string;
  actorId?: string | null;
  purchaseOrderId: string;
  file: {
    originalname: string;
    mimetype: string;
    buffer: Buffer;
  };
}

/**
 * Persists an uploaded invoice document against a purchase order.
 *
 * fileUrl / filePublicId are non-nullable, so the document is stored before the
 * row exists: the invoice id is generated here, the upload is keyed on it, and
 * only then is the row written. A failed transaction deletes the object it just
 * uploaded, so Cloudinary never accumulates files no invoice points at.
 *
 * No OCR happens here — the caller enqueues the invoice job and answers 202.
 */
export async function createInvoice(params: CreateInvoiceParams): Promise<InvoiceView> {
  const { organizationId, purchaseOrderId, file } = params;

  const purchaseOrder = await prisma.purchaseOrder.findFirst({
    where: { id: purchaseOrderId, organizationId },
    select: { id: true, status: true, supplierId: true },
  });

  if (!purchaseOrder) {
    throw AppError.notFound("Purchase order not found");
  }

  if (!INVOICEABLE_PO_STATUSES.includes(purchaseOrder.status)) {
    throw AppError.invalidState(`A ${purchaseOrder.status} purchase order cannot be invoiced`, {
      purchaseOrderStatus: purchaseOrder.status,
    });
  }

  const invoiceId = randomUUID();

  // Validates MIME type, size and magic bytes before anything leaves the process.
  const uploaded = await getStorageProvider().upload({
    invoiceId,
    fileName: file.originalname,
    buffer: file.buffer,
    mimeType: file.mimetype,
  });

  try {
    return await prisma.$transaction(async (tx) => {
      const invoice = await tx.invoice.create({
        data: {
          id: invoiceId,
          organizationId,
          purchaseOrderId: purchaseOrder.id,
          supplierId: purchaseOrder.supplierId,
          status: InvoiceStatus.UPLOADED,
          fileUrl: uploaded.url,
          filePublicId: uploaded.storageKey,
          fileMimeType: file.mimetype,
          fileSizeBytes: uploaded.bytes,
        },
        select: invoiceViewSelect,
      });

      await recordAudit(tx, {
        organizationId,
        actorType: "USER",
        actorId: params.actorId ?? null,
        action: "INVOICE_UPLOADED",
        entityType: INVOICE_ENTITY,
        entityId: invoice.id,
        metadata: {
          purchaseOrderId: purchaseOrder.id,
          fileName: file.originalname,
          fileMimeType: file.mimetype,
          fileSizeBytes: uploaded.bytes,
        },
      });

      return invoice;
    });
  } catch (error) {
    // Best-effort cleanup: the upload succeeded but nothing references it now.
    // A failure here must not mask the error that actually broke the request.
    try {
      await getStorageProvider().delete(uploaded.storageKey);
    } catch (cleanupError) {
      console.error(
        `Failed to remove orphaned Cloudinary object ${uploaded.storageKey}:`,
        cleanupError,
      );
    }

    throw error;
  }
}

// ---------------------------------------------------------------------------
// Generation (PDFKit convenience document, never OCR'd)
// ---------------------------------------------------------------------------

export interface GenerateInvoiceParams {
  organizationId: string;
  actorId?: string | null;
  purchaseOrderId: string;
  items?: GeneratedInvoiceLineOverride[];
}

export interface GenerateInvoiceResult {
  invoice: InvoiceView;
  /** False when a generated invoice already existed for this PO — the caller answers 200, not 201. */
  created: boolean;
}

/**
 * Renders a PDFKit invoice from the purchase order's own data and stores it as
 * an Invoice row with source: GENERATED.
 *
 * This is a convenience document for the demo operator, never the document
 * three-way matching acts on (CLAUDE.md §9: AI/OCR is the only path onto a
 * payable invoice). It is created straight at EXTRACTED with real totals, no
 * queue job is enqueued, and a second call is idempotent — it returns the
 * invoice already on file for this PO rather than rendering a duplicate.
 *
 * Idempotency has two layers: the upfront lookup below answers instantly on
 * an ordinary repeat call once the first has committed, but two *concurrent*
 * calls can both pass that check before either commits. The real guard is
 * Invoice.generatedForPurchaseOrderId @unique (schema.prisma) — the loser's
 * insert fails with a unique-constraint violation, caught below, which
 * deletes its now-orphaned upload and returns the winner's row instead of
 * erroring or leaving two GENERATED invoices on one purchase order.
 *
 * The PDF render and Cloudinary upload below run inline in this request,
 * not behind a queue job. This is a deliberate exception to the "no
 * long-running work inside Express" rule, not an oversight: the CLAUDE.md
 * spec for the *real* invoice-upload path (§7) has the equivalent storage
 * upload happen synchronously in the request too — only Gemini/OCR extraction
 * is deferred to a worker there. There is no such AI step here (every figure
 * is already known from the PO), so a queue would add a job/worker/status
 * round trip without deferring anything actually slow or non-deterministic.
 */
export async function generateInvoiceForPurchaseOrder(
  params: GenerateInvoiceParams,
): Promise<GenerateInvoiceResult> {
  const { organizationId, purchaseOrderId } = params;

  // Independent reads — run them together rather than one after the other.
  const [purchaseOrder, existing] = await Promise.all([
    loadPurchaseOrderForDocuments({ organizationId, purchaseOrderId }),
    prisma.invoice.findFirst({
      where: { organizationId, purchaseOrderId, source: InvoiceSource.GENERATED },
      select: invoiceViewSelect,
    }),
  ]);

  if (!INVOICEABLE_PO_STATUSES.includes(purchaseOrder.status)) {
    throw AppError.invalidState(`A ${purchaseOrder.status} purchase order cannot be invoiced`, {
      purchaseOrderStatus: purchaseOrder.status,
    });
  }

  if (existing) {
    return { invoice: existing, created: false };
  }

  const lines = buildGeneratedInvoiceLines(
    purchaseOrder.items.map((item) => ({
      purchaseOrderItemId: item.id,
      productId: item.productId,
      description: item.description,
      quantity: item.quantity,
      unitPricePaise: item.unitPricePaise,
    })),
    params.items,
  );
  const totals = computeGeneratedInvoiceTotals(lines, purchaseOrder.taxRateBps);

  const invoiceNumber = buildGeneratedInvoiceNumber(purchaseOrder.poNumber);
  const invoiceDate = new Date();

  const pdf = await renderInvoicePdf({
    invoiceNumber,
    invoiceDate,
    poNumber: purchaseOrder.poNumber,
    currency: purchaseOrder.currency,
    subtotalPaise: totals.subtotalPaise,
    taxPaise: totals.taxPaise,
    totalPaise: totals.totalPaise,
    supplier: purchaseOrder.supplier,
    billTo: { organizationName: purchaseOrder.organization.name },
    items: lines,
  });

  const invoiceId = randomUUID();

  // Same ordering as createInvoice: fileUrl/filePublicId are non-nullable, so
  // the document is stored before the row exists.
  const uploaded = await getStorageProvider().upload({
    invoiceId,
    fileName: `${invoiceNumber}.pdf`,
    buffer: pdf,
    mimeType: "application/pdf",
  });

  try {
    const invoice = await prisma.$transaction(async (tx) => {
      const created = await tx.invoice.create({
        data: {
          id: invoiceId,
          organizationId,
          purchaseOrderId: purchaseOrder.id,
          supplierId: purchaseOrder.supplierId,
          status: InvoiceStatus.EXTRACTED,
          source: InvoiceSource.GENERATED,
          generatedForPurchaseOrderId: purchaseOrder.id,
          fileUrl: uploaded.url,
          filePublicId: uploaded.storageKey,
          fileMimeType: "application/pdf",
          fileSizeBytes: uploaded.bytes,
          invoiceNumber,
          normalizedInvoiceNumber: normalizeInvoiceNumber(invoiceNumber),
          invoiceDate,
          supplierNameRaw: purchaseOrder.supplier.name,
          poNumberRaw: purchaseOrder.poNumber,
          subtotalPaise: totals.subtotalPaise,
          taxPaise: totals.taxPaise,
          totalPaise: totals.totalPaise,
          currency: purchaseOrder.currency,
          extractedAt: invoiceDate,
          items: {
            create: lines.map((line, index) => ({
              lineNumber: index + 1,
              description: line.description,
              quantity: line.quantity,
              unitPricePaise: line.unitPricePaise,
              lineTotalPaise: line.lineTotalPaise,
              productId: line.productId,
            })),
          },
        },
        select: invoiceViewSelect,
      });

      await recordAudit(tx, {
        organizationId,
        actorType: "USER",
        actorId: params.actorId ?? null,
        action: "INVOICE_GENERATED",
        entityType: INVOICE_ENTITY,
        entityId: created.id,
        metadata: {
          purchaseOrderId: purchaseOrder.id,
          invoiceNumber,
          totalPaise: totals.totalPaise,
        },
      });

      return created;
    });

    return { invoice, created: true };
  } catch (error) {
    // Best-effort cleanup: the upload succeeded but nothing references it now,
    // whether this is the ordinary failure path or the race described above.
    try {
      await getStorageProvider().delete(uploaded.storageKey);
    } catch (cleanupError) {
      console.error(
        `Failed to remove orphaned Cloudinary object ${uploaded.storageKey}:`,
        cleanupError,
      );
    }

    if (isUniqueViolation(error)) {
      // Lost the race on generatedForPurchaseOrderId @unique: a concurrent
      // call already committed a GENERATED invoice for this PO. Its row is
      // the correct answer, not an error.
      const winner = await prisma.invoice.findFirst({
        where: { organizationId, purchaseOrderId, source: InvoiceSource.GENERATED },
        select: invoiceViewSelect,
      });

      if (winner) {
        return { invoice: winner, created: false };
      }
    }

    throw error;
  }
}

// ---------------------------------------------------------------------------
// Worker: load, claim, apply
// ---------------------------------------------------------------------------

const invoiceForProcessingSelect = {
  id: true,
  organizationId: true,
  status: true,
  source: true,
  filePublicId: true,
  fileMimeType: true,
  extractionAttempts: true,
  purchaseOrderId: true,
} satisfies Prisma.InvoiceSelect;

export type InvoiceForProcessing = Prisma.InvoiceGetPayload<{
  select: typeof invoiceForProcessingSelect;
}>;

export async function loadInvoiceForProcessing(params: {
  organizationId: string;
  invoiceId: string;
}): Promise<InvoiceForProcessing> {
  const invoice = await prisma.invoice.findFirst({
    where: { id: params.invoiceId, organizationId: params.organizationId },
    select: invoiceForProcessingSelect,
  });

  if (!invoice) {
    throw AppError.notFound("Invoice not found");
  }

  return invoice;
}

/** True once extraction has already produced a result — the worker returns early. */
export function isExtracted(status: InvoiceStatus): boolean {
  return EXTRACTED_STATUSES.includes(status);
}

/**
 * Claims the invoice for extraction: UPLOADED -> PROCESSING.
 *
 * Returns false when no row moved. The worker treats an invoice already
 * PROCESSING as its own earlier attempt and proceeds; any other status means
 * someone else owns it.
 */
export async function claimInvoiceForExtraction(params: {
  organizationId: string;
  invoiceId: string;
}): Promise<boolean> {
  const { count } = await prisma.invoice.updateMany({
    where: {
      id: params.invoiceId,
      organizationId: params.organizationId,
      status: InvoiceStatus.UPLOADED,
    },
    data: {
      status: InvoiceStatus.PROCESSING,
      extractionAttempts: { increment: 1 },
      failureReason: null,
    },
  });

  return count > 0;
}

/**
 * Writes the extracted invoice: PROCESSING -> EXTRACTED, plus its line items.
 *
 * Every money value goes through toPaise() here — Gemini returned printed
 * decimal strings and never performed arithmetic. Nothing in this transaction
 * touches the PurchaseOrder: AI output must never rewrite the commitment it is
 * about to be matched against.
 */
export async function applyInvoiceExtraction(params: {
  organizationId: string;
  invoiceId: string;
  result: InvoiceExtraction;
  raw: Prisma.InputJsonValue;
}): Promise<InvoiceView> {
  const { organizationId, invoiceId, result } = params;

  return prisma.$transaction(async (tx) => {
    const claimed = await tx.invoice.updateMany({
      where: { id: invoiceId, organizationId, status: InvoiceStatus.PROCESSING },
      data: {
        status: InvoiceStatus.EXTRACTED,
        invoiceNumber: result.invoiceNumber,
        normalizedInvoiceNumber:
          result.invoiceNumber != null ? normalizeInvoiceNumber(result.invoiceNumber) : null,
        invoiceDate: toInvoiceDate(result.invoiceDate),
        supplierNameRaw: result.supplierName,
        poNumberRaw: result.poNumber,
        subtotalPaise: toPaise(result.subtotal),
        taxPaise: toPaise(result.tax),
        totalPaise: toPaise(result.total),
        currency: result.currency,
        extractedAt: new Date(),
        rawExtraction: params.raw,
        failureReason: null,
      },
    });

    if (claimed.count === 0) {
      throw AppError.conflict("Invoice is no longer being processed", { invoiceId });
    }

    // A retry that got this far previously would collide with
    // @@unique([invoiceId, lineNumber]); replacing the set keeps it idempotent.
    await tx.invoiceItem.deleteMany({ where: { invoiceId } });

    if (result.items.length > 0) {
      await tx.invoiceItem.createMany({
        data: result.items.map((item, index) => ({
          invoiceId,
          lineNumber: index + 1,
          description: item.description,
          quantity: item.quantity,
          // Null, never 0: a figure the document did not print is not a price
          // of zero, and matching must be able to tell those apart.
          unitPricePaise: toPaise(item.unitPrice),
          lineTotalPaise: toPaise(item.lineTotal),
        })),
      });
    }

    await recordAudit(tx, {
      organizationId,
      actorType: "AI",
      action: "INVOICE_EXTRACTED",
      entityType: INVOICE_ENTITY,
      entityId: invoiceId,
      metadata: {
        invoiceNumber: result.invoiceNumber,
        totalPaise: toPaise(result.total),
        currency: result.currency,
        itemCount: result.items.length,
      },
    });

    return tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: invoiceViewSelect });
  });
}

/**
 * Terminal failure path, used only once BullMQ has exhausted its retries.
 * The document stays in storage so a human can look at it.
 */
export async function applyInvoiceExtractionFailure(params: {
  organizationId: string;
  invoiceId: string;
  reason: string;
}): Promise<InvoiceView> {
  const { organizationId, invoiceId, reason } = params;

  return prisma.$transaction(async (tx) => {
    const failed = await tx.invoice.updateMany({
      where: {
        id: invoiceId,
        organizationId,
        status: { in: [InvoiceStatus.UPLOADED, InvoiceStatus.PROCESSING] },
      },
      data: { status: InvoiceStatus.FAILED, failureReason: reason },
    });

    // A stalled or duplicate delivery of an earlier attempt can land here after
    // another attempt has already extracted the invoice. The guard above keeps
    // the status correct; without this check it would still raise a CRITICAL
    // exception against an invoice that actually succeeded.
    if (failed.count === 0) {
      console.warn(
        `Invoice ${invoiceId}: extraction failure ignored, invoice is no longer being processed — ${reason}`,
      );

      return tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: invoiceViewSelect });
    }

    await recordException(tx, {
      organizationId,
      type: ExceptionType.INVOICE_EXTRACTION_FAILED,
      severity: Severity.CRITICAL,
      entityType: INVOICE_ENTITY,
      entityId: invoiceId,
      title: "Invoice extraction failed",
      description: reason,
    });

    await recordAudit(tx, {
      organizationId,
      actorType: "SYSTEM",
      action: "WORKFLOW_FAILED",
      entityType: INVOICE_ENTITY,
      entityId: invoiceId,
      metadata: { stage: "invoice-extraction", reason },
    });

    return tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: invoiceViewSelect });
  });
}
