/**
 * Shared drawing primitives for the three PDFKit renderers in src/pdf/documents.
 *
 * Kept dumb and generic (no Prisma types) so it stays trivially unit-testable and
 * reusable across the purchase order, goods receipt and invoice documents.
 */

/**
 * Formats integer paise as "INR 1,820.00".
 *
 * Helvetica (PDFKit's built-in font) is WinAnsi-encoded and has no glyph for
 * "₹" (Rupee sign) — it renders as a blank box. The ISO currency code is
 * used instead of a symbol so every renderer is safe with no font embedding.
 * String-based grouping, never float math, per CLAUDE.md's money rules.
 */
export function formatPaise(paise: number, currency: string): string {
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(paise);
  const whole = Math.floor(abs / 100);
  const minor = String(abs % 100).padStart(2, "0");
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${currency} ${grouped}.${minor}`;
}

export function formatQuantity(quantity: number): string {
  return String(quantity);
}

export function formatDate(date: Date | null | undefined): string {
  if (!date) {
    return "—";
  }
  return date.toISOString().slice(0, 10);
}

export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

export interface TableColumn {
  label: string;
  width: number;
  align?: "left" | "right" | "center";
}

const PAGE_BOTTOM_MARGIN = 50;

/**
 * Starts a new page when the cursor is too close to the bottom. Returns
 * whether it did, so the caller can react (e.g. redraw a header row) instead
 * of inferring a page break from an incidental doc.y value.
 */
function ensureRoom(doc: PDFKit.PDFDocument, rowHeight: number): boolean {
  const bottom = doc.page.height - doc.page.margins.bottom - PAGE_BOTTOM_MARGIN;
  if (doc.y + rowHeight > bottom) {
    doc.addPage();
    return true;
  }
  return false;
}

export function drawDocumentHeader(
  doc: PDFKit.PDFDocument,
  input: { organizationName: string; title: string; documentNumber: string; date: Date },
): void {
  doc.fontSize(20).font("Helvetica-Bold").text(input.organizationName);
  doc.moveDown(0.3);
  doc.fontSize(14).font("Helvetica-Bold").text(input.title);
  doc.moveDown(0.2);
  doc
    .fontSize(10)
    .font("Helvetica")
    .text(`${input.documentNumber}  •  ${formatDate(input.date)}`);
  doc.moveDown(1);
  doc
    .moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .strokeColor("#cccccc")
    .stroke();
  doc.moveDown(0.7);
}

/** A label/value block, e.g. supplier or delivery details, laid out two columns wide. */
export function drawKeyValueBlock(
  doc: PDFKit.PDFDocument,
  heading: string,
  entries: [string, string][],
): void {
  doc.fontSize(11).font("Helvetica-Bold").text(heading);
  doc.moveDown(0.2);
  doc.fontSize(10).font("Helvetica");
  for (const [label, value] of entries) {
    doc.text(`${label}: ${value}`);
  }
  doc.moveDown(0.8);
}

/**
 * A simple bordered table with a header row. Rows must already be formatted
 * strings — money/date formatting happens in the caller via the helpers above.
 */
export function drawLineItemTable(
  doc: PDFKit.PDFDocument,
  columns: TableColumn[],
  rows: string[][],
): void {
  const left = doc.page.margins.left;
  const rowHeight = 20;

  /** Tallest bottom edge reached by any cell in `cells`, laid out at the current doc.y. */
  function drawRowCells(cells: string[]): number {
    let x = left;
    const y = doc.y;
    let maxBottom = y;
    cells.forEach((cell, index) => {
      const column = columns[index];
      if (!column) {
        return;
      }
      doc.text(cell, x, y, { width: column.width, align: column.align ?? "left" });
      maxBottom = Math.max(maxBottom, doc.y);
      x += column.width;
    });
    return maxBottom;
  }

  /** Estimated height of `cells` if drawn now, accounting for wrapped multi-line text. */
  function measureRowHeight(cells: string[]): number {
    let maxHeight = rowHeight;
    cells.forEach((cell, index) => {
      const column = columns[index];
      if (!column) {
        return;
      }
      maxHeight = Math.max(maxHeight, doc.heightOfString(cell, { width: column.width }));
    });
    return maxHeight;
  }

  function drawHeaderRow(): void {
    doc.font("Helvetica-Bold").fontSize(9);
    const right = left + columns.reduce((sum, column) => sum + column.width, 0);
    doc.y = drawRowCells(columns.map((column) => column.label));
    doc.moveDown(0.9);
    doc.moveTo(left, doc.y).lineTo(right, doc.y).strokeColor("#000000").stroke();
    doc.moveDown(0.3);
  }

  ensureRoom(doc, rowHeight * 2);
  drawHeaderRow();

  doc.font("Helvetica").fontSize(9);
  for (const row of rows) {
    const startedNewPage = ensureRoom(doc, measureRowHeight(row));
    if (startedNewPage) {
      drawHeaderRow();
    }

    doc.y = drawRowCells(row);
    doc.moveDown(0.9);
  }

  doc.moveDown(0.5);
}

export function drawTotals(doc: PDFKit.PDFDocument, rows: [string, string][]): void {
  const right = doc.page.width - doc.page.margins.right;
  const labelWidth = 150;
  const valueWidth = 150;

  doc.font("Helvetica").fontSize(10);
  for (const [label, value] of rows) {
    const y = doc.y;
    doc.text(label, right - labelWidth - valueWidth, y, { width: labelWidth, align: "right" });
    doc.text(value, right - valueWidth, y, { width: valueWidth, align: "right" });
    doc.moveDown(0.5);
  }
}

export function drawFooter(doc: PDFKit.PDFDocument, note: string): void {
  doc.moveDown(1.5);
  doc.fontSize(8).font("Helvetica-Oblique").fillColor("#888888").text(note, { align: "left" });
  doc.fillColor("#000000");
}
