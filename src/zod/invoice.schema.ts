import { z } from "zod";
import { InvoiceSource, InvoiceStatus } from "../generated/prisma/enums.js";
import { MAX_MONEY_PAISE } from "../rules/approvalRules.js";

// ---------------------------------------------------------------------------
// API input
// ---------------------------------------------------------------------------

/**
 * Parsed from the multipart text fields. The document itself arrives on
 * req.file via src/middleware/upload.ts, not through Zod.
 */
export const createInvoiceSchema = z.object({
  purchaseOrderId: z.string().min(1),
});
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;

export const invoiceIdParamSchema = z.object({
  id: z.string().min(1),
});

export const listInvoicesQuerySchema = z.object({
  status: z.enum(InvoiceStatus).optional(),
  source: z.enum(InvoiceSource).optional(),
  purchaseOrderId: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
  cursor: z.string().min(1).optional(),
});
export type ListInvoicesQuery = z.infer<typeof listInvoicesQuerySchema>;

// ---------------------------------------------------------------------------
// AI output
// ---------------------------------------------------------------------------

/** Hard ceiling on line items, so a hallucinated array cannot blow up a transaction. */
const MAX_INVOICE_ITEMS = 100;

/**
 * Money arrives as the decimal string printed on the document — never as paise,
 * and never as a float. Gemini transcribes; toPaise() below does the only
 * arithmetic, in TypeScript (CLAUDE.md: AI interprets, deterministic code decides).
 */
const money = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, "Expected a plain decimal amount such as 1820.50")
  // Every paise column this lands in is a Prisma `Int` (32-bit Postgres
  // integer). Without this bound a hallucinated "99999999999" reaches the
  // insert and surfaces as an opaque int4 overflow *inside* the extraction
  // transaction, which the worker can only read as a technical failure and
  // retry three times. Rejected here it is ordinary malformed AI output.
  .refine((value) => (toPaise(value) ?? 0) <= MAX_MONEY_PAISE, {
    message: `Amount exceeds the maximum supported value (${MAX_MONEY_PAISE} paise)`,
  })
  .nullable();

export const invoiceItemExtractionSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().int().positive(),
  unitPrice: money,
  lineTotal: money,
});

export const invoiceExtractionSchema = z.object({
  invoiceNumber: z.string().min(1).nullable(),
  /** ISO yyyy-mm-dd as printed; parsed into a Date by the service. */
  invoiceDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date (yyyy-mm-dd)")
    .nullable(),
  supplierName: z.string().min(1).nullable(),
  poNumber: z.string().min(1).nullable(),
  currency: z.string().length(3).nullable(),
  subtotal: money,
  tax: money,
  total: money,
  items: z.array(invoiceItemExtractionSchema).max(MAX_INVOICE_ITEMS),
});

export type InvoiceExtraction = z.infer<typeof invoiceExtractionSchema>;
export type InvoiceItemExtraction = z.infer<typeof invoiceItemExtractionSchema>;

/**
 * Converts a printed decimal amount to integer minor units.
 *
 * Deliberately string-based: `Math.round(Number("1820.15") * 100)` is exactly
 * the floating-point rounding CLAUDE.md forbids for money.
 */
export function toPaise(value: string | null): number | null {
  if (value === null) {
    return null;
  }

  const [whole, fraction = ""] = value.split(".");
  const minor = fraction.padEnd(2, "0").slice(0, 2);

  return Number(whole) * 100 + Number(minor);
}

/**
 * Parses the printed ISO date, returning null for a value that is not a real date.
 *
 * The round-trip check matters: `new Date("2026-02-31")` does not throw, it
 * rolls over to 3 March. Storing that would put a date on the invoice that the
 * document never carried.
 */
export function toInvoiceDate(value: string | null): Date | null {
  if (value === null) {
    return null;
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);

  if (Number.isNaN(parsed.getTime()) || !parsed.toISOString().startsWith(value)) {
    return null;
  }

  return parsed;
}
