import PDFDocument from "pdfkit";

/**
 * Collects a PDFKit document's output stream into a single Buffer.
 *
 * Every renderer in src/pdf/documents builds its document synchronously and
 * calls doc.end() before this resolves — the caller never sees a partial PDF.
 */
export function renderToBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}

/** A4, generous margins, no built-in font embedding needed (Helvetica ships with PDFKit). */
export function createDocument(): PDFKit.PDFDocument {
  return new PDFDocument({ size: "A4", margin: 50, bufferPages: true });
}
