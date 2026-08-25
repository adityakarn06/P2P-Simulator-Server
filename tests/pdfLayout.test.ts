import { describe, expect, it } from "vitest";
import { drawLineItemTable, type TableColumn } from "../src/pdf/layout.js";
import { createDocument, renderToBuffer } from "../src/pdf/render.js";

const columns: TableColumn[] = [
  { label: "Description", width: 220 },
  { label: "Qty", width: 60, align: "right" },
];

// Mirrors the PAGE_BOTTOM_MARGIN constant in src/pdf/layout.ts — not exported,
// so reproduced here to compute the same page-break threshold ensureRoom uses.
const PAGE_BOTTOM_MARGIN = 50;

describe("drawLineItemTable", () => {
  it("advances doc.y by the wrapped row's full measured height, not a fixed single-line estimate", async () => {
    const doc = createDocument();
    const promise = renderToBuffer(doc);

    const longDescription =
      "A very long line item description that is guaranteed to wrap across several lines " +
      "inside a 220pt-wide column at 9pt Helvetica, well beyond a single 20pt row height.";

    // Same font the row loop draws with, so this matches drawLineItemTable's own measurement.
    doc.font("Helvetica").fontSize(9);
    const wrappedHeight = doc.heightOfString(longDescription, { width: 220 });
    expect(wrappedHeight).toBeGreaterThan(20); // sanity check: this text does wrap

    const yBefore = doc.y;
    drawLineItemTable(doc, columns, [[longDescription, "1"]]);
    const yAfterWrappedRow = doc.y;

    doc.end();
    await promise;

    // If doc.y only reflected the last-drawn (short) "Qty" cell rather than the
    // tallest cell, this delta would be far smaller than the measured wrap height.
    expect(yAfterWrappedRow - yBefore).toBeGreaterThanOrEqual(wrappedHeight);
  });

  it("paginates and repeats the header when a wrapped row would overflow the page", async () => {
    const doc = createDocument();
    const promise = renderToBuffer(doc);

    const longDescription = "Wraps to several lines. ".repeat(20);

    doc.font("Helvetica").fontSize(9);
    const wrappedHeight = doc.heightOfString(longDescription, { width: 220 });
    const bottom = doc.page.height - doc.page.margins.bottom - PAGE_BOTTOM_MARGIN;

    // Leave just enough room for the header but not for the wrapped row that follows.
    doc.y = bottom - wrappedHeight + 10;

    drawLineItemTable(doc, columns, [[longDescription, "1"]]);
    const pageCount = doc.bufferedPageRange().count;

    doc.end();
    await promise;

    expect(pageCount).toBe(2);
  });
});
