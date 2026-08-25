import type { Response } from "express";

/**
 * Streams a binary file back as a download.
 *
 * Deliberately bypasses sendSuccess()'s JSON envelope — a binary body has no
 * JSON representation. Errors raised before this is called (404, invalid
 * state, etc.) still go through the normal errorHandler / envelope.
 */
export function sendFile(res: Response, buffer: Buffer, mimeType: string, filename: string): void {
  res.status(200);
  res.setHeader("Content-Type", mimeType);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Length", String(buffer.length));
  res.send(buffer);
}

/** Rendered PDFs (purchase order / goods receipt / generated invoice) always come back as application/pdf. */
export function sendPdf(res: Response, buffer: Buffer, filename: string): void {
  sendFile(res, buffer, "application/pdf", filename);
}
