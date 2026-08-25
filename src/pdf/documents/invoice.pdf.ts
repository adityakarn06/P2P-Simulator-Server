import {
  drawDocumentHeader,
  drawFooter,
  drawKeyValueBlock,
  drawLineItemTable,
  drawTotals,
  formatPaise,
  formatQuantity,
} from "../layout.js";
import { createDocument, renderToBuffer } from "../render.js";

export interface InvoicePdfInput {
  invoiceNumber: string;
  invoiceDate: Date;
  poNumber: string;
  currency: string;
  subtotalPaise: number;
  taxPaise: number;
  totalPaise: number;
  supplier: { name: string; email: string | null; phone: string | null };
  billTo: { organizationName: string };
  items: {
    description: string;
    quantity: number;
    unitPricePaise: number;
    lineTotalPaise: number;
  }[];
}

/**
 * Renders a supplier invoice document. The supplier — not the buyer — is the
 * issuer here, unlike the PO and receipt PDFs, which the buyer's own
 * organization issues.
 */
export async function renderInvoicePdf(input: InvoicePdfInput): Promise<Buffer> {
  const doc = createDocument();
  const promise = renderToBuffer(doc);

  drawDocumentHeader(doc, {
    organizationName: input.supplier.name,
    title: "Invoice",
    documentNumber: input.invoiceNumber,
    date: input.invoiceDate,
  });

  drawKeyValueBlock(doc, "Bill to", [["Organization", input.billTo.organizationName]]);

  drawKeyValueBlock(doc, "Supplier", [
    ["Name", input.supplier.name],
    ["Email", input.supplier.email ?? "—"],
    ["Phone", input.supplier.phone ?? "—"],
  ]);

  drawKeyValueBlock(doc, "Reference", [["Purchase order", input.poNumber]]);

  drawLineItemTable(
    doc,
    [
      { label: "Description", width: 220 },
      { label: "Qty", width: 60, align: "right" },
      { label: "Unit price", width: 110, align: "right" },
      { label: "Line total", width: 110, align: "right" },
    ],
    input.items.map((item) => [
      item.description,
      formatQuantity(item.quantity),
      formatPaise(item.unitPricePaise, input.currency),
      formatPaise(item.lineTotalPaise, input.currency),
    ]),
  );

  drawTotals(doc, [
    ["Subtotal", formatPaise(input.subtotalPaise, input.currency)],
    ["Tax", formatPaise(input.taxPaise, input.currency)],
    ["Total", formatPaise(input.totalPaise, input.currency)],
  ]);

  drawFooter(
    doc,
    "This invoice was generated for demo convenience by a hackathon procurement simulator and is not a real supplier document.",
  );

  doc.end();
  return promise;
}
